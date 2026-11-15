// test.mjs — Aegis local test harness (no secrets, no mainnet).
// Spins up a mock JSON-RPC server (eth_getCode / eth_call), runs 9
// decision cases + 1 circuit-binding case + a live-server smoke test.
// Usage: npm test   (requires `npm run setup` first for the circuit artifacts)

import { createServer } from "http";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { decide, parseBlocklist, REASON } from "./decide.mjs";
import { makeRpc } from "./rpc.mjs";
import { buildCircuitInputs, generateProof } from "./prove.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CIRCUIT = {
  wasm: resolve(ROOT, "circuits", "guard.wasm"),
  zkey: resolve(ROOT, "circuits", "guard_final.zkey"),
  vk: resolve(ROOT, "circuits", "vk.json"),
};

const USER = "0x20fce977dad6e7537cf020e1b178b34da8295bb9";
const BUSD = "0x55d398326f99059ff775485246999027b3197955";
const SPENDER = "0x1111111111111111111111111111111111111111";
const EOA = "0x2222222222222222222222222222222222222222";
const REVERT_CONTRACT = "0x3333333333333333333333333333333333333333";
const BLOCKED = "0x4444444444444444444444444444444444444444";
const MOCK_PORT = 8546;

const pad32 = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const addrWord = (a) => "0".repeat(24) + a.replace(/^0x/, "").toLowerCase();
const amountWord = (n) => BigInt(n).toString(16).padStart(64, "0");
const MAX_UINT = (1n << 256n) - 1n;
const calldata = (sel, ...words) => "0x" + sel + words.join("");

