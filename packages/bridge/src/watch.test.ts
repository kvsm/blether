import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InboxFile, inboxPath, readInboxState } from "./inbox-file.js";
import { hookOutput, watchInbox } from "./watch.js";

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

  it("answers hooks with the unread summary, or nothing", () => {
    expect(hookOutput("UserPromptSubmit", path)).toBeUndefined();
    new InboxFile(path).arrived("api", 1, ["api"]);

    expect(JSON.parse(hookOutput("UserPromptSubmit", path)!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "📬 1 unread Blether message (from api). Call read_mailbox to read them.",
      },
    });
    expect(hookOutput("SessionStart", undefined)).toBeUndefined();
  });
});
