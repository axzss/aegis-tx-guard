// decide.mjs — Aegis transaction-guard decision logic (pure, no I/O except
// the injected rpc object). Six deterministic checks; APPROVE only if all
// six pass. Fail closed: any error, unknown, or unparseable input = REJECT.
//
// Checks:
//   c1 VALID_REQUEST      — from/to are 20-byte hex addresses; data is
//                           0x-hex; value is a non-negative integer.
//   c2 NO_UNLIMITED_APPROVAL — no approve/increaseAllowance to uint256-max,
//                           no setApprovalForAll(true).
//   c3 KNOWN_SELECTOR     — empty calldata (plain transfer) or a selector
//                           in the known-safe list.
//   c4 TARGET_HAS_CODE    — non-empty calldata requires bytecode at `to`
//                           (eth_getCode != 0x); plain transfers exempt.
//   c5 NOT_BLOCKLISTED    — `to`, approve spender, and transfer recipient
//                           are not blocklisted (env BLOCKLIST) and the
//                           transfer recipient is not the zero address.
//   c6 SIMULATION_OK      — eth_call(from, to, data, value) succeeds.
//
// Reason codes are stable strings so callers and the circuit can agree
// on exactly which check failed.

export const REASON = {
  APPROVE: "ALL_CHECKS_PASSED",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNLIMITED_APPROVAL: "UNLIMITED_APPROVAL",
  UNKNOWN_SELECTOR: "UNKNOWN_SELECTOR",
  NO_CODE: "NO_CODE_AT_TARGET",
  BLOCKLISTED: "BLOCKLISTED",
  SIMULATION_REVERT: "SIMULATION_REVERT",
  RPC_UNAVAILABLE: "RPC_UNAVAILABLE",
};

export const CHECKS = [
  "VALID_REQUEST",
  "NO_UNLIMITED_APPROVAL",
  "KNOWN_SELECTOR",
  "TARGET_HAS_CODE",
  "NOT_BLOCKLISTED",
  "SIMULATION_OK",
];

// uint256 max, as a BigInt.
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// 4-byte selectors we understand. Anything else is UNKNOWN_SELECTOR.
//   a9059cbb transfer(address,uint256)
//   23b872dd transferFrom(address,address,uint256)
//   095ea7b3 approve(address,uint256)          (bounded amount only)
//   39509351 increaseAllowance(address,uint256) (bounded amount only)
//   1249c58b mint()                             (common no-arg mint)
//   4e71d92d claim()                            (common no-arg claim)
const KNOWN_SELECTORS = new Set([
  "a9059cbb",
  "23b872dd",
  "095ea7b3",
  "39509351",
  "1249c58b",
  "4e71d92d",
]);

// Selectors that carry an amount in the LAST 32-byte word (approve /
// increaseAllowance) and selectors that carry a boolean approval
// (setApprovalForAll).
const AMOUNT_SELECTORS = new Set(["095ea7b3", "39509351"]);

function isAddress(v) {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isHexData(v) {
  return typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);
}

function selectorOf(data) {
  if (!data || data === "0x") return "";
  return data.slice(2, 10).toLowerCase();
}

// Last 32-byte word of calldata as BigInt (for approve/increaseAllowance).
function lastWordAmount(data) {
  const words = data.slice(2);
  const last = words.slice(-64);
  return BigInt("0x" + last);
}

// First address argument (32-byte word) for approve/transfer-style calls.
function firstArgAddress(data) {
  const words = data.slice(2);
  const word = words.slice(8, 72); // first arg after the 4-byte selector
  return "0x" + word.slice(-40);
}

// setApprovalForAll(address,bool): bool is the last word (0/1).
function approvalForAllValue(data) {
  const words = data.slice(2);
  return BigInt("0x" + words.slice(-64));
}

// Parse the blocklist env var: comma-separated lowercase addresses.
export function parseBlocklist(envValue) {
  const set = new Set([ZERO_ADDRESS]);
  if (envValue) {
    for (const a of envValue.split(",")) {
      const t = a.trim().toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(t)) set.add(t);
    }
  }
  return set;
}

