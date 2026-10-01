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

/** Bumped whenever the schema changes incompatibly. */
const SCHEMA_VERSION = 6;

export class IncompatibleDatabaseError extends Error {
  constructor(path: string, version: number) {
    super(
      `${path} was created by an older relay (schema ${version}, need ${SCHEMA_VERSION}). ` +
        "Dev-mode databases can't be migrated; move it aside and restart the relay.",
    );
    this.name = "IncompatibleDatabaseError";
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

  /** Opens (creating if needed) a store at `path`, or in memory for ":memory:". */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const { user_version: version } = this.db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    const hasTables =
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'")
        .get() !== undefined;
    if (hasTables && version !== SCHEMA_VERSION) {
      this.db.close();
      throw new IncompatibleDatabaseError(path, version);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = ${SCHEMA_VERSION};
      CREATE TABLE IF NOT EXISTS developers (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        log  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS teams (
        id      TEXT PRIMARY KEY,
        log     TEXT NOT NULL,
        entries INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        id        TEXT NOT NULL UNIQUE,
        team      TEXT NOT NULL REFERENCES teams (id),
        sender    TEXT NOT NULL,
        recipient TEXT NOT NULL,
        envelope    TEXT,
        received_at TEXT NOT NULL,
        status    TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'read'))
      );
      CREATE INDEX IF NOT EXISTS messages_unread
        ON messages (team, recipient, seq) WHERE status <> 'read';
      CREATE INDEX IF NOT EXISTS messages_sent ON messages (team, sender, seq);
    `);
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
