import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InboxFile, inboxPath, readInboxState } from "./inbox-file.js";
import { watchInbox, type WatchEnd } from "./watch.js";

describe("telling a connected session about mail", () => {
  let home: string;
  let path: string;
  let inbox: InboxFile;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "blether-inbox-"));
    path = inboxPath(home, "team", "web");
    inbox = new InboxFile(path);
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const watch = (session = inbox.session, quietStart = false) => {
    const lines: string[] = [];
    const ended: WatchEnd[] = [];
    stop?.();
    stop = watchInbox(
      path,
      session,
      (l) => lines.push(l),
      (why) => ended.push(why),
      { intervalMs: 10, quietStart },
    );
    return { lines, ended };
  };

  it("keeps who and how many, never what was said", () => {
    inbox.arrived("api", 1, ["api"]);

    expect(readInboxState(path)).toMatchObject({
      session: inbox.session,
      arrivals: 1,
      unread: 1,
      from: ["api"],
      lastFrom: "api",
    });
  });

  it("prints a line for each arrival, and nothing for reads", async () => {
    inbox.write(0, []);
    const { lines } = watch();

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
    inbox.arrived("api", 2, ["api"]);

    expect(watch().lines).toEqual([
      "📬 2 unread Blether messages (from api). Call read_mailbox to read them.",
    ]);
  });

  it("doesn't repeat waiting mail when restarted quietly", () => {
    inbox.arrived("api", 2, ["api"]);
    watch();

    expect(watch(inbox.session, true).lines).toEqual([]);
  });

  it("reports mail that arrived between a watch and its quiet restart", () => {
    inbox.write(0, []);
    watch();
    stop?.();
    inbox.arrived("api", 1, ["api"]);

    expect(watch(inbox.session, true).lines).toEqual([
      "New Blether message from api. 📬 1 unread Blether message (from api). Call read_mailbox to read them.",
    ]);
  });

  it("says mail is waiting on a quiet start with no earlier watch", () => {
    inbox.arrived("api", 1, ["api"]);

    expect(watch(inbox.session, true).lines).toEqual([
      "📬 1 unread Blether message (from api). Call read_mailbox to read them.",
    ]);
  });

  it("waits for the bridge to write the file", async () => {
    const { lines } = watch();

    inbox.arrived("api", 1, ["api"]);

    await expect
      .poll(() => lines)
      .toEqual([
        "📬 1 unread Blether message (from api). Call read_mailbox to read them.",
      ]);
  });

  it("stops when its session disconnects, and a late write doesn't reopen it", async () => {
    inbox.write(0, []);
    const { lines, ended } = watch();

    inbox.close();
    inbox.arrived("api", 1, ["api"]);

    await expect.poll(() => ended).toEqual(["disconnected"]);
    expect(readInboxState(path)).toMatchObject({ closed: true, unread: 0 });
    expect(lines).toEqual([]);
  });

  it("stops when its session loses the relay for good", async () => {
    inbox.write(0, []);
    const { ended } = watch();

    inbox.close({ lost: true });

    await expect.poll(() => ended).toEqual(["lost"]);
  });

  it("stops when another session takes the agent over", async () => {
    inbox.write(0, []);
    const { lines, ended } = watch();

    new InboxFile(path).arrived("api", 1, ["api"]);

    await expect.poll(() => ended).toEqual(["taken-over"]);
    expect(lines).toEqual([]);
  });
});
