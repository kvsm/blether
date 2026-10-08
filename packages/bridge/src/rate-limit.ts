import { z } from "zod";

/**
 * Hard limits on how many messages an agent sends, to stop runaway loops:
 * two agents trading replies forever, or a broadcast that sets everyone
 * replying. Counted by the bridge over a sliding window.
 */
export const SendLimits = z.object({
  /** Most messages this agent may send, to anyone, within the window. */
  perAgent: z.number().int().min(1),
  /** Most messages this agent may send to any one agent within the window. */
  perRecipient: z.number().int().min(1),
  /** Most messages this agent may send in any one thread within the window. */
  perThread: z.number().int().min(1).default(10),
  windowMinutes: z.number().int().min(1),
});
export type SendLimits = z.infer<typeof SendLimits>;

export const DEFAULT_SEND_LIMITS: SendLimits = {
  perAgent: 30,
  perRecipient: 10,
  perThread: 10,
  windowMinutes: 10,
};

/** Why a send is over a limit, or undefined if it isn't. */
export type LimitCheck = string | undefined;

/** Counts an agent's sends and says when the next one would be over a limit. */
export class SendLimiter {
  private sends: { to: string; thread?: string | undefined; at: number }[] = [];

  constructor(
    private readonly agent: string,
    private readonly limits: SendLimits,
    private readonly now: () => Date,
  ) {}

  private recent(): { to: string; thread?: string | undefined; at: number }[] {
    const since = this.now().getTime() - this.limits.windowMinutes * 60_000;
    this.sends = this.sends.filter((s) => s.at > since);
    return this.sends;
  }

  /** Whether one more message to `to`, in `thread` if it's a reply, would be over a limit, and why. */
  check(to: string, thread?: string): LimitCheck {
    const recent = this.recent();
    const window = `the last ${this.limits.windowMinutes} minutes`;
    if (thread) {
      const inThread = recent.filter((s) => s.thread === thread).length;
      if (inThread >= this.limits.perThread) {
        return `${this.agent} has sent ${inThread} messages in this thread in ${window}. This may be a loop between agents.`;
      }
    }
    const toRecipient = recent.filter((s) => s.to === to).length;
    if (toRecipient >= this.limits.perRecipient) {
      return `${this.agent} has sent ${toRecipient} messages to ${to} in ${window}. This may be a loop between agents.`;
    }
    if (recent.length >= this.limits.perAgent) {
      return `${this.agent} has sent ${recent.length} messages in ${window}. This may be a runaway loop.`;
    }
    return undefined;
  }

  /** Whether sending one message to each of `recipients` would be over a limit, and why. */
  checkAll(recipients: readonly string[], thread?: string): LimitCheck {
    const recent = this.recent();
    if (recent.length + recipients.length > this.limits.perAgent) {
      return `${this.agent} has sent ${recent.length} messages in the last ${this.limits.windowMinutes} minutes, and this would send ${recipients.length} more. This may be a runaway loop.`;
    }
    for (const to of recipients) {
      const reason = this.check(to, thread);
      if (reason) return reason;
    }
    return undefined;
  }

  /** Counts a message that was sent, in `thread` if it was a reply. */
  record(to: string, thread?: string): void {
    this.sends.push({ to, thread, at: this.now().getTime() });
  }
}
