import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The marketplace and plugin names in the package's `.claude-plugin/marketplace.json`. */
export const PLUGIN_ID = "blether@blether";
const MARKETPLACE = "blether";

/** Runs `claude` with `args`, resolving to its exit code and output. */
export type ClaudeRunner = (
  args: string[],
) => Promise<{ code: number; out: string }>;

export const runClaude: ClaudeRunner = (args) =>
  new Promise((resolvePromise, reject) => {
    // On Windows `claude` may be a .cmd shim, which only runs through a
    // shell, so pass one quoted command line. (Arguments here are fixed words
    // and a path, never containing quotes.)
    const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
    const child =
      process.platform === "win32"
        ? spawn(["claude", ...args].map((a) => `"${a}"`).join(" "), {
            shell: true,
            stdio,
          })
        : spawn("claude", args, { stdio });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, out }));
  });

/**
 * The installed package's root: the directory holding the marketplace the
 * plugin is installed from. The bundled CLI lives in `<root>/plugin/dist`.
 */
export function packageRoot(
  from = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".claude-plugin", "marketplace.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Registers this package as a Claude Code marketplace and installs the
 * plugin from it, so the plugin, bridge and CLI are always the same version.
 * Safe to run again, for instance after upgrading the package.
 */
export async function installClaudePlugin(
  root: string,
  claude: ClaudeRunner,
  say: (line: string) => void,
): Promise<void> {
  const step = async (args: string[], what: string) => {
    const { code, out } = await claude(args);
    if (code !== 0) {
      throw new Error(
        `Couldn't ${what} (claude ${args.join(" ")}):\n${out.trim()}`,
      );
    }
    return out;
  };

  let marketplaces: { name?: string }[];
  try {
    marketplaces = JSON.parse(
      await step(
        ["plugin", "marketplace", "list", "--json"],
        "list marketplaces",
      ),
    ) as { name?: string }[];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Couldn't read Claude Code's list of marketplaces.", {
        cause: error,
      });
    }
    throw error;
  }
  if (marketplaces.some((m) => m.name === MARKETPLACE)) {
    // Re-add it, in case it points at another copy of Blether.
    await step(
      ["plugin", "marketplace", "remove", MARKETPLACE],
      "remove the old Blether marketplace",
    );
  }
  await step(
    ["plugin", "marketplace", "add", root],
    "add the Blether marketplace",
  );
  say(`Added the Blether marketplace from ${root}.`);
  await step(["plugin", "install", PLUGIN_ID], "install the Blether plugin");
  say(`Installed the ${PLUGIN_ID} plugin.`);
}

/**
 * Removes the plugin and the marketplace `installClaudePlugin` added.
 * Either may already be gone, so a failure to remove one isn't an error.
 */
export async function uninstallClaudePlugin(
  claude: ClaudeRunner,
  say: (line: string) => void,
): Promise<void> {
  const { code } = await claude(["plugin", "uninstall", PLUGIN_ID]);
  if (code === 0) say(`Uninstalled the ${PLUGIN_ID} plugin.`);
  const removed = await claude([
    "plugin",
    "marketplace",
    "remove",
    MARKETPLACE,
  ]);
  if (removed.code === 0) say("Removed the Blether marketplace.");
}

/** Claude Code's user settings file, which holds permission rules for every project. */
export function claudeSettingsPath(env = process.env): string {
  return join(
    env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "settings.json",
  );
}

/**
 * A permission-rule path for everything under the Blether home: relative to
 * the user's home (`~/`) where it's inside it, otherwise absolute (`//`).
 */
export function bletherHomeRule(home: string, userHome = homedir()): string {
  const forward = (path: string) =>
    path.split("\\").join("/").replace(/\/+$/, "");
  const path = forward(home);
  const user = forward(userHome);
  if (path.toLowerCase().startsWith(`${user.toLowerCase()}/`)) {
    return `~/${path.slice(user.length + 1)}/**`;
  }
  return `//${path.replace(/^\/+/, "")}/**`;
}

/**
 * Deny rules that keep Claude Code away from the Blether home (device keys,
 * Approval Policy) and from the commands that change membership, devices or
 * the policy. They're only as strong as Claude Code's enforcement: see #73.
 */
export function denyRules(bletherHome: string): string[] {
  const home = bletherHomeRule(bletherHome);
  return [
    `Read(${home})`,
    `Edit(${home})`,
    ...[
      "invite",
      "join",
      "team remove",
      "policy set",
      "device add",
      "device revoke",
    ].map((command) => `Bash(blether ${command}:*)`),
  ];
}

interface ClaudeSettings {
  permissions?: { deny?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** Reads Claude Code's settings, or {} if there are none. Throws if they can't be read. */
function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Couldn't read ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Couldn't read ${path}: it isn't a JSON object.`);
  }
  return parsed as ClaudeSettings;
}

function writeSettings(path: string, settings: ClaudeSettings) {
  mkdirSync(dirname(path), { recursive: true });
  // Write then rename, so Claude Code never reads half a file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temp, path);
}

/** The rules in `rules` that Claude Code's settings at `path` don't have yet. */
export function missingDenyRules(path: string, rules: string[]): string[] {
  const deny = readSettings(path).permissions?.deny ?? [];
  return rules.filter((rule) => !deny.includes(rule));
}

/** Adds `rules` to the deny list in Claude Code's settings at `path`, keeping everything else. */
export function addDenyRules(path: string, rules: string[]): void {
  const settings = readSettings(path);
  const deny = settings.permissions?.deny ?? [];
  writeSettings(path, {
    ...settings,
    permissions: {
      ...settings.permissions,
      deny: [...deny, ...rules.filter((rule) => !deny.includes(rule))],
    },
  });
}

/** Takes `rules` out of the deny list in Claude Code's settings at `path`. Returns how many were there. */
export function removeDenyRules(path: string, rules: string[]): number {
  const settings = readSettings(path);
  const deny = settings.permissions?.deny;
  if (!deny) return 0;
  const kept = deny.filter((rule) => !rules.includes(rule));
  if (kept.length === deny.length) return 0;
  writeSettings(path, {
    ...settings,
    permissions: { ...settings.permissions, deny: kept },
  });
  return deny.length - kept.length;
}
