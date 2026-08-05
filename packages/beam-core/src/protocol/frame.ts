import { MAGIC } from "./spec.js";

/*
 * Escaped framing.
 *
 * Why escape at all, from the firmware header, verbatim in substance: delta bytes
 * are arbitrary, so before escaping a payload byte could equal the opening byte.
 * Lose one byte anywhere and the framer locks onto a payload byte as a header and
 * never finds its footing again: every packet after it fails its checksum and its
 * contents fall through to the text parser, which is exactly what a bad link looked
 * like, a burst of unknown-command errors with binary in them and a checksum
 * counter climbing without stopping. Escaped, the opening byte can only ever mean
 * the start of a packet, so a lost byte costs one packet and the next lands clean.
 *
 * The measured cost is about one extra byte in eighty.
 */

/**
 * Escape a built packet in place of a copy where nothing needs escaping.
 *
 * `low` is the bottom of the reserved range and it is the version compatibility
 * knob: hermite packets pass 0xA4, legacy packets take the 0xA5 default, because
 * firmware that predates the hermite magic would mistranslate `A7 04`. Byte 0 is
 * never escaped: the magic must stay recognisable.
 */
export function escapeFrame(b: Uint8Array, low: number = MAGIC.FLAT): Uint8Array {
  let extra = 0;
  for (let i = 1; i < b.length; i++) {
    if (b[i]! >= low && b[i]! <= MAGIC.ESC) extra++;
  }
  if (!extra) return b;

  const out = new Uint8Array(b.length + extra);
  out[0] = b[0]!;
  let o = 1;
  for (let i = 1; i < b.length; i++) {
    const v = b[i]!;
    if (v >= low && v <= MAGIC.ESC) {
      out[o++] = MAGIC.ESC;
      out[o++] = v & 0x0f;
    } else {
      out[o++] = v;
    }
  }
  return out;
}

/** The receiver's reconstruction: an escaped byte carries its literal in the low nibble. */
export function unescapeByte(nibble: number): number {
  return 0xa0 | (nibble & 0x0f);
}

/** Every byte that can open a packet, across both domains. */
export function isMagic(b: number): boolean {
  return b === MAGIC.STEP || b === MAGIC.HERMITE || b === MAGIC.FLAT || b === MAGIC.DELTA;
}

/**
 * Should this byte restart the framer?
 *
 * INV-13, and the one inherited defect that gets fixed rather than ported.
 *
 * The shipped receiver restarts on any magic byte at any time, on the reasoning
 * that an opening byte part way through means the packet being built never
 * finished. That is right for a genuinely lost packet, but the shipped sender does
 * not escape a payload 0xA4 inside a legacy flat or delta packet, so an ordinary
 * pulse low byte of 164, or a 164 ms duration, or a delta of -92, mis-frames a
 * perfectly good packet. It is self limiting, since the restart consumes the tail
 * and the frame then times out or fails CRC while the sequence stays primed, but it
 * costs the packet.
 *
 * Treating a magic byte as an opener only when no frame is currently open closes
 * that hole and is compatible in both directions: a real lost packet still leaves
 * the framer to be abandoned by the 250 ms idle check, which is the mechanism that
 * was already covering the case where the opener itself went missing.
 */
export function isFrameOpener(b: number, frameOpen: boolean): boolean {
  return !frameOpen && isMagic(b);
}
