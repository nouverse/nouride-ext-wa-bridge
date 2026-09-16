/**
 * The one protobuf message Baileys decodes from this package.
 *
 * `PreKeyWhisperMessage`, and only to read `identityKey` out of an incoming `pkmsg` so a changed
 * identity key can be noticed — see `extractIdentityFromPkmsg` in Baileys' `Signal/libsignal.js`.
 * Nothing encodes one here.
 *
 * Hand-decoded rather than pulled from a schema, because one optional `bytes` field at tag 3 does
 * not justify a protobuf runtime, and because the caller wraps the whole thing in `try {} catch {}`
 * and treats any failure as "no identity key" — which is the right answer for a malformed message
 * and the right answer for a field that is absent.
 *
 *     message PreKeyWhisperMessage {
 *       optional uint32 preKeyId       = 1;
 *       optional bytes  baseKey        = 2;
 *       optional bytes  identityKey    = 3;   // the only one read
 *       optional bytes  message        = 4;
 *       optional uint32 registrationId = 5;
 *       optional uint32 signedPreKeyId = 6;
 *     }
 */

/** A base-128 varint, returning the value and where it ended. */
function readVarint(bytes, at) {
  let value = 0;
  let shift = 0;
  let index = at;
  while (index < bytes.length) {
    const byte = bytes[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
    // A varint longer than ten bytes is malformed, and past 2^53 the arithmetic above is wrong
    // anyway. Neither matters for the fields here, all of which are small.
    if (shift > 63) break;
  }
  throw new Error("truncated varint");
}

export const PreKeyWhisperMessage = {
  /**
   * Returns `{ identityKey }` — a Uint8Array, **empty** when the field is not present.
   *
   * Empty rather than undefined because that is what the real decoder does, and the two are compared
   * against each other on 300 encoded messages. The only consumer tests `?.length === 33`, which
   * answers false either way, but matching the oracle exactly is cheaper than arguing that a
   * difference is harmless.
   *
   * Every other field is skipped by wire type rather than parsed, so an unknown or reordered field
   * does not derail the scan. An unrecognised wire type throws, and the caller reads that the same
   * way it reads anything else that goes wrong.
   */
  decode(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let at = 0;
    let identityKey = new Uint8Array(0);

    while (at < buf.length) {
      const { value: key, next } = readVarint(buf, at);
      at = next;
      const field = key >>> 3;
      const wire = key & 0x7;

      if (wire === 2) {
        const { value: length, next: afterLength } = readVarint(buf, at);
        at = afterLength;
        if (at + length > buf.length) throw new Error("truncated length-delimited field");
        if (field === 3) identityKey = buf.slice(at, at + length);
        at += length;
      } else if (wire === 0) {
        at = readVarint(buf, at).next;
      } else if (wire === 5) {
        at += 4;
      } else if (wire === 1) {
        at += 8;
      } else {
        throw new Error(`unsupported wire type ${wire}`);
      }
    }

    return { identityKey };
  },
};
