/**
 * The four crypto primitives Baileys imports from `libsignal/src/crypto.js`.
 *
 * Written against `node:crypto` rather than forwarded, because the Rust bridge does not export
 * them under these names. They are AES-256-CBC, HMAC-SHA256 and the three-chunk HKDF from RFC 5869 —
 * generic primitives with one correct implementation, not Signal protocol logic.
 *
 * `deriveSecrets` is transcribed from the shape the protocol needs and not from a licensed source:
 * HKDF-Extract with the salt as key, then three HKDF-Expand rounds whose info block is
 * `T(n-1) || info || n`. `crypto-known-answers.test.ts` pins all four against fixed vectors, because
 * a crypto function that is subtly wrong fails as "the other end closed the session" three layers
 * away from here.
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
 * RFC 5869, returning the first `chunks` 32-byte blocks.
 *
 * The info block is built once and mutated between rounds — `infoArray` holds `T(n-1) || info || n`,
 * and the first round takes only the `info || 1` tail because `T(0)` is empty. That layout is what
 * the protocol expects, so it is copied exactly rather than tidied.
 */
export function deriveSecrets(input, salt, info, chunks) {
  assertBuffer(input);
  assertBuffer(salt);
  assertBuffer(info);
  if (salt.byteLength !== 32) throw new Error("Got salt of incorrect length");

  const rounds = chunks ?? 3;
  if (rounds < 1 || rounds > 3) throw new Error("Got chunks of incorrect length");

  const prk = calculateMAC(salt, input);
  const infoArray = new Uint8Array(info.byteLength + 1 + 32);
  infoArray.set(info, 32);
  infoArray[infoArray.length - 1] = 1;

  const signed = [calculateMAC(prk, Buffer.from(infoArray.slice(32)))];
  for (let round = 2; round <= rounds; round += 1) {
    infoArray.set(signed[signed.length - 1]);
    infoArray[infoArray.length - 1] = round;
    signed.push(calculateMAC(prk, Buffer.from(infoArray)));
  }
  return signed;
}

export function verifyMAC(data, key, mac, length) {
  const calculated = calculateMAC(key, data).slice(0, length);
  if (mac.length !== length || calculated.length !== length) throw new Error("Bad MAC length");
  if (!mac.equals(calculated)) throw new Error("Bad MAC");
}
