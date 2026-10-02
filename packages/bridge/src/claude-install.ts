import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
