import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "./crypto.js";
import {
  createIdentity,
  verifyIdentityLog,
  type Identity,
} from "./identity.js";
import {
  acceptInvite,
  createAgent,
  createInvite,
  createTeam,
  deleteAgent,
  removeMember,
  verifyTeamLog,
  type Signer,
  type TeamLog,
} from "./team.js";

function developer(name: string): Signer {
  const device = generateDeviceKey();
  return { device, identity: verifyIdentityLog(createIdentity(device, name)) };
}

const kev = developer("Kev");
const carol = developer("Carol");
const dan = developer("Dan");
const identities = new Map<string, Identity>(
  [kev, carol, dan].map((d) => [d.identity.id, d.identity]),
);
const verify = (log: TeamLog) => verifyTeamLog(log, identities);

/** Kev's team; Carol and Dan are members; Carol owns api, Dan owns ops. */
function team() {
  const log = createTeam("product", kev);
  for (const member of [carol, dan]) {
    const invite = createInvite(verify(log), kev);
    log.push(invite.entry);
    log.push(acceptInvite(verify(log), invite.invite, invite.secret, member));
  }
  log.push(createAgent(verify(log), "api", [], carol));
  log.push(createAgent(verify(log), "ops", [], dan));
  return log;
}

describe("removing members", () => {
  it("removes a member and deletes their agents", () => {
    const log = team();
    log.push(removeMember(verify(log), carol.identity.id, kev));

    const result = verify(log);
    expect(result.members).toEqual([kev.identity.id, dan.identity.id]);
    expect(result.agents.map((a) => a.name)).toEqual(["ops"]);
    expect(result.deletedAgents).toEqual([
      { name: "api", owner: carol.identity.id, deletedAt: expect.any(String) },
    ]);
  });

  it("only lets the Team Admin remove members", () => {
    const log = team();
    log.push(removeMember(verify(log), dan.identity.id, carol));

    expect(() => verify(log)).toThrow(/only the Team Admin can remove/);
  });

  it("doesn't let the Team Admin remove themselves", () => {
    const log = team();
    log.push(removeMember(verify(log), kev.identity.id, kev));

    expect(() => verify(log)).toThrow(/can't remove themselves/);
  });

  it("revokes the open invites a removed member created", () => {
    const log = team();
    log.push(createInvite(verify(log), carol).entry);
    log.push(removeMember(verify(log), carol.identity.id, kev));

    expect(verify(log).invites.at(-1)?.status).toBe("revoked");
  });

  it("stops a removed member making further changes", () => {
    const log = team();
    log.push(removeMember(verify(log), carol.identity.id, kev));
    log.push(createAgent(verify(log), "web", [], carol));

    expect(() => verify(log)).toThrow(/only members can create agents/);
  });
});

describe("deleting agents", () => {
  it("lets an agent's owner delete it", () => {
    const log = team();
    log.push(deleteAgent(verify(log), "api", carol));

    expect(verify(log).agents.map((a) => a.name)).toEqual(["ops"]);
  });

  it("lets the Team Admin delete any agent, but not other members", () => {
    const byAdmin = team();
    byAdmin.push(deleteAgent(verify(byAdmin), "api", kev));
    expect(verify(byAdmin).agents.map((a) => a.name)).toEqual(["ops"]);

    const byDan = team();
    byDan.push(deleteAgent(verify(byDan), "api", dan));
    expect(() => verify(byDan)).toThrow(
      /only an agent's owner or the Team Admin/,
    );
  });

  it("marks an agent created with a deleted agent's name as a replacement", () => {
    const log = team();
    log.push(deleteAgent(verify(log), "api", carol));
    log.push(createAgent(verify(log), "api", [], dan));

    const [, replacement] = verify(log).agents;
    expect(replacement).toMatchObject({
      name: "api",
      owner: dan.identity.id,
      replacesDeleted: true,
    });
  });
});
