/**
 * Curve25519, forwarded to `whatsapp-rust-bridge`.
 *
 * Every one of the four names Baileys reaches for exists there with the same shape, so this file is
 * a rename and nothing more. `generateKeyPair` is re-exported rather than wrapped because Baileys
 * uses both the named import and `import * as curve`.
 */

export {
  calculateAgreement,
  calculateSignature,
  generateKeyPair,
  verifySignature,
} from "whatsapp-rust-bridge";
