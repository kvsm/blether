import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay, type RelayOptions } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

/** The message counts a relay prints for its operator. */
describe("relay statistics", () => {
  let relay: Relay | undefined;
  let root: string;
  let kev: Device;
  let carol: Device;
  let lines: string[];
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blether-stats-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    lines = [];
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay?.close();
    relay = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /** A relay that prints only on shutdown, and a team with web, docs (frontend) and api, ui (frontend). */
  const setUp = async (options: RelayOptions = {}) => {
    relay = await startRelay({
      statsIntervalMs: 0,
      log: (l) => lines.push(l),
      ...options,
    });
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await carol.run("join", await kev.invite("backend"));
    await kev.run("role", "add", "backend", "frontend");
    await kev.run("agent", "create", "backend", "web");
    await kev.run("agent", "create", "backend", "docs", "--role", "frontend");
    await carol.run("agent", "create", "backend", "api");
    await carol.run("agent", "create", "backend", "ui", "--role", "frontend");
  };

  const session = async (
    who: Device,
    agent: string,
    log?: (line: string) => void,
  ) => {
    const s = await who.session("backend", agent, log ? { log } : {});
    cleanups.push(s.close);
    return s;
  };

  /** One direct message, one to the frontend role (2 copies), one to everyone (3 copies). */
  const sendMix = async (web: Awaited<ReturnType<typeof session>>) => {
    await web.call("send_message", { to: "api", body: "direct" });
    await web.call("send_message", { role: "frontend", body: "role" });
    await web.call("send_message", { everyone: true, body: "all" });
  };

  const shutdownReport = async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay!.close();
    relay = undefined;
    return lines.join("\n");
  };

  it("counts messages stored for each recipient, and nothing about audiences by default", async () => {
    await setUp();
    const bridgeLog: string[] = [];
    const web = await session(kev, "web", (l) => bridgeLog.push(l));

    await sendMix(web);
    const report = await shutdownReport();

    expect(report).toContain(": 6 stored (6 new)");
    expect(report).toMatch(
      /backend \([\w-]{8}\): 6 stored, by recipient: api 2, docs 2, ui 2/,
    );
    expect(report).not.toContain("sends");
    expect(bridgeLog.join("\n")).not.toContain("audience hints");
  });

  it("counts role messages and broadcasts once each in debug mode", async () => {
    await setUp({ debugAudience: true });
    const bridgeLog: string[] = [];
    const web = await session(kev, "web", (l) => bridgeLog.push(l));

    await sendMix(web);
    const report = await shutdownReport();

    expect(report).toContain("api 2, docs 2, ui 2");
    expect(report).toContain(
      "sends (each counted once, from bridges' hints): 3: direct 1, role frontend 1, everyone 1",
    );
    expect(report).not.toContain("without a hint");
    expect(bridgeLog.join("\n")).toContain(
      "is in debug mode and asked for audience hints",
    );
  });

  it("keeps teams apart", async () => {
    await setUp();
    await kev.run("team", "create", "frontend", "--relay", relay!.url);
    await kev.run("agent", "create", "frontend", "site");
    await kev.run("agent", "create", "frontend", "app");
    const web = await session(kev, "web");
    await web.call("send_message", { to: "api", body: "hi" });
    const site = await kev.session("frontend", "site");
    cleanups.push(site.close);
    await site.call("send_message", { to: "app", body: "hi" });

    const report = await shutdownReport();

    expect(report).toContain(": 2 stored");
    expect(report).toMatch(
      /backend \([\w-]{8}\): 1 stored, by recipient: api 1/,
    );
    expect(report).toMatch(
      /frontend \([\w-]{8}\): 1 stored, by recipient: app 1/,
    );
  });

  it("prints periodically only when there are new messages", async () => {
    await setUp({ statsIntervalMs: 20 });
    const web = await session(kev, "web");

    await web.call("send_message", { to: "api", body: "one" });
    await expect.poll(() => lines.join("\n")).toContain("1 stored (1 new)");
    const printed = lines.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBe(printed);

    await web.call("send_message", { to: "api", body: "two" });
    await expect.poll(() => lines.join("\n")).toContain("2 stored (1 new)");
  });

  it("prints nothing on shutdown when no messages were sent", async () => {
    await setUp();
    expect(await shutdownReport()).not.toContain("stored");
  });
});
