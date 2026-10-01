import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Attachment } from "@blether/protocol";
import { z } from "zod";

/**
 * The messages an agent has sent from this device, kept locally (the relay
 * only ever holds them encrypted, and discards them once read). They let a
 * reply be shown with what it answers, and a lost message be resent.
 */
export const SentRecord = z.object({
  id: z.uuid(),
  to: z.string(),
  body: z.string(),
  attachments: z.array(Attachment).optional(),
  thread: z.uuid(),
  sentAt: z.iso.datetime(),
});
export type SentRecord = z.infer<typeof SentRecord>;

/** One agent's sent messages on this device, in `<home>/sent/<team>.<agent>.json`, most recent `limit` kept. */
export class SentLog {
  private records: SentRecord[] | undefined;

  constructor(
    readonly home: string,
    private readonly team: string,
    private readonly agent: string,
    private readonly limit = 1000,
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(team + agent)) {
      throw new Error("Bad team or agent name.");
    }
  }

  private get path() {
    return join(this.home, "sent", `${this.team}.${this.agent}.json`);
  }

  private load(): SentRecord[] {
    this.records ??= existsSync(this.path)
      ? z.array(SentRecord).parse(JSON.parse(readFileSync(this.path, "utf8")))
      : [];
    return this.records;
  }

  get(id: string): SentRecord | undefined {
    return this.load().find((r) => r.id === id);
  }

  add(record: SentRecord): void {
    this.records = [...this.load(), record].slice(-this.limit);
    mkdirSync(join(this.home, "sent"), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.records, null, 2) + "\n", {
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }
}
