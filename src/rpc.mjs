// rpc.mjs — minimal JSON-RPC client (BSC/EVM) using Node's built-in fetch.
// Two calls only: eth_getCode and eth_call. Timeouts are hard; any failure
// throws so the caller can fail closed (the guard never approves on an
// unknown chain state).

export function makeRpc(rpcUrl, timeoutMs = 8000) {
  async function rpcCall(method, params) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      if (data.error) throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
      return data.result;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    // Returns bytecode hex ("0x" when the address has no code).
    async getCode(address) {
      return rpcCall("eth_getCode", [address, "latest"]);
    },
    // Returns true when eth_call succeeds (no revert). An eth_call that
    // FAILS WITH A REVERT is a simulation failure (returns false), not an
    // RPC failure — the transaction would revert on chain. Any other RPC
    // error throws so the caller can fail closed as RPC_UNAVAILABLE.
    async call({ from, to, data, value }) {
      try {
        // gasPrice 0 + an explicit gas cap: the simulation checks the call
        // LOGIC, not whether the sender can currently pay gas (the wallet
        // checks fees separately at signing). Without this, eth_call on
        // a nearly-empty `from` fails with "insufficient funds" and a
        // perfectly valid call looks like a revert.
        const result = await rpcCall("eth_call", [
          { from, to, data, value, gas: "0x2dc6c0", gasPrice: "0x0" },
          "latest",
        ]);
        return typeof result === "string";
      } catch (e) {
        if (/revert/i.test(String(e?.message || e))) return false;
        throw e;
      }
    },
  };
}
