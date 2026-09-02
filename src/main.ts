/**
 * The bridge as its own executable — stdin in, stdout out, `process.exit` to stop.
 *
 * Split from `index.ts` when the engine gained the option of hosting the bridge in its own process.
 * The split is the whole mechanism: `index.ts` is now a library that says nothing about where the
 * protocol flows, and this file is the standalone wiring. Importing `index.ts` no longer starts
 * reading stdin, which it did as a side effect of being imported at all.
 *
 * `build-wa-bridge.ts` compiles this file. The engine imports `index.ts`. Nothing else changed —
 * same protocol, same handlers, same process semantics out here.
 */

import { handleLine } from "./index.ts";

/**
 * `process.stdin` rather than `Bun.stdin`, so this runs under Node as well.
 *
 * That is not hypothetical tidiness: Baileys leans on Node crypto and stream APIs, and being able to
 * run the bridge on Node while the engine stays pure Bun is half of why the boundary in
 * ARCHITECTURE §6 is drawn where it is.
 *
 * Commands are handled one at a time. `send` awaits the network, and processing the next line
 * concurrently would let two replies to the same chat race into the wrong order.
 */
const decoder = new TextDecoder();
let buffer = "";

process.stdin.on("end", () => {
  // The engine went away. Staying alive would leave an orphan holding the WhatsApp session, which
  // then fights the next bridge for the same credentials.
  process.exit(0);
});

for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true });
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    await handleLine(line);
  }
}
