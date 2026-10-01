import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultBletherHome } from "./keystore.js";

/**
 * Escalations (see CONTEXT.md): an agent setting a message aside until its
 * developer decides what to do with it.
 *
 * They are bookkeeping, not a security boundary. The agent records the
 * developer's answer from the conversation; a message that could trick it
 * into faking an answer could equally trick it into not escalating. What
 * escalations guarantee is that a question is never lost: it survives the
 * session ending, and is raised again until it's answered.
 */

export const Escalation = z.object({
  id: z.string(),
  /** The message the escalation is about. */
  messageId: z.uuid(),
  /** The agent that sent the message. */
  from: z.string(),
  /** The message's text, so the developer can see what they're deciding. */
  body: z.string(),
  /** What the agent needs the developer to decide. */
  question: z.string().min(1),
  createdAt: z.iso.datetime(),
  status: z.enum(["pending", "approved", "declined"]),
  answeredAt: z.iso.datetime().optional(),
  /** Anything the developer added when answering. */
  note: z.string().optional(),
});
export type Escalation = z.infer<typeof Escalation>;

const EscalationFile = z.array(Escalation);

/** One agent's escalations on this device, in `<home>/escalations/<team>.<agent>.json`. */
export class EscalationStore {
  constructor(
    readonly home: string,
    readonly team: string,
    readonly agent: string,
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(team + agent)) {
      throw new Error("Bad team or agent name.");
    }
  }

  private get path() {
    return join(this.home, "escalations", `${this.team}.${this.agent}.json`);
  }

  all(): Escalation[] {
    if (!existsSync(this.path)) return [];
    return EscalationFile.parse(JSON.parse(readFileSync(this.path, "utf8")));
  }

  pending(): Escalation[] {
    return this.all().filter((e) => e.status === "pending");
  }

  get(id: string): Escalation | undefined {
    return this.all().find((e) => e.id === id);
  }

  add(
    escalation: Omit<Escalation, "id" | "status" | "createdAt">,
    now = new Date(),
  ): Escalation {
    const created: Escalation = {
      ...escalation,
      id: randomUUID().slice(0, 8),
      status: "pending",
      createdAt: now.toISOString(),
    };
    this.write([...this.all(), created]);
    return created;
  }

  /** Records the developer's answer. Throws if there's no such pending escalation. */
  answer(
    id: string,
    decision: "approved" | "declined",
    note: string | undefined,
    now = new Date(),
  ): Escalation {
    const all = this.all();
    const escalation = all.find((e) => e.id === id);
    if (!escalation) throw new Error(`There's no escalation ${id}.`);
    if (escalation.status !== "pending") {
      throw new Error(`Escalation ${id} was already ${escalation.status}.`);
    }
    escalation.status = decision;
    escalation.answeredAt = now.toISOString();
    if (note) escalation.note = note;
    this.write(all);
    return escalation;
  }

  private write(escalations: Escalation[]) {
    mkdirSync(join(this.home, "escalations"), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(escalations, null, 2) + "\n", {
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }
}

/** Every agent's pending escalations on this device, keyed by agent. */
export function allPendingEscalations(
  home: string = defaultBletherHome(),
): { team: string; agent: string; escalations: Escalation[] }[] {
  const dir = join(home, "escalations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const [team, agent] = file.slice(0, -".json".length).split(".");
      const escalations = new EscalationStore(home, team!, agent!).pending();
      return { team: team!, agent: agent!, escalations };
    })
    .filter((entry) => entry.escalations.length > 0);
}
