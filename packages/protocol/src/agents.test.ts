import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "./crypto.js";
import {
  createIdentity,
  verifyIdentityLog,
  type Identity,
} from "./identity.js";
import {
  acceptInvite,
  addRole,
  createAgent,
  createInvite,
  createTeam,
  setAgentRoles,
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

/** Kev's team with Carol as a member and the roles frontend and backend. */
function team() {
  const log = createTeam("product", kev);
  const invite = createInvite(verify(log), kev);
  log.push(invite.entry);
  log.push(acceptInvite(verify(log), invite.invite, invite.secret, carol));
  log.push(addRole(verify(log), "frontend", kev));
  log.push(addRole(verify(log), "backend", carol));
  return log;
}

describe("team roles", () => {
  it("lets any member add a role to the agreed list", () => {
    expect(verify(team()).roles).toEqual(["frontend", "backend"]);
  });

  it("refuses a role the team already has", () => {
    const log = team();
    log.push(addRole(verify(log), "frontend", carol));

    expect(() => verify(log)).toThrow(/already has that role/);
  });

  it("refuses roles from non-members", () => {
    const log = team();
    log.push(addRole(verify(log), "ops", dan));

    expect(() => verify(log)).toThrow(/only members can add roles/);
  });
});

describe("team agents", () => {
  it("records an agent owned by the member who created it", () => {
    const log = team();
    log.push(createAgent(verify(log), "web", ["frontend"], carol));

    expect(verify(log).agents).toEqual([
      {
        name: "web",
        owner: carol.identity.id,
        roles: ["frontend"],
        createdAt: expect.any(String),
      },
    ]);
  });

  it("refuses a second agent with the same name", () => {
    const log = team();
    log.push(createAgent(verify(log), "web", [], carol));
    log.push(createAgent(verify(log), "web", [], kev));

    expect(() => verify(log)).toThrow(/already has an agent called web/);
  });

  it("refuses roles that aren't on the team's list", () => {
    const log = team();
    log.push(createAgent(verify(log), "web", ["design"], carol));

    expect(() => verify(log)).toThrow(/no role called design/);
  });

  it("refuses an agent from a non-member", () => {
    const log = team();
    log.push(createAgent(verify(log), "web", [], dan));

    expect(() => verify(log)).toThrow(/only members can create agents/);
  });

  it("lets the owner, and only the owner, change an agent's roles", () => {
    const log = team();
    log.push(createAgent(verify(log), "web", ["frontend"], carol));
    log.push(setAgentRoles(verify(log), "web", ["frontend", "backend"], carol));
    expect(verify(log).agents[0]?.roles).toEqual(["frontend", "backend"]);

    const byKev = [...log, setAgentRoles(verify(log), "web", [], kev)];
    expect(() => verify(byKev)).toThrow(/only an agent's owner/);
  });

  it("refuses a role listed twice", () => {
    const log = team();
    log.push(createAgent(verify(log), "web", ["frontend", "frontend"], carol));

    expect(() => verify(log)).toThrow(/listed twice/);
  });
});
