/**
 * The parts of the `libsignal` shim that are written here rather than forwarded.
 *
 * `shims/libsignal/` replaces the GPL-3.0 `libsignal` package with one that forwards to
 * `whatsapp-rust-bridge` (MIT). Most of it is a rename — the four classes and the four curve
 * primitives exist there with the same shapes, and getting a rename wrong fails loudly.
 *
 * Two modules are not renames. `src/crypto.js` reimplements AES-256-CBC, HMAC-SHA256, SHA-512 and
 * the three-chunk HKDF against `node:crypto`, because the bridge does not export them.
 * `src/protobufs.js` hand-decodes one optional `bytes` field. Both fail *quietly* when they are
 * subtly wrong: the symptom is a session the other end closes, three layers away from the cause.
 *
 * So they are pinned against **frozen vectors generated from the real `libsignal`**, in
 * `fixtures/libsignal-vectors.json`. Frozen rather than compared live, because the whole point of
 * the shim is that the real package stops being installed — an oracle that disappears with the thing
 * it is checking is no oracle at all. They were also compared live at 200 random inputs per crypto
 * function and 300 encoded messages before being frozen.
 */

import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/libsignal-vectors.json";
import {
  calculateMAC,
  decrypt,
  deriveSecrets,
  encrypt,
  hash,
  verifyMAC,
} from "../shims/libsignal/src/crypto.js";
import { PreKeyWhisperMessage } from "../shims/libsignal/src/protobufs.js";

const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");

describe("the crypto primitives match the implementation they replace", () => {
  test("AES-256-CBC encrypts to the same ciphertext, and decrypts back", () => {
    for (const v of vectors.crypto) {
      const got = encrypt(bytes(v.key), bytes(v.data), bytes(v.iv));
      expect(got.toString("hex")).toBe(v.encrypted);
      expect(decrypt(bytes(v.key), got, bytes(v.iv)).toString("hex")).toBe(v.data);
    }
  });

  test("HMAC-SHA256 and SHA-512 agree", () => {
    for (const v of vectors.crypto) {
      expect(calculateMAC(bytes(v.key), bytes(v.data)).toString("hex")).toBe(v.mac);
      expect(hash(bytes(v.data)).toString("hex")).toBe(v.hash);
    }
  });

  test("HKDF agrees at one, two and three chunks", () => {
    /**
     * All three, because the info block is mutated between rounds — `T(n-1) || info || n` — and a
     * loop that is wrong about which part it overwrites still produces the right answer for the
     * first chunk. The protocol uses more than one.
     */
    for (const v of vectors.crypto) {
      for (const chunks of [1, 2, 3] as const) {
        const got = deriveSecrets(bytes(v.data), bytes(v.salt), bytes(v.info), chunks);
        expect(got.map((b) => b.toString("hex"))).toEqual(v.derived[chunks - 1]!);
        expect(got).toHaveLength(chunks);
      }
    }
  });

  test("a buffer is required, because a string would encrypt something else entirely", () => {
    // `createCipheriv` accepts a utf-8 string as a key and quietly uses different bytes.
    expect(() => encrypt("not a buffer" as never, Buffer.alloc(16), Buffer.alloc(16))).toThrow(TypeError);
  });

  test("verifyMAC accepts a correct tag and refuses a wrong one", () => {
    const key = bytes(vectors.crypto[0]!.key);
    const data = bytes(vectors.crypto[0]!.data);
    const mac = calculateMAC(key, data).slice(0, 16);
    expect(() => verifyMAC(data, key, mac, 16)).not.toThrow();
    const wrong = Buffer.from(mac);
    wrong[0] = wrong[0]! ^ 0xff;
    expect(() => verifyMAC(data, key, wrong, 16)).toThrow("Bad MAC");
  });
});

describe("the PreKeyWhisperMessage decoder", () => {
  test("reads the identity key out of a real encoded message", () => {
    for (const v of vectors.protobuf) {
      expect(Buffer.from(PreKeyWhisperMessage.decode(bytes(v.encoded)).identityKey).toString("hex"))
        .toBe(v.identityKey);
    }
  });

  test("an absent identity key is empty, not undefined", () => {
    // What the real decoder does. The one consumer tests `?.length === 33`, which answers false
    // either way, but matching the oracle exactly is cheaper than arguing a difference is harmless.
    const absent = vectors.protobuf.find((v) => v.identityKey === "");
    expect(absent).toBeDefined();
    expect(PreKeyWhisperMessage.decode(bytes(absent!.encoded)).identityKey).toHaveLength(0);
  });

  test("a truncated message throws rather than returning a short key", () => {
    // The caller wraps this in `try {} catch {}` and reads a throw as "no identity key", which is
    // the right answer. Returning a half-read field would not be.
    const full = bytes(vectors.protobuf[1]!.encoded);
    expect(() => PreKeyWhisperMessage.decode(full.slice(0, full.length - 4))).toThrow();
  });
});

