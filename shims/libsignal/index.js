/**
 * The four Signal classes Baileys reaches for, forwarded to `whatsapp-rust-bridge`.
 *
 * `ProtocolAddress` and `SessionRecord` pass straight through — same constructor, same
 * `serialize()` / `deserialize()` / `toString()`. `SessionCipher` and `SessionBuilder` are wrapped
 * for one reason, and it is the only real difference between the two implementations:
 *
 * ## The storage contract disagrees about `loadSession`
 *
 * Baileys' `signalStorage()` returns a **record** from `loadSession`, because that is what the JS
 * `libsignal` did:
 *
 *     loadSession:  (id) => libsignal.SessionRecord.deserialize(bytesFromTheDatabase)
 *     storeSession: (id, record) => save(record.serialize())
 *
 * The Rust bridge's `SignalStorage` declares `loadSession(address): Uint8Array`. So the record has
 * to be turned back into bytes on the way in. `storeSession` needs nothing: both sides pass a
 * record, and it is the same class.
 *
 * Wrapping the storage rather than patching Baileys keeps the whole change inside this package, and
 * inside one function.
 */

import {
  calculateSignature,
  ProtocolAddress,
  SessionBuilder as RustSessionBuilder,
  SessionCipher as RustSessionCipher,
  SessionRecord as RustSessionRecord,
} from "whatsapp-rust-bridge";

export { ProtocolAddress };

/**
 * A record written by the old implementation, which this one cannot read.
 *
 * The two serialisations are unrelated: the JS `libsignal` wrote a bespoke JSON object
 * (`{_sessions, version}`), the Rust bridge writes Signal's `SessionStructure` protobuf. Measured
 * rather than assumed — a real X3DH session built with the JS implementation, handed to
 * `RustSessionRecord.deserialize`, came back **empty and without throwing**:
 *
 *     JS made a session. open: true   sessions: 1
 *     RUST read it.      open: false  re-serialized: 0 bytes
 *
 * Silently empty is the dangerous shape. Baileys would hold a record that claims to exist and has
 * nothing in it, and every caller downstream would have to guess what that means. So a legacy record
 * is marked here and turned into a plain **absence** in `bytesLoading` below, which is a state
 * Baileys already handles: no session, so negotiate one.
 */
const LEGACY = Symbol("libsignal.legacy-record");

function looksLegacy(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    "_sessions" in value &&
    "version" in value
  );
}

export class SessionRecord extends RustSessionRecord {
  static deserialize(value) {
    const record = RustSessionRecord.deserialize(looksLegacy(value) ? new Uint8Array(0) : value);
    if (looksLegacy(value)) record[LEGACY] = true;
    return record;
  }
}

/**
 * A Signal public key as the protocol carries it: 33 bytes, `0x05` then the raw point.
 *
 * Baileys stores the raw 32 and prefixes at the boundary — `generateSignalPubKey` — so anything it
 * hands back has to be prefixed again before it is signed or verified.
 */
function prefixed(pubKey) {
  if (pubKey.length !== 32) return pubKey;
  const out = new Uint8Array(33);
  out[0] = 5;
  out.set(pubKey, 1);
  return out;
}

/**
 * Baileys' storage, adapted to the contract the Rust bridge declares.
 *
 * Two shapes disagree, and both were found by a live box rather than by reading:
 *
 * `loadSession` — Baileys answers with a **record**, because that is what the JS `libsignal` did;
 * the bridge asks for bytes. A record that is already bytes passes through untouched.
 *
 * `loadSignedPreKey` — Baileys answers with a bare `{privKey, pubKey}`; the bridge wants
 * `{keyId, keyPair, signature}` and refuses without the signature (`InvalidState("load_signed_pre_key",
 * "Missing signature bytes")`, which is where every inbound `pkmsg` stopped). The signature is
 * **recomputed, not invented**: Baileys made it as `sign(identityPrivate, prefixed(preKeyPublic))`
 * — `signedKeyPair` in its `Utils/crypto.js` — and both halves are reachable from this storage, so
 * the same call reproduces the same bytes.
 *
 * `loadPreKey` needs nothing: the bridge asks for a `KeyPair`, which is what Baileys already returns.
 */
function adapted(storage) {
  return {
    ...storage,
    loadSignedPreKey: async (id) => {
      const key = await storage.loadSignedPreKey(id);
      if (!key) return null;
      // Already the bridge's shape — a caller that does the right thing is not punished for it.
      if (key.keyPair) return key;
      const identity = await storage.getOurIdentity();
      return {
        keyId: id,
        keyPair: { privKey: key.privKey, pubKey: key.pubKey },
        signature: calculateSignature(identity.privKey, prefixed(key.pubKey)),
      };
    },
    loadSession: async (address) => {
      const record = await storage.loadSession(address);
      if (record === null || record === undefined) return null;
      // Written by the old implementation: report no session rather than an empty one. The next
      // message negotiates a fresh one, which is the same path a contact who reinstalled takes.
      if (record[LEGACY]) return null;
      if (record instanceof Uint8Array) return record;
      return record.serialize();
    },
  };
}

/**
 * What Baileys looks for when it decides a decrypt failure is recoverable.
 *
 * `decode-wa-message.js` matches the error text against exactly two patterns:
 *
 *     sessionRecordErrors: ['No session record', 'SessionError: No session record']
 *
 * A match sets `isSessionRecordError`, which is what makes it send a retry receipt — and a retry
 * receipt is what makes the phone re-send as `pkmsg` with a bundle, re-establishing the session.
 *
 * The Rust bridge says `SessionCipher.decryptWhisperMessage failed: SessionNotFound(...)`, which
 * matches neither. Without this translation the recovery never fires: the phone keeps sending
 * `type='msg'` for a session only the cipher disagrees about, every message fails the same way, and
 * nothing in the log says why. That is not hypothetical — it is what a live box did for eight
 * minutes across two deploys.
 */
const NO_SESSION = "SessionError: No session record";

function translate(error) {
  const text = String(error?.message ?? error ?? "");
  if (!text.includes("SessionNotFound")) return error;
  const translated = new Error(NO_SESSION);
  translated.cause = error;
  return translated;
}

export class SessionCipher extends RustSessionCipher {
  constructor(storage, remoteAddress) {
    super(adapted(storage), remoteAddress);
  }

  // Both decrypt entry points, because `msg` and `pkmsg` take different ones and either can arrive
  // first. `encrypt` is left alone: a missing session there is a caller error, not something a retry
  // receipt can fix.
  async decryptWhisperMessage(ciphertext) {
    try {
      return await super.decryptWhisperMessage(ciphertext);
    } catch (error) {
      throw translate(error);
    }
  }

  async decryptPreKeyWhisperMessage(ciphertext) {
    try {
      return await super.decryptPreKeyWhisperMessage(ciphertext);
    } catch (error) {
      throw translate(error);
    }
  }
}

export class SessionBuilder extends RustSessionBuilder {
  constructor(storage, remoteAddress) {
    super(adapted(storage), remoteAddress);
  }
}
