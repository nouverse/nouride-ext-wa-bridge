#!/usr/bin/env bun
/**
 * WhatsApp bridge — the only process in this repo that links against Baileys.
 *
 * It exists because `@whiskeysockets/baileys` is GPL-3.0 and the engine is not. Nothing here is
 * imported by anything there: the entire interface is newline-delimited JSON on stdio, declared twice
 * by hand (`src/protocol.ts` here, `packages/shared/src/types/bridge.ts` there) with a version field
 * so a drift fails the handshake instead of surfacing as a mystery three hours later.
 *
 * Two things it is careful about:
 *
 * **The QR is emitted, never printed.** WhatsApp has no bot token — pairing is a phone scanning a
 * code — and the person holding the phone is not the person reading the server's stdout. So the code
 * goes up the protocol and the engine serves it to whoever is looking at the dashboard.
 *
 * **Credentials survive a restart, encrypted.** That is the whole point of the session directory: a
 * bridge that asks for a new scan on every boot is a bridge nobody will keep running. `auth.ts` holds
 * the reason it is encrypted rather than plain.
 */

import * as io from "./io.ts";
import { BridgeExit } from "./io.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { BRIDGE_PROTOCOL_VERSION, type BridgeCommand, type BridgeEvent } from "./protocol.ts";
import { useEncryptedAuthState, type EncryptedAuthState } from "./auth.ts";
import { cleanMentionText, extractMentions } from "./mentions.ts";

/**
 * The one field this bridge reads off whatever Baileys threw.
 *
 * A disconnect arrives as `lastDisconnect.error`, and Baileys puts the reason in
 * `output.statusCode` because it throws `@hapi/boom` errors. Typed structurally rather than by
 * importing `Boom`: this is the only property ever read, and the import was buying a *type* from
 * `@hapi/boom@10` while the object producing it comes from the `@hapi/boom@9` nested under Baileys.
 * The two agree on `statusCode` today, which is exactly the kind of thing that is fine until it is
 * not — and it cost this plugin a direct dependency, in a plugin whose point is having almost none.
 */
type DisconnectError = { output?: { statusCode?: number } };

/**
 * stdout belongs to the protocol, so nothing else may write to it.
 *
 * `libsignal-node`, deep inside Baileys, calls `console.log('Closing session:', …)` and dumps a whole
 * session record — straight into the middle of this process's JSON stream. The engine logged sixteen
 * "unparseable line from the bridge" warnings per occurrence, and a frame that happened to be split
 * by one of those writes would have been corrupted rather than merely noisy: an `ack` lost that way
 * is a reply that hangs for thirty seconds and is then dropped.
 *
 * Redirected rather than tolerated. A dependency cannot be asked not to print, and the protocol
 * cannot afford to share the channel.
 */
