# Aegis — Verifiable Transaction Guard

A Wildcard Track entry for zkVerify Agent Games Season 01.

**The problem.** Before you sign a crypto transaction, nothing proves it is
safe to sign. Drainers hide behind unlimited `approve()` calls,
`setApprovalForAll(true)`, and unfamiliar contract functions. Wallets show
you hex; you are expected to trust it. On BNB Chain — where free mints and
new agent tokens appear daily — the cost of one bad signature is the whole
wallet.

**What Aegis does.** Aegis is a public HTTPS agent that screens a proposed
transaction *before* it is signed and returns a decision with a
zero-knowledge proof:

- `POST /guard` with `{ from, to, data, value }` (BSC mainnet by default).
- Six deterministic checks (see below). **APPROVE only if all six pass.**
- Every response carries a **Groth16 proof** (BN128, Circom 2.x, snarkjs)
  over a custom circuit that constrains `decision == APPROVE` to be
  possible only when all six check bits are 1. A proof for an APPROVE
  with a failed check cannot be generated — the witness assertion fails.
- When a Kurier API key is configured, the proof is also submitted to
  zkVerify mainnet via Kurier and polled until **Finalized**; the vk is
  registered once and its hash cached in `data/vk-hash.json`.

## The six checks

| # | Check | Fails when |
|---|-------|-----------|
| c1 | VALID_REQUEST | `from`/`to` not addresses, `data` not hex, `value` negative |
| c2 | NO_UNLIMITED_APPROVAL | `approve`/`increaseAllowance` to uint256-max, or `setApprovalForAll(true)` |
| c3 | KNOWN_SELECTOR | calldata selector not in the known-safe list (transfer, transferFrom, bounded approve/increaseAllowance, no-arg mint/claim) |
| c4 | TARGET_HAS_CODE | calldata sent to an address with no bytecode (`eth_getCode`) |
| c5 | NOT_BLOCKLISTED | target, approve spender, or transfer recipient is blocklisted (env `BLOCKLIST`; zero address always blocked) |
| c6 | SIMULATION_OK | `eth_call` of the transaction reverts (or the RPC is unreachable — fail closed) |

Reason codes are stable strings (`UNLIMITED_APPROVAL`, `UNKNOWN_SELECTOR`,
`NO_CODE_AT_TARGET`, `BLOCKLISTED`, `SIMULATION_REVERT`,
`RPC_UNAVAILABLE`, `INVALID_REQUEST`, `ALL_CHECKS_PASSED`).

## Honesty note

The proof binds the *decision* to the *check results*. It does not prove
the checks are right about the world — a wrong check list can still pass a
bad transaction. That is the same rule the Proof Gatekeeper track teaches:
*a proof can verify perfectly and still authorize the wrong action.* The
check list is public (in `src/decide.mjs`), the failure modes are
documented, and the guard fails closed on every uncertainty (unknown
selector, missing bytecode, RPC failure, reverted simulation).

## Run locally

```sh
npm install
npm run setup   # compile guard.circom + local Powers of Tau + Groth16 setup
npm test        # 16 checks: 10 decision cases + 3 proof cases + 3 live-server
npm start       # :3000 — POST /guard
```

## Deploy (Render free tier, no card)

1. Push this repo to GitHub.
2. Render → New → Web Service → connect the repo (or use `render.yaml`).
3. Plan **free** → build `npm install` → start `node src/server.mjs` →
   health check path `/health`.
4. Optional env vars: `RPC_URL` (default public BSC dataseed),
   `BLOCKLIST` (comma-separated addresses), `KURIER_API_KEY` (submits
   proofs to zkVerify mainnet; without it, proofs are generated locally
   and returned, not submitted), `AGENT_GAMES_HMAC_SECRET` (signs
   responses with `x-agent-games-signature`).
5. Keep-alive: Render free spins down after 15 min idle — curl `/health`
   every ~10 min to keep it warm.

## API

- `GET /health` — liveness + config status.
- `GET /` — service info + check list.
- `POST /guard` (alias `POST /check`) — `{ from, to, data, value }` in,
  `{ decision, reason_code, checks, details, proof, public_signals, ... }` out.

Example — screen a bounded approve (see `demo/` for full transcripts):

```sh
curl -s -X POST https://<your-render-url>/guard \
  -H 'content-type: application/json' \
  -d '{"from":"0x...","to":"0x55d398326f99059fF775485246999027B3197955",
       "data":"0x095ea7b3...","value":"0"}'
```

> **Verifying from a proxied sandbox/VM:** plain `curl` (HTTP/1.1) can
> stall for 10–150 s on any POST with a body when the egress proxy
> delays HTTP/1.1 request bodies — this looks like the endpoint hanging
> but the server answers in ~1.5 s. Use `curl --http2` (or a client
> that negotiates HTTP/2) to verify. GETs are unaffected. See
> `STATUS.md` ("Live /guard hang — investigation") for the evidence.

## Files

- `circuits/guard.circom` — the 6-check binding circuit (13 constraints).
- `src/decide.mjs` — pure 6-check decision logic.
- `src/rpc.mjs` — `eth_getCode` + `eth_call` client.
- `src/prove.mjs` — snarkjs Groth16 prove + local verify.
- `src/kurier.mjs` — Kurier register-vk / submit-proof / job-status.
- `src/sign.mjs` — HMAC-SHA256 response signing.
- `src/server.mjs` — HTTP server, 30s budget, fail closed.
- `src/test.mjs` — mock-RPC harness (16 checks).

## Wildcard submission (Agent Games dashboard)

- **Agent link:** this repo (+ live demo URL after deploy).
- **Public endpoint:** `https://<render-url>/guard`.
- **Use case:** anyone about to sign a transaction — wallets, agent
  frameworks, and mint/claim hunters — gets a pre-sign safety verdict
  with a proof, instead of trusting hex.
- **Build context:** Node 22 stdlib + snarkjs; custom Circom circuit;
  Kurier for on-chain verification. Full detail in `STATUS.md`.
- **zkVerify:** the guard's APPROVE is backed by a Groth16 proof that
  the decision follows from the six checks; with a Kurier key the proof
  reference is finalized on zkVerify mainnet.

## License

MIT.
