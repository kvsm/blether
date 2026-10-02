import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BLETHER_VERSION } from "@blether/protocol";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const versionOf = (...path: string[]) =>
  (JSON.parse(readFileSync(join(root, ...path), "utf8")) as { version: string })
    .version;

/** The npm package, relay image, plugin and packages release together (`pnpm set-version`). */
describe("versions", () => {
  const release = versionOf("packages", "blether", "package.json");

  it.each(readdirSync(join(root, "packages")))(
    "packages/%s has the release version",
    (name) => {
      expect(versionOf("packages", name, "package.json")).toBe(release);
    },
  );

  it("the plugin has the release version", () => {
    expect(
      versionOf(
        "packages",
        "blether",
        "plugin",
        ".claude-plugin",
        "plugin.json",
      ),
    ).toBe(release);
  });

  it("BLETHER_VERSION is the release version", () => {
    expect(BLETHER_VERSION).toBe(release);
  });
});
