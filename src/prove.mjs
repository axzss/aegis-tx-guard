// prove.mjs — Groth16 proof generation for the Aegis guard circuit.
// Circuit inputs: the six check bits (c1..c6, "0"/"1") + decision ("0"/"1").
// The circuit constrains decision == 1 only if every check == 1, so a
// proof can only be generated for a decision that follows from the checks.
// The proof is verified locally against vk.json before it is returned.

import { readFileSync } from "fs";
import * as snarkjs from "snarkjs";

export function buildCircuitInputs(checks, decision) {
  const bit = (v) => (v ? "1" : "0");
  return {
    c1: bit(checks.c1),
    c2: bit(checks.c2),
    c3: bit(checks.c3),
    c4: bit(checks.c4),
    c5: bit(checks.c5),
    c6: bit(checks.c6),
    decision: decision === "APPROVE" ? "1" : "0",
  };
}

export async function generateProof(circuitInputs, paths) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    paths.wasm,
    paths.zkey
  );
  const vk = JSON.parse(readFileSync(paths.vk, "utf8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error("local proof verification failed");
  return { proof, publicSignals };
}

export function generateProofTimed(circuitInputs, paths, timeoutMs = 30000) {
  return Promise.race([
    generateProof(circuitInputs, paths),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("proof-generation-timeout")), timeoutMs)
    ),
  ]);
}