// The decision. `tx` = { from, to, data, value } (value: decimal string,
// default "0"; data: 0x-hex, default "0x"). `rpc` = { getCode(address),
// call(tx) } — injected so tests can use a mock. Returns
// { decision, reason_code, checks: { c1..c6: 0|1 }, details }.
export async function decide(tx, rpc, blocklist) {
  const checks = { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0 };
  const details = {};
  const fail = (reason) => ({
    decision: "REJECT",
    reason_code: reason,
    checks,
    details,
  });

  // c1 — VALID_REQUEST
  const from = tx?.from;
  const to = tx?.to;
  const data = tx?.data ?? "0x";
  const value = tx?.value ?? "0";
  let valueBig;
  try {
    valueBig = BigInt(String(value));
  } catch {
    return fail(REASON.INVALID_REQUEST);
  }
  if (!isAddress(from) || !isAddress(to) || !isHexData(data) || valueBig < 0n) {
    details.c1 = "bad from/to/data/value";
    return fail(REASON.INVALID_REQUEST);
  }
  checks.c1 = 1;

  const sel = selectorOf(data);
  const hasData = data !== "0x";
  const toLower = to.toLowerCase();

  // c2 — NO_UNLIMITED_APPROVAL
  if (AMOUNT_SELECTORS.has(sel)) {
    let amount;
    try {
      amount = lastWordAmount(data);
    } catch {
      details.c2 = "unparseable amount";
      return fail(REASON.INVALID_REQUEST);
    }
    if (amount === UINT256_MAX) {
      details.c2 = `unlimited ${sel} amount`;
      return fail(REASON.UNLIMITED_APPROVAL);
    }
  }
  if (sel === "a22cb465") {
    // setApprovalForAll(address,bool)
    if (approvalForAllValue(data) === 1n) {
      details.c2 = "setApprovalForAll(true)";
      return fail(REASON.UNLIMITED_APPROVAL);
    }
  }
  checks.c2 = 1;

  // c3 — KNOWN_SELECTOR
  if (hasData && !KNOWN_SELECTORS.has(sel)) {
    details.c3 = `unknown selector 0x${sel}`;
    return fail(REASON.UNKNOWN_SELECTOR);
  }
  checks.c3 = 1;

  // c4 — TARGET_HAS_CODE (only for calls with calldata)
  if (hasData) {
    let code;
    try {
      code = await rpc.getCode(to);
    } catch (e) {
      details.c4 = "getCode failed: " + String(e?.message || e).slice(0, 80);
      return fail(REASON.RPC_UNAVAILABLE);
    }
    if (typeof code !== "string" || code === "0x" || code === "0x0") {
      details.c4 = "no bytecode at target";
      return fail(REASON.NO_CODE);
    }
  }
  checks.c4 = 1;

  // c5 — NOT_BLOCKLISTED
  const addrs = [toLower];
  if (["095ea7b3", "39509351", "a9059cbb", "23b872dd"].includes(sel)) {
    try {
      addrs.push(firstArgAddress(data).toLowerCase());
    } catch { /* unparseable arg -> caught by c1/c3 already; ignore here */ }
  }
  if (sel === "23b872dd") {
    // transferFrom(from,to,amount): second arg is the recipient.
    try {
      const words = data.slice(2);
      addrs.push(("0x" + words.slice(72, 136).slice(-40)).toLowerCase());
    } catch { /* ignore */ }
  }
  const blocked = addrs.find((a) => blocklist.has(a));
  if (blocked) {
    details.c5 = `blocklisted address ${blocked}`;
    return fail(REASON.BLOCKLISTED);
  }
  checks.c5 = 1;

  // c6 — SIMULATION_OK (eth_call must succeed)
  try {
    const ok = await rpc.call({ from, to, data, value: "0x" + valueBig.toString(16) });
    if (!ok) {
      details.c6 = "eth_call reverted";
      return fail(REASON.SIMULATION_REVERT);
    }
  } catch (e) {
    details.c6 = "eth_call failed: " + String(e?.message || e).slice(0, 80);
    return fail(REASON.RPC_UNAVAILABLE);
  }
  checks.c6 = 1;

  return {
    decision: "APPROVE",
    reason_code: REASON.APPROVE,
    checks,
    details,
  };
}
