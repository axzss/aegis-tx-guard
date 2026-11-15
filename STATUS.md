# Aegis — STATUS

**Wildcard Track entry — built 15 Nov 2026. Repo: https://github.com/axzss/aegis-tx-guard (commit d2dacea, 20 files, public).**

## What is DONE (verified 15 Nov ~14:00 WIB)

- **Circuit built** — `circuits/guard.circom` (Circom 2.2.2): 6 check-bit
  inputs + decision; constraints force decision == 1 only if every check
  == 1, plus bit-ness constraints. Compiled + Groth16 setup with a local
  Powers of Tau (power 12). Artifacts: `guard.wasm`, `guard_final.zkey`,
  `vk.json` (14 constraints, 9 wires, 7 public inputs, 0 private).
- **Decision logic** — `src/decide.mjs`: 6 deterministic checks
  (VALID_REQUEST, NO_UNLIMITED_APPROVAL, KNOWN_SELECTOR,
  TARGET_HAS_CODE, NOT_BLOCKLISTED, SIMULATION_OK), fail closed, stable
  reason codes.
- **RPC client** — `src/rpc.mjs`: `eth_getCode` + `eth_call` over the
  public BSC dataseed (verified live), 8s timeouts, `gasPrice: 0x0` so
  simulation checks call logic, not the sender's gas balance.
- **Prover** — `src/prove.mjs`: snarkjs `fullProve` + local verify
  against vk.json before returning.
- **Kurier client** — `src/kurier.mjs`: register-vk (own circuit vk,
  hash cached in `data/vk-hash.json`), submit-proof, poll to Finalized.
  Env-gated: without `KURIER_API_KEY` proofs are local-only.
- **Server** — `src/server.mjs`: `GET /health`, `GET /`, `POST /guard`
  (+ `/check` alias), 30s budget, prover warmup at boot, JSON logging.
- **Tests — 16/16 PASS** (`npm test`, 15 Nov ~14:00 WIB): mock-RPC
  harness, 10 decision cases, 3 proof cases incl. the circuit-binding
  case "APPROVE with c2=0 cannot be proven", 3 live-server smoke tests.
- **Live BSC demo — VERIFIED** (`demo/live-bsc-transcript.md`): bounded
  BUSD approve → APPROVE/ALL_CHECKS_PASSED (1.091 ms, proof present);
  plain transfer → APPROVE (297 ms); unlimited approve → REJECT /
  UNLIMITED_APPROVAL (314 ms, no RPC calls). Two live bugs found and
  fixed during the demo (hand-typed calldata off by one byte;
  eth_call gas-balance check — see transcript).
- **Pushed to GitHub** — `axzss/aegis-tx-guard`, public, commit
  d2dacea. Includes `render.yaml` (Render Blueprint, free tier,
  healthCheckPath /health) + `README.md` + `.env.example`.
