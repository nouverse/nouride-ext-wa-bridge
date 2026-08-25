/**
 * The encrypted session store.
 *
 * The failure this guards against is the one that makes the whole bridge not worth running: a session
 * that cannot be read back is a QR scan on every restart. So the round-trip is the first test, and the
 * wrong-key case is the second — GCM must refuse rather than hand back plausible garbage, because
 * garbage credentials fail later and look like a WhatsApp problem.
 *
 * Skips itself when Baileys is not installed, and that is not politeness — `plugins/wa-bridge` is
 * deliberately outside the root workspace, so `bun test ./apps/ ./packages/` on a fresh clone has no
 * GPL package to resolve. Failing there would make an optional component a required one. Install it
 * (`cd plugins/wa-bridge && bun install`) and these run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AuthModule = typeof import("../src/auth.ts");

let auth: AuthModule | null = null;
try {
  auth = await import("../src/auth.ts");
} catch {
  // Baileys is not installed here. Announced rather than silent: a suite that quietly covers nothing
  // reads exactly like a suite that passed.
  console.warn("wa-bridge: skipping the session tests — run `bun install` in plugins/wa-bridge");
}

const describeAuth = auth ? describe : describe.skip;
const useEncryptedAuthState = (...args: Parameters<AuthModule["useEncryptedAuthState"]>) =>
  (auth as AuthModule).useEncryptedAuthState(...args);
const parseKey = (...args: Parameters<AuthModule["parseKey"]>) =>
  (auth as AuthModule).parseKey(...args);

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wa-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeAuth("the key", () => {
  test("accepts exactly 32 bytes of hex", () => {
    expect(parseKey(KEY)).toHaveLength(32);
    expect(parseKey(`  ${KEY}  `)).toHaveLength(32);
  });

  test("refuses anything else rather than padding or truncating it", () => {
    // Silently accepting a short key would encrypt the session under something weaker than it claims.
    expect(() => parseKey("abc")).toThrow(/64 hex/);
    expect(() => parseKey("z".repeat(64))).toThrow(/64 hex/);
    expect(() => parseKey("")).toThrow(/64 hex/);
  });
});

describeAuth("round trip", () => {
  test("credentials written by one session are read back by the next", async () => {
    const first = await useEncryptedAuthState(dir, KEY);
    const registrationId = first.state.creds.registrationId;
    await first.saveCreds();

    // A second open is exactly what a restart does.
    const second = await useEncryptedAuthState(dir, KEY);

    // If this ever fails, the bridge asks for a new QR on every boot.
    expect(second.state.creds.registrationId).toBe(registrationId);
    expect(second.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private);
  });

  test("signal keys survive too, as Buffers rather than JSON objects", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.state.keys.set({
      "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } },
    } as never);

    const reopened = await useEncryptedAuthState(dir, KEY);
    const back = (await reopened.state.keys.get("pre-key", ["1"])) as Record<
      string,
      { public: Uint8Array; private: Uint8Array }
    >;

    // Baileys hands these to libsignal, which wants bytes. A plain `{type:"Buffer",data:[…]}` object
    // survives JSON but breaks decryption, which is why BufferJSON is used on both sides.
    expect(Buffer.from(back["1"]?.public ?? [])).toEqual(Buffer.from([1, 2, 3]));
    expect(Buffer.from(back["1"]?.private ?? [])).toEqual(Buffer.from([4, 5, 6]));
  });

  test("deleting a key removes its file", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1]) } } } as never);
    expect(readdirSync(dir).some((f) => f.startsWith("pre-key-1"))).toBe(true);

    await auth.state.keys.set({ "pre-key": { "1": null } } as never);
    expect(readdirSync(dir).some((f) => f.startsWith("pre-key-1"))).toBe(false);
  });
});

describeAuth("at rest", () => {
  test("nothing readable is on disk", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.saveCreds();

    const blob = readFileSync(join(dir, "creds.enc"));
    const asText = blob.toString("utf8");

    // The point of the whole file: a copy of this directory must not be a working login.
    expect(asText).not.toContain("registrationId");
    expect(asText).not.toContain("noiseKey");
    expect(asText.startsWith("{")).toBe(false);
  });

  test("the wrong key refuses rather than returning garbage", async () => {
    const first = await useEncryptedAuthState(dir, KEY);
    await first.saveCreds();

    const wrong = await useEncryptedAuthState(dir, OTHER_KEY);

    // GCM authenticates, so this is a refusal, not a silent mis-decrypt. The store falls back to a
    // fresh identity — which asks for a QR, the correct outcome for "these credentials are unreadable".
    expect(wrong.state.creds.registrationId).not.toBe(first.state.creds.registrationId);
  });

  test("clear() leaves nothing behind", async () => {
    const auth = await useEncryptedAuthState(dir, KEY);
    await auth.saveCreds();
    expect(readdirSync(dir).filter((f) => f.endsWith(".enc"))).not.toHaveLength(0);

    auth.clear();
    expect(readdirSync(dir).filter((f) => f.endsWith(".enc"))).toHaveLength(0);
  });
});
