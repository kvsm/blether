import { z } from "zod";
import {
  PublicKey,
  Signature,
  canonicalJson,
  hash,
  keyFromSecret,
  randomToken,
  sign,
  verify,
  type DeviceKey,
} from "./crypto.js";
import type { Identity } from "./identity.js";
import { AgentName, RoleName } from "./names.js";

/**
 * A team's membership log (ADR 0006): an append-only chain of signed entries.
 * Each entry names the hash of the one before it. The team id is the hash of
 * the first entry.
 *
 * Joining uses an invite key pair derived from the invite secret: the
 * inviter publishes only its public key, and the invitee proves they hold the
 * secret by signing their own "member added" entry with it.
 */

/** A team's name, and the local name a developer knows it by. */
export const TeamName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "lowercase letters, digits and hyphens, starting with a letter or digit",
  );
export type TeamName = z.infer<typeof TeamName>;

const IdentityId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const InviteId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const DEFAULT_INVITE_TTL_HOURS = 72;
const INVITE_KEY_CONTEXT = "blether-invite-v1";

export const TeamEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("team-created"),
    name: TeamName,
    createdAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("invite-created"),
    invite: InviteId,
    inviteKey: PublicKey,
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("invite-revoked"),
    invite: InviteId,
    createdAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("member-added"),
    invite: InviteId,
    createdAt: z.iso.datetime(),
  }),
  /** Adds a role to the team's agreed list. Any member can. */
  z.object({
    type: z.literal("role-added"),
    role: RoleName,
    createdAt: z.iso.datetime(),
  }),
  /** Creates an agent owned by the entry's author. */
  z.object({
    type: z.literal("agent-created"),
    agent: AgentName,
    roles: z.array(RoleName),
    createdAt: z.iso.datetime(),
  }),
  /** Replaces an agent's roles. Only its owner can. */
  z.object({
    type: z.literal("agent-roles-set"),
    agent: AgentName,
    roles: z.array(RoleName),
    createdAt: z.iso.datetime(),
  }),
  /** Deletes an agent and its mailbox. Its owner or the Team Admin can. */
  z.object({
    type: z.literal("agent-deleted"),
    agent: AgentName,
    createdAt: z.iso.datetime(),
  }),
  /**
   * Removes a developer from the team, with all their agents and mailboxes,
   * and revokes any invites they created that are still open. Only the Team
   * Admin can, and not themselves.
   */
  z.object({
    type: z.literal("member-removed"),
    member: IdentityId,
    createdAt: z.iso.datetime(),
  }),
]);
export type TeamEntry = z.infer<typeof TeamEntry>;

export const SignedTeamEntry = z.object({
  entry: TeamEntry,
  /** Hash of the previous signed entry; null for the first. */
  prev: z.string().nullable(),
  /** Identity id of the developer making the change. */
  author: IdentityId,
  /** The author's device that signed it. */
  signer: PublicKey,
  signature: Signature,
  /** member-added only: the same content signed by the invite key. */
  inviteSignature: Signature.optional(),
});
export type SignedTeamEntry = z.infer<typeof SignedTeamEntry>;

export const TeamLog = z.array(SignedTeamEntry).min(1);
export type TeamLog = z.infer<typeof TeamLog>;

export interface Invite {
  id: string;
  key: PublicKey;
  invitedBy: string;
  expiresAt: string;
  status: "open" | "used" | "revoked";
}

/** What a verified membership log says about a team. */
export interface Team {
  id: string;
  name: TeamName;
  admin: string;
  /** Identity ids of the members, the admin included. */
  members: string[];
  invites: Invite[];
  /** The team's agreed list of roles. */
  roles: RoleName[];
  /** The team's agents, in the order they were created. */
  agents: TeamAgent[];
  /** Agents that have been deleted, oldest first. */
  deletedAgents: DeletedAgent[];
  /** Hash of the last entry: what the next entry's `prev` must be. */
  head: string;
}

/** An agent as the team log records it. Whether a session is acting as it comes from the relay. */
export interface TeamAgent {
  name: AgentName;
  /** Identity id of the developer who created and owns it. */
  owner: string;
  roles: RoleName[];
  createdAt: string;
  /** Set when the name belonged to an agent that was deleted: this is a new agent, not that one. */
  replacesDeleted?: true;
}

