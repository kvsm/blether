import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  IdentityLog,
  PublicKey,
  TeamName,
  compareLogs,
  verifyIdentityLog,
  type DeviceKey,
} from "@blether/protocol";
import { z } from "zod";

/** What a bridge needs to prove who it is: this device's key and its developer's identity log. */
export interface Credentials {
  device: DeviceKey;
  identity: IdentityLog;
}

/** Where this device's Blether state lives: `BLETHER_HOME`, or `~/.blether`. */
export function defaultBletherHome(): string {
  return process.env.BLETHER_HOME ?? join(homedir(), ".blether");
}

const DeviceKeyFile = z.object({
  publicKey: PublicKey,
  secretKey: z.string().min(1),
});

/** `BLETHER_HOME` was written by an earlier dev build whose files this one can't read. */
export class OutdatedBletherHomeError extends Error {
  constructor(home: string) {
    super(
      `${home} was created by an earlier development build of Blether and can't be read. ` +
        `Move it aside (mv ${home} ${home}.old) and run \`blether init\` again.`,
    );
    this.name = "OutdatedBletherHomeError";
  }
}

/**
 * Stores credentials as files in a directory readable only by the current
 * user (ADR 0006). On Windows, the directory under the user profile is
 * already private to the user; POSIX permissions are set explicitly.
 */
export class FileKeyStore {
  constructor(readonly home: string = defaultBletherHome()) {}

  private get devicePath() {
    return join(this.home, "device-key.json");
  }

  /** Written by earlier builds, which called devices "machines". */
  private get legacyPath() {
    return join(this.home, "machine-key.json");
  }

  private get identityPath() {
    return join(this.home, "identity.json");
  }

  /** A device key waiting to be added to an identity by another device. */
  private get pendingPath() {
    return join(this.home, "pending-device-key.json");
  }

  exists(): boolean {
    return (
      existsSync(this.devicePath) ||
      existsSync(this.identityPath) ||
      existsSync(this.legacyPath)
    );
  }

  /** Loads and checks the stored credentials, or returns undefined if there are none. */
  load(): Credentials | undefined {
    if (!this.exists()) return undefined;
    if (existsSync(this.legacyPath)) {
      throw new OutdatedBletherHomeError(this.home);
    }
    const device = DeviceKeyFile.parse(readJson(this.devicePath));
    const identity = IdentityLog.parse(readJson(this.identityPath));
    if (!verifyIdentityLog(identity).devices.includes(device.publicKey)) {
      throw new Error(
        `${this.identityPath} doesn't include this device's key (${this.devicePath}).`,
      );
    }
    return { device, identity };
  }

  save(credentials: Credentials): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writePrivate(this.devicePath, credentials.device);
    writePrivate(this.identityPath, credentials.identity);
  }

  /** Replaces the stored identity log with a newer version of it. */
  saveIdentity(identity: IdentityLog): void {
    writePrivate(this.identityPath, identity);
  }

  loadPendingDevice(): DeviceKey | undefined {
    return existsSync(this.pendingPath)
      ? DeviceKeyFile.parse(readJson(this.pendingPath))
      : undefined;
  }

  savePendingDevice(device: DeviceKey): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writePrivate(this.pendingPath, device);
  }

  /** Turns the pending device key into this device's key, with `identity` as its identity. */
  completePendingDevice(identity: IdentityLog): Credentials {
    const device = this.loadPendingDevice();
    if (!device) throw new Error("There is no pending device key.");
    if (!verifyIdentityLog(identity).devices.includes(device.publicKey)) {
      throw new Error("That identity doesn't include this device's key.");
    }
    const credentials = { device, identity };
    this.save(credentials);
    rmSync(this.pendingPath);
    return credentials;
  }
}

/** A relay served a log older than, or inconsistent with, one this device has already verified. */
export class StaleLogError extends Error {
  constructor(
    readonly kind: "identity" | "team",
    relation: "behind" | "diverged",
  ) {
    super(
      relation === "behind"
        ? `The relay sent an older version of a ${kind} log than this device has already seen.`
        : `The relay sent a version of a ${kind} log that disagrees with one this device has already seen.`,
    );
    this.name = "StaleLogError";
  }
}

/** Checks logs from the relay against what this device has already seen. */
export interface LogWitness {
  /** Throws StaleLogError unless `log` is the same as, or extends, the longest version seen; then remembers it. */
  witness(kind: "identity" | "team", id: string, log: readonly unknown[]): void;
}

/**
 * Remembers the longest version of each identity and team log this device has
 * verified, under `<home>/seen`, so a relay can't serve an outdated one
 * (from before a device was added or a member removed) without being noticed.
 */
export class SeenLogs implements LogWitness {
  constructor(readonly home: string = defaultBletherHome()) {}

  private path(kind: "identity" | "team", id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Bad log id: ${id}`);
    return join(this.home, "seen", kind, `${id}.json`);
  }

  witness(
    kind: "identity" | "team",
    id: string,
    log: readonly unknown[],
  ): void {
    const path = this.path(kind, id);
    if (existsSync(path)) {
      const relation = compareLogs(
        log,
        z.array(z.unknown()).parse(readJson(path)),
      );
      if (relation === "behind" || relation === "diverged") {
        throw new StaleLogError(kind, relation);
      }
      if (relation === "same") return;
    }
    mkdirSync(join(this.home, "seen", kind), { recursive: true, mode: 0o700 });
    writePrivate(path, log);
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

/** What this device remembers about a team its developer belongs to. */
export const TeamRecord = z.object({
  /** The local name the developer uses for the team, e.g. in BLETHER_TEAM. */
  name: TeamName,
  id: z.string(),
  relayUrl: z.url(),
});
export type TeamRecord = z.infer<typeof TeamRecord>;

/** The teams this device's developer has created or joined, one file each under `<home>/teams`. */
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
