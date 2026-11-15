// server.mjs — Aegis transaction-guard agent endpoint (Node 22 stdlib only).
// Routes:
//   GET  /health  -> { ok, protocolVersion, service, uptime, ... }
//   GET  /        -> service info (JSON)
//   POST /guard   -> guard a proposed transaction (also POST /check alias)
// Guard flow (30s hard budget):
//   1. read raw body -> 2. parse tx -> 3. decide() (6 checks, fail closed)
//   4. generate Groth16 proof binding the decision to the check bits
//   5. submit to Kurier + poll (best effort, bounded, only if a
//      KURIER_API_KEY is configured and the vk is registered)
//   6. reply { decision, reason_code, checks, proof, public_signals, ... }.
// A decision is ALWAYS returned, even if proof generation or Kurier fails
// — a missing proof weakens the claim, a timeout loses the whole answer.

import { createServer } from "http";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { decide, parseBlocklist, REASON } from "./decide.mjs";
import { makeRpc } from "./rpc.mjs";
import { buildCircuitInputs, generateProofTimed } from "./prove.mjs";
import { registerVk, submitProof, pollUntilFinalized } from "./kurier.mjs";
import { signBody } from "./sign.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

try { process.loadEnvFile(resolve(ROOT, ".env")); } catch { /* no .env yet */ }

const CFG = {
  port: Number(process.env.PORT || 3000),
  hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || "",
  kurierKey: process.env.KURIER_API_KEY || "",
  kurierNetwork: process.env.KURIER_NETWORK || "mainnet",
  rpcUrl: process.env.RPC_URL || "https://bsc-dataseed.binance.org/",
  blocklist: parseBlocklist(process.env.BLOCKLIST || ""),
  logFile: process.env.LOG_FILE || resolve(ROOT, "logs", "guard.log"),
  vkHashFile: resolve(ROOT, "data", "vk-hash.json"),
  proofTimeoutMs: Number(process.env.PROOF_TIMEOUT_MS || 30000),
  kurierPollTimeoutMs: Number(process.env.KURIER_POLL_TIMEOUT_MS || 20000),
  circuit: {
    wasm: resolve(ROOT, "circuits", "guard.wasm"),
    zkey: resolve(ROOT, "circuits", "guard_final.zkey"),
    vk: resolve(ROOT, "circuits", "vk.json"),
  },
};