for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
  console[level] = (...args: unknown[]) => {
    try {
      process.stderr.write(
        `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
      );
    } catch {
      // A value that will not stringify is not worth crashing the bridge over.
    }
  };
}

function emit(event: BridgeEvent): void {
  io.write(JSON.stringify(event));
}

/**
 * Baileys' own logging, redirected to stderr.
 *
 * Not cosmetic. Baileys ships a pino logger that writes to **stdout** by default, and stdout here is
 * the protocol — its handshake dumps land in the middle of the JSON stream and the engine reads them
 * as garbage lines. Found by running the bridge for the first time: the very first connection
 * printed four pino objects before any protocol event.
 *
 * `silent` by default rather than off entirely, because a session that will not link is diagnosed
 * from exactly these lines. `NOURIDE_WA_LOG_LEVEL=debug` turns them on, on stderr, where the engine
 * already forwards them into the daemon log.
 */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function makeLogger(level: string) {
  const threshold = LOG_LEVELS.indexOf(level as LogLevel);
  const write = (at: LogLevel) => (a: unknown, b?: unknown) => {
    if (threshold < 0 || LOG_LEVELS.indexOf(at) < threshold) return;
    const message = typeof a === "string" ? a : (b ?? "");
    const detail = typeof a === "string" ? undefined : a;
    note(`baileys ${at}: ${String(message)}`, detail);
  };
  const logger = {
    level,
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
    child: () => logger,
  };
  return logger;
}

/** Logs go to stderr. stdout is the protocol, and one stray line there corrupts it. */
function note(message: string, detail?: unknown): void {
  process.stderr.write(
    `${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`,
  );
}

let sessionDirFromEnv = process.env.NOURIDE_WA_SESSION_DIR ?? "";
/**
 * Read from the environment, because that is how a spawned bridge is given it.
 *
 * `let`, not `const`, for the in-process host — which must not use the environment at all. Putting
 * the session key into the daemon's own `process.env` would hand it to every command the agent runs
 * through `exec`, since a child inherits the parent's environment. `configure()` passes it directly
 * instead, so it exists only in this module.
 */
let sessionKey = process.env.NOURIDE_WA_SESSION_KEY ?? "";

/**
 * Supply what the environment would have carried, for a bridge running inside another process.
 *
 * Only the in-process host calls this; standalone reads the environment as before. The session
 * directory still arrives over the protocol in `hello` and still wins over this — the engine holds
 * the config — so this is really about the key.
 */
export function configure(input: { sessionDir?: string; encryptionKey: string }): void {
  sessionKey = input.encryptionKey;
  if (input.sessionDir) sessionDirFromEnv = input.sessionDir;
}

let socket: WASocket | null = null;
let auth: EncryptedAuthState | null = null;
let sessionDir = "";
let mediaDir = "";
let handshakeDone = false;
let stopping = false;
/** Whether this socket has actually signed in. Sending before it has is what threw inside Baileys. */
let linked = false;

/**
 * Which socket's events still count.
 *
 * Baileys emits `connection.update` more than once per socket, and a reconnect used to *replace* the
 * module-level `socket` while leaving the old object's listeners registered — so a second `close`
 * from a socket already replaced started another connection. Sockets multiplied instead of being
 * swapped, each one holding a WhatsApp session and its own credentials writer.
 *
 * This took a live server down: memory exhausted to the point that sshd could not complete a banner
 * exchange. The generation counter is the fix — a listener that is not the current generation returns
 * immediately — and `teardown()` is the belt to its braces.
 */
let generation = 0;
let starting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

/** Capped exponential backoff. A close that fails instantly must not become a tight loop. */
const BACKOFF_MAX_MS = 30_000;

/** Where downloaded media lands, so the engine gets a path rather than bytes on the pipe. */
function ensureMediaDir(): string {
  const dir = join(sessionDir, "media");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Drop the current socket and everything listening to it. */
function teardown(): void {
  const old = socket;
  socket = null;
  if (!old) return;
  try {
    old.ev.removeAllListeners("connection.update");
    old.ev.removeAllListeners("creds.update");
    old.ev.removeAllListeners("messages.upsert");
  } catch {
    // Older Baileys builds expose this differently; ending the socket is what actually matters.
  }
  try {
    old.end(undefined);
  } catch {
    // Already gone.
  }
}

/** After this many failures in a row, it stops being transient and the engine should know. */
const GIVE_UP_AFTER = 8;

function scheduleReconnect(reason: string): void {
  if (stopping || reconnectTimer) return;

  if (attempt >= GIVE_UP_AFTER) {
    // Said once, and then this process stays put rather than spinning. The engine's own reconnect
    // takes over from here — which is correct, because respawning is the thing this process cannot
    // do for itself.
    note("giving up", { attempts: attempt, reason });
    emit({ type: "status", status: "disconnected", reason: `gave up after ${attempt} attempts` });
    return;
  }

  const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt);
  attempt += 1;
  note("reconnecting", { in_ms: delay, attempt, reason });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void start().catch((err) => {
      note("reconnect failed", String(err));
      emit({ type: "status", status: "disconnected", reason: String(err) });
      scheduleReconnect("start threw");
    });
  }, delay);
}

async function start(): Promise<void> {
  // Two closes arriving together used to mean two sockets. One at a time, always.
  if (stopping || starting) return;
  starting = true;
  const mine = ++generation;

  try {
    teardown();

    // Opened once and reused. A fresh auth state per reconnect would give two live sockets two
    // different credential objects writing the same files — which corrupts the session rather than
    // merely wasting work.
    if (!auth) auth = await useEncryptedAuthState(sessionDir, sessionKey);
    mediaDir = ensureMediaDir();

    const { version } = await fetchLatestBaileysVersion();
    note("connecting", { version, generation: mine });

    socket = makeWASocket({
      version,
      auth: auth.state,
      // See makeLogger: without this, Baileys writes pino JSON to stdout and corrupts the protocol.
      // `warn` by default, matching the reference implementations. Silent was a mistake: the one thing
      // that would have explained a message accepted and never delivered is Baileys' own warning, and
      // it was being thrown away. `NOURIDE_WA_LOG_LEVEL=debug` turns it all the way up.
      logger: makeLogger(process.env.NOURIDE_WA_LOG_LEVEL ?? "warn") as never,
      // We forward it instead. Printing to stdout would corrupt the protocol stream, and printing to
      // a terminal nobody is watching is why this field exists at all.
      printQRInTerminal: false,
      // Named, so the entry under Linked devices on the phone says what it is rather than "Ubuntu".
      browser: ["Nouride", "Chrome", "120.0"],
      // Left offline on purpose: an account marked online stops delivering push notifications to the
      // phone that owns it.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      /**
       * Required on Baileys 7.
       *
       * When a sender's E2EE session needs re-establishing, WhatsApp asks for the original message
       * to complete a retry handshake. With no `getMessage` the decrypt fails, `msg.message` arrives
       * as null, and the message is **dropped without a trace** — which is exactly the class of
       * silent loss this bridge has already cost a day to. We keep no message store, and an empty
       * placeholder is enough for the handshake.
       */
      getMessage: async () => ({ conversation: "" }),
    });

    socket.ev.on("creds.update", () => {
      if (mine !== generation) return;
      void auth?.saveCreds();
    });

    socket.ev.on("connection.update", (update) => {
      // A socket that has been replaced still holds this listener and still emits. Acting on it is
      // what multiplied connections until a live server ran out of memory.
      if (mine !== generation) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) emit({ type: "qr", qr });
      if (connection === "connecting") emit({ type: "status", status: "connecting" });

      if (connection === "open") {
        attempt = 0;
        linked = true;
        emit({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: socket?.user?.id ?? "" });
        emit({ type: "status", status: "connected" });
        return;
      }

      if (connection !== "close") return;
      linked = false;

      const status = (lastDisconnect?.error as DisconnectError | undefined)?.output?.statusCode;

      // `loggedOut` is the one that is not a network problem: the phone unlinked this device, and the
      // stored credentials are now worthless. Reconnecting with them loops forever, so the session is
      // dropped and the engine is told to expect a fresh scan.
      /**
       * `loggedOut` (401) stops this process — it does **not** delete the session.
       *
       * It used to. That cost a working link: WhatsApp sent one 401 twenty-six seconds after a
       * successful pairing, the credentials were wiped on the spot, the next connect started from
       * nothing, and the reply the person was waiting for died with
       * `authState.creds.me.id is undefined` because the socket was no longer signed in. A single
       * ambiguous signal must not be answered by destroying the only copy of something.
       *
       * So: say so, stop retrying, and leave the files. If the account really was unlinked the next
       * start says 401 again and stops again — noisy, not destructive. Deleting is what the explicit
       * `logout` command is for, and what removing the gateway now does.
       */
      if (status === DisconnectReason.loggedOut) {
        teardown();
        linked = false;
        emit({ type: "session_expired" });
        emit({ type: "status", status: "disconnected", reason: "logged out" });
        return;
      }

      if (stopping) {
        emit({ type: "status", status: "disconnected", reason: "shutting down" });
        return;
      }

      /**
       * `connecting`, not `disconnected` — this bridge is about to fix it itself.
       *
       * Reporting `disconnected` made the engine start its own recovery: tear the gateway down and
       * spawn a replacement bridge. Both layers then retried the same transient close, and since the
       * engine's reconnect did not kill the process it was replacing, every cycle left one more live
       * bridge behind.
       *
       * The division of labour is: a close this process can recover from is this process's problem
       * and stays invisible above; `disconnected` means it has genuinely given up, and only then
       * should anything above act.
       */
      emit({
        type: "status",
        status: "connecting",
        reason: lastDisconnect?.error ? String(lastDisconnect.error) : "connection closed",
      });

      /**
       * `restartRequired` (515) is normal, and it is the one that bites.
       *
       * WhatsApp sends it immediately after a successful pairing: the socket that carried the scan
       * has to be replaced before anything else works. So the very first thing a freshly linked
       * bridge does is reconnect — which was exactly the path that multiplied sockets. That is why
       * this survived every test and did not survive ten minutes after somebody scanned.
       */
      teardown();
      scheduleReconnect(
        status === DisconnectReason.restartRequired
          ? "restart required after pairing"
          : String(status ?? "closed"),
      );
    });

    /**
     * A message the server took and then rejected.
     *
     * Baileys reports this through `messages.update` with `status: ERROR` and the platform's code in
     * `messageStubParameters` — the documented path, rather than the warning it also logs. Forwarded
     * up because nothing above could otherwise tell a delivered message from a refused one: the send
     * resolved, the ack came back, and the reply simply never appeared.
     *
     * `463` is the one that matters in practice: WhatsApp refusing to let a restricted account start
     * a new chat. Baileys' own note is explicit that retrying "counts as another reach out and worsens
     * the restriction", which is why this is reported rather than retried.
     */
    socket.ev.on("messages.update", (updates) => {
      if (mine !== generation) return;
      for (const entry of updates) {
        const status = entry.update?.status;
        if (status !== proto.WebMessageInfo.Status.ERROR) continue;
        const code = String(entry.update?.messageStubParameters?.[0] ?? "unknown");
        emit({
          type: "delivery_refused",
          chatId: entry.key?.remoteJid ?? "",
          messageId: entry.key?.id ?? "",
          code,
        });
        note("delivery refused", { chatId: entry.key?.remoteJid, code });
      }
    });

    socket.ev.on("messages.upsert", (upsert) => {
      if (mine !== generation) return;
      if (upsert.type !== "notify") return;
      void Promise.all(
        upsert.messages.map((message) =>
          forward(message).catch((err) => note("could not forward a message", String(err))),
        ),
      );
    });
  } finally {
    starting = false;
  }
}

/**
 * The phone number behind a LID, from the session store.
 *
 * WhatsApp now addresses many conversations by **LID** (`267199126233213@lid`) instead of by phone
 * number. Baileys 7 learns the mapping and writes it into the auth store as
 * `lid-mapping-<lid>_reverse` — and then does not use it when addressing an outgoing message. A
 * reply sent to the bare LID is accepted by `sendMessage`, returns a message key, throws nothing,
 * and is never delivered.
 *
 * That cost a day of "it says it sent but nothing arrives", with clean logs on both sides. Both
 * reference implementations resolve the mapping themselves for the same reason.
 *
 * Returns null when there is no mapping yet, and the caller sends to the LID as before — which is
 * the best that can be done and is at least no worse than not trying.
 */
function phoneForLid(lid: string): string | null {
  const bare = lid.replace(/@.*$/, "").replace(/:\d+$/, "");
  const raw = auth?.read<unknown>(`lid-mapping-${bare}_reverse`);
  if (raw === null || raw === undefined) return null;
  // Baileys has stored this as a bare string and as a wrapped object across versions.
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number"
        ? String(raw)
        : typeof (raw as { pn?: unknown }).pn === "string"
          ? (raw as { pn: string }).pn
          : null;
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

/**
 * The address a message should be sent to: the one it arrived on.
 *
 * An earlier version resolved `…@lid` to `…@s.whatsapp.net` through the stored mapping, on the
 * reasoning that a phone JID is the "real" address. That was wrong and made things worse. A libsignal
 * session is keyed by *address*, and the session WhatsApp established for this conversation is the
 * LID one — sending to the phone JID reaches for a different session, and libsignal answered by
 * closing the one that worked (`Closing session: SessionEntry {…}` in the log, at exactly that send).
 *
 * Both reference implementations send to the incoming address for this reason. One of them keeps a
 * LID→phone map and never consults it when sending, which is the same conclusion reached the same way.
 *
 * `phoneForLid` is kept because knowing the number behind a LID is genuinely useful — for identity and
 * for allowlists — just not for addressing.
 */
function sendTarget(chatId: string): { to: string; resolved: boolean } {
  return { to: chatId, resolved: false };
}

/**
 * A send that cannot hang forever.
 *
 * Baileys occasionally never settles — most often uploading media, less often on plain text — and a
 * bridge whose command loop is awaiting it stops answering entirely. Both reference implementations
 * wrap every send in a timeout for exactly this reason; failing loudly at sixty seconds is what lets
 * the engine buffer and retry instead of the whole gateway going quiet.
 */
const SEND_TIMEOUT_MS = Number(process.env.NOURIDE_WA_SEND_TIMEOUT_MS ?? 60_000);

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${SEND_TIMEOUT_MS / 1000}s`)),
      SEND_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** WhatsApp refuses anything longer, and a reply from a model routinely exceeds it. */
const MAX_MESSAGE_LENGTH = 4096;
/** Between chunks, so a split reply arrives in order rather than interleaved. */
const CHUNK_DELAY_MS = 300;

function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Prefer a paragraph break, then a line, then a space. Cutting mid-word is the last resort.
    const window = rest.slice(0, max);
    const boundary = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = boundary > max * 0.5 ? boundary : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function textOf(message: WAMessage): string {
  const content = message.message;
  if (!content) return "";
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ""
  );
}

/**
 * `contextInfo`, wherever it happens to live.
 *
 * It is attached to the content type rather than to the message, so a fixed path finds it for plain
 * text and misses it on an image with a caption — which is the case where a group tag matters most.
 */
function contextInfoOf(message: WAMessage): {
  mentionedJid?: (string | null)[] | null;
  stanzaId?: string | null;
  participant?: string | null;
  quotedMessage?: unknown;
} | null {
  const content = message.message;
  if (!content) return null;
  for (const value of Object.values(content)) {
    if (value && typeof value === "object" && "contextInfo" in value) {
      const info = (value as { contextInfo?: unknown }).contextInfo;
      if (info && typeof info === "object") return info as ReturnType<typeof contextInfoOf>;
    }
  }
  return null;
}

/** The readable text of any message content — used for the quoted message a tag refers to. */
function textOfContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, { text?: string; caption?: string; fileName?: string }> & {
    conversation?: string;
  };
  return (
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.videoMessage?.caption ??
    c.documentMessage?.caption ??
    // A document with no caption still says something: its name is the only text there is.
    (c.documentMessage?.fileName ? `[document: ${c.documentMessage.fileName}]` : "")
  );
}

