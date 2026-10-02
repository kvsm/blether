import { describe, expect, it } from "vitest";
import { RelayStats } from "./stats.js";

const fanout = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const team = "a1b2c3d4e5f6";

describe("RelayStats in debug mode", () => {
  it("counts copies without a hint as unlabelled, still per recipient", () => {
    const stats = new RelayStats(new Date(0), true);
    stats.record(team, "backend", "api", undefined);
    stats.record(team, "backend", "web", {
      audience: { kind: "agent" },
      fanout: fanout(1),
    });

    const report = stats.report();

    expect(report).toContain("by recipient: api 1, web 1");
    expect(report).toContain("direct 1, everyone 0; 1 stored without a hint");
  });

  it("counts a fan-out once however many copies it has", () => {
    const stats = new RelayStats(new Date(0), true);
    const hint = { audience: { kind: "everyone" as const }, fanout: fanout(2) };
    for (const agent of ["api", "ui", "web"]) {
      stats.record(team, "backend", agent, hint);
    }

    expect(stats.report()).toContain("1: direct 0, everyone 1");
  });

  it("ignores hints outside debug mode", () => {
    const stats = new RelayStats(new Date(0), false);
    stats.record(team, "backend", "api", {
      audience: { kind: "role", role: "frontend" },
      fanout: fanout(3),
    });

    expect(stats.report()).not.toContain("frontend");
  });
});
