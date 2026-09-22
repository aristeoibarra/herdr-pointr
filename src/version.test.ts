import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two files carry the version and nothing makes them agree.
 *
 * They are read by different things — npm and herdr's plugin registry — so a
 * drift does not break a build, it just publishes a plugin
 * whose manifest disagrees with its own package. That is confusing for whoever
 * installed it and invisible to whoever shipped it.
 */

const root = join(import.meta.dirname, "..");

function readJsonVersion(file: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${file}: not an object`);
  const version = Reflect.get(parsed, "version");
  if (typeof version !== "string") throw new Error(`${file}: no version`);
  return version;
}

/** Reads the manifest's top-level `version` without pulling in a TOML parser. */
function readManifestVersion(): string {
  const body = readFileSync(join(root, "herdr-plugin.toml"), "utf8");
  // Top-level only: stop at the first [section], so a future [[actions]] block
  // with its own version key cannot be mistaken for the package's.
  const top = body.split(/^\s*\[/m)[0] ?? "";
  const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(top);
  if (!match?.[1]) throw new Error("herdr-plugin.toml: no top-level version");
  return match[1];
}

describe("version", () => {
  it("is the same in package.json and the plugin manifest", () => {
    expect(readManifestVersion()).toBe(readJsonVersion("package.json"));
  });

  it("is a plain semver triple", () => {
    expect(readJsonVersion("package.json")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
