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
 * The same storage, with `loadSession` answering in bytes.
 *
 * `record.serialize()` on the way past, because a record is what Baileys hands back and bytes are
 * what the bridge asks for. A record that is already bytes is passed through untouched, so a caller
 * that does the right thing to begin with is not punished for it — and `null`/`undefined` mean "no
 * session", which both sides agree on.
 */
function bytesLoading(storage) {
  return {
    ...storage,
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

export class SessionCipher extends RustSessionCipher {
  constructor(storage, remoteAddress) {
    super(bytesLoading(storage), remoteAddress);
  }
}

export class SessionBuilder extends RustSessionBuilder {
  constructor(storage, remoteAddress) {
    super(bytesLoading(storage), remoteAddress);
  }
}
