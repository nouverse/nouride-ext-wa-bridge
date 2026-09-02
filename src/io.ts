/**
 * Where the protocol goes, and how this process ends — the two things that differ between running
 * the bridge as its own executable and running it inside the engine.
 *
 * ## Why this file exists
 *
 * The bridge was only ever a process: it wrote newline JSON to `stdout`, read commands from `stdin`,
 * and called `process.exit` when it was done. All three are wrong in-process — stdout belongs to the
 * daemon's logs, stdin to whatever started it, and exiting would take the whole daemon with it.
 *
 * Rather than thread an `io` argument through 850 lines of Baileys handling, the two calls the rest
 * of the file makes — `emit` and `exit` — go through here. Standalone wiring lives in `main.ts` and
 * is the default; the engine replaces it with `attach()`.
 *
 * ## This is the seam to cut
 *
 * Unplugging the in-process mode is: stop calling `attach()`, and this file goes back to being a
 * two-line indirection nobody notices. Nothing else in the bridge knows which mode it is in, and the
 * wire protocol is byte-identical either way — which is the point. See WHATSAPP.md.
 */

export interface BridgeIo {
  /** One protocol line, without the trailing newline. */
  write(line: string): void;
  /**
   * End this bridge.
   *
   * Standalone, that is `process.exit`. In-process it closes the channel and unwinds, because a
   * daemon hosting the bridge must outlive it — a protocol mismatch or a missing session key is the
   * bridge's problem, not a reason to drop every other gateway.
   */
  exit(code: number): void;
}

const STDOUT: BridgeIo = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  exit: (code) => {
    process.exit(code);
  },
};

let current: BridgeIo = STDOUT;

/** Point the bridge at something other than stdio. Returns a function that restores the default. */
export function attach(io: BridgeIo): () => void {
  current = io;
  return () => {
    current = STDOUT;
  };
}

export function write(line: string): void {
  current.write(line);
}

export function exit(code: number): never {
  current.exit(code);
  /**
   * Standalone never reaches this. In-process `exit` returns, and every caller in `index.ts` was
   * written expecting `process.exit` never to — so the throw preserves that shape rather than
   * letting execution fall into code that assumes it is still connected.
   */
  throw new BridgeExit(code);
}

/** Thrown by `exit` in-process, so the host can tell a deliberate stop from a crash. */
export class BridgeExit extends Error {
  constructor(readonly code: number) {
    super(`bridge exited with code ${code}`);
    this.name = "BridgeExit";
  }
}