- **Creator Track drafts** — `~/workspace/zkverify-agent-games/creator-track/`:
  `article.md` (dev.to/Medium-ready deep dive, ~2,000 words, includes
  #AgentGames) + `x-thread.md` (7 posts, all <280 chars, all verified
  by length check, includes #AgentGames + @ZKVProtocol).

## Live /guard hang — investigated + cleared (15 Nov ~14:20–15:00 WIB)

**Symptom:** every `POST /guard` from the VM timed out (25 s, 150 s),
including an invalid request that should fast-reject; `GET /health`
stayed fast. One /guard coincided with a process restart (uptime reset).

**Root cause — NOT the server. The VM's egress CONNECT proxy stalls
HTTP/1.1 requests with a body.** Evidence:
- `GET /health` + `GET /` answer in <1.5 s while a /guard is "in
  flight", and /health answers in ~0.6 s at t+2 s / t+7 s / t+15 s
  during a hung /guard → the Node event loop is free; no promise in
  the server is blocking it.
- `POST /nonexistent` (404 branch, never reads a body, never proves)
  also hangs; `GET /guard` (same 404 branch) answers in 1.4 s → the
  hang correlates with request *method/body*, not any handler code.
- Same hang from the VM to unrelated hosts: `POST https://httpbin.org/post`
  (10 s timeout; succeeds at 30 s), `POST https://postman-echo.com/post`
  (10 s timeout). `POST https://jsonplaceholder.typicode.com/posts`
  works (201, 3.3 s) — it negotiates HTTP/2.
- `curl --http2 -X POST .../health` answers 404 in 0.46 s; plain
  HTTP/1.1 curl stalls. The local server answers every case in <200 ms
  (16/16 tests; invalid /guard 148 ms).
- No code change was needed: RPC has an 8 s abort timeout, proof
  generation a 30 s race timeout, decide() fail-closes without I/O for
  invalid input. The earlier uptime reset was not reproduced across
  6+ /guard calls (uptime advanced steadily); likely a Render free-tier
  recycle/deploy, not a crash.

**Live verification (Render, `curl --http2`, 15 Nov ~15:00 WIB):**
- Plain transfer (0.00001 BNB, hunter wallet → EOA) → **APPROVE /
  ALL_CHECKS_PASSED, all 6 checks 1, proof present, server 1.612 s,
  total 1.99 s.** Proof independently re-verified locally:
  `snarkjs groth16 verify circuits/vk.json` → **OK!**
- Unlimited approve (`approve(spender, uint256-max)` on BUSD) →
  **REJECT / UNLIMITED_APPROVAL, c1=1 c2=0, proof present, server
  1.376 s, total 1.81 s.**
- Invalid request (`{"from":"0x123","to":"0x456"}`) → **REJECT /
  INVALID_REQUEST, proof present, server 1.186 s, total 1.65 s.**
- `kurier_status: skipped` (no `KURIER_API_KEY` set on Render) —
  proofs are generated locally and returned, not submitted on-chain.

**Lesson for verifiers:** use `curl --http2` (or any HTTP/2 client)
from proxied environments; plain HTTP/1.1 curl will misleadingly
time out on POSTs.

## What is NOT done — needs Arch (browser / dashboard)

1. **DEPLOY on Render** (browser, ~2 min, free, no card): New → Web
   Service → connect `axzss/aegis-tx-guard` (or `render.yaml` Blueprint)
   → plan **free** → build `npm install` → start `node src/server.mjs`
   → health check `/health`. Note the public URL.
2. **OPTIONAL env vars in Render:** `KURIER_API_KEY` (Kurier dashboard —
   same account as the Gatekeeper; submits proofs to mainnet),
   `BLOCKLIST` (extra scam addresses), `AGENT_GAMES_HMAC_SECRET`
   (only if response signing is wanted; not required for Wildcard).
   Without the Kurier key the endpoint still works and returns proofs.
3. **KEEP-ALIVE:** Render free spins down after 15 min idle — curl
   `/health` every ~10 min (same cron pattern as the Gatekeeper).
4. **SUBMIT the Wildcard entry** (dashboard, before 21 Nov 2026):
   agentgames.zkverify.io → Wildcard → submission form with:
   - Agent link: `https://github.com/axzss/aegis-tx-guard`
   - Public endpoint: `https://<render-url>/guard`
   - Use case / build context: see README (copy-paste ready).
   - zkVerify: Groth16 proof per decision; Kurier finalization when the
     key is set (proof reference / vkHash from `data/vk-hash.json`).
   - Bonus: share the build publicly (X post with #AgentGames — see the
     Creator Track draft; the article also covers this build).

## Risks / limitations (documented)

- The guard is strict by design: unknown selectors are rejected, so
  legitimate-but-unlisted contract calls need a list update
  (`KNOWN_SELECTORS` in `src/decide.mjs`).
- `eth_call` simulation is only as good as the public RPC; a stale or
  rate-limited dataseed fails closed (REJECT + RPC_UNAVAILABLE).
- Render free: ephemeral disk — `data/vk-hash.json` is re-created by
  re-registering the vk if the service restarts (cheap, one call).
- The proof binds decision-to-checks, not checks-to-truth (see README
  "Honesty note"). The check list is the security boundary, not the
  circuit.