/** An agent that was deleted, or whose owner was removed from the team. */
export interface DeletedAgent {
  name: AgentName;
  owner: string;
  deletedAt: string;
}

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamError";
  }
}

/** The developer and device signing a change. */
export interface Signer {
  identity: Identity;
  device: DeviceKey;
}

function signedContent(
  entry: TeamEntry,
  prev: string | null,
  author: string,
): string {
  return canonicalJson({ entry, prev, author });
}

function signEntry(
  entry: TeamEntry,
  prev: string | null,
  by: Signer,
): SignedTeamEntry {
  return {
    entry,
    prev,
    author: by.identity.id,
    signer: by.device.publicKey,
    signature: sign(by.device, signedContent(entry, prev, by.identity.id)),
  };
}

export function entryHash(signed: SignedTeamEntry): string {
  return hash(canonicalJson(signed));
}

/** Starts a new team with `by` as its Team Admin. */
export function createTeam(
  name: TeamName,
  by: Signer,
  now = new Date(),
): TeamLog {
  return [
    signEntry(
      {
        type: "team-created",
        name: TeamName.parse(name),
        createdAt: now.toISOString(),
      },
      null,
      by,
    ),
  ];
}

/** Creates an invite. `secret` goes in the invite string; only the entry goes to the relay. */
export function createInvite(
  team: Team,
  by: Signer,
  {
    now = new Date(),
    ttlHours = DEFAULT_INVITE_TTL_HOURS,
  }: { now?: Date; ttlHours?: number } = {},
): { entry: SignedTeamEntry; invite: string; secret: string } {
  const secret = randomToken();
  const invite = randomToken(16);
  const inviteKey = keyFromSecret(INVITE_KEY_CONTEXT, secret);
  const entry = signEntry(
    {
      type: "invite-created",
      invite,
      inviteKey: inviteKey.publicKey,
      expiresAt: new Date(now.getTime() + ttlHours * 3_600_000).toISOString(),
      createdAt: now.toISOString(),
    },
    team.head,
    by,
  );
  return { entry, invite, secret };
}

/** Deletes agent `name`, which `by` must own unless they're the Team Admin. */
export function deleteAgent(
  team: Team,
  name: AgentName,
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  return signEntry(
    { type: "agent-deleted", agent: name, createdAt: now.toISOString() },
    team.head,
    by,
  );
}

/** Removes developer `member` from the team. `by` must be the Team Admin. */
export function removeMember(
  team: Team,
  member: string,
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  return signEntry(
    { type: "member-removed", member, createdAt: now.toISOString() },
    team.head,
    by,
  );
}

/** Adds `role` to the team's agreed list of roles. */
export function addRole(
  team: Team,
  role: RoleName,
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  return signEntry(
    {
      type: "role-added",
      role: RoleName.parse(role),
      createdAt: now.toISOString(),
    },
    team.head,
    by,
  );
}

/** Creates agent `name`, owned by `by`, with roles from the team's list. */
export function createAgent(
  team: Team,
  name: AgentName,
  roles: RoleName[],
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  return signEntry(
    {
      type: "agent-created",
      agent: AgentName.parse(name),
      roles,
      createdAt: now.toISOString(),
    },
    team.head,
    by,
  );
}

/** Replaces the roles of agent `name`, which `by` must own. */
export function setAgentRoles(
  team: Team,
  name: AgentName,
  roles: RoleName[],
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  return signEntry(
    {
      type: "agent-roles-set",
      agent: name,
      roles,
      createdAt: now.toISOString(),
    },
    team.head,
    by,
  );
}

export function revokeInvite(
  team: Team,
  invite: string,
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  return signEntry(
    { type: "invite-revoked", invite, createdAt: now.toISOString() },
    team.head,
    by,
  );
}

/** The entry that adds `by` to the team, proving they hold the invite's secret. */
export function acceptInvite(
  team: Team,
  invite: string,
  secret: string,
  by: Signer,
  now = new Date(),
): SignedTeamEntry {
  const entry: TeamEntry = {
    type: "member-added",
    invite,
    createdAt: now.toISOString(),
  };
  const signed = signEntry(entry, team.head, by);
  const inviteKey = keyFromSecret(INVITE_KEY_CONTEXT, secret);
  return {
    ...signed,
    inviteSignature: sign(
      inviteKey,
      signedContent(entry, team.head, by.identity.id),
    ),
  };
}

