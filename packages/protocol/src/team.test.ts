import { describe, expect, it } from "vitest";
import { generateDeviceKey, randomToken, sign } from "./crypto.js";
import {
  createIdentity,
  verifyIdentityLog,
  type Identity,
} from "./identity.js";
import {
  InviteLinkError,
  formatInviteLink,
  parseInviteLink,
} from "./invite.js";
import {
  TeamError,
  acceptInvite,
  createInvite,
  createTeam,
  isInviteOpen,
  revokeInvite,
  verifyTeamLog,
  type Signer,
  type TeamLog,
} from "./team.js";

function developer(name: string): Signer {
  const device = generateDeviceKey();
  return {
    device,
    identity: verifyIdentityLog(createIdentity(device, name)),
  };
}

const kev = developer("Kev");
const carol = developer("Carol");
const dan = developer("Dan");
const identities = new Map<string, Identity>(
  [kev, carol, dan].map((d) => [d.identity.id, d.identity]),
);
const verify = (log: TeamLog) => verifyTeamLog(log, identities);

/** A team created by Kev, with an open invite for Carol. */
function teamWithInvite(ttlHours?: number) {
  const log = createTeam("backend", kev);
  const created = createInvite(
    verify(log),
    kev,
    ttlHours === undefined ? {} : { ttlHours },
  );
  log.push(created.entry);
  return { log, ...created };
}

describe("team log", () => {
  it("makes the creator the Team Admin and only member", () => {
    const team = verify(createTeam("backend", kev));

    expect(team.name).toBe("backend");
    expect(team.admin).toBe(kev.identity.id);
    expect(team.members).toEqual([kev.identity.id]);
    expect(team.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("keeps the team id as the log grows", () => {
    const { log } = teamWithInvite();

    expect(verify(log).id).toBe(verify(log.slice(0, 1)).id);
  });

  it("adds a member who holds the invite secret", () => {
    const { log, invite, secret } = teamWithInvite();
    log.push(acceptInvite(verify(log), invite, secret, carol));

    const team = verify(log);
    expect(team.members).toEqual([kev.identity.id, carol.identity.id]);
    expect(team.invites[0]?.status).toBe("used");
  });

  it("refuses a join signed without the invite secret", () => {
    const { log, invite } = teamWithInvite();
    log.push(acceptInvite(verify(log), invite, randomToken(), carol));

    expect(() => verify(log)).toThrow(/isn't signed by the invite key/);
  });

  it("refuses a second use of the same invite", () => {
    const { log, invite, secret } = teamWithInvite();
    log.push(acceptInvite(verify(log), invite, secret, carol));
    log.push(acceptInvite(verify(log), invite, secret, dan));

    expect(() => verify(log)).toThrow(/invite is used/);
  });

  it("refuses a join after the invite has expired", () => {
    const { log, invite, secret } = teamWithInvite(1);
    const later = new Date(Date.now() + 2 * 3_600_000);
    log.push(acceptInvite(verify(log), invite, secret, carol, later));

    expect(() => verify(log)).toThrow(/expired/);
  });

  it("refuses a join with a revoked invite", () => {
    const { log, invite, secret } = teamWithInvite();
    log.push(revokeInvite(verify(log), invite, kev));
    log.push(acceptInvite(verify(log), invite, secret, carol));

    expect(() => verify(log)).toThrow(/invite is revoked/);
  });

  it("only lets the inviter or the Team Admin revoke an invite", () => {
    const { log, invite, secret } = teamWithInvite();
    log.push(acceptInvite(verify(log), invite, secret, carol));
    const byCarol = createInvite(verify(log), carol);
    log.push(byCarol.entry);

    const dansAttempt = [
      ...log,
      revokeInvite(verify(log), byCarol.invite, dan),
    ];
    expect(() => verify(dansAttempt)).toThrow(
      /only the inviter or the Team Admin/,
    );

    const adminRevokes = [
      ...log,
      revokeInvite(verify(log), byCarol.invite, kev),
    ];
    expect(verify(adminRevokes).invites[1]?.status).toBe("revoked");
  });

  it("only lets members invite", () => {
    const log = createTeam("backend", kev);
    log.push(createInvite(verify(log), dan).entry);

    expect(() => verify(log)).toThrow(/only members can invite/);
  });

  it("refuses an entry that doesn't follow the one before it", () => {
    const { log } = teamWithInvite();
    const second = createInvite(verify(log.slice(0, 1)), kev).entry;
    log.push(second);

    expect(() => verify(log)).toThrow(/doesn't follow/);
  });

  it("refuses an entry whose content was changed after signing", () => {
    const { log } = teamWithInvite();
    const entry = log[1]!.entry;
    if (entry.type !== "invite-created") throw new Error("unexpected");
    entry.expiresAt = "2999-01-01T00:00:00.000Z";

    expect(() => verify(log)).toThrow(/invalid signature/);
  });

  it("refuses an entry signed by a device its author doesn't own", () => {
    const log = createTeam("backend", kev);
    const forged = { ...log[0]!, signer: carol.device.publicKey };
    forged.signature = sign(carol.device, "anything");

    expect(() => verify([forged])).toThrow(/device its author doesn't own/);
  });

  it("refuses an author it has no identity for", () => {
    const stranger = developer("Stranger");

    expect(() => verify(createTeam("backend", stranger))).toThrow(
      /unknown author/,
    );
  });

  it("knows when an invite has expired", () => {
    const { log } = teamWithInvite(1);
    const [invite] = verify(log).invites;

    expect(isInviteOpen(invite!)).toBe(true);
    expect(isInviteOpen(invite!, new Date(Date.now() + 2 * 3_600_000))).toBe(
      false,
    );
  });

  it("rejects malformed logs", () => {
    expect(() => verifyTeamLog([], identities)).toThrow(TeamError);
  });
});

describe("invite links", () => {
  const link = {
    relayUrl: "wss://relay.example.com",
    teamId: "a".repeat(43),
    inviteId: "b".repeat(22),
    secret: "c".repeat(43),
  };

  it("round-trips a wss relay as blether://", () => {
    const text = formatInviteLink(link);

    expect(text).toBe(
      `blether://relay.example.com/${"a".repeat(43)}/${"b".repeat(22)}#${"c".repeat(43)}`,
    );
    expect(parseInviteLink(text)).toEqual(link);
  });

  it("round-trips a local ws relay, with its port, as blether+ws://", () => {
    const local = { ...link, relayUrl: "ws://127.0.0.1:7357" };
    const text = formatInviteLink(local);

    expect(text.startsWith("blether+ws://127.0.0.1:7357/")).toBe(true);
    expect(parseInviteLink(text)).toEqual(local);
  });

  it("rejects text that isn't an invite", () => {
    expect(() => parseInviteLink("https://example.com")).toThrow(
      InviteLinkError,
    );
    expect(() =>
      parseInviteLink(formatInviteLink(link).replace(/#.*/, "")),
    ).toThrow(InviteLinkError);
  });
});
