/**
 * Wire protocol — a hand-maintained copy of
 * `packages/shared/src/types/bridge.ts`.
 *
 * Do NOT replace this with an import from `@nouride/shared`. This process links
 * against GPL-3.0 code and sharing a module with the engine is precisely the link
 * the separation exists to avoid. Keep the two files in step by hand; the `hello`
 * handshake checks the version so a drift fails loudly.
 */

export const BRIDGE_PROTOCOL_VERSION = 3;

export type BridgeCommand =
  | { type: "hello"; version: number; sessionDir: string }
  | { type: "send"; id: string; chatId: string; text: string; replyTo?: string; mentions?: string[] }
  | { type: "send_media"; id: string; chatId: string; path: string; mimeType: string; caption?: string; mentions?: string[] }
  | { type: "typing"; chatId: string }
  /** Mark an inbound message read — sent only once the engine has accepted it. */
  | { type: "read"; chatId: string; messageId: string; participant?: string }
  | { type: "logout" }
  | { type: "shutdown" };

export type BridgeEvent =
  | { type: "ready"; version: number; jid: string }
  | { type: "qr"; qr: string }
  | { type: "status"; status: "connecting" | "connected" | "disconnected"; reason?: string }
  | { type: "session_expired" }
  | {
      type: "message";
      id: string;
      chatId: string;
      chatType: "dm" | "group";
      senderId: string;
      senderName: string;
      text: string;
      timestamp: number;
      replyTo?: string;
      /** Ids this message addressed, so a group bot can answer only when it was tagged. */
      mentions?: string[];
      /** The text of the message being replied to — the context a tag in a group refers to. */
      quotedText?: string;
      /** Who wrote the quoted message. */
      quotedSender?: string;
      /** Our own address on this account, so the engine can tell whether the mention was for us. */
      selfIds?: string[];
      media?: { path: string; mimeType: string; kind: string; caption?: string };
    }
  | { type: "ack"; id: string }
  /**
   * WhatsApp took the message and then refused it.
   *
   * Separate from `error`, which is a command that failed. This one arrives *after* a successful
   * send: `sendMessage` returned a key, the ack came back, and the server rejected it afterwards.
   * Nothing above could tell the difference, which is how it stayed silent.
   */
  | { type: "delivery_refused"; chatId: string; messageId: string; code: string }
  | { type: "error"; id?: string; message: string };