/**
 * Someone holding an invite isn't a member yet, but needs the team's log to
 * join it. The relay shows it to them if they prove they hold the invite's
 * secret, by signing the connection's challenge with the invite key. The
 * challenge ties the proof to one connection, so it can't be replayed.
 */
const INVITE_PROOF_CONTEXT = "blether-invite-proof-v1";

function inviteProofMessage(
  challenge: string,
  team: string,
  invite: string,
): string {
  return [INVITE_PROOF_CONTEXT, challenge, team, invite].join("\n");
}

/** Proves, on the connection that was sent `challenge`, that the caller holds invite `invite` to team `team`. */
export function proveInvite(
  secret: string,
  challenge: string,
  team: string,
  invite: string,
): Signature {
  return sign(
    keyFromSecret(INVITE_KEY_CONTEXT, secret),
    inviteProofMessage(challenge, team, invite),
  );
}

/** True if `proof` was made with the secret of `invite`, a still-open invite to `team`, for `challenge`. */
export function verifyInviteProof(
  team: Team,
  invite: string,
  challenge: string,
  proof: string,
  now = new Date(),
): boolean {
  const held = team.invites.find((i) => i.id === invite);
  return (
    held !== undefined &&
    isInviteOpen(held, now) &&
    verify(held.key, inviteProofMessage(challenge, team.id, invite), proof)
  );
}

/**
 * Checks every entry of `log` and returns the team it describes. `identities`
 * must include every author, keyed by identity id. Throws TeamError if the log
 * doesn't verify.
 */
export function verifyTeamLog(
  log: unknown,
  identities: ReadonlyMap<string, Identity>,
): Team {
  const parsed = TeamLog.safeParse(log);
  if (!parsed.success) throw new TeamError("Team log is malformed.");
  const entries = parsed.data;

  let team: Team | undefined;
  let prev: string | null = null;

  for (const [index, signed] of entries.entries()) {
    const where = `Entry ${index} (${signed.entry.type})`;
    if (signed.prev !== prev) {
      throw new TeamError(`${where} doesn't follow the entry before it.`);
    }
    const author = identities.get(signed.author);
    if (!author) throw new TeamError(`${where} has an unknown author.`);
    if (!author.devices.includes(signed.signer)) {
      throw new TeamError(
        `${where} is signed by a device its author doesn't own.`,
      );
    }
    const content = signedContent(signed.entry, signed.prev, signed.author);
    if (!verify(signed.signer, content, signed.signature)) {
      throw new TeamError(`${where} has an invalid signature.`);
    }

    const { entry } = signed;
    if (!team) {
      if (entry.type !== "team-created") {
        throw new TeamError("Team log must start with team-created.");
      }
      team = {
        id: entryHash(signed),
        name: entry.name,
        admin: signed.author,
        members: [signed.author],
        invites: [],
        roles: [],
        agents: [],
        deletedAgents: [],
        head: "",
      };
    } else {
      apply(team, signed, entry, content, where);
    }
    prev = entryHash(signed);
    team.head = prev;
  }

  return team!;
}

