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
  windowMinutes: z.number().int().min(1),
});
export type SendLimits = z.infer<typeof SendLimits>;

export const DEFAULT_SEND_LIMITS: SendLimits = {
  perAgent: 30,
  perRecipient: 10,
  windowMinutes: 10,
};

/** Why a send is over a limit, or undefined if it isn't. */
export type LimitCheck = string | undefined;

/** Counts an agent's sends and says when the next one would be over a limit. */
export class SendLimiter {
  private sends: { to: string; at: number }[] = [];

  constructor(
    private readonly agent: string,
    private readonly limits: SendLimits,
    private readonly now: () => Date,
  ) {}

  private recent(): { to: string; at: number }[] {
    const since = this.now().getTime() - this.limits.windowMinutes * 60_000;
    this.sends = this.sends.filter((s) => s.at > since);
    return this.sends;
  }

  /** Whether one more message to `to` would be over a limit, and why. */
  check(to: string): LimitCheck {
    const recent = this.recent();
    const window = `the last ${this.limits.windowMinutes} minutes`;
    const toRecipient = recent.filter((s) => s.to === to).length;
    if (toRecipient >= this.limits.perRecipient) {
      return `${this.agent} has sent ${toRecipient} messages to ${to} in ${window}. This may be a loop between agents.`;
    }
    if (recent.length >= this.limits.perAgent) {
      return `${this.agent} has sent ${recent.length} messages in ${window}. This may be a runaway loop.`;
    }
    return undefined;
  }

  /** Counts a message that was sent. */
  record(to: string): void {
    this.sends.push({ to, at: this.now().getTime() });
  }
}
