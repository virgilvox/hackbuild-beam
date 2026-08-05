/**
 * Browser transports. This entry is the only place in the SDK allowed to touch a
 * browser global.
 *
 * Both Web Serial and Web Bluetooth work from `file://` in Chromium, which treats
 * it as a secure context. The shipped tools prove it daily and the single file
 * build depends on it.
 *
 * Neither API is in the DOM lib, so both transports declare the shapes they use
 * structurally. That keeps the package free of an ambient type dependency and keeps
 * the surface honest: what is declared is exactly what is called.
 *
 * INV-62c: BLE discovery filters on the Nordic UART service UUID and never on the
 * device name. A name filter cannot see the other rig at all.
 */

export { WebSerialTransport, type WebSerialOptions } from "../transports/serial.js";
export { WebBleTransport, type WebBleOptions } from "../transports/ble.js";