function apply(
  team: Team,
  signed: SignedTeamEntry,
  entry: TeamEntry,
  content: string,
  where: string,
) {
  const isMember = team.members.includes(signed.author);
  const invite =
    "invite" in entry
      ? team.invites.find((i) => i.id === entry.invite)
      : undefined;

  switch (entry.type) {
    case "team-created":
      throw new TeamError(`${where}: a team can only be created once.`);
    case "invite-created":
      if (!isMember) throw new TeamError(`${where}: only members can invite.`);
      if (invite) throw new TeamError(`${where}: invite id already used.`);
      team.invites.push({
        id: entry.invite,
        key: entry.inviteKey,
        invitedBy: signed.author,
        expiresAt: entry.expiresAt,
        status: "open",
      });
      return;
    case "invite-revoked":
      if (!invite) throw new TeamError(`${where}: no such invite.`);
      if (signed.author !== invite.invitedBy && signed.author !== team.admin) {
        throw new TeamError(
          `${where}: only the inviter or the Team Admin can revoke an invite.`,
        );
      }
      if (invite.status !== "open") {
        throw new TeamError(`${where}: invite is already ${invite.status}.`);
      }
      invite.status = "revoked";
      return;
    case "member-added":
      if (!invite) throw new TeamError(`${where}: no such invite.`);
      if (invite.status !== "open") {
        throw new TeamError(`${where}: invite is ${invite.status}.`);
      }
      if (isMember) throw new TeamError(`${where}: already a member.`);
      if (
        !signed.inviteSignature ||
        !verify(invite.key, content, signed.inviteSignature)
      ) {
        throw new TeamError(`${where} isn't signed by the invite key.`);
      }
      if (entry.createdAt > invite.expiresAt) {
        throw new TeamError(`${where}: invite had expired.`);
      }
      invite.status = "used";
      team.members.push(signed.author);
      return;
    case "role-added":
      if (!isMember)
        throw new TeamError(`${where}: only members can add roles.`);
      if (team.roles.includes(entry.role)) {
        throw new TeamError(`${where}: the team already has that role.`);
      }
      team.roles.push(entry.role);
      return;
    case "agent-created":
      if (!isMember) {
        throw new TeamError(`${where}: only members can create agents.`);
      }
      if (team.agents.some((a) => a.name === entry.agent)) {
        throw new TeamError(
          `${where}: the team already has an agent called ${entry.agent}.`,
        );
      }
      checkRoles(team, entry.roles, where);
      team.agents.push({
        name: entry.agent,
        owner: signed.author,
        roles: [...entry.roles],
        createdAt: entry.createdAt,
        ...(team.deletedAgents.some((d) => d.name === entry.agent)
          ? { replacesDeleted: true as const }
          : {}),
      });
      return;
    case "agent-roles-set": {
      const agent = team.agents.find((a) => a.name === entry.agent);
      if (!agent) throw new TeamError(`${where}: no such agent.`);
      if (agent.owner !== signed.author) {
        throw new TeamError(
          `${where}: only an agent's owner can change its roles.`,
        );
      }
      checkRoles(team, entry.roles, where);
      agent.roles = [...entry.roles];
      return;
    }
    case "agent-deleted": {
      const agent = team.agents.find((a) => a.name === entry.agent);
      if (!agent) throw new TeamError(`${where}: no such agent.`);
      if (agent.owner !== signed.author && signed.author !== team.admin) {
        throw new TeamError(
          `${where}: only an agent's owner or the Team Admin can delete it.`,
        );
      }
      deleteAgents(team, (a) => a.name === entry.agent, entry.createdAt);
      return;
    }
    case "member-removed": {
      if (signed.author !== team.admin) {
        throw new TeamError(
          `${where}: only the Team Admin can remove members.`,
        );
      }
      if (entry.member === team.admin) {
        throw new TeamError(
          `${where}: the Team Admin can't remove themselves.`,
        );
      }
      if (!team.members.includes(entry.member)) {
        throw new TeamError(`${where}: not a member.`);
      }
      team.members = team.members.filter((m) => m !== entry.member);
      deleteAgents(team, (a) => a.owner === entry.member, entry.createdAt);
      for (const invite of team.invites) {
        if (invite.invitedBy === entry.member && invite.status === "open") {
          invite.status = "revoked";
        }
      }
      return;
    }
  }
}

function deleteAgents(
  team: Team,
  matches: (agent: TeamAgent) => boolean,
  deletedAt: string,
) {
  for (const agent of team.agents.filter(matches)) {
    team.deletedAgents.push({
      name: agent.name,
      owner: agent.owner,
      deletedAt,
    });
  }
  team.agents = team.agents.filter((a) => !matches(a));
}

function checkRoles(team: Team, roles: readonly string[], where: string) {
  if (new Set(roles).size !== roles.length) {
    throw new TeamError(`${where}: a role is listed twice.`);
  }
  const unknown = roles.find((r) => !team.roles.includes(r));
  if (unknown) {
    throw new TeamError(`${where}: the team has no role called ${unknown}.`);
  }
}

/** Whether an invite can still be accepted at `now`. */
export function isInviteOpen(invite: Invite, now = new Date()): boolean {
  return invite.status === "open" && now.toISOString() <= invite.expiresAt;
}
