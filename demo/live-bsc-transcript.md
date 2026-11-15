# Live demo transcript — Aegis vs BSC mainnet

**When:** 15 Nov 2026 ~14:00 WIB. **RPC:** public BSC dataseed
(`https://bsc-dataseed.binance.org/`), no key. **Server:** local
`node src/server.mjs` on :3458, no Kurier key (proofs local-only).
Full Groth16 proofs were returned in every response below; they are
trimmed here to `proof: present` for readability (verify one with
`snarkjs groth16 verify circuits/vk.json public.json proof.json`).

## 1. Bounded approve — BUSD, 100 tokens — APPROVE

Request `from` = hunter wallet `0x20fC…BB9`, `to` = BUSD
`0x55d398326f99059fF775485246999027B3197955`, `data` =
`approve(0x1111…1111, 100e18)`, `value` = 0.

```json
{"decision": "APPROVE", "reason_code": "ALL_CHECKS_PASSED",
 "checks": {"c1": 1, "c2": 1, "c3": 1, "c4": 1, "c5": 1, "c6": 1},
 "details": {}, "ms": 1091, "proof_status": "ok",
 "kurier_status": "skipped", "proof": "present",
 "public_signals": ["1", "1", "1", "1", "1", "1", "1", "1"]}
```

## 2. Plain transfer, affordable value (0.00001 BNB) — APPROVE

```json
{"decision": "APPROVE", "reason_code": "ALL_CHECKS_PASSED",
 "checks": {"c1": 1, "c2": 1, "c3": 1, "c4": 1, "c5": 1, "c6": 1},
 "details": {}, "ms": 297, "proof_status": "ok",
 "kurier_status": "skipped", "proof": "present",
 "public_signals": ["1", "1", "1", "1", "1", "1", "1", "1"]}
```

## 3. Unlimited approve — REJECT (no RPC calls needed)

`approve(spender, uint256-max)`:

```json
{"decision": "REJECT", "reason_code": "UNLIMITED_APPROVAL",
 "checks": {"c1": 1, "c2": 0, "c3": 0, "c4": 0, "c5": 0, "c6": 0},
 "details": {"c2": "unlimited 095ea7b3 amount"}, "ms": 314,
 "proof_status": "ok", "kurier_status": "skipped", "proof": "present",
 "public_signals": ["0", "1", "0", "0", "0", "0", "0", "0"]}
```

## Two bugs found live (and fixed)

1. **Hand-typed calldata was malformed.** My first demo approve
   reverted on chain even from a rich address. Root cause: a
   hand-typed amount word was 65 hex chars instead of 64. Fix: build
   calldata programmatically (the test harness already did; the demo
   did not). Lesson: never hand-type calldata.
2. **eth_call charges gas in simulation.** The first plain-transfer
   demo used value 0.01 BNB from a wallet holding 0.000082 BNB and
   failed with "insufficient funds for gas * price + value". Fix:
   `eth_call` now sends `gasPrice: 0x0` with an explicit gas cap, so
   the simulation checks the call *logic*, not whether the sender can
   currently pay gas. A value the sender cannot afford still fails
   the simulation (correctly — that transfer genuinely cannot execute).
