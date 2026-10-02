import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AgentName } from "@blether/protocol";
import { z } from "zod";

/**
 * A project's `.blether/session.json`: which team and agent sessions started
 * in the project act as, so the bridge's MCP config needs no per-project
 * environment. Written by `blether use`.
 */
const SessionFileContents = z.object({
  team: z.string().min(1),
  agent: AgentName,
});
export type SessionFileContents = z.infer<typeof SessionFileContents>;

const DIR = ".blether";
const FILE = "session.json";

/** The agent name is the developer's own, so the directory ignores itself rather than being committed. */
const GITIGNORE =
  "# Written by `blether use`: this developer's own agent for the project.\n*\n";

export class SessionFileError extends Error {}

/** Writes `<projectDir>/.blether/session.json`, returning its path. */
export function writeSessionFile(
  projectDir: string,
  contents: SessionFileContents,
): string {
  const dir = join(projectDir, DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
  const path = join(dir, FILE);
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

/**
 * Finds the session file for a session started in `start`: in `start` or the
 * nearest directory above it that has one, stopping at the repository root
 * (the first directory with `.git`). The Blether home, `~/.blether`, is never
 * taken for a project's.
 */
export function findSessionFile(
  start: string,
  bletherHome: string,
): { path: string; contents: SessionFileContents } | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, DIR);
    const path = join(candidate, FILE);
    if (resolve(candidate) !== resolve(bletherHome) && existsSync(path)) {
      return { path, contents: readSessionFile(path) };
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) return undefined;
    dir = parent;
  }
}

function readSessionFile(path: string): SessionFileContents {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SessionFileError(
      `${path} isn't valid JSON (${(error as Error).message}). Write it again with \`blether use <team> <agent>\`.`,
    );
  }
  const parsed = SessionFileContents.safeParse(raw);
  if (!parsed.success) {
    throw new SessionFileError(
      `${path} doesn't name a team and agent. Write it again with \`blether use <team> <agent>\`.`,
    );
  }
  return parsed.data;
}
