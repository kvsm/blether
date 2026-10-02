import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentName,
  DeliveryStatus,
  Identity,
  IdentityLog,
  Message,
  SentMessage,
  TeamLog,
} from "@blether/protocol";

/**
 * How to create the database at its current version, and how to bring an
 * older one up to it. To change the schema: update `create`, append a
 * migration from the previous version, and bump `version`.
 */
export interface StoreSchema {
  version: number;
  /** Creates every table at `version`, in an empty database. */
  create: string;
  /** The oldest version `migrations` can start from. */
  oldest: number;
  /** `migrations[i]` takes a database from version `oldest + i` to the next. */
  migrations: string[];
}

export const CURRENT_SCHEMA: StoreSchema = {
  version: 7,
  create: `
    CREATE TABLE developers (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      log  TEXT NOT NULL
    );
    CREATE TABLE teams (
      id      TEXT PRIMARY KEY,
      log     TEXT NOT NULL,
      entries INTEGER NOT NULL
    );
    CREATE TABLE messages (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      id        TEXT NOT NULL UNIQUE,
      team      TEXT NOT NULL REFERENCES teams (id),
      sender    TEXT NOT NULL,
      recipient TEXT NOT NULL,
      envelope    TEXT,
      received_at TEXT NOT NULL,
      status    TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'read', 'lost')),
      -- 1 while the sender hasn't yet been told the message was lost.
      lost_unacked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX messages_unread
      ON messages (team, recipient, seq) WHERE status <> 'read';
    CREATE INDEX messages_sent ON messages (team, sender, seq);
  `,
  // Version 7 is the first relay release databases are kept from.
  oldest: 7,
  migrations: [],
};

/** A database this relay can't open: from a development build, or a newer relay. */
export class IncompatibleDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleDatabaseError";
  }
}

/**
 * Writes a consistent copy of the relay database at `path` to `target`,
 * which must not exist yet. Safe while the relay is running.
 */
