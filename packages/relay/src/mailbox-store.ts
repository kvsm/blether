import { DatabaseSync } from "node:sqlite";
import type {
  AgentName,
  DeliveryStatus,
  Identity,
  IdentityLog,
  Message,
  SentMessage,
} from "@blether/protocol";

/** Bumped whenever the schema changes incompatibly. */
const SCHEMA_VERSION = 2;

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
 * Durable storage for the relay: developers' identity logs, which developer
 * owns each agent, and agents' mailboxes. A message's body is kept only until
 * the recipient reads it; after that the relay keeps just enough to report
 * its delivery status to the sender.
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
      CREATE TABLE IF NOT EXISTS agents (
        name  TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES developers (id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        id        TEXT NOT NULL UNIQUE,
        sender    TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body      TEXT,
        sent_at   TEXT NOT NULL,
        status    TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'read'))
      );
      CREATE INDEX IF NOT EXISTS messages_unread
        ON messages (recipient, seq) WHERE status <> 'read';
      CREATE INDEX IF NOT EXISTS messages_sent ON messages (sender, seq);
    `);
  }

  /** Stores a verified identity, replacing any older copy of its log. */
  saveDeveloper(identity: Identity, log: IdentityLog): void {
    this.db
      .prepare(
        `INSERT INTO developers (id, name, log) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, log = excluded.log`,
      )
      .run(identity.id, identity.name, JSON.stringify(log));
  }

  /** The developer id that owns `agent`, if any session has acted as it. */
  agentOwner(agent: AgentName): string | undefined {
    const row = this.db
      .prepare("SELECT owner FROM agents WHERE name = ?")
      .get(agent) as { owner: string } | undefined;
    return row?.owner;
  }

  /**
   * Records that `owner` owns `agent`, so others can message it. Until agents
   * are created deliberately (#8), the first developer to act as a name owns it.
   */
  claimAgent(agent: AgentName, owner: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO agents (name, owner) VALUES (?, ?)")
      .run(agent, owner);
  }

  /**
   * Puts a message in its recipient's mailbox with status `queued`.
   * Returns false, storing nothing, if a message with that id already exists.
   */
  add(message: Message): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, sender, recipient, body, sent_at, status)
         VALUES (?, ?, ?, ?, ?, 'queued')`,
      )
      .run(message.id, message.from, message.to, message.body, message.sentAt);
    return changes === 1;
  }

  markDelivered(id: string): void {
    this.db
      .prepare(
        "UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'queued'",
      )
      .run(id);
  }

  /** Marks messages in `agent`'s mailbox read and discards their bodies. Ids for other mailboxes are ignored. */
  markRead(agent: AgentName, ids: readonly string[]): void {
    const update = this.db.prepare(
      `UPDATE messages SET status = 'read', body = NULL
       WHERE id = ? AND recipient = ? AND status <> 'read'`,
    );
    for (const id of ids) update.run(id, agent);
  }

  /** Every message in `agent`'s mailbox it hasn't read yet, oldest first. */
  unread(agent: AgentName): Message[] {
    const rows = this.db
      .prepare(
        `SELECT id, sender, recipient, body, sent_at FROM messages
         WHERE recipient = ? AND status <> 'read' ORDER BY seq`,
      )
      .all(agent) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      from: row.sender,
      to: row.recipient,
      body: row.body,
      sentAt: row.sent_at,
    }));
  }

  /** The `limit` messages `agent` sent most recently, newest first. */
  sentBy(agent: AgentName, limit: number): SentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, recipient, sent_at, status FROM messages
         WHERE sender = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(agent, limit) as unknown as SentRow[];
    return rows.map((row) => ({
      id: row.id,
      to: row.recipient,
      sentAt: row.sent_at,
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
  body: string;
  sent_at: string;
}

interface SentRow {
  id: string;
  recipient: string;
  sent_at: string;
  status: DeliveryStatus;
}
