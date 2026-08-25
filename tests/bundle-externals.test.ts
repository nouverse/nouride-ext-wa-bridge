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
 * This is the guard that a peer added upstream does not walk back into the bundle unnoticed.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

describe("a built bundle", () => {
  const bundles = [
    join(BRIDGE_ROOT, "../../dist/wa-bridge/index.js"),
    join(BRIDGE_ROOT, "../../dist/nourun-linux-x64/wa-bridge/index.js"),
  ].filter(existsSync);

  test.skipIf(bundles.length === 0)("carries no reference to a native module", () => {
    // Asserted on the artefact, not just the flags: a bundler change that stopped honouring
    // `--external` would leave the flags correct and the bundle broken.
    for (const bundle of bundles) {
      const contents = readFileSync(bundle, "utf-8");
      expect(contents).not.toContain("sharp.node");
      expect(contents).not.toContain("@img/sharp");
      // Still the bridge, so an empty or truncated file cannot pass this by accident.
      expect(contents).toContain("no session directory was given");
    }
  });
});

/**
 * The other half of the fix, and the one that actually makes the failure catchable.
 *
 * `--external` keeps a native *loader* out of the bundle. `--no-install` is what stops Bun from
 * treating the resulting runtime import as an install attempt: its default is "auto-install when
 * there is no node_modules", and the bundle lives in a directory that has none by design. Installing
 * needs somewhere to write, the service's hardening makes `$HOME` read-only, and Bun reports that
 * fatally during resolution — before any `.catch()` can see it.
 */
describe("how the bridge is launched", () => {
  test("the spawn command disables Bun's auto-install", () => {
    const source = readFileSync(
      join(BRIDGE_ROOT, "../../apps/engine/src/modules/gateways/bridge.ts"),
      "utf-8",
    );
    // Asserted on the source because the resolver walks the filesystem for a bridge that is not
    // there in a test environment, and the flag is the claim worth pinning either way.
    expect(source).toContain('"--no-install"');
    // Before `run`, or Bun reads it as an argument to the script rather than to itself.
    expect(source).toMatch(/const BUN = \["bun", "--no-install"\]/);
    expect(source).toContain('[...BUN, "run", path]');
  });
});
