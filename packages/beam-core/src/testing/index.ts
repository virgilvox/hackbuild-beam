/**
 * The firmware reference model, published so downstream consumers can run
 * conformance tests too.
 *
 * This is the executable spec for what a board does: the framer, sequence handling
 * and stretch with its EMA, the segment interpolator, the tick pacer, the
 * starvation gate and the dead man.
 *
 * The sync duty is a rule, not an aspiration: any firmware change updates this
 * model in the same commit. The original g++ harness carries a "copied verbatim"
 * comment and has drifted on four counts, which is exactly what the rule exists to
 * prevent. See INV-71.
 *
 * PORT STATUS: scaffold. The model lands at M1, against golden fixtures captured
 * from both shipped tools before any porting begins.
 */

export {};
