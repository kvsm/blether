import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * Keeps a Blether home's storage key, the key its secrets are encrypted
 * under, in the OS (ADR 0011). Implementations call the OS's own tools, with
 * secrets on standard input, never on the command line.
 */
export interface Keychain {
  /** Where the key is kept, as the CLI names it: "the macOS keychain". */
  readonly name: string;
  /** The storage key, or undefined if there isn't one. Throws if the keychain can't be used. */
  read(): Buffer | undefined;
  /** Stores `key`, replacing any storage key already there. Throws if the keychain can't be used. */
  write(key: Buffer): void;
  /** Removes the storage key, if there is one. */
  delete(): void;
}

/** The keychain this platform offers for `home`, or undefined if there's none Blether supports. */
export function platformKeychain(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Keychain | undefined {
  // Named after the home's path, so separate homes (and tests) don't share a key.
  const account = createHash("sha256")
    .update(resolve(home))
    .digest("hex")
    .slice(0, 32);
  switch (platform) {
    case "darwin":
      return new MacKeychain(account);
    case "linux":
      return new SecretService(account);
    case "win32":
      return new Dpapi(home);
    default:
      return undefined;
  }
}

const SERVICE = "blether";
// Long enough for the OS to ask the developer to unlock a keychain.
const TIMEOUT_MS = 60_000;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input = ""): Run {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Couldn't run ${command}: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr.trim(),
  };
}

function failed(command: string, result: Run): Error {
  return new Error(
    `${command} failed${result.stderr ? `: ${result.stderr}` : ` with exit code ${result.status}`}`,
  );
}

function decodeKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("The storage key in the keychain isn't a storage key.");
  }
  return key;
}

/** A generic password in the login keychain, through `security`. */
class MacKeychain implements Keychain {
  readonly name = "the macOS keychain";

  constructor(private readonly account: string) {}

  read(): Buffer | undefined {
    const result = run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      this.account,
      "-w",
    ]);
    // 44: errSecItemNotFound.
    if (result.status === 44) return undefined;
    if (result.status !== 0) throw failed("security", result);
    return decodeKey(result.stdout);
  }

  write(key: Buffer): void {
    // `security -i` reads commands from standard input, which keeps the key
    // off the command line. Nothing here needs quoting: the account is hex
    // and the key base64.
    const result = run(
      "security",
      ["-i"],
      `add-generic-password -U -s ${SERVICE} -a ${this.account} -w ${key.toString("base64")}\n`,
    );
    if (result.status !== 0) throw failed("security", result);
    // `security -i` can report success after a command in it failed.
    if (!this.read()?.equals(key)) {
      throw new Error(
        `security couldn't store the key${result.stderr ? `: ${result.stderr}` : "."}`,
      );
    }
  }

  delete(): void {
    run("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      this.account,
    ]);
  }
}

/** The freedesktop Secret Service (GNOME Keyring, KWallet), through `secret-tool`. */
class SecretService implements Keychain {
  readonly name = "the Secret Service keyring";

  constructor(private readonly account: string) {}

  private get attributes() {
    return ["service", SERVICE, "account", this.account];
  }

  read(): Buffer | undefined {
    const result = run("secret-tool", ["lookup", ...this.attributes]);
    // A missing secret fails quietly; a missing Secret Service says why.
    if (result.status === 1 && !result.stderr) return undefined;
    if (result.status !== 0) throw failed("secret-tool", result);
    return decodeKey(result.stdout);
  }

  write(key: Buffer): void {
    const result = run(
      "secret-tool",
      ["store", "--label=Blether storage key", ...this.attributes],
      key.toString("base64"),
    );
    if (result.status !== 0) throw failed("secret-tool", result);
  }

  delete(): void {
    run("secret-tool", ["clear", ...this.attributes]);
  }
}

