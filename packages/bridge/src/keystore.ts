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
import {
  LostStorageKeyError,
  SecretBox,
  isSealed,
  platformKeychain,
} from "./storage-key.js";

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
    // Forward slashes work in every shell, including Git Bash on Windows.
    const path = home.replaceAll("\\", "/");
    super(
      `${home} was created by an earlier development build of Blether and can't be read. ` +
        `Move it aside (mv "${path}" "${path}.old") and run \`blether init\` again.`,
    );
    this.name = "OutdatedBletherHomeError";
  }
}

/** This device's key is encrypted, and its storage key can't be read or is gone. */
export class UndecryptableDeviceKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndecryptableDeviceKeyError";
  }
}

/**
 * Stores credentials as files in a directory readable only by the current
 * user (ADR 0006). On Windows, the directory under the user profile is
 * already private to the user; POSIX permissions are set explicitly.
 * Device secret keys are encrypted under a storage key the OS keeps, where
 * there's a keychain (ADR 0011).
 */
export class FileKeyStore {
  constructor(
    readonly home: string = defaultBletherHome(),
    private readonly box = new SecretBox(
      platformKeychain(home),
      process.env.BLETHER_KEYCHAIN !== "off",
    ),
  ) {}

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
    const device = this.readDeviceKey(this.devicePath);
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
    this.writeDeviceKey(this.devicePath, credentials.device);
    writePrivate(this.identityPath, credentials.identity);
  }

  /** Replaces the stored identity log with a newer version of it. */
  saveIdentity(identity: IdentityLog): void {
    writePrivate(this.identityPath, identity);
  }

  loadPendingDevice(): DeviceKey | undefined {
    return existsSync(this.pendingPath)
      ? this.readDeviceKey(this.pendingPath)
      : undefined;
  }

  savePendingDevice(device: DeviceKey): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.writeDeviceKey(this.pendingPath, device);
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

  /**
   * Encrypts device keys stored as they are, now there's a keychain. Returns
   * the keychain's name if it encrypted any.
   */
  encryptStoredKeys(): string | undefined {
    let encrypted = false;
    for (const path of [this.devicePath, this.pendingPath]) {
      if (!existsSync(path)) continue;
      const file = DeviceKeyFile.parse(readJson(path));
      if (isSealed(file.secretKey)) continue;
      const secretKey = this.box.seal(file.secretKey);
      if (!isSealed(secretKey)) return undefined;
      writePrivate(path, { ...file, secretKey });
      encrypted = true;
    }
    return encrypted ? this.box.keychain?.name : undefined;
  }

  /** How this device's key (or its pending key) is kept, for the developer. */
  keyProtection(): string {
    const path = existsSync(this.devicePath)
      ? this.devicePath
      : this.pendingPath;
    const { secretKey } = DeviceKeyFile.parse(readJson(path));
    if (isSealed(secretKey)) {
      return `encrypted, with its storage key in ${this.box.keychain?.name}`;
    }
    const why = this.box.unavailable
      ? ` (no keychain: ${this.box.unavailable})`
      : "";
    return `in a file only you can read${why}`;
  }

  private readDeviceKey(path: string): DeviceKey {
    const file = DeviceKeyFile.parse(readJson(path));
    try {
      return { ...file, secretKey: this.box.open(file.secretKey) };
    } catch (error) {
      if (!(error instanceof LostStorageKeyError)) {
        throw new UndecryptableDeviceKeyError(
          `The device key in ${path} can't be decrypted. ${(error as Error).message}`,
        );
      }
      throw new UndecryptableDeviceKeyError(
        `The device key in ${path} can't be decrypted. ${error.message} ` +
          "That happens if the keychain was reset, or on Windows if an administrator reset your password, and the key can't be recovered. " +
          `Move ${this.home} aside, then run \`blether device request\` and approve this device from another of yours, ` +
          "or, if this was your only device, run `blether init` and ask to be invited to your teams again.",
      );
    }
  }

  private writeDeviceKey(path: string, device: DeviceKey) {
    writePrivate(path, {
      publicKey: device.publicKey,
      secretKey: this.box.seal(device.secretKey),
    });
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

/** Which messages an agent has read, so a relay replaying one is noticed. */
export interface ReadMessageLog {
  has(id: string): boolean;
  add(ids: readonly string[]): void;
}

/**
 * Remembers the ids of messages an agent has read on this device, under
 * `<home>/seen/messages`, keeping the most recent `limit`.
 */
export class ReadMessages implements ReadMessageLog {
  private ids: string[] | undefined;

  constructor(
    readonly home: string,
    private readonly team: string,
    private readonly agent: string,
    private readonly limit = 10_000,
  ) {}

  private get path() {
    if (!/^[A-Za-z0-9_-]+$/.test(this.team + this.agent)) {
      throw new Error("Bad team or agent name.");
    }
    return join(
      this.home,
      "seen",
      "messages",
      `${this.team}.${this.agent}.json`,
    );
  }

  private load(): string[] {
    this.ids ??= existsSync(this.path)
      ? z.array(z.string()).parse(readJson(this.path))
      : [];
    return this.ids;
  }

  has(id: string): boolean {
    return this.load().includes(id);
  }

  add(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const known = this.load();
    const merged = [...known, ...ids.filter((id) => !known.includes(id))];
    this.ids = merged.slice(-this.limit);
    mkdirSync(join(this.home, "seen", "messages"), {
      recursive: true,
      mode: 0o700,
    });
    writePrivate(this.path, this.ids);
  }
}
