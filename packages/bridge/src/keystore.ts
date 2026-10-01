import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  IdentityLog,
  PublicKey,
  TeamName,
  verifyIdentityLog,
  type MachineKey,
} from "@blether/protocol";
import { z } from "zod";

/** What a bridge needs to prove who it is: this machine's key and its developer's identity log. */
export interface Credentials {
  machine: MachineKey;
  identity: IdentityLog;
}

/** Where this machine's Blether state lives: `BLETHER_HOME`, or `~/.blether`. */
export function defaultBletherHome(): string {
  return process.env.BLETHER_HOME ?? join(homedir(), ".blether");
}

const MachineKeyFile = z.object({
  publicKey: PublicKey,
  secretKey: z.string().min(1),
});

/**
 * Stores credentials as files in a directory readable only by the current
 * user (ADR 0006). On Windows, the directory under the user profile is
 * already private to the user; POSIX permissions are set explicitly.
 */
export class FileKeyStore {
  constructor(readonly home: string = defaultBletherHome()) {}

  private get machinePath() {
    return join(this.home, "machine-key.json");
  }

  private get identityPath() {
    return join(this.home, "identity.json");
  }

  exists(): boolean {
    return existsSync(this.machinePath) || existsSync(this.identityPath);
  }

  /** Loads and checks the stored credentials, or returns undefined if there are none. */
  load(): Credentials | undefined {
    if (!this.exists()) return undefined;
    const machine = MachineKeyFile.parse(readJson(this.machinePath));
    const identity = IdentityLog.parse(readJson(this.identityPath));
    if (!verifyIdentityLog(identity).machines.includes(machine.publicKey)) {
      throw new Error(
        `${this.identityPath} doesn't include this machine's key (${this.machinePath}).`,
      );
    }
    return { machine, identity };
  }

  save(credentials: Credentials): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writePrivate(this.machinePath, credentials.machine);
    writePrivate(this.identityPath, credentials.identity);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writePrivate(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when the file is created.
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** What this machine remembers about a team its developer belongs to. */
export const TeamRecord = z.object({
  /** The local name the developer uses for the team, e.g. in BLETHER_TEAM. */
  name: TeamName,
  id: z.string(),
  relayUrl: z.url(),
});
export type TeamRecord = z.infer<typeof TeamRecord>;

/** The teams this machine's developer has created or joined, one file each under `<home>/teams`. */
export class TeamDirectory {
  constructor(readonly home: string = defaultBletherHome()) {}

  private get dir() {
    return join(this.home, "teams");
  }

  private path(name: string) {
    return join(this.dir, `${TeamName.parse(name)}.json`);
  }

  get(name: string): TeamRecord | undefined {
    const path = this.path(name);
    return existsSync(path) ? TeamRecord.parse(readJson(path)) : undefined;
  }

  list(): TeamRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => TeamRecord.parse(readJson(join(this.dir, file))))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  save(record: TeamRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivate(this.path(record.name), TeamRecord.parse(record));
  }
}