// Mock RPC: BUSD + REVERT_CONTRACT + BLOCKED have bytecode; everything
// else is an EOA. eth_call reverts only for REVERT_CONTRACT.
function startMockRpc() {
  const coded = new Set([BUSD.toLowerCase(), REVERT_CONTRACT.toLowerCase(), BLOCKED.toLowerCase()]);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let q = {};
      try { q = JSON.parse(body); } catch { /* ignore */ }
      let result = null;
      let error = null;
      if (q.method === "eth_getCode") {
        result = coded.has(String(q.params?.[0]).toLowerCase()) ? "0x6080604052348015610010" : "0x";
      } else if (q.method === "eth_call") {
        const to = String(q.params?.[0]?.to || "").toLowerCase();
        if (to === REVERT_CONTRACT.toLowerCase()) {
          error = { code: -32000, message: "execution reverted" };
        } else {
          result = "0x";
        }
      } else if (q.method === "eth_blockNumber") {
        result = "0x7f7f592";
      } else {
        error = { code: -32601, message: "method not found" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(error ? { jsonrpc: "2.0", id: q.id, error } : { jsonrpc: "2.0", id: q.id, result }));
    });
  });
  return new Promise((resolveListen) => server.listen(MOCK_PORT, "127.0.0.1", () => resolveListen(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function main() {
  const hasCircuit = existsSync(CIRCUIT.wasm) && existsSync(CIRCUIT.zkey) && existsSync(CIRCUIT.vk);
  console.log(`Aegis tests — circuit artifacts: ${hasCircuit ? "present" : "MISSING (run npm run setup first)"}`);
  if (!hasCircuit) process.exit(2);

  const mock = await startMockRpc();
  const rpc = makeRpc(`http://127.0.0.1:${MOCK_PORT}`);
  const blocklist = parseBlocklist(BLOCKED);

  console.log("Decision cases (mock RPC):");
  // 1. Plain transfer to an EOA — APPROVE.
  let d = await decide({ from: USER, to: EOA, data: "0x", value: "10000000000000000" }, rpc, blocklist);
  check("1 plain transfer -> APPROVE", d.decision === "APPROVE" && d.reason_code === REASON.APPROVE, JSON.stringify(d));
  // 2. Bounded approve on a real contract — APPROVE.
  d = await decide({ from: USER, to: BUSD, data: calldata("095ea7b3", addrWord(SPENDER), amountWord(100n * 10n ** 18n)), value: "0" }, rpc, blocklist);
  check("2 bounded approve -> APPROVE", d.decision === "APPROVE", JSON.stringify(d));
  // 3. Unlimited approve — REJECT.
  d = await decide({ from: USER, to: BUSD, data: calldata("095ea7b3", addrWord(SPENDER), MAX_UINT.toString(16).padStart(64, "0")), value: "0" }, rpc, blocklist);
  check("3 unlimited approve -> REJECT/UNLIMITED_APPROVAL", d.decision === "REJECT" && d.reason_code === REASON.UNLIMITED_APPROVAL && d.checks.c2 === 0, JSON.stringify(d));
  // 4. setApprovalForAll(true) — REJECT.
  d = await decide({ from: USER, to: BUSD, data: calldata("a22cb465", addrWord(SPENDER), amountWord(1)), value: "0" }, rpc, blocklist);
  check("4 setApprovalForAll(true) -> REJECT/UNLIMITED_APPROVAL", d.decision === "REJECT" && d.reason_code === REASON.UNLIMITED_APPROVAL, JSON.stringify(d));
  // 5. Unknown selector — REJECT.
  d = await decide({ from: USER, to: BUSD, data: calldata("deadbeef", amountWord(0)), value: "0" }, rpc, blocklist);
  check("5 unknown selector -> REJECT/UNKNOWN_SELECTOR", d.decision === "REJECT" && d.reason_code === REASON.UNKNOWN_SELECTOR && d.checks.c3 === 0, JSON.stringify(d));
  // 6. Call to an EOA (no code) — REJECT.
  d = await decide({ from: USER, to: EOA, data: calldata("a9059cbb", addrWord(SPENDER), amountWord(1)), value: "0" }, rpc, blocklist);
  check("6 transfer to EOA w/ calldata -> REJECT/NO_CODE", d.decision === "REJECT" && d.reason_code === REASON.NO_CODE && d.checks.c4 === 0, JSON.stringify(d));
  // 7. Transfer to the zero address — REJECT (blocklist includes 0x0).
  d = await decide({ from: USER, to: BUSD, data: calldata("a9059cbb", addrWord("0x0000000000000000000000000000000000000000"), amountWord(1)), value: "0" }, rpc, blocklist);
  check("7 transfer to 0x0 -> REJECT/BLOCKLISTED", d.decision === "REJECT" && d.reason_code === REASON.BLOCKLISTED && d.checks.c5 === 0, JSON.stringify(d));
  // 8. Call to a blocklisted contract — REJECT.
  d = await decide({ from: USER, to: BLOCKED, data: calldata("a9059cbb", addrWord(SPENDER), amountWord(1)), value: "0" }, rpc, blocklist);
  check("8 blocklisted target -> REJECT/BLOCKLISTED", d.decision === "REJECT" && d.reason_code === REASON.BLOCKLISTED, JSON.stringify(d));
  // 9. Simulation reverts — REJECT.
  d = await decide({ from: USER, to: REVERT_CONTRACT, data: calldata("a9059cbb", addrWord(SPENDER), amountWord(1)), value: "0" }, rpc, blocklist);
  check("9 eth_call revert -> REJECT/SIMULATION_REVERT", d.decision === "REJECT" && d.reason_code === REASON.SIMULATION_REVERT && d.checks.c6 === 0, JSON.stringify(d));
  // 10. Invalid request — REJECT.
  d = await decide({ from: "not-an-address", to: BUSD, data: "0x", value: "0" }, rpc, blocklist);
  check("10 invalid request -> REJECT/INVALID_REQUEST", d.decision === "REJECT" && d.reason_code === REASON.INVALID_REQUEST && d.checks.c1 === 0, JSON.stringify(d));

  console.log("Proof cases (Groth16, guard circuit):");
  // 11. APPROVE proof verifies.
  const okInputs = buildCircuitInputs({ c1: 1, c2: 1, c3: 1, c4: 1, c5: 1, c6: 1 }, "APPROVE");
  const t0 = Date.now();
  const { proof, publicSignals } = await generateProof(okInputs, CIRCUIT);
  check("11 APPROVE proof verifies locally", Array.isArray(publicSignals) && publicSignals.length === 8, `signals=${JSON.stringify(publicSignals)} (${Date.now() - t0}ms)`);
  // 12. Circuit binding: APPROVE with a failed check must FAIL to prove.
  const badInputs = buildCircuitInputs({ c1: 1, c2: 0, c3: 1, c4: 1, c5: 1, c6: 1 }, "APPROVE");
  let bindingFailed = false;
  try {
    await generateProof(badInputs, CIRCUIT);
  } catch {
    bindingFailed = true;
  }
  check("12 APPROVE with c2=0 cannot be proven (circuit binds decision)", bindingFailed);
  // 13. REJECT proof verifies (decision 0 is always allowed).
  const rejInputs = buildCircuitInputs({ c1: 1, c2: 0, c3: 1, c4: 1, c5: 1, c6: 1 }, "REJECT");
  await generateProof(rejInputs, CIRCUIT);
  check("13 REJECT proof verifies locally", true);

  console.log("Live server smoke test (port 3457, mock RPC):");
  const server = spawn("node", ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "3457", RPC_URL: `http://127.0.0.1:${MOCK_PORT}`, BLOCKLIST: BLOCKED },
    stdio: "ignore",
  });
  try {
    let health = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const r = await fetch("http://127.0.0.1:3457/health");
        if (r.ok) { health = await r.json(); break; }
      } catch { /* not up yet */ }
    }
    check("14 /health ok", health?.ok === true, JSON.stringify(health));
    const guard = async (tx) => {
      const r = await fetch("http://127.0.0.1:3457/guard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tx),
      });
      return r.json();
    };
    const g1 = await guard({ from: USER, to: EOA, data: "0x", value: "10000000000000000" });
    check("15 POST /guard plain transfer -> APPROVE + proof", g1.decision === "APPROVE" && !!g1.proof && g1.proof_status === "ok", JSON.stringify(g1).slice(0, 200));
    const g2 = await guard({ from: USER, to: BUSD, data: calldata("095ea7b3", addrWord(SPENDER), MAX_UINT.toString(16).padStart(64, "0")), value: "0" });
    check("16 POST /guard unlimited approve -> REJECT + proof", g2.decision === "REJECT" && g2.reason_code === REASON.UNLIMITED_APPROVAL && !!g2.proof, JSON.stringify(g2).slice(0, 200));
  } finally {
    server.kill("SIGTERM");
    mock.close();
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
