/**
 * Baileys credentials, encrypted at rest.
 *
 * `useMultiFileAuthState` writes the session as plain JSON, and that session is a *login* — anyone
 * who copies the directory is signed in as this WhatsApp account, on their own machine, with no
 * further prompt. On a server that directory sits next to everything else being backed up, which is
 * how a backup becomes a credential leak (§17.1 item 6).
 *
 * So this implements the same `AuthenticationState` contract Baileys expects, with every file
 * AES-256-GCM'd under a key the engine supplies through the environment. The key never touches the
 * wire protocol and never goes in the config file — the config holds its *name*, like every other
 * credential here.
 *
 * The layout is deliberately the same as the stock one: one file per key, so a re-key or a manual
 * recovery is a file-by-file job rather than one giant blob that fails as a unit.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 64 hex characters — the same 32 bytes AES-256 wants, checked here rather than truncated silently. */
export function parseKey(hex: string): Buffer {
  const cleaned = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error(
      "the WhatsApp session key must be 64 hex characters (32 bytes) — generate one with `openssl rand -hex 32`",
    );
  }
  return Buffer.from(cleaned, "hex");
}

function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // iv | tag | ciphertext — fixed-width prefixes, so reading back needs no framing format.
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, blob: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error("session file is truncated");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // Throws on a wrong key or a tampered file rather than returning plausible garbage — which is the
  // whole reason for GCM over CBC here.
  return Buffer.concat([
    decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

/** `session-abc.json` — the id is not ours and may contain anything, so it is not a path component. */
function fileFor(dir: string, name: string): string {
  return join(dir, `${name.replace(/[^0-9A-Za-z._-]/g, "_")}.enc`);
}

export interface EncryptedAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Drops every credential. Used when WhatsApp says this session is finished. */
  clear: () => void;
  /**
   * Read one stored entry by name, decrypted.
   *
   * Exists for the LID mapping. Baileys writes `lid-mapping-<lid>_reverse` into the same store as
   * everything else and then never consults it when addressing an outgoing message — so the caller
   * has to. See `phoneForLid` in index.ts for why that matters.
   */
  read: <T>(name: string) => T | null;
}

export async function useEncryptedAuthState(
  dir: string,
  keyHex: string,
): Promise<EncryptedAuthState> {
  const key = parseKey(keyHex);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const readData = <T>(name: string): T | null => {
    try {
      const blob = readFileSync(fileFor(dir, name));
      return JSON.parse(decrypt(key, blob), BufferJSON.reviver) as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      // A key change or a corrupt file is worth saying out loud. Returning null would look like a
      // fresh install and silently ask for a new QR scan, hiding the real cause.
      process.stderr.write(`session file ${name} unreadable: ${String(err)}\n`);
      return null;
    }
  };

  const writeData = (name: string, value: unknown): void => {
    const path = fileFor(dir, name);
    const tmp = `${path}.tmp`;
    // Written aside and renamed: a crash mid-write must not leave a half-file where the credentials
    // were, because that is unrecoverable without another QR scan.
    writeFileSync(tmp, encrypt(key, JSON.stringify(value, BufferJSON.replacer)), { mode: 0o600 });
    renameSync(tmp, path);
  };

  const creds: AuthenticationCreds = readData<AuthenticationCreds>("creds") ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          for (const id of ids) {
            let value = readData<SignalDataTypeMap[typeof type]>(`${type}-${id}`);
            // Baileys stores this one as a protobuf and expects it back as one.
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              ) as unknown as SignalDataTypeMap[typeof type];
            }
            if (value) out[id] = value;
          }
          return Promise.resolve(out);
        },
        set: (data) => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              const name = `${type}-${id}`;
              if (value) writeData(name, value);
              else rmSync(fileFor(dir, name), { force: true });
            }
          }
          return Promise.resolve();
        },
      },
    },
    saveCreds: async () => {
      writeData("creds", creds);
    },
    clear: () => {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".enc")) rmSync(join(dir, entry), { force: true });
      }
    },
    read: <T,>(name: string) => readData<T>(name),
  };
}
