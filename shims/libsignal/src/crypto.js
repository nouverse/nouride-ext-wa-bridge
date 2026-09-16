/**
 * The four crypto primitives Baileys imports from `libsignal/src/crypto.js`.
 *
 * Written against `node:crypto` rather than forwarded, because the Rust bridge does not export
 * them under these names. They are AES-256-CBC, HMAC-SHA256 and the three-chunk HKDF from RFC 5869 —
 * generic primitives with one correct implementation, not Signal protocol logic.
 *
 * `deriveSecrets` is transcribed from the shape the protocol needs and not from a licensed source:
 * HKDF-Extract with the salt as key, then three HKDF-Expand rounds whose info block is
 * `T(n-1) || info || n`. `tests/libsignal-shim.test.ts` pins all of them against vectors frozen from the
 * real `libsignal` — frozen rather than compared live, because the point of this shim is that the
 * real package stops being installed. A crypto function that is subtly wrong fails as "the other end
 * closed the session", three layers away from here.
 */

import nodeCrypto from "node:crypto";

function assertBuffer(value) {
  if (!Buffer.isBuffer(value)) {
    throw TypeError(`Expected Buffer instead of: ${value?.constructor?.name ?? typeof value}`);
  }
  return value;
}

export function encrypt(key, data, iv) {
  assertBuffer(key);
  assertBuffer(data);
  assertBuffer(iv);
  const cipher = nodeCrypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function decrypt(key, data, iv) {
  assertBuffer(key);
  assertBuffer(data);
  assertBuffer(iv);
  const decipher = nodeCrypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function calculateMAC(key, data) {
  assertBuffer(key);
  assertBuffer(data);
  const hmac = nodeCrypto.createHmac("sha256", key);
  hmac.update(data);
  return Buffer.from(hmac.digest());
}

export function hash(data) {
  assertBuffer(data);
  const sha512 = nodeCrypto.createHash("sha512");
  sha512.update(data);
  return Buffer.from(sha512.digest());
}

/**
 * HKDF (RFC 5869), returning the first `chunks` blocks of output.
 *
 * Written from the RFC rather than from any implementation: extract once with the salt as the HMAC
 * key, then expand with `T(n) = HMAC(PRK, T(n-1) || info || n)`, `T(0)` empty. SHA-256, so each
 * block is 32 bytes.
 *
 * The one thing that is not the RFC is the ceiling of three blocks, which is a property of the
 * caller rather than of HKDF — the protocol asks for at most three — and refusing more is better
 * than returning something nobody has checked.
 *
 * Pinned by known-answer vectors in `tests/libsignal-shim.test.ts`. That matters more here than
 * anywhere else in this file: a KDF that is subtly wrong produces keys that are merely different,
 * and the failure arrives as "the other end closed the session".
 */
export function deriveSecrets(input, salt, info, chunks) {
  assertBuffer(input);
  assertBuffer(salt);
  assertBuffer(info);
  if (salt.byteLength !== 32) throw new Error("Got salt of incorrect length");

  const blocks = chunks ?? 3;
  if (blocks < 1 || blocks > 3) throw new Error("Got chunks of incorrect length");

  const prk = calculateMAC(salt, input);
  const out = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; counter <= blocks; counter += 1) {
    previous = calculateMAC(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    out.push(previous);
  }
  return out;
}

export function verifyMAC(data, key, mac, length) {
  const calculated = calculateMAC(key, data).slice(0, length);
  if (mac.length !== length || calculated.length !== length) throw new Error("Bad MAC length");
  if (!mac.equals(calculated)) throw new Error("Bad MAC");
}
