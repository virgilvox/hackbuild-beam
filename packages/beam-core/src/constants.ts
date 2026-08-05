/*
 * One number, one place.
 *
 * INV-68: TICK_HZ currently exists as three separate literals across the DETENT
 * codebase. The firmware says 20000, the browser app says 20000 with the comment
 * "must match firmware TICK_HZ", and the g++ harness says 10000. That third one is
 * why the harness's reference tick gaps of 23 and 41 are not directly comparable
 * to anything the shipped board does. In this repo it is exported once and the
 * firmware header is generated from it.
 */

/** Stepper ISR base rate, hertz. The alarm fires every 50 us. */
export const TICK_HZ = 20000;

/**
 * INV-10: computed, never pasted.
 *
 * The 28BYJ-48 gear train is 63.68395:1, not 64:1. Eight half steps per electrical
 * revolution times 63.68395 gives 4075.7728 half steps per output revolution. The
 * firmware comment rounds DEG_PER_STEP to 0.0883266; the real value is
 * 0.08832680761793199 and using the comment's figure shifts every step count.
 */
export const STEPS_PER_REV = 4075.7728;
export const DEG_PER_STEP = 360 / STEPS_PER_REV;

/** Half steps of mirror to degrees of beam: a mirror doubles its own rotation. */
export const BEAM_DEG_PER_STEP = DEG_PER_STEP * 2;

/** Stepper queue. One slot is burned so head == tail can mean empty. */
export const DETENT_QUEUE_LEN = 256;
export const DETENT_QUEUE_USABLE = DETENT_QUEUE_LEN - 1;

/** Servo queue, same one-slot convention: 48 slots, 47 reported free at most. */
export const WASHER_QUEUE_LEN = 48;
export const WASHER_QUEUE_USABLE = WASHER_QUEUE_LEN - 1;

/**
 * INV-39: the largest axis delta one segment may carry.
 *
 * Long moves split so no single segment exceeds int16 and so the queue stays
 * granular enough for a stop to land quickly. The cast to int16 in the wire format
 * is only lossless because this split ships with it, so the two must never be
 * separated.
 */
export const MAX_SEGMENT_AXIS_DELTA = 2000;

/** Coil re-energise settle: hold the last phase so the rotor pulls back into register. */
export const COIL_SETTLE_TICKS = Math.trunc(TICK_HZ / 33); // 606 ticks, 30.3 ms

/**
 * Loss estimation. Segments are not a fixed length: they run from a millisecond to
 * a hundred and fifty, ended wherever the tolerance says. A single neighbour used
 * to stand in for the lost ones, which was fine at two segments per packet; at
 * eight to a packet one bad sample gets multiplied by eight and the bench measured
 * the plot running a tenth of a second off tempo from one drop. A running average
 * of what has actually been arriving is the honest estimator.
 */
export const LOSS_EMA_ALPHA = 1 / 8;
export const LOSS_STRETCH_CAP_MS = 60_000;
export const JOB_NOMINAL_MS_DEFAULT = 17;

/** Safety timings, milliseconds. All four are bench numbers. */
export const STARVATION_GATE_MS = 300;
export const WASHER_DEADMAN_MS = 1500;
export const DETENT_DEADMAN_MS = 5000;
export const SEGMENT_CONTINUITY_MS = 250;
export const FRAMER_IDLE_ABANDON_MS = 250;

/** Flow control. */
export const WASHER_EMIT_GATE_SLOTS = 6;
export const DETENT_BATCH_MAX_POINTS = 6;
export const DETENT_CREDIT_HEADROOM = DETENT_BATCH_MAX_POINTS + 8; // 14
export const BLE_MAX_WRITES_IN_FLIGHT = 3;

/** BLE chunking: start long, fall back stickily to the 20 byte floor on refusal. */
export const BLE_CHUNK_START = 180;
export const BLE_CHUNK_FLOOR = 20;
export const BLE_PACKET_BUDGET = 176;

/** Nordic UART Service. Identical on both boards, and it must stay that way. */
export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

/**
 * Device names seen in the wild. These are for DISPLAY ONLY.
 *
 * INV-62c: BLE discovery filters on the service UUID above, never on the name. The
 * step app filters on a "DETENT" name prefix today, which cannot see a "LASER RIG"
 * board at all. Both firmwares call addServiceUUID with the NUS service and set a
 * scan response, so the service filter finds both and any future rig for free.
 */
export const BLE_DEVICE_NAMES = ["BEAM", "LASER RIG", "DETENT"] as const;

export const SERIAL_BAUD = 115200;