const rpc = makeRpc(CFG.rpcUrl);
const startedAt = Date.now();
let vkHash = null; // from data/vk-hash.json or a fresh Kurier registration
let kurierStatus = "skipped";

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  try {
    mkdirSync(dirname(CFG.logFile), { recursive: true });
    appendFileSync(CFG.logFile, line + "\n", "utf8");
  } catch { /* logging must never crash a guard call */ }
  console.log(line);
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        rejectBody(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function sendJson(res, status, obj) {
  const raw = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (CFG.hmacSecret) headers["x-agent-games-signature"] = signBody(CFG.hmacSecret, raw);
  res.writeHead(status, headers);
  res.end(raw);
}

// Warm up the prover once at boot (first fullProve is the slowest).
async function warmupProver() {
  try {
    const dummy = buildCircuitInputs({ c1: 1, c2: 1, c3: 1, c4: 1, c5: 1, c6: 1 }, "APPROVE");
    await generateProofTimed(dummy, CFG.circuit, 60000);
    log({ event: "prover-warmup", status: "ok" });
  } catch (e) {
    log({ event: "prover-warmup", status: "failed", error: String(e?.message || e).slice(0, 120) });
  }
}

// Register the guard vk with Kurier once (only when a key is configured).
// Reads a cached vkHash from data/vk-hash.json first.
async function ensureVkRegistered() {
  if (!CFG.kurierKey) return;
  try {
    if (existsSync(CFG.vkHashFile)) {
      const cached = JSON.parse(readFileSync(CFG.vkHashFile, "utf8"));
      if (cached?.vkHash) {
        vkHash = cached.vkHash;
        kurierStatus = "vk-cached";
        log({ event: "kurier-vk", status: "cached", vkHash: vkHash.slice(0, 18) + "…" });
        return;
      }
    }
    const vkJson = JSON.parse(readFileSync(CFG.circuit.vk, "utf8"));
    const reg = await registerVk(CFG.kurierKey, vkJson, CFG.kurierNetwork);
    if (reg?.vkHash) {
      vkHash = reg.vkHash;
      mkdirSync(dirname(CFG.vkHashFile), { recursive: true });
      writeFileSync(CFG.vkHashFile, JSON.stringify({ vkHash, network: CFG.kurierNetwork }, null, 2));
      kurierStatus = "vk-registered";
      log({ event: "kurier-vk", status: "registered", vkHash: vkHash.slice(0, 18) + "…" });
    } else {
      kurierStatus = "vk-register-no-hash";
      log({ event: "kurier-vk", status: "no-hash", response: JSON.stringify(reg).slice(0, 120) });
    }
  } catch (e) {
    kurierStatus = "vk-register-failed:" + String(e?.message || e).slice(0, 80);
    log({ event: "kurier-vk", status: "failed", error: String(e?.message || e).slice(0, 120) });
  }
}

async function handleGuard(req, res) {
  const t0 = Date.now();
  let proofStatus = "skipped";
  let kurier = "skipped";
  try {
    const raw = await readBody(req);
    let tx;
    try {
      tx = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "bad-json" });
    }

    const d = await decide(tx, rpc, CFG.blocklist);
    let proof = null;
    let publicSignals = null;
    try {
      const inputs = buildCircuitInputs(d.checks, d.decision);
      const r = await generateProofTimed(inputs, CFG.circuit, CFG.proofTimeoutMs);
      proof = r.proof;
      publicSignals = r.publicSignals;
      proofStatus = "ok";
    } catch (e) {
      proofStatus = "failed:" + String(e?.message || e).slice(0, 80);
    }

    if (proof && CFG.kurierKey && vkHash) {
      try {
        const sub = await submitProof(CFG.kurierKey, proof, publicSignals, vkHash, CFG.kurierNetwork);
        if (sub?.jobId) {
          const poll = await pollUntilFinalized(CFG.kurierKey, sub.jobId, {
            timeoutMs: CFG.kurierPollTimeoutMs,
            network: CFG.kurierNetwork,
          });
          kurier = poll.finalized ? "Finalized" : `not-finalized(${poll.status})`;
        } else {
          kurier = "submit-no-jobid";
        }
      } catch (e) {
        kurier = "error:" + String(e?.message || e).slice(0, 80);
      }
    }

    const body = {
      decision: d.decision,
      reason_code: d.reason_code,
      checks: d.checks,
      details: d.details,
      ms: Date.now() - t0,
      proof_status: proofStatus,
      kurier_status: kurier,
    };
    if (proof) {
      body.proof = proof;
      body.public_signals = publicSignals;
      if (vkHash) body.vk_hash = vkHash;
    }
    log({ route: "guard", decision: d.decision, reason_code: d.reason_code, proof: proofStatus, kurier, ms: Date.now() - t0 });
    return sendJson(res, 200, body);
  } catch (e) {
    log({ route: "guard", error: "handler-" + String(e?.message || e).slice(0, 120), ms: Date.now() - t0 });
    try {
      return sendJson(res, 200, { decision: "REJECT", reason_code: REASON.RPC_UNAVAILABLE, checks: { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0 }, details: {}, ms: Date.now() - t0 });
    } catch { /* socket already gone */ }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true, protocolVersion: "v1", service: "aegis-tx-guard",
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      rpc: CFG.rpcUrl,
      kurier: CFG.kurierKey ? kurierStatus : "missing",
      vk_hash: vkHash || null,
    });
  }
  if (req.method === "GET" && path === "/") {
    return sendJson(res, 200, {
      service: "aegis-tx-guard", protocolVersion: "v1",
      endpoints: ["GET /health", "POST /guard", "POST /check"],
      checks: ["VALID_REQUEST", "NO_UNLIMITED_APPROVAL", "KNOWN_SELECTOR", "TARGET_HAS_CODE", "NOT_BLOCKLISTED", "SIMULATION_OK"],
    });
  }
  if (req.method === "POST" && (path === "/guard" || path === "/check")) return handleGuard(req, res);

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not-found" }));
});

server.listen(CFG.port, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), event: "listening", port: CFG.port,
    rpc: CFG.rpcUrl,
    hmac: CFG.hmacSecret ? "configured" : "not-set (responses unsigned)",
    kurier: CFG.kurierKey ? "configured" : "MISSING (proofs generated locally, NOT submitted to Kurier)",
  }));
  if (!CFG.kurierKey) console.log("NOTE: KURIER_API_KEY not set — proofs are generated locally but NOT submitted to Kurier. Set it in .env when Arch provides it.");
  warmupProver();
  ensureVkRegistered();
});
