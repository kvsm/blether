import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRunner } from "./claude-install.js";
import { bletherHomeRule, packageRoot } from "./claude-install.js";
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

  const settingsPath = () => join(dir, "claude", "settings.json");
  const settings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
  let asked: string[];
  beforeEach(() => {
    asked = [];
  });

  /** Runs `blether claude <command>`, answering `answer` if asked to confirm. */
  const run = (
    claude: ClaudeRunner,
    root: string | undefined,
    { command = "install", answer = false } = {},
  ) =>
    runCli(["claude", command], {
      store: new FileKeyStore(join(dir, "home")),
      io: {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        confirm: async (question) => {
          asked.push(question);
          return answer;
        },
      },
      claude,
      packageRoot: root,
      claudeSettings: settingsPath(),
    });
  const homeRule = () => bletherHomeRule(join(dir, "home"));

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

  describe("deny rules", () => {
    const commandRules = [
      "Bash(blether invite:*)",
      "Bash(blether join:*)",
      "Bash(blether team remove:*)",
      "Bash(blether policy set:*)",
      "Bash(blether device add:*)",
      "Bash(blether device revoke:*)",
    ];

    it("adds deny rules for Blether's home and trust-changing commands, with consent, keeping other settings", async () => {
      mkdirSync(join(dir, "claude"));
      writeFileSync(
        settingsPath(),
        JSON.stringify({
          theme: "dark",
          permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./.env)"] },
        }),
      );

      expect(await run(fakeClaude(), "/pkg", { answer: true })).toBe(0);

      expect(asked).toEqual([expect.stringContaining("Add these deny rules")]);
      expect(settings()).toEqual({
        theme: "dark",
        permissions: {
          allow: ["Bash(ls:*)"],
          deny: [
            "Read(./.env)",
            `Read(${homeRule()})`,
            `Edit(${homeRule()})`,
            ...commandRules,
          ],
        },
      });
    });

    it("adds none if the developer says no", async () => {
      expect(await run(fakeClaude(), "/pkg", { answer: false })).toBe(0);

      expect(asked).toHaveLength(1);
      expect(() => readFileSync(settingsPath())).toThrow();
      expect(out.join("\n")).toContain("Skipped the deny rules");
    });

    it("doesn't ask again, or add them twice, once they're in place", async () => {
      await run(fakeClaude(), "/pkg", { answer: true });
      asked = [];

      expect(await run(fakeClaude(), "/pkg", { answer: true })).toBe(0);

      expect(asked).toEqual([]);
      expect(settings().permissions.deny).toHaveLength(8);
      expect(out.join("\n")).toContain("already in place");
    });

    it("leaves settings it can't read alone", async () => {
      mkdirSync(join(dir, "claude"));
      writeFileSync(settingsPath(), "{ not json");

      expect(await run(fakeClaude(), "/pkg", { answer: true })).toBe(1);

      expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
      expect(err.join("\n")).toContain("Couldn't read");
    });

    it("are removed, with the plugin, by claude uninstall", async () => {
      mkdirSync(join(dir, "claude"));
      writeFileSync(
        settingsPath(),
        JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }),
      );
      await run(fakeClaude(), "/pkg", { answer: true });
      calls = [];

      expect(
        await run(fakeClaude(["blether"]), "/pkg", { command: "uninstall" }),
      ).toBe(0);

      expect(settings()).toEqual({ permissions: { deny: ["Read(./.env)"] } });
      expect(calls).toEqual([
        "plugin uninstall blether@blether",
        "plugin marketplace remove blether",
      ]);
    });

    it("name Blether's home relative to the user's home where they can", () => {
      expect(bletherHomeRule("/home/kev/.blether", "/home/kev")).toBe(
        "~/.blether/**",
      );
      expect(
        bletherHomeRule("C:\\Users\\kev\\.blether", "C:\\Users\\kev"),
      ).toBe("~/.blether/**");
      expect(bletherHomeRule("/srv/blether", "/home/kev")).toBe(
        "//srv/blether/**",
      );
    });
  });

  it("finds the package root above the bundled CLI", () => {
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), "{}");
    mkdirSync(join(dir, "plugin", "dist"), { recursive: true });

    expect(packageRoot(join(dir, "plugin", "dist"))).toBe(dir);
  });
});