/**
 * Baileys' own signal repository, driven end to end through the shim.
 *
 * The rest of this file checks the two modules written here. This one checks the part that cannot be
 * checked by reading: that `makeLibSignalRepository` — 430 lines of Baileys, unmodified, importing
 * `libsignal` by name in four places — actually runs against the replacement.
 *
 * It was worth writing. The first attempt looked like it passed and was resolving to the real
 * package the whole time: a plain dependency alias does not reach Baileys' own copy, because Baileys
 * depends on `libsignal` itself and bun installs it a second time underneath. `overrides` is what
 * replaces it everywhere, and this test is what noticed.
 */
describe("Baileys' repository runs on the shim", () => {
  async function repository() {
    const rs = await import("whatsapp-rust-bridge");
    const { makeLibSignalRepository } = await import(
      "@whiskeysockets/baileys/lib/Signal/libsignal.js"
    );

    const me = rs.generateKeyPair();
    const store = new Map<string, unknown>();
    const keys = {
      get: async (type: string, ids: string[]) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          const value = store.get(`${type}-${id}`);
          if (value) out[id] = value;
        }
        return out;
      },
      set: async (data: Record<string, Record<string, unknown>>) => {
        for (const [type, entries] of Object.entries(data))
          for (const [id, value] of Object.entries(entries ?? {}))
            value ? store.set(`${type}-${id}`, value) : store.delete(`${type}-${id}`);
      },
      transaction: async (fn: () => Promise<unknown>) => fn(),
      isInTransaction: () => false,
    };
    const silent = { info() {}, warn() {}, error() {}, trace() {}, debug() {}, child() { return silent; } };
    const auth = {
      // The shape Baileys reads: `.private` / `.public`, with the public key unprefixed.
      creds: { signedIdentityKey: { private: me.privKey, public: me.pubKey.slice(1) }, registrationId: 4242 },
      keys,
    };
    return { repo: makeLibSignalRepository(auth as never, silent as never), store, rs };
  }

  test("injects a session from a bundle and encrypts against it", async () => {
    const { repo, store, rs } = await repository();
    const peer = rs.generateKeyPair();
    const signed = rs.generateKeyPair();
    const pre = rs.generateKeyPair();
    const jid = "62811000111@s.whatsapp.net";

    await repo.injectE2ESession({
      jid,
      session: {
        registrationId: 99,
        identityKey: peer.pubKey,
        signedPreKey: { keyId: 1, publicKey: signed.pubKey, signature: rs.calculateSignature(peer.privKey, signed.pubKey) },
        preKey: { keyId: 2, publicKey: pre.pubKey },
      },
    } as never);

    expect([...store.keys()]).toEqual(["session-62811000111.0"]);
    expect(await repo.validateSession(jid)).toMatchObject({ exists: true });

    const out = await repo.encryptMessage({ jid, data: Buffer.from("halo dari nouride") } as never);
    // `pkmsg` is the first message on a new session — a `msg` here would mean the prekey handshake
    // never happened. The body arrives as a Uint8Array now rather than a binary string, and Baileys'
    // `Buffer.from(body, "binary")` handles both: the encoding argument is ignored for a TypedArray.
    expect(out.type).toBe("pkmsg");
    expect(out.ciphertext.length).toBeGreaterThan(100);
  });

  test("a session written by the old implementation reads as absent, not as empty", async () => {
    /**
     * The one behaviour difference, and the reason it is handled here rather than left alone.
     *
     * The two serialisations are unrelated — a bespoke JSON object against Signal's
     * `SessionStructure` protobuf — and the Rust `deserialize` accepts the old object **without
     * throwing**, returning an empty record. Baileys would then hold a session that claims to exist
     * and cannot do anything, which is worse than having none.
     */
    const { SessionRecord } = await import("../shims/libsignal/index.js");
    const legacy = SessionRecord.deserialize({ _sessions: { some: {} }, version: "v1" });
    expect(legacy.haveOpenSession()).toBe(false);
  });
});
