import { DatabaseSync } from "node:sqlite";
import type {
  AgentName,
  DeliveryStatus,
  Message,
  SentMessage,
} from "@blether/protocol";

/**
 * Durable storage for agents' mailboxes. A message's body is kept only until
 * the recipient reads it; after that the relay keeps just enough to report
 * its delivery status to the sender.
 */
export class MailboxStore {
  private readonly db: DatabaseSync;

  /** Opens (creating if needed) a store at `path`, or in memory for ":memory:". */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY
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

  /** Records that a session has acted as `agent`, so others can message it. */
  rememberAgent(agent: AgentName): void {
    this.db
      .prepare("INSERT OR IGNORE INTO agents (name) VALUES (?)")
      .run(agent);
  }

  isKnownAgent(agent: AgentName): boolean {
    return (
      this.db.prepare("SELECT 1 FROM agents WHERE name = ?").get(agent) !==
      undefined
    );
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