// Windows PowerShell 5.1 ships with every Windows. Exit 2: DPAPI can't
// decrypt the key, as after an administrator resets the account's password.
const DPAPI_SCRIPT = (method: "Protect" | "Unprotect") =>
  [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `try { $out = [Security.Cryptography.ProtectedData]::${method}($in, $null, 'CurrentUser') } ` +
      "catch [Security.Cryptography.CryptographicException] { exit 2 }",
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");

/** A file in the Blether home, encrypted by DPAPI for the current Windows account. */
class Dpapi implements Keychain {
  readonly name = "Windows (DPAPI)";

  constructor(private readonly home: string) {}

  private get path() {
    return join(this.home, "storage-key.dpapi");
  }

  private powershell(method: "Protect" | "Unprotect", input: string): Run {
    return run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT(method)],
      input,
    );
  }

  read(): Buffer | undefined {
    if (!existsSync(this.path)) return undefined;
    const result = this.powershell(
      "Unprotect",
      readFileSync(this.path, "utf8"),
    );
    if (result.status === 2) return undefined;
    if (result.status !== 0) throw failed("PowerShell", result);
    return decodeKey(result.stdout);
  }

  write(key: Buffer): void {
    const result = this.powershell("Protect", key.toString("base64"));
    if (result.status !== 0) throw failed("PowerShell", result);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${result.stdout}\n`);
  }

  delete(): void {
    rmSync(this.path, { force: true });
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "enc:v1:";

/** Whether `stored` is a secret encrypted under a storage key. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** A stored secret can't be decrypted: its storage key is gone or was replaced. */
export class LostStorageKeyError extends Error {
  constructor(keychain: string) {
    super(`Its storage key is no longer in ${keychain}, or was replaced.`);
    this.name = "LostStorageKeyError";
  }
}

/**
 * Encrypts secrets under a Blether home's storage key, with AES-256-GCM, and
 * decrypts them. Where there's no keychain, or it can't be used, secrets are
 * stored as they are.
 */
export class SecretBox {
  private key: Buffer | undefined;
  /** Why the last secret was stored as it is, if the keychain couldn't be used. */
  unavailable: string | undefined;

  /**
   * @param keychain Where encrypted secrets' storage key is kept.
   * @param sealing Whether to encrypt new secrets; false stores them as they are.
   */
  constructor(
    readonly keychain: Keychain | undefined,
    private readonly sealing = keychain !== undefined,
  ) {}

  /** `secret`, encrypted if there's a keychain to keep its storage key. */
  seal(secret: string): string {
    if (!this.keychain || !this.sealing) {
      this.unavailable = this.keychain
        ? "BLETHER_KEYCHAIN is off"
        : `Blether doesn't support a keychain on ${process.platform}`;
      return secret;
    }
    try {
      this.key ??= this.keychain.read();
      if (!this.key) {
        const key = randomBytes(KEY_BYTES);
        this.keychain.write(key);
        this.key = key;
      }
    } catch (error) {
      this.unavailable = (error as Error).message;
      return secret;
    }
    this.unavailable = undefined;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const sealed = Buffer.concat([
      nonce,
      cipher.update(secret, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return PREFIX + sealed.toString("base64");
  }

  /**
   * The secret `stored` holds, decrypting it if it was sealed. Throws
   * LostStorageKeyError if its storage key is gone or was replaced.
   */
  open(stored: string): string {
    if (!isSealed(stored)) return stored;
    if (!this.keychain) {
      throw new Error(
        `It's encrypted, and Blether doesn't support a keychain on ${process.platform}.`,
      );
    }
    let key;
    try {
      key = this.key ?? this.keychain.read();
    } catch (error) {
      throw new Error(
        `Couldn't read its storage key from ${this.keychain.name}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!key) throw new LostStorageKeyError(this.keychain.name);
    const sealed = Buffer.from(stored.slice(PREFIX.length), "base64");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        sealed.subarray(0, NONCE_BYTES),
      );
      decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
      const secret = Buffer.concat([
        decipher.update(
          sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES),
        ),
        decipher.final(),
      ]).toString("utf8");
      this.key = key;
      return secret;
    } catch {
      throw new LostStorageKeyError(this.keychain.name);
    }
  }
}
