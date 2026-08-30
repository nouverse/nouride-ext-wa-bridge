# wa-bridge

The WhatsApp connection, in its own process.

`@whiskeysockets/baileys` is GPL-3.0. This directory is deliberately **not** a member of the root
workspace, carries its own lockfile, and shares no code with the rest of the repo — not even
`@nouride/shared`. The entire interface is newline-delimited JSON on stdio (or a WebSocket), declared
twice by hand: `src/protocol.ts` here, `packages/shared/src/types/bridge.ts` there. The duplication
is the point; the `hello` handshake carries a version so a drift is a rejected connection rather
than a mystery at runtime.

## Install

Not installed by default. Nothing else in the repo needs it, and the root test suite passes without
it — these tests skip themselves with a warning.

```sh
cd plugins/wa-bridge
bun install
bun test          # session round-trip and at-rest encryption
```

## Build

It ships as a **compiled executable** with the Bun runtime inside it, so a server running the bridge
needs no Bun installed. `build:binary` stages one into the release tarball automatically; build one
on its own with:

```sh
bun run build:wa-bridge                       # → dist/wa-bridge/wa-bridge
bun run build:wa-bridge --target linux-x64    # → dist/wa-bridge-linux-x64.tar.gz
```

The target matters, and it did not when this was a JavaScript bundle: a binary built for the wrong
architecture or libc fails with `Exec format error` at the first connection. `scripts/build-wa-bridge.ts`
carries the rest — why four of Baileys' peers are deliberately left out, and what compiling them in
would break.

## Running

The engine spawns it and speaks the protocol; you should not need to run it by hand. To watch a
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
prints for humans goes through `note()`.

**The session is a login.** Copying `sessionDir` to another machine signs that machine in as this
WhatsApp account. `src/auth.ts` therefore implements Baileys' `AuthenticationState` over AES-256-GCM
files instead of `useMultiFileAuthState`, which stores plain JSON. Lose the key and you scan again;
leak the key *and* the directory and you have leaked the account.

## Runtime

Runs under Bun or Node — `process.stdin`, not `Bun.stdin`. That is not tidiness: Baileys leans on
Node's crypto and stream APIs, and Bun logs warnings about unimplemented `ws` events. Bun works
today; if a WhatsApp connection misbehaves in a way the engine does not, try Node before suspecting
the protocol.
