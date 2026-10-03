import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InboxFile, inboxPath, readInboxState } from "./inbox-file.js";
import {
  hookOutput,
  mailboxMark,
  waitForFreshInbox,
  watchInbox,
} from "./watch.js";

describe("telling hosts without channels about mail", () => {
  let home: string;
  let path: string;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-inbox-"));
    path = inboxPath(home, "team", "web");
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const watch = () => {
    const lines: string[] = [];
    stop = watchInbox(path, (l) => lines.push(l), { intervalMs: 10 });
    return lines;
  };

  it("keeps who and how many, never what was said", () => {
    new InboxFile(path).arrived("api", 1, ["api"]);

    expect(readInboxState(path)).toMatchObject({
      arrivals: 1,
      unread: 1,
      from: ["api"],
      lastFrom: "api",
    });
  });

  it("prints a line for each arrival, and nothing for reads", async () => {
    const inbox = new InboxFile(path);
    inbox.write(0, []);
    const lines = watch();

    inbox.arrived("api", 1, ["api"]);
    await expect.poll(() => lines.length).toBe(1);
    inbox.write(0, []);
    inbox.arrived("docs", 1, ["docs"]);
    await expect.poll(() => lines.length).toBe(2);

    expect(lines).toEqual([
      "New Blether message from api. 📬 1 unread Blether message (from api). Call read_mailbox to read them.",
      "New Blether message from docs. 📬 1 unread Blether message (from docs). Call read_mailbox to read them.",
    ]);
  });

  it("says once at the start if mail is already waiting", () => {
    new InboxFile(path).arrived("api", 2, ["api"]);

    expect(watch()).toEqual([
      "📬 2 unread Blether messages (from api). Call read_mailbox to read them.",
    ]);
  });

  it("starts watching once a bridge first writes the file", async () => {
    const lines = watch();

    new InboxFile(path).arrived("api", 1, ["api"]);

    await expect
      .poll(() => lines)
      .toEqual([
        "📬 1 unread Blether message (from api). Call read_mailbox to read them.",
      ]);
  });

  const context = (output: string | undefined) =>
    output === undefined
      ? undefined
      : (
          JSON.parse(output) as {
            hookSpecificOutput: { additionalContext: string };
          }
        ).hookSpecificOutput.additionalContext;

  it("says nothing to hooks when no mail is waiting", () => {
    expect(
      hookOutput({ event: "SessionStart", state: undefined }),
    ).toBeUndefined();
    new InboxFile(path).write(0, []);
    expect(
      hookOutput({ event: "UserPromptSubmit", state: readInboxState(path) }),
    ).toBeUndefined();
  });

  it("tells a new session to read its mail before responding", () => {
    new InboxFile(path).arrived("api", 1, ["api"]);

    expect(
      JSON.parse(
        hookOutput({ event: "SessionStart", state: readInboxState(path) })!,
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "📬 You have 1 unread Blether message (from api). Before you respond to the developer, call mcp__plugin_blether_blether__read_mailbox (load it with ToolSearch first if it's deferred): a teammate may have sent something that affects your work.",
      },
    });
  });

  it("reminds on a prompt only when the mail has changed", () => {
    const inbox = new InboxFile(path);
    inbox.arrived("api", 1, ["api"]);
    const told = mailboxMark(readInboxState(path));

    expect(
      hookOutput({
        event: "UserPromptSubmit",
        state: readInboxState(path),
        told,
      }),
    ).toBeUndefined();

    inbox.arrived("docs", 2, ["api", "docs"]);
    expect(
      context(
        hookOutput({
          event: "UserPromptSubmit",
          state: readInboxState(path),
          told,
        }),
      ),
    ).toBe(
      "📬 New Blether mail: 2 unread Blether messages (from api, docs). Call mcp__plugin_blether_blether__read_mailbox before you carry on.",
    );
  });

  it("asks the agent to start its own watch where the host has no monitor", () => {
    const said = context(
      hookOutput({
        event: "SessionStart",
        state: undefined,
        watchCommand: 'node "cli.js" watch',
      }),
    );

    expect(said).toContain("Monitor tool");
    expect(said).toContain('node "cli.js" watch');
    expect(said).toContain("start it again each time it expires");
  });

  it("waits at session start for the new bridge's count, not the last session's", async () => {
    new InboxFile(path, () => new Date(Date.now() - 60_000)).write(0, []);
    const since = new Date();
    const waited = waitForFreshInbox(path, since, { intervalMs: 10 });

    setTimeout(() => new InboxFile(path).arrived("api", 1, ["api"]), 50);
    await waited;

    expect(readInboxState(path)?.unread).toBe(1);
  });

  it("gives up waiting when no bridge writes", async () => {
    const started = Date.now();
    await waitForFreshInbox(path, new Date(), {
      timeoutMs: 50,
      intervalMs: 10,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(readInboxState(path)).toBeUndefined();
  });
});
