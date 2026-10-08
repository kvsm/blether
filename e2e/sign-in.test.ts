import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, startBridge, type StartedBridge } from "@blether/bridge";
import {
  startRelay,
  tokenAccess,
  tokenHash,
  type Relay,
  type Rules,
} from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

const KEV_TOKEN = "kev-token-kev-token-kev-token-kev-token";
const CAROL_TOKEN = "carol-token-carol-token-carol-token";

/** A relay that admits Kev and Carol by token; only Kev may create teams if `rules` says so. */
const tokenRelay = (rules?: Rules) =>
  startRelay({
    access: {
      provider: tokenAccess([
        {
          subject: "kev",
          sha256: tokenHash(KEV_TOKEN),
          claims: { roles: "team-creator" },
        },
        { subject: "carol", sha256: tokenHash(CAROL_TOKEN) },
      ]),
      ...(rules ? { rules } : {}),
    },
  });

describe("signing in to a relay", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  let started: StartedBridge | undefined;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "blether-sign-in-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await started?.close();
    started = undefined;
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const signIn = async (who: Device, token: string, target: string) => {
    who.typeSecret(token);
    return who.run("sign-in", target);
  };

  it("lets signed-in developers create a team, join it and message each other", async () => {
    relay = await tokenRelay();

    const signedIn = await signIn(kev, KEV_TOKEN, relay.url);
    expect(signedIn).toMatchObject({ code: 0 });
    expect(signedIn.out).toBe(`Signed in to the relay at ${relay.url}.`);
    expect((await kev.run("whoami")).out).toContain(
      `Signed in to:\n  ${relay.url}  (token, since `,
    );

    await kev.run("team", "create", "backend", "--relay", relay.url);
    const invite = await kev.invite("backend");
    // Carol signs in with the invite, before she's in the team.
    expect(await signIn(carol, CAROL_TOKEN, invite)).toMatchObject({ code: 0 });
    expect(await carol.run("join", invite)).toMatchObject({ code: 0 });

    await kev.run("agent", "create", "backend", "web");
    await carol.run("agent", "create", "backend", "api");
    const web = await kev.session("backend", "web");
    const api = await carol.session("backend", "api");
    cleanups.push(web.close, api.close);
    await web.call("send_message", { to: "api", body: "Signed in and here" });
    await expect
      .poll(() => api.call("read_mailbox"))
      .toContain("Signed in and here");
  });

  it("tells a developer who hasn't signed in how to", async () => {
    relay = await tokenRelay();

    const result = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      relay.url,
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain(`blether sign-in ${relay.url}`);
  });

  it("keeps no sign-in the relay doesn't accept", async () => {
    relay = await tokenRelay();

    const result = await signIn(kev, "not-a-token", relay.url);

    expect(result.code).toBe(1);
    expect(result.err).toContain("didn't accept your sign-in");
    expect((await kev.run("whoami")).out).not.toContain("Signed in to");
  });

  it("only signs in at an interactive terminal", async () => {
    relay = await tokenRelay();
    const err: string[] = [];

    const code = await runCli(["sign-in", relay.url], {
      store: kev.store,
      teams: kev.teams,
      io: { out: () => {}, err: (line) => err.push(line) },
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("interactive terminal");
  });

  it("says an open relay needs no sign-in", async () => {
    relay = await startRelay();

    const result = await kev.run("sign-in", relay.url);

    expect(result).toMatchObject({ code: 0 });
    expect(result.out).toBe(
      `The relay at ${relay.url} doesn't need a sign-in.`,
    );
  });

  it("forgets a sign-in", async () => {
    relay = await tokenRelay();
    await signIn(kev, KEV_TOKEN, relay.url);
    await kev.run("team", "create", "backend", "--relay", relay.url);

    expect((await kev.run("sign-out", "backend")).out).toBe(
      `Signed out of the relay at ${relay.url}.`,
    );
    const members = await kev.run("team", "members", "backend");
    expect(members.code).toBe(1);
    expect(members.err).toContain("requires a sign-in");
  });

  it("refuses to create a team when the relay's rules don't allow it", async () => {
    relay = await tokenRelay({
      connect: "signed-in",
      "team.create": [{ claim: "roles", value: "team-creator" }],
    });
    await signIn(carol, CAROL_TOKEN, relay.url);

    const result = await carol.run(
      "team",
      "create",
      "frontend",
      "--relay",
      relay.url,
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain("doesn't allow you to create teams");
  });

  it("tells the agent the developer must sign in when the bridge can't", async () => {
    relay = await tokenRelay();
    await signIn(kev, KEV_TOKEN, relay.url);
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
    await kev.run("sign-out", relay.url);

    started = await startBridge(
      {
        BLETHER_HOME: kev.store.home,
        BLETHER_PROJECT_DIR: join(root, "elsewhere"),
        BLETHER_TEAM: "backend",
        BLETHER_AGENT: "web",
      },
      () => {},
    );

    expect(started.problem).toContain("sign-in-required");
    expect(started.problem).toContain(
      "run `blether sign-in backend` in their own terminal",
    );
  });
});
