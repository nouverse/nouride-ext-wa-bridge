/**
 * What must stay out of the bridge bundle.
 *
 * Baileys reaches for its optional peers with `import('sharp').catch(() => {})` and gives up quietly
 * when they are absent — a send loses its thumbnail and nothing else. Bundling one defeats that:
 * `sharp` is a native module, so what lands in the bundle is its *loader*, which then tries to
 * materialise a `.node` file that is not there. Bun answers by reaching for a temp directory it has
 * not been given, and the error is fatal rather than catchable:
 *
 *   error: Unexpected accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL
 *
 * Seen live the first time anything was sent to WhatsApp as an image: the bridge exited 1, the gateway
 * reconnected, and the retry landed before the new session had finished linking — so the visible
 * symptom was "not linked yet", two layers away from the cause.
 *
 * This is the guard that a peer added upstream does not walk back into the artefact unnoticed — and,
 * below it, the guards on how that artefact is built and launched: a compiled executable that carries
 * its own runtime, so a server running the bridge needs no Bun installed on it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_EXTERNALS } from "../../../scripts/bridge-externals.ts";

const BRIDGE_ROOT = join(import.meta.dir, "..");
const BAILEYS = join(BRIDGE_ROOT, "node_modules/@whiskeysockets/baileys/package.json");

describe("the bundle's external list", () => {
  test.skipIf(!existsSync(BAILEYS))("covers every peer dependency Baileys declares", () => {
    // Read from Baileys itself rather than restated here: the failure mode is upstream adding one,
    // and a hand-copied list cannot notice that.
    const pkg = JSON.parse(readFileSync(BAILEYS, "utf-8")) as {
      peerDependencies?: Record<string, string>;
    };
    const peers = Object.keys(pkg.peerDependencies ?? {});
    expect(peers.length).toBeGreaterThan(0);

    const missing = peers.filter((name) => !(BRIDGE_EXTERNALS as readonly string[]).includes(name));
    expect(missing).toEqual([]);
  });

  test("names sharp, which is the one that is native and not optional upstream", () => {
    // `sharp` is the only peer Baileys does *not* mark optional in `peerDependenciesMeta`, and the
    // only one carrying a platform binary. If this list ever loses it, media sending dies fatally.
    expect(BRIDGE_EXTERNALS).toContain("sharp");
  });
});

describe("a built bridge", () => {
  // Both shapes a build produces: `build:wa-bridge` on its own, and the copy `build:binary` stages
  // inside a release tarball. Whichever exist get checked; a checkout that has built neither skips.
  const built = [
    join(BRIDGE_ROOT, "../../dist/wa-bridge/wa-bridge"),
    join(BRIDGE_ROOT, "../../dist/wa-bridge-linux-x64/wa-bridge/wa-bridge"),
    join(BRIDGE_ROOT, "../../dist/nourun-linux-x64/wa-bridge/wa-bridge"),
    // The pre-executable bundle, still checked where one is lying around.
    join(BRIDGE_ROOT, "../../dist/wa-bridge/index.js"),
    join(BRIDGE_ROOT, "../../dist/nourun-linux-x64/wa-bridge/index.js"),
  ].filter(existsSync);

  test.skipIf(built.length === 0)("carries no reference to a native module", () => {
    // Asserted on the artefact, not just the flags: a bundler change that stopped honouring
    // `--external` would leave the flags correct and the artefact broken.
    //
    // Searched as bytes rather than as a decoded string, because the artefact is now an executable
    // with the Bun runtime in front of the JavaScript. `readFileSync(path, "utf-8")` on 66MB of that
    // is a lossy decode of mostly-not-text, and the needles below would still be found — but only by
    // luck, and a 66MB JS string to do it.
    for (const path of built) {
      const bytes = readFileSync(path);
      expect(bytes.includes("sharp.node")).toBe(false);
      expect(bytes.includes("@img/sharp")).toBe(false);
      // Still the bridge, so an empty or truncated file cannot pass this by accident.
      expect(bytes.includes("no session directory was given")).toBe(true);
    }
  });

  test.skipIf(!existsSync(join(BRIDGE_ROOT, "../../dist/wa-bridge/wa-bridge")))(
    "is executable, because the engine spawns it with no interpreter in front",
    () => {
      // The mode is the whole difference between "found it" and "EACCES", and `bun build --compile`
      // is what sets it. A build step that wrote the file some other way would pass every test above
      // and fail on the box.
      const path = join(BRIDGE_ROOT, "../../dist/wa-bridge/wa-bridge");
      expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
    },
  );
});

/**
 * How the engine decides what to run, and why the order is what it is.
 *
 * The compiled executable is first because it carries its own runtime: an install that has one needs
 * no Bun on the machine at all, which is the point of shipping it. The interpreted paths below it are
 * still real — the old `index.js` bundle, so an upgrade from an older tarball keeps working, and the
 * two source paths a checkout has.
 *
 * Asserted against the source because the resolver walks the filesystem for a bridge that is not
 * there in a test environment. The claims are worth pinning either way.
 */
describe("how the bridge is launched", () => {
  const source = readFileSync(
    join(BRIDGE_ROOT, "../../apps/engine/src/modules/gateways/bridge.ts"),
    "utf-8",
  );

  test("looks for the compiled executable before anything interpreted", () => {
    const compiled = source.indexOf('{ path: "wa-bridge/wa-bridge", compiled: true }');
    const bundle = source.indexOf('{ path: "wa-bridge/index.js", compiled: false }');
    expect(compiled).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(-1);
    expect(compiled).toBeLessThan(bundle);
  });

  test("spawns the compiled bridge bare — no `bun` in front of it", () => {
    // The name has to match what `build-wa-bridge.ts` writes, and nothing else checks that pair.
    expect(source).toContain("if (isExecutableFile(path)) return [path];");
  });

  test("checks the executable bit rather than trusting the file is there", () => {
    // A tarball unpacked by something that drops the mode leaves a path that stats perfectly and
    // fails at spawn with `EACCES` — a WhatsApp gateway that will not start, three layers from
    // the cause.
    expect(source).toContain("isExecutableFile");
  });

  test("still disables Bun's auto-install on the script paths", () => {
    // Unchanged and still load-bearing for a source checkout: the reason is in the block comment
    // above `BUN` in that file, and it cost a live box a fatal, uncatchable resolution error.
    expect(source).toMatch(/const BUN = \["bun", "--no-install"\]/);
    expect(source).toContain('[...BUN, "run", path]');
  });
});