function mediaKind(message: WAMessage): { kind: string; mimeType: string } | null {
  const content = message.message;
  if (!content) return null;
  if (content.imageMessage) {
    return { kind: "image", mimeType: content.imageMessage.mimetype ?? "image/jpeg" };
  }
  if (content.videoMessage) {
    return { kind: "video", mimeType: content.videoMessage.mimetype ?? "video/mp4" };
  }
  if (content.audioMessage) {
    return { kind: "audio", mimeType: content.audioMessage.mimetype ?? "audio/ogg" };
  }
  if (content.documentMessage) {
    return {
      kind: "file",
      mimeType: content.documentMessage.mimetype ?? "application/octet-stream",
    };
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
};

async function forward(message: WAMessage): Promise<void> {
  // Our own messages come back on this event; answering them is how loops start.
  if (message.key.fromMe) return;

  const remoteJid = message.key.remoteJid;
  if (!remoteJid || remoteJid === "status@broadcast") return;

  const text = textOf(message);
  const media = mediaKind(message);
  if (!text.trim() && !media) return;

  const group = isJidGroup(remoteJid) ?? false;
  // In a group the sender is `participant`; in a DM the chat *is* the sender. Getting this wrong
  // makes every member of a group share one identity, which is the thing the people table exists to
  // tell apart.
  const senderId = (group ? message.key.participant : remoteJid) ?? remoteJid;

  let mediaField: { path: string; mimeType: string; kind: string; caption?: string } | undefined;
  if (media) {
    try {
      const bytes = (await downloadMediaMessage(message, "buffer", {})) as Buffer;
      const extension = EXTENSIONS[media.mimeType] ?? "bin";
      const path = join(mediaDir, `${randomUUID()}.${extension}`);
      writeFileSync(path, bytes, { mode: 0o600 });
      mediaField = {
        path,
        mimeType: media.mimeType,
        kind: media.kind,
        ...(text.trim() ? { caption: text } : {}),
      };
    } catch (err) {
      // The text still goes through. Losing a photo is better than losing the message that came with
      // it, and the sender gets an answer either way.
      note("media download failed", String(err));
    }
  }

  /**
   * Who was addressed, and what they were addressing.
   *
   * `contextInfo` hangs off whichever content type the message happens to be, so it is searched for
   * rather than read from a fixed path. Both matter in a group: `mentionedJid` is how "answer only
   * when tagged" is decided at all, and the quoted text is the context a tag usually refers to —
   * "@bot what about this?" is meaningless without the message it points at.
   */
  const context = contextInfoOf(message);
  const mentions = (context?.mentionedJid ?? []).filter(Boolean) as string[];
  const quotedText = textOfContent(context?.quotedMessage ?? null);

  // Both of our own addresses. WhatsApp addresses the same account by phone JID and by LID depending
  // on the conversation, and a mention check that knows only one of them misses half the tags.
  const selfIds = [socket?.user?.id, (socket?.user as { lid?: string } | undefined)?.lid]
    .filter((id): id is string => Boolean(id))
    .map((id) => id.replace(/:\d+@/, "@"));

  emit({
    type: "message",
    id: message.key.id ?? randomUUID(),
    chatId: remoteJid,
    chatType: group ? "group" : "dm",
    senderId,
    senderName: message.pushName ?? "unknown",
    text,
    timestamp: Number(message.messageTimestamp ?? 0) * 1000,
    ...(context?.stanzaId ? { replyTo: context.stanzaId } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(quotedText ? { quotedText } : {}),
    ...(context?.participant ? { quotedSender: context.participant } : {}),
    ...(selfIds.length > 0 ? { selfIds } : {}),
    ...(mediaField ? { media: mediaField } : {}),
  });
}

async function handle(command: BridgeCommand): Promise<void> {
  if (command.type === "hello") {
    if (command.version !== BRIDGE_PROTOCOL_VERSION) {
      emit({
        type: "error",
        message: `protocol version mismatch: engine ${command.version}, bridge ${BRIDGE_PROTOCOL_VERSION}`,
      });
      io.exit(1);
    }
    handshakeDone = true;

    // The engine's value wins over the environment: the environment is how the key arrives, but the
    // directory is a config setting and the engine is the one holding the config.
    sessionDir = command.sessionDir || sessionDirFromEnv;
    if (!sessionDir) {
      emit({ type: "error", message: "no session directory was given" });
      io.exit(1);
    }
    if (!sessionKey) {
      emit({
        type: "error",
        message: "NOURIDE_WA_SESSION_KEY is not set — refusing to write an unencrypted session",
      });
      io.exit(1);
    }

    try {
      await start();
    } catch (err) {
      emit({ type: "status", status: "disconnected", reason: String(err) });
      note("start failed", String(err));
    }
    return;
  }

  if (command.type === "shutdown") {
    stopping = true;
    // The timer first: a reconnect firing between here and `exit` would open a socket nobody owns,
    // and the process that owned it is already on its way out.
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    teardown();
    io.exit(0);
  }

  if (!handshakeDone) {
    emit({ type: "error", message: "no hello received" });
    return;
  }

  /**
   * Not connected, and not *signed in*, are different failures.
   *
   * A socket exists from the moment it is created; `creds.me` only exists once WhatsApp has accepted
   * the login. Sending in between threw `undefined is not an object (evaluating
   * 'authState.creds.me.id')` from inside Baileys — an error nobody could act on, attached to a
   * message that was then dropped. Said in words instead, so the engine can buffer and retry rather
   * than treat it as a broken socket.
   */
  if (!socket || !linked) {
    emit({
      type: "error",
      ...("id" in command ? { id: command.id } : {}),
      message: socket
        ? "not linked yet — this number has not finished signing in to WhatsApp"
        : "not connected to WhatsApp",
    });
    return;
  }

  try {
    switch (command.type) {
      case "send": {
        /**
         * Chunked, timed out, and logged.
         *
         * `sendMessage` resolving is not delivery — it returns the message it built, and one built
         * for an address whose session cannot be established is accepted and then goes nowhere. That
         * failure left no trace on either side, which is how a person ended up staring at a chat that
         * never answered while every log said everything was fine. The returned key is the only
         * evidence that separates "sent" from "accepted and lost".
         */
        const target = sendTarget(command.chatId);
        const chunks = splitMessage(command.text);
        const mentions = extractMentions(command.text, command.mentions);
        let sent: Awaited<ReturnType<typeof socket.sendMessage>> | undefined;
        for (const [index, chunk] of chunks.entries()) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
          const payload: Parameters<typeof socket.sendMessage>[1] = {
            text: cleanMentionText(chunk),
            ...(mentions.length > 0 ? { mentions } : {}),
          };
          sent = await withTimeout(socket.sendMessage(target.to, payload), "sendMessage");
        }
        note("sent", {
          chatId: command.chatId,
          to: target.to,
          isLid: isLidUser(command.chatId) ?? false,
          phoneBehindLid: isLidUser(command.chatId) ? phoneForLid(command.chatId) : null,
          chunks: chunks.length,
          mentions: mentions.length,
          id: sent?.key?.id ?? null,
        });
        // Clears the typing bubble the turn raised. Without it WhatsApp leaves "typing…" up until it
        // times out on its own, which reads as a second reply still coming.
        void socket.sendPresenceUpdate("paused", target.to).catch(() => {});
        emit({ type: "ack", id: command.id });
        return;
      }

      case "send_media": {
        const kind = command.mimeType.split("/")[0];
        const mentions = extractMentions(command.caption ?? "", command.mentions);
        const caption = command.caption ? cleanMentionText(command.caption) : undefined;
        const fileBuffer = readFileSync(command.path);
        const content =
          kind === "image"
            ? { image: fileBuffer, caption }
            : kind === "video"
              ? { video: fileBuffer, caption }
              : kind === "audio"
                ? {
                    audio: fileBuffer,
                    mimetype: command.mimeType,
                    /**
                     * Push-to-talk. The single field that separates a voice note from an audio file.
                     *
                     * Without it WhatsApp shows a file row with a play button; with it, the round
                     * voice bubble with the waveform. The engine says which was meant — the mime type
                     * cannot, since both are `audio/ogg`.
                     */
                    ...(command.voice ? { ptt: true } : {}),
                  }
                : {
                    document: fileBuffer,
                    mimetype: command.mimeType,
                    fileName: command.path.split("/").pop() ?? "file",
                    caption,
                  };
        const payload = {
          ...content,
          ...(mentions.length > 0 ? { mentions } : {}),
        };
        await withTimeout(socket.sendMessage(sendTarget(command.chatId).to, payload as never), "sendMedia");
        emit({ type: "ack", id: command.id });
        return;
      }

      /**
       * Blue ticks, and only once the message has been taken seriously.
       *
       * Sent by the engine *after* it accepts a message, not on arrival: marking a stranger's message
       * read in `pair` mode would tell them they had been seen by someone who is in fact ignoring
       * them. Read means read.
       */
      case "read":
        await socket.readMessages([
          {
            remoteJid: command.chatId,
            id: command.messageId,
            fromMe: false,
            ...(command.participant ? { participant: command.participant } : {}),
          },
        ]);
        return;

      case "typing":
        // Plain `composing`, which is what the two working implementations send. An earlier version
        // asserted `available` first on the theory that WhatsApp ignores presence from an offline
        // client; neither reference does that, and theirs show typing.
        await socket.sendPresenceUpdate("composing", sendTarget(command.chatId).to);
        return;

      case "logout":
        // The one path that deletes: an explicit instruction, not an inferred one.
        stopping = true;
        await socket.logout();
        teardown();
        auth?.clear();
        auth = null;
        linked = false;
        emit({ type: "session_expired" });
        return;
    }
  } catch (err) {
    emit({
      type: "error",
      ...("id" in command ? { id: command.id } : {}),
      message: String(err),
    });
  }
}

/**
 * Feed one protocol line in. The engine's in-process host calls this; `main.ts` calls it per line
 * read from stdin.
 *
 * Commands are handled one at a time by the caller, and that is load-bearing: `send` awaits the
 * network, and processing the next line concurrently would let two replies to the same chat race
 * into the wrong order.
 */
export async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    await handle(JSON.parse(trimmed) as BridgeCommand);
  } catch (err) {
    if (err instanceof BridgeExit) throw err;
    emit({ type: "error", message: `malformed command: ${String(err)}` });
  }
}

/**
 * Tear the connection down without ending the host.
 *
 * Only the in-process host needs this: standalone, the process going away is the teardown. Here the
 * daemon may drop a WhatsApp gateway and keep running, and a socket left open would fight the next
 * bridge for the same credentials — the same reason `stdin`'s `end` handler exists in `main.ts`.
 */
export function stopBridge(): void {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  teardown();
}
