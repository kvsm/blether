import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayConfigError, relayConfig } from "./config.js";
import {
  CURRENT_SCHEMA,
  IncompatibleDatabaseError,
  MailboxStore,
  backUpDatabase,
  type StoreSchema,
} from "./mailbox-store.js";
import { startRelay, type Relay } from "./relay.js";

/** What running a relay for a team needs beyond relaying: health checks, TLS, upgrades and backups. */
describe("hosting the relay", () => {
  let dir: string;
  let relay: Relay | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blether-hosting-"));
  });
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const httpUrl = (r: Relay) => r.url.replace(/^ws/, "http");

  describe("health check", () => {
    it("answers GET /healthz", async () => {
      relay = await startRelay();

      const res = await fetch(`${httpUrl(relay)}/healthz`);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok\n");
    });

    it("tells other HTTP requests it's a relay", async () => {
      relay = await startRelay();

      const res = await fetch(`${httpUrl(relay)}/`);

      expect(res.status).toBe(426);
      expect(await res.text()).toContain("This is a Blether relay");
    });
  });

  const openssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!openssl)("serves wss:// with a certificate", async () => {
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    execFileSync(
      "openssl",
      [
        ...[
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
        ],
        ...["-nodes", "-days", "1", "-subj", "/CN=localhost"],
        ...["-addext", "subjectAltName=IP:127.0.0.1"],
        ...["-keyout", key, "-out", cert],
      ],
      { stdio: "ignore" },
    );

    relay = await startRelay(
      relayConfig({
        BLETHER_RELAY_PORT: "0",
        BLETHER_RELAY_DB: join(dir, "relay.db"),
        BLETHER_RELAY_TLS_CERT: cert,
        BLETHER_RELAY_TLS_KEY: key,
      }),
    );
    expect(relay.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);

    const body = await new Promise<string>((resolve, reject) => {
      get(`${httpUrl(relay!)}/healthz`, { ca: readFileSync(cert) }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve(text));
      }).on("error", reject);
    });
    expect(body).toBe("ok\n");
  });

  describe("configuration", () => {
    it("needs both halves of a certificate", () => {
      expect(() => relayConfig({ BLETHER_RELAY_TLS_CERT: "cert.pem" })).toThrow(
        RelayConfigError,
      );
    });

    it("explains a port that isn't a number", () => {
      expect(() => relayConfig({ BLETHER_RELAY_PORT: "http" })).toThrow(
        'BLETHER_RELAY_PORT must be a whole number, not "http".',
      );
    });

    it("explains a certificate file it can't read", () => {
      expect(() =>
        relayConfig({
          BLETHER_RELAY_TLS_CERT: join(dir, "missing.pem"),
          BLETHER_RELAY_TLS_KEY: join(dir, "missing.pem"),
        }),
      ).toThrow("Couldn't read");
    });
  });

  // Each test opens, copies and migrates real database files, which can take
  // several seconds on a busy Windows CI runner.
  describe("upgrades", { timeout: 20_000 }, () => {
    const path = () => join(dir, "relay.db");

    /** The current schema plus one migration, as the next relay release would have. */
    const next = (migration: string): StoreSchema => ({
      ...CURRENT_SCHEMA,
      version: CURRENT_SCHEMA.version + 1,
      migrations: [...CURRENT_SCHEMA.migrations, migration],
    });

    const query = (file: string, sql: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    };
    const version = (file: string) =>
      (query(file, "PRAGMA user_version")[0] as { user_version: number })
        .user_version;

    /** A database at the current schema with one developer in it. */
    const existing = () => {
      new MailboxStore(path()).close();
      const db = new DatabaseSync(path());
      db.prepare("INSERT INTO developers VALUES ('dev', 'Kev', '[]')").run();
      db.close();
    };

    it("migrates an older database, keeping its data and a copy of it", () => {
      existing();
      const lines: string[] = [];

      new MailboxStore(path(), {
        schema: next("ALTER TABLE developers ADD COLUMN note TEXT"),
        log: (l) => lines.push(l),
      }).close();

      expect(version(path())).toBe(CURRENT_SCHEMA.version + 1);
      expect(query(path(), "SELECT name, note FROM developers")).toEqual([
        { name: "Kev", note: null },
      ]);
      const copy = `${path()}.before-schema-${CURRENT_SCHEMA.version + 1}`;
      expect(version(copy)).toBe(CURRENT_SCHEMA.version);
      expect(lines.join("\n")).toContain(
        `from schema ${CURRENT_SCHEMA.version} to ${CURRENT_SCHEMA.version + 1}`,
      );
    });

    it("leaves the database as it was when a migration fails", () => {
      existing();

      expect(
        () =>
          new MailboxStore(path(), {
            schema: next(
              "ALTER TABLE developers ADD COLUMN note TEXT; NOT VALID SQL",
            ),
          }),
      ).toThrow();

      expect(version(path())).toBe(CURRENT_SCHEMA.version);
      expect(
        query(path(), "SELECT name FROM pragma_table_info('developers')"),
      ).not.toContainEqual({ name: "note" });
    });

    it("refuses a database from a newer relay", () => {
      existing();
      new MailboxStore(path(), {
        schema: next("ALTER TABLE developers ADD COLUMN note TEXT"),
      }).close();

      expect(() => new MailboxStore(path())).toThrow(
        /written by a newer relay/,
      );
    });

    it("refuses a database from a development build", () => {
      const db = new DatabaseSync(path());
      db.exec("CREATE TABLE old (x); PRAGMA user_version = 3");
      db.close();

      expect(() => new MailboxStore(path())).toThrow(IncompatibleDatabaseError);
      expect(() => new MailboxStore(path())).toThrow(
        /earlier development build/,
      );
    });
  });

  it("backs up the database while the relay is running", async () => {
    const path = join(dir, "relay.db");
    relay = await startRelay({ databasePath: path });
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO developers VALUES ('dev', 'Kev', '[]')").run();
    db.close();

    const target = join(dir, "backup.db");
    backUpDatabase(path, target);

    const copy = new DatabaseSync(target, { readOnly: true });
    expect(copy.prepare("SELECT name FROM developers").all()).toEqual([
      { name: "Kev" },
    ]);
    copy.close();
  });

  it("won't overwrite an existing file with a backup", () => {
    const path = join(dir, "relay.db");
    new MailboxStore(path).close();
    const target = join(dir, "backup.db");
    writeFileSync(target, "precious");

    expect(() => backUpDatabase(path, target)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(existsSync(target)).toBe(true);
  });
});
