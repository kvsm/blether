import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignIns, startBridge, type StartedBridge } from "@blether/bridge";
import { oidcAccess, startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIENCE,
  CLIENT_ID,
  identityProvider,
  type IdentityProvider,
} from "./identity-provider.js";
import { device, type Device } from "./support.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("signing in to a relay with OpenID Connect", () => {
  let idp: IdentityProvider;
  let relay: Relay;
  let root: string;
  let kev: Device;
  let started: StartedBridge | undefined;

  const oidcRelay = (timing: { warnBeforeExpiryMs?: number } = {}) =>
    startRelay({
      access: {
        provider: oidcAccess({
          issuer: idp.issuer,
          audience: AUDIENCE,
          clientId: CLIENT_ID,
          scopes: ["relay.access", "offline_access"],
        }),
        ...timing,
        graceAfterExpiryMs: 0,
      },
    });

  beforeEach(async () => {
    idp = await identityProvider();
    root = mkdtempSync(join(tmpdir(), "blether-oidc-"));
    kev = device(root, "kev");
    kev.useBrowser(idp.browser);
    await kev.run("init", "--name", "Kev");
  });
  afterEach(async () => {
    await started?.close();
    started = undefined;
    await relay.close();
    await idp.close();
    rmSync(root, { recursive: true, force: true });
  });

  const saved = () => new SignIns(kev.store.home).get(relay.url);

  it("signs in through the browser, then uses the relay", async () => {
    relay = await oidcRelay();
    let opened: string | undefined;
    kev.useBrowser((url) => {
      opened = url;
      return idp.browser(url);
    });

    const signedIn = await kev.run("sign-in", relay.url);

    expect(signedIn).toMatchObject({ code: 0 });
    expect(signedIn.out).toContain("Opening your browser to sign in");
    expect(signedIn.out).toContain(`Signed in to the relay at ${relay.url}.`);
    const asked = new URL(opened!);
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked.searchParams.get("scope")).toBe("relay.access offline_access");
    expect(idp.grants).toEqual(["authorization_code"]);
    expect(saved()).toMatchObject({
      kind: "oidc",
      refreshToken: expect.any(String),
      access: { issuer: idp.issuer, clientId: CLIENT_ID },
    });
    expect((await kev.run("whoami")).out).toContain(
      `  ${relay.url}  (oidc, since `,
    );
    expect(
      await kev.run("team", "create", "backend", "--relay", relay.url),
    ).toMatchObject({ code: 0 });
  });

  it("signs in with a device code", async () => {
    relay = await oidcRelay();

    const signedIn = await kev.run("sign-in", relay.url, "--device-code");

    expect(signedIn).toMatchObject({ code: 0 });
    expect(signedIn.out).toContain(
      `go to ${idp.issuer}/activate and enter the code WDJB-MJHT`,
    );
    expect(idp.grants).toEqual([
      "urn:ietf:params:oauth:grant-type:device_code",
      "urn:ietf:params:oauth:grant-type:device_code",
    ]);
    expect(saved()?.kind).toBe("oidc");
  });

  it("says why the identity provider refused, and keeps nothing", async () => {
    relay = await oidcRelay();
    idp.deny();

    const result = await kev.run("sign-in", relay.url);

    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "Not signed in: Your administrator hasn't given you access. (access_denied)",
    );
    expect(saved()).toBeUndefined();
  });

  it("refreshes an access token that's running out before using it", async () => {
    relay = await oidcRelay();
    idp.tokensLast(120);
    await kev.run("sign-in", relay.url);
    const first = saved()!.credential;

    const created = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      relay.url,
    );

    expect(created).toMatchObject({ code: 0 });
    expect(idp.grants).toEqual(["authorization_code", "refresh_token"]);
    expect(saved()!.credential).not.toBe(first);
  });

  it("says to sign in again when the identity provider won't refresh", async () => {
    relay = await oidcRelay();
    idp.tokensLast(120);
    await kev.run("sign-in", relay.url);
    idp.revokeRefreshTokens();

    const result = await kev.run(
      "team",
      "create",
      "backend",
      "--relay",
      relay.url,
    );

    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `Couldn't renew your sign-in to the relay at ${relay.url}: The refresh token has expired. (invalid_grant) Run \`blether sign-in ${relay.url}\` to sign in again.`,
    );
  });

  it("keeps an agent session connected by renewing its sign-in as it runs out", async () => {
    relay = await oidcRelay({ warnBeforeExpiryMs: 2_000 });
    await kev.run("sign-in", relay.url);
    await kev.run("team", "create", "backend", "--relay", relay.url);
    await kev.run("agent", "create", "backend", "web");
    // From now on, each sign-in lasts three seconds.
    idp.tokensLast(3);
    await kev.run("sign-in", relay.url);
    const before = idp.grants.length;

    started = await startBridge(
      {
        BLETHER_HOME: kev.store.home,
        BLETHER_PROJECT_DIR: join(root, "elsewhere"),
        BLETHER_TEAM: "backend",
        BLETHER_AGENT: "web",
      },
      () => {},
    );
    await wait(5_000);

    expect(started.problem).toBeUndefined();
    const refreshes = idp.grants
      .slice(before)
      .filter((g) => g === "refresh_token");
    expect(refreshes.length).toBeGreaterThanOrEqual(3);
    idp.tokensLast(3600);
    expect((await kev.run("agent", "list", "backend")).out).toMatch(
      /web.*online/,
    );
  }, 15_000);
});
