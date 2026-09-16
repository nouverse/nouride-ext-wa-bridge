# wa-bridge

The WhatsApp connection, as its own module.

Deliberately **not** a member of the root workspace. It carries its own lockfile — a 268-package tree
that never lands in the engine's `node_modules` — and shares no code with the rest of the repo, not
even `@nouride/shared`. The entire interface is newline-delimited JSON, declared twice by hand:
`src/protocol.ts` here, `packages/shared/src/types/bridge.ts` there. The duplication is the point;
the `hello` handshake carries a version so a drift is a rejected connection rather than a mystery at
runtime.

Every Nouride edition compiles this into the daemon. There is no second executable and nothing to
spawn — `bridge_transport` left unset means in-process, and `ws` reaches a bridge running somewhere
else. A third transport, `stdio`, spawned an executable the tarball used to ship beside the daemon;
it was removed on 2026-09-16, and a config still naming it is read as `inproc` with a warning.

## `libsignal` is detached from Baileys

The reason this matters: a binary that links GPL-3.0 code is a combined work, and Nouride ships
closed-source binaries.

`@whiskeysockets/baileys` is **MIT**. It depended on
[`libsignal`](https://www.npmjs.com/package/libsignal), which is **GPL-3.0**, and that was the only
copyleft code in the tree. `shims/libsignal/` replaces it, and `overrides` in `package.json` is what
makes the replacement reach Baileys' own copy:

```json
"overrides": { "libsignal": "file:./shims/libsignal" }
```

A plain dependency alias does **not** work — Baileys depends on `libsignal` itself, so bun installs a
second copy under `@whiskeysockets/baileys/node_modules` and a root alias never reaches it. That was
the first attempt, and the end-to-end test passed against the real package the whole time.

The shim forwards to [`whatsapp-rust-bridge`](https://www.npmjs.com/package/whatsapp-rust-bridge) —
MIT, published by the Baileys organisation, already a dependency of Baileys and already used by its
utility layer. Baileys itself is unmodified: it imports the package in four places, three of them
deep imports, and all four resolve here.

| file | what it does |
|---|---|
| `shims/libsignal/index.js` | the four Signal classes, plus the adapter below |
| `shims/libsignal/src/curve.js` | four curve primitives, forwarded unchanged |
| `shims/libsignal/src/crypto.js` | AES-256-CBC, HMAC-SHA256, SHA-512, three-chunk HKDF, against `node:crypto` — the bridge does not export these |
| `shims/libsignal/src/protobufs.js` | the one optional field Baileys decodes, by hand |

**The adapter is the interesting part.** Two storage contracts disagree, and both were found by a
live box rather than by reading:

- `loadSession` — Baileys answers with a record; the bridge asks for bytes.
- `loadSignedPreKey` — Baileys answers with a bare `{privKey, pubKey}`; the bridge wants
  `{keyId, keyPair, signature}` and refuses without it. The signature is **recomputed** the way
  Baileys made it, `sign(identityPrivate, prefixed(preKeyPublic))` — not invented.

And one error is translated: the bridge says `SessionNotFound(...)` where Baileys matches the literal
text `'No session record'` to decide a decrypt failure is recoverable. Without the translation it
never sends a retry receipt, the phone never re-sends as `pkmsg`, and every inbound message fails
identically with nothing in the log saying why.

**Editing the shim needs `bun install`.** `file:` *copies* the directory rather than linking it, so a
stale copy will be bundled while the source looks right. `tests/libsignal-shim.test.ts` imports it by
**package name** for exactly this reason — a stale copy is a red suite instead of a silent wrong
binary.

A session written before this change cannot be read, and `src/auth.ts` drops one on read so it looks
absent rather than empty. The ratchet re-negotiates on the next message; pairing is untouched,
because `creds` is a separate file.

This is a stopgap. [WhiskeySockets/Baileys#2067](https://github.com/WhiskeySockets/Baileys/pull/2067)
does the same migration upstream and keeps the old on-disk format, so nothing re-negotiates — drop
the shim when it lands.

## Install

A submodule, so a fresh clone has an empty directory until `git submodule update --init
plugins/wa-bridge`. The root test suite passes without it — these tests skip themselves with a
warning, because a clone that has nothing to do with WhatsApp should not be a clone that cannot run
the suite.

```sh
cd plugins/wa-bridge
bun install
bun test          # session round-trip, at-rest encryption, and the libsignal shim
```

## Build

Nothing stages this beside the daemon any more — every edition compiles it in. What this builds is a
bridge that runs **somewhere else**, reached with `bridge_transport = "ws"`: its own container, its
own host. It is a compiled executable with the Bun runtime inside it, so that host needs no Bun.

```sh
bun run build:wa-bridge                       # → dist/wa-bridge/wa-bridge
bun run build:wa-bridge --target linux-x64    # → dist/wa-bridge-linux-x64.tar.gz
```

The target matters, and it did not when this was a JavaScript bundle: a binary built for the wrong
architecture or libc fails with `Exec format error` at the first connection. `scripts/build-wa-bridge.ts`
carries the rest — why four of Baileys' peers are deliberately left out, and what compiling them in
would break.

## Running

The engine hosts it and speaks the protocol; you should not need to run it by hand. To watch a
pairing code without the daemon (`version` must match `BRIDGE_PROTOCOL_VERSION` in `src/protocol.ts`,
or the bridge rejects the handshake and says so):

```sh
NOURIDE_WA_SESSION_KEY=$(openssl rand -hex 32) \
  sh -c 'echo "{\"type\":\"hello\",\"version\":3,\"sessionDir\":\"/tmp/wa\"}"; sleep 30' \
  | bun run src/index.ts
```

| Variable | Meaning |
|---|---|
| `NOURIDE_WA_SESSION_KEY` | 64 hex characters. Required — the bridge refuses to write an unencrypted session. |
| `NOURIDE_WA_SESSION_DIR` | Fallback session directory; the engine's `hello` wins. |
| `NOURIDE_WA_LOG_LEVEL` | Baileys' own logging, on stderr. `silent` by default. |

## Two things that are easy to get wrong

**stdout is the protocol.** Baileys' pino logger writes there by default, and its handshake dump
lands in the middle of the JSON stream. `makeLogger` redirects it to stderr; anything this process
prints for humans goes through `note()`. Still true in-process: stdout there belongs to whatever
launched the daemon, which is a worse place to corrupt.

**The session is a login.** Copying `sessionDir` to another machine signs that machine in as this
WhatsApp account. `src/auth.ts` therefore implements Baileys' `AuthenticationState` over AES-256-GCM
files instead of `useMultiFileAuthState`, which stores plain JSON. Lose the key and you scan again;
leak the key *and* the directory and you have leaked the account.

## Runtime

Runs under Bun or Node — `process.stdin`, not `Bun.stdin`. That is not tidiness: Baileys leans on
Node's crypto and stream APIs, and Bun logs warnings about unimplemented `ws` events. Bun works
today; if a WhatsApp connection misbehaves in a way the engine does not, try Node before suspecting
the protocol.
