import type { AudienceHint } from "@blether/protocol";

/** Fan-out ids remembered so each send is counted once; copies of one send arrive together. */
const RECENT_FANOUTS = 10_000;

interface TeamStats {
  name: string;
  /** Messages stored for each recipient agent: one per copy. */
  toAgent: Map<string, number>;
  /** Debug mode: sends by audience, each fan-out counted once. */
  direct: number;
  toRole: Map<string, number>;
  toEveryone: number;
  /** Debug mode: copies that came with no usable hint. */
  unlabelled: number;
}

/**
 * Counts the messages a relay stores, from what it already sees (the
 * recipient of each copy) and, in debug mode, from the audience hints
 * bridges send. Counts start from zero when the relay starts.
 */
export class RelayStats {
  private readonly teams = new Map<string, TeamStats>();
  private readonly fanouts = new Set<string>();
  private total = 0;
  private reported = 0;

  constructor(
    private readonly since: Date,
    private readonly debugAudience: boolean,
  ) {}

  /** Counts one stored copy, for `recipient` in the team `teamId` (called `teamName`). */
  record(
    teamId: string,
    teamName: string,
    recipient: string,
    hint: AudienceHint | undefined,
  ): void {
    const team = this.team(teamId, teamName);
    this.total++;
    team.toAgent.set(recipient, (team.toAgent.get(recipient) ?? 0) + 1);
    if (!this.debugAudience) return;
    if (!hint) {
      team.unlabelled++;
      return;
    }
    if (this.fanouts.has(hint.fanout)) return;
    this.remember(hint.fanout);
    const { audience } = hint;
    if (audience.kind === "agent") team.direct++;
    else if (audience.kind === "everyone") team.toEveryone++;
    else
      team.toRole.set(audience.role, (team.toRole.get(audience.role) ?? 0) + 1);
  }

  /** Whether anything has been counted since the relay started. */
  get any(): boolean {
    return this.total > 0;
  }

  /** Whether anything has been counted since the last report. */
  get changed(): boolean {
    return this.total !== this.reported;
  }

  /** A summary for the relay's output, marking everything up to now as reported. */
  report(): string {
    const lines = [
      `Messages since ${this.since.toISOString()}: ${this.total} stored (${this.total - this.reported} new)`,
    ];
    this.reported = this.total;
    for (const team of [...this.teams.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const stored = [...team.toAgent.values()].reduce((a, b) => a + b, 0);
      const recipients = [...team.toAgent]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([agent, n]) => `${agent} ${n}`)
        .join(", ");
      lines.push(
        `  ${team.name}: ${stored} stored, by recipient: ${recipients}`,
      );
      if (this.debugAudience) {
        const roles = [...team.toRole]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([role, n]) => `role ${role} ${n}`);
        const sends = team.direct + team.toEveryone + sum(team.toRole);
        lines.push(
          `    sends (each counted once, from bridges' hints): ${sends}: ` +
            [
              `direct ${team.direct}`,
              ...roles,
              `everyone ${team.toEveryone}`,
            ].join(", ") +
            (team.unlabelled > 0
              ? `; ${team.unlabelled} stored without a hint`
              : ""),
        );
      }
    }
    return lines.join("\n");
  }

  private team(id: string, name: string): TeamStats {
    // Names needn't be unique across a relay's teams, so add the id's start.
    const label = `${name} (${id.slice(0, 8)})`;
    let team = this.teams.get(id);
    if (!team) {
      team = {
        name: label,
        toAgent: new Map(),
        direct: 0,
        toRole: new Map(),
        toEveryone: 0,
        unlabelled: 0,
      };
      this.teams.set(id, team);
    }
    team.name = label;
    return team;
  }

  private remember(fanout: string) {
    this.fanouts.add(fanout);
    if (this.fanouts.size > RECENT_FANOUTS) {
      const oldest = this.fanouts.values().next().value!;
      this.fanouts.delete(oldest);
    }
  }
}

function sum(counts: Map<string, number>) {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}
