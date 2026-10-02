import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRunner } from "./claude-install.js";
import { packageRoot } from "./claude-install.js";
import { runCli } from "./cli.js";
import { FileKeyStore } from "./keystore.js";

describe("blether claude install", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let calls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blether-claude-"));
    out = [];
    err = [];
    calls = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for the claude CLI, with `marketplaces` already added, failing any command that starts with `fails`. */
  const fakeClaude =
    (marketplaces: string[] = [], fails?: string): ClaudeRunner =>
    async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (fails && command.startsWith(fails)) {
        return { code: 1, out: "something went wrong" };
      }
      if (command === "plugin marketplace list --json") {
        return {
          code: 0,
          out: JSON.stringify(marketplaces.map((name) => ({ name }))),
        };
      }
      return { code: 0, out: "" };
    };

  const run = (claude: ClaudeRunner, root: string | undefined) =>
    runCli(["claude", "install"], {
      store: new FileKeyStore(join(dir, "home")),
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      claude,
      packageRoot: root,
    });

  it("adds the package as a marketplace and installs the plugin", async () => {
    expect(await run(fakeClaude(), "/pkg")).toBe(0);

    expect(calls).toEqual([
      "plugin marketplace list --json",
      "plugin marketplace add /pkg",
      "plugin install blether@blether",
    ]);
    expect(out.join("\n")).toContain("Installed the blether@blether plugin");
  });

  it("replaces a Blether marketplace added from somewhere else", async () => {
    expect(await run(fakeClaude(["blether", "other"]), "/pkg")).toBe(0);

    expect(calls).toEqual([
      "plugin marketplace list --json",
      "plugin marketplace remove blether",
      "plugin marketplace add /pkg",
      "plugin install blether@blether",
    ]);
  });

  it("explains a step that fails", async () => {
    expect(await run(fakeClaude([], "plugin install"), "/pkg")).toBe(1);

    expect(err.join("\n")).toContain(
      "Couldn't install the Blether plugin (claude plugin install blether@blether):\nsomething went wrong",
    );
  });

  it("explains that it needs the package", async () => {
    expect(await run(fakeClaude(), undefined)).toBe(1);

    expect(err.join("\n")).toContain("npm install -g @kvsm/blether");
    expect(calls).toEqual([]);
  });

  it("finds the package root above the bundled CLI", () => {
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), "{}");
    mkdirSync(join(dir, "plugin", "dist"), { recursive: true });

    expect(packageRoot(join(dir, "plugin", "dist"))).toBe(dir);
  });
});
