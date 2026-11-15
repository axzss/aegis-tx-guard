#!/usr/bin/env bash
# Aegis circuit setup: compile guard.circom, run a local Powers of Tau
# (small circuit — power 12 is plenty), Groth16 setup, export vk.
# Run once:  npm run setup
# Requires: circom 2.x binary (downloaded automatically if missing) and
# snarkjs (npm install first). No secrets, no network beyond the downloads.
set -euo pipefail
cd "$(dirname "$0")/.."
CIRCUITS="circuits"
CIRCOM_BIN="${CIRCOM_BIN:-./scripts/circom-linux-amd64}"

if [ ! -x "$CIRCOM_BIN" ]; then
  echo "Downloading circom 2.2.2 (linux-amd64)..."
  mkdir -p scripts
  curl -sL --max-time 120 -o "$CIRCOM_BIN" \
    https://github.com/iden3/circom/releases/download/v2.2.2/circom-linux-amd64
  chmod +x "$CIRCOM_BIN"
fi
"$CIRCOM_BIN" --version

echo "Compiling guard.circom..."
"$CIRCOM_BIN" "$CIRCUITS/guard.circom" --r1cs --wasm --sym -o "$CIRCUITS"
mv "$CIRCUITS/guard_js/guard.wasm" "$CIRCUITS/guard.wasm"
rm -rf "$CIRCUITS/guard_js"

echo "Powers of Tau (bn128, power 12)..."
npx snarkjs powersoftau new bn128 12 "$CIRCUITS/pot12_0000.ptau" -v
npx snarkjs powersoftau contribute "$CIRCUITS/pot12_0000.ptau" "$CIRCUITS/pot12_0001.ptau" \
  --name="aegis-first-contribution" -v -e="aegis deterministic entropy"
npx snarkjs powersoftau prepare phase2 "$CIRCUITS/pot12_0001.ptau" "$CIRCUITS/pot12_final.ptau" -v

echo "Groth16 setup..."
npx snarkjs groth16 setup "$CIRCUITS/guard.r1cs" "$CIRCUITS/pot12_final.ptau" "$CIRCUITS/guard_final.zkey"
npx snarkjs zkey export verificationkey "$CIRCUITS/guard_final.zkey" "$CIRCUITS/vk.json"
npx snarkjs zkey export verificationkey "$CIRCUITS/guard_final.zkey" "$CIRCUITS/vk.json" >/dev/null
echo "---"
npx snarkjs r1cs info "$CIRCUITS/guard.r1cs"
ls -l "$CIRCUITS/"
echo "Setup complete. vk.json is the verification key; register it with Kurier (see README) to get a vkHash."
