pragma circom 2.0.0;

// Aegis guard circuit.
// Proves: decision == APPROVE (1) ONLY IF every one of the six
// off-chain checks passed (c1..c6 == 1).
// All inputs are public: anyone verifying the proof sees exactly which
// checks passed and that the decision follows from them. The proof does
// NOT claim the checks themselves are true in the world — it claims the
// decision is consistent with the check results. (Same honesty rule as
// the Proof Gatekeeper circuit: a proof can verify and still authorize
// the wrong action if the checks are wrong. The checks live in
// src/decide.mjs; this circuit binds the decision to them.)
template Guard() {
    signal input c1;
    signal input c2;
    signal input c3;
    signal input c4;
    signal input c5;
    signal input c6;
    signal input decision;
    signal output ok;

    // All inputs are bits.
    c1 * (c1 - 1) === 0;
    c2 * (c2 - 1) === 0;
    c3 * (c3 - 1) === 0;
    c4 * (c4 - 1) === 0;
    c5 * (c5 - 1) === 0;
    c6 * (c6 - 1) === 0;
    decision * (decision - 1) === 0;

    // APPROVE only if every check passed.
    decision * (1 - c1) === 0;
    decision * (1 - c2) === 0;
    decision * (1 - c3) === 0;
    decision * (1 - c4) === 0;
    decision * (1 - c5) === 0;
    decision * (1 - c6) === 0;

    ok <== decision;
}

component main { public [c1, c2, c3, c4, c5, c6, decision] } = Guard();