export function backUpDatabase(path: string, target: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

export interface StoreOptions {
  /** Where to report migrations. */
  log?: (line: string) => void;
  /** Only for tests: a schema other than the current one. */
  schema?: StoreSchema;
}

/** Creates the schema in a new database, or migrates an older one to it. */
function openSchema(
  db: DatabaseSync,
  path: string,
  schema: StoreSchema,
  log: (line: string) => void,
) {
  const { user_version: found } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const isEmpty =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get() ===
    undefined;
  if (isEmpty) {
    db.exec(
      `BEGIN; ${schema.create}; PRAGMA user_version = ${schema.version}; COMMIT;`,
    );
    return;
  }
  if (found === schema.version) return;
  if (found > schema.version) {
    throw new IncompatibleDatabaseError(
      `${path} was written by a newer relay (schema ${found}; this relay knows up to ${schema.version}). ` +
        "Run the newer relay, or restore a backup taken before it was upgraded.",
    );
  }
  if (found < schema.oldest) {
    throw new IncompatibleDatabaseError(
      `${path} was created by an earlier development build of the relay (schema ${found}) and can't be migrated. ` +
        "Move it aside and restart the relay; teams will need setting up again.",
    );
  }
  if (path !== ":memory:") {
    const backup = `${path}.before-schema-${schema.version}`;
    if (existsSync(backup)) {
      log(`Keeping the copy already saved as ${backup}.`);
    } else {
      db.prepare("VACUUM INTO ?").run(backup);
      log(`Saved a copy of ${path} as ${backup} before migrating it.`);
    }
  }
  for (let version = found; version < schema.version; version++) {
    const migration = schema.migrations[version - schema.oldest];
    if (migration === undefined) {
      throw new Error(`No migration from schema ${version}.`);
    }
    db.exec("BEGIN");
    try {
      db.exec(migration);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    log(`Migrated ${path} from schema ${version} to ${version + 1}.`);
  }
}

/**
 * Durable storage for the relay: developers' identity logs, teams'
 * membership logs (which also record each team's agents), and agents'
 * mailboxes. Messages are end-to-end encrypted envelopes the relay can't
 * read, and each is kept only until the recipient reads it;
 * after that the relay keeps just enough to report its delivery status to
 * the sender.
 */
export class MailboxStore {
  private readonly db: DatabaseSync;

  /**
   * Opens (creating if needed) a store at `path`, or in memory for
   * ":memory:". An older database is migrated to the current schema, after
   * a copy is saved beside it as `<path>.before-schema-<n>`.
   */
  constructor(
    path: string,
    { log = () => {}, schema = CURRENT_SCHEMA }: StoreOptions = {},
  ) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      openSchema(this.db, path, schema, log);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  // Developers

  /** Stores a verified identity, replacing any older copy of its log. */
  saveDeveloper(identity: Identity, log: IdentityLog): void {
    this.db
      .prepare(
        `INSERT INTO developers (id, name, log) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, log = excluded.log`,
      )
      .run(identity.id, identity.name, JSON.stringify(log));
  }

  /** The stored identity log of one developer, if the relay knows them. */
  developerLog(id: string): IdentityLog | undefined {
    return this.developerLogs([id])[0];
  }

  /** The stored identity logs of the given developers that the relay knows. */
  developerLogs(ids: Iterable<string>): IdentityLog[] {
    const get = this.db.prepare("SELECT log FROM developers WHERE id = ?");
    const logs: IdentityLog[] = [];
    for (const id of new Set(ids)) {
      const row = get.get(id) as { log: string } | undefined;
      if (row) logs.push(JSON.parse(row.log) as IdentityLog);
    }
    return logs;
  }

  // Teams

  teamLog(team: string): TeamLog | undefined {
    const row = this.db
      .prepare("SELECT log FROM teams WHERE id = ?")
      .get(team) as { log: string } | undefined;
    return row && (JSON.parse(row.log) as TeamLog);
  }

  /** Stores a new team's log. Returns false if the team already exists. */
  createTeam(team: string, log: TeamLog): boolean {
    const { changes } = this.db
      .prepare(
        "INSERT OR IGNORE INTO teams (id, log, entries) VALUES (?, ?, ?)",
      )
      .run(team, JSON.stringify(log), log.length);
    return changes === 1;
  }

  /**
   * Replaces a team's log with `log`, but only if the stored log still has
   * `expectedEntries` entries, so concurrent appends can't both succeed.
   */
  updateTeam(team: string, log: TeamLog, expectedEntries: number): boolean {
    const { changes } = this.db
      .prepare(
        "UPDATE teams SET log = ?, entries = ? WHERE id = ? AND entries = ?",
      )
      .run(JSON.stringify(log), log.length, team, expectedEntries);
    return changes === 1;
  }

  // Mailboxes

  /**
   * Puts a message in its recipient's mailbox with status `queued`.
   * Returns false, storing nothing, if a message with that id already exists.
   */
  add(team: string, message: Message): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, team, sender, recipient, envelope, received_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      )
      .run(
        message.id,
        team,
        message.from,
        message.to,
        JSON.stringify(message.envelope),
        message.receivedAt,
      );
    return changes === 1;
  }

  /**
   * Deletes an agent's mailbox: every message it hadn't read becomes lost,
   * its envelope is discarded, and its sender is owed a notice.
   */
  loseMailbox(team: string, agent: AgentName): void {
    this.db
      .prepare(
        `UPDATE messages SET status = 'lost', envelope = NULL, lost_unacked = 1
         WHERE team = ? AND recipient = ? AND status IN ('queued', 'delivered')`,
      )
      .run(team, agent);
  }

  /** Lost messages an agent sent that it hasn't been told about yet, oldest first. */
  unackedLost(team: string, sender: AgentName): SentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, recipient, received_at, status FROM messages
         WHERE team = ? AND sender = ? AND status = 'lost' AND lost_unacked = 1 ORDER BY seq`,
      )
      .all(team, sender) as unknown as SentRow[];
    return rows.map((row) => ({
      id: row.id,
      to: row.recipient,
      sentAt: row.received_at,
      status: row.status,
    }));
  }

  /** Records that the sender has seen these lost-message notices. Ids for other senders are ignored. */
  ackLost(team: string, sender: AgentName, ids: readonly string[]): void {
    const update = this.db.prepare(
      "UPDATE messages SET lost_unacked = 0 WHERE id = ? AND team = ? AND sender = ?",
    );
    for (const id of ids) update.run(id, team, sender);
  }

  markDelivered(id: string): void {
    this.db
      .prepare(
        "UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'queued'",
      )
      .run(id);
  }

  /** Marks messages in an agent's mailbox read and discards their bodies. Ids for other mailboxes are ignored. */
  markRead(team: string, agent: AgentName, ids: readonly string[]): void {
    const update = this.db.prepare(
      `UPDATE messages SET status = 'read', envelope = NULL
       WHERE id = ? AND team = ? AND recipient = ? AND status <> 'read'`,
    );
    for (const id of ids) update.run(id, team, agent);
  }

  /** Every message in an agent's mailbox it hasn't read yet, oldest first. */
  unread(team: string, agent: AgentName): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, sender, recipient, envelope, received_at FROM messages
         WHERE team = ? AND recipient = ? AND status <> 'read' ORDER BY seq`,
      )
      .all(team, agent) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      from: row.sender,
      to: row.recipient,
      envelope: JSON.parse(row.envelope) as Message["envelope"],
      receivedAt: row.received_at,
    }));
  }

  /** The `limit` messages an agent sent most recently, newest first. */
  sentBy(team: string, agent: AgentName, limit: number): SentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, recipient, received_at, status FROM messages
         WHERE team = ? AND sender = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(team, agent, limit) as unknown as SentRow[];
    return rows.map((row) => ({
      id: row.id,
      to: row.recipient,
      sentAt: row.received_at,
      status: row.status,
    }));
  }

  close(): void {
    this.db.close();
  }
}

interface MessageRow {
  id: string;
  sender: string;
  recipient: string;
  envelope: string;
  received_at: string;
}

interface SentRow {
  id: string;
  recipient: string;
  received_at: string;
  status: DeliveryStatus;
}
