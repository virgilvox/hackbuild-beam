/*
 * CRC-8/ATM: polynomial 0x07, init 0x00, no reflection, no final xor, MSB first.
 *
 * Why it is load bearing, from the firmware header: BLE writes arrive in 20 byte
 * chunks, so a lost chunk splices the head of one packet onto the tail of another.
 * Unchecked that lands as a bogus axis value and the beam jumps clean across the
 * room.
 *
 * The range is the unescaped bytes from the magic through the last payload byte,
 * excluding only the CRC byte itself. The CRC is computed before escaping, so the
 * CRC byte is itself subject to escaping if it lands in the reserved range.
 */
export function crc8(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = 0;
  for (let i = from; i < to; i++) {
    c ^= bytes[i]!;
    for (let b = 0; b < 8; b++) {
      c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
  }
  return c;
}
