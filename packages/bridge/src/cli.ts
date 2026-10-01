import { parseArgs } from "node:util";
import {
  DEFAULT_INVITE_TTL_HOURS,
  DeveloperName,
  InviteLinkError,
  TeamName,
  acceptInvite,
  createIdentity,
  createInvite,
  createTeam,
  formatInviteLink,
  generateMachineKey,
  isInviteOpen,
  parseInviteLink,
  revokeInvite,
  verifyIdentityLog,
  type Signer,
} from "@blether/protocol";
import {
  FileKeyStore,
  TeamDirectory,
  type Credentials,
  type TeamRecord,
} from "./keystore.js";
import { RelayConnection, RelayError } from "./relay-connection.js";

/**
 * The `blether` command. Everything that changes who a developer is, or who
 * is in a team, happens here and never through the agent (ADR 0006).
 */

const USAGE = `Usage: blether <command>

Commands:
  init --name <name>                 Create this machine's key and your Blether identity
  whoami                             Show your identity
  team create <name> --relay <url>   Start a team on a relay; you become its Team Admin
  team list                          List the teams you belong to
  team members <team>                Show a team's members and open invites
  invite <team> [--hours <n>]        Create an invite to share (default ${DEFAULT_INVITE_TTL_HOURS} hours)
  revoke-invite <team> <invite-id>   Revoke an invite that hasn't been used
  join <invite> [--as <name>]        Join a team; --as picks your local name for it

Set BLETHER_HOME to keep Blether's files somewhere other than ~/.blether.`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliContext {
  store: FileKeyStore;
  teams: TeamDirectory;
  io: CliIo;
  now?: () => Date;
}

/** A failure to report to the user, with no stack trace. */
class CliError extends Error {}

/** Runs the CLI with `argv` (without the node and script paths). Resolves to the exit code. */
export async function runCli(
  argv: string[],
  context: Partial<CliContext> = {},
): Promise<number> {
  const store = context.store ?? new FileKeyStore();
  const ctx: CliContext = {
    store,
    teams: context.teams ?? new TeamDirectory(store.home),
    io: context.io ?? { out: console.log, err: console.error },
    ...(context.now ? { now: context.now } : {}),
  };
  try {
    return await dispatch(argv, ctx);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // node:util parseArgs reports bad options with ERR_PARSE_ARGS_* codes.
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      ctx.io.err(`${(error as Error).message}\n\n${USAGE}`);
      return 1;
    }
    if (
      error instanceof CliError ||
      error instanceof RelayError ||
      error instanceof InviteLinkError
    ) {
      ctx.io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function dispatch(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return init(rest, ctx);
    case "whoami":
      return whoami(ctx);
    case "team": {
      const [sub, ...args] = rest;
      if (sub === "create") return teamCreate(args, ctx);
      if (sub === "list") return teamList(ctx);
      if (sub === "members") return teamMembers(args, ctx);
      throw new CliError(
        `Unknown team command: ${sub ?? "(none)"}\n\n${USAGE}`,
      );
    }
    case "invite":
      return invite(rest, ctx);
    case "revoke-invite":
      return revoke(rest, ctx);
    case "join":
      return join(rest, ctx);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      ctx.io.out(USAGE);
      return command === undefined ? 1 : 0;
    default:
      throw new CliError(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

function init(args: string[], { store, io }: CliContext): number {
  const { values } = parseArgs({
    args,
    options: { name: { type: "string" } },
  });
  const name = DeveloperName.safeParse(values.name);
  if (!name.success) {
    throw new CliError(
      'Give your name, as teammates will see it: blether init --name "Kev"',
    );
  }
  if (store.exists()) {
    throw new CliError(
      `There is already a Blether identity in ${store.home}. Run \`blether whoami\` to see it.`,
    );
  }

  const machine = generateMachineKey();
  const identity = createIdentity(machine, name.data);
  store.save({ machine, identity });

  const { id } = verifyIdentityLog(identity);
  io.out(`Created identity for ${name.data}.`);
  io.out(`Identity: ${id}`);
  io.out(`Keys stored in ${store.home}. Keep this directory private.`);
  return 0;
}

function whoami({ store, io }: CliContext): number {
  const credentials = loadCredentials(store);
  const identity = verifyIdentityLog(credentials.identity);
  io.out(`Name:     ${identity.name}`);
  io.out(`Identity: ${identity.id}`);
  io.out(`Machine:  ${credentials.machine.publicKey}`);
  return 0;
}

async function teamCreate(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { relay: { type: "string" } },
  });
  const name = parseTeamName(positionals[0]);
  if (!values.relay) {
    throw new CliError(
      "Say which relay hosts the team: blether team create <name> --relay wss://relay.example.com",
    );
  }
  if (ctx.teams.get(name)) {
    throw new CliError(`You already have a team called ${name}.`);
  }
  const credentials = loadCredentials(ctx.store);
  const signer = toSigner(credentials);

  const { team } = await withRelay(values.relay, credentials, (relay) =>
    relay.createTeam(createTeam(name, signer, now(ctx))),
  );
  ctx.teams.save({ name, id: team.id, relayUrl: values.relay });
  ctx.io.out(`Created team ${name}. You are its Team Admin.`);
  ctx.io.out(`Invite teammates with: blether invite ${name}`);
  return 0;
}

function teamList({ teams, io }: CliContext): number {
  const records = teams.list();
  if (records.length === 0) {
    io.out("You aren't in any teams yet.");
    return 0;
  }
  for (const record of records) io.out(`${record.name}  ${record.relayUrl}`);
  return 0;
}

async function teamMembers(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const credentials = loadCredentials(ctx.store);
  const { team, identities } = await withRelay(
    record.relayUrl,
    credentials,
    (relay) => relay.getTeam(record.id),
  );

  ctx.io.out(`Team ${team.name}:`);
  for (const member of team.members) {
    const name = identities.get(member)?.name ?? "(unknown)";
    ctx.io.out(`  ${name}${member === team.admin ? " (Team Admin)" : ""}`);
  }
  const open = team.invites.filter((i) => isInviteOpen(i, now(ctx)));
  if (open.length > 0) {
    ctx.io.out("Open invites:");
    for (const i of open) {
      const by = identities.get(i.invitedBy)?.name ?? "(unknown)";
      ctx.io.out(`  ${i.id}  by ${by}, expires ${i.expiresAt}`);
    }
  }
  return 0;
}

async function invite(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { hours: { type: "string" } },
  });
  const record = loadTeam(ctx.teams, positionals[0]);
  const ttlHours =
    values.hours === undefined
      ? DEFAULT_INVITE_TTL_HOURS
      : Number(values.hours);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) {
    throw new CliError("--hours must be a number of hours, up to 720.");
  }
  const credentials = loadCredentials(ctx.store);

  const created = await withRelay(
    record.relayUrl,
    credentials,
    async (relay) => {
      const { team } = await relay.getTeam(record.id);
      const result = createInvite(team, toSigner(credentials), {
        now: now(ctx),
        ttlHours,
      });
      await relay.appendTeam(record.id, result.entry);
      return result;
    },
  );

  const link = formatInviteLink({
    relayUrl: record.relayUrl,
    teamId: record.id,
    inviteId: created.invite,
    secret: created.secret,
  });
  ctx.io.out(
    `Invite to ${record.name}, valid for ${ttlHours} hours and one use:`,
  );
  ctx.io.out("");
  ctx.io.out(`  ${link}`);
  ctx.io.out("");
  ctx.io.out(
    "Send it to your teammate privately. They join with: blether join <invite>",
  );
  ctx.io.out(
    `To cancel it: blether revoke-invite ${record.name} ${created.invite}`,
  );
  return 0;
}

async function revoke(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const inviteId = args[1];
  if (!inviteId)
    throw new CliError("Usage: blether revoke-invite <team> <invite-id>");
  const credentials = loadCredentials(ctx.store);

  await withRelay(record.relayUrl, credentials, async (relay) => {
    const { team } = await relay.getTeam(record.id);
    if (!team.invites.some((i) => i.id === inviteId)) {
      throw new CliError(`${record.name} has no invite ${inviteId}.`);
    }
    await relay.appendTeam(
      record.id,
      revokeInvite(team, inviteId, toSigner(credentials), now(ctx)),
    );
  });
  ctx.io.out(`Revoked invite ${inviteId}.`);
  return 0;
}

async function join(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { as: { type: "string" } },
  });
  if (!positionals[0])
    throw new CliError("Usage: blether join <invite> [--as <name>]");
  const link = parseInviteLink(positionals[0]);
  const credentials = loadCredentials(ctx.store);
  const signer = toSigner(credentials);

  const record: TeamRecord = await withRelay(
    link.relayUrl,
    credentials,
    async (relay) => {
      const { team } = await relay.getTeam(link.teamId);
      if (team.members.includes(signer.identity.id)) {
        throw new CliError(`You're already a member of ${team.name}.`);
      }
      const name =
        values.as === undefined ? team.name : parseTeamName(values.as);
      if (ctx.teams.get(name)) {
        throw new CliError(
          `You already have a team called ${name}. Pick another local name with --as <name>.`,
        );
      }
      const invite = team.invites.find((i) => i.id === link.inviteId);
      if (!invite || !isInviteOpen(invite, now(ctx))) {
        throw new CliError(
          `This invite to ${team.name} has ${invite ? `been ${invite.status === "open" ? "expired" : invite.status}` : "never existed"}. Ask for a new one.`,
        );
      }
      const joined = await relay.appendTeam(
        link.teamId,
        acceptInvite(team, link.inviteId, link.secret, signer, now(ctx)),
      );
      if (!joined.team.members.includes(signer.identity.id)) {
        throw new CliError("The relay didn't record your membership.");
      }
      return { name, id: team.id, relayUrl: link.relayUrl };
    },
  );

  ctx.teams.save(record);
  ctx.io.out(`Joined ${record.name}.`);
  ctx.io.out(`Point a bridge at it with BLETHER_TEAM=${record.name}.`);
  return 0;
}

function now(ctx: CliContext): Date {
  return ctx.now?.() ?? new Date();
}

function parseTeamName(name: string | undefined): string {
  const parsed = TeamName.safeParse(name);
  if (!parsed.success) {
    throw new CliError(
      "Team names use lowercase letters, digits and hyphens, for example: backend",
    );
  }
  return parsed.data;
}

function loadCredentials(store: FileKeyStore): Credentials {
  const credentials = store.load();
  if (!credentials) {
    throw new CliError(
      `No Blether identity in ${store.home}. Run \`blether init --name "<your name>"\` first.`,
    );
  }
  return credentials;
}

function loadTeam(teams: TeamDirectory, name: string | undefined): TeamRecord {
  const record = teams.get(parseTeamName(name));
  if (!record) {
    throw new CliError(
      `You aren't in a team called ${name}. Run \`blether team list\` to see your teams.`,
    );
  }
  return record;
}

function toSigner(credentials: Credentials): Signer {
  return {
    identity: verifyIdentityLog(credentials.identity),
    machine: credentials.machine,
  };
}

async function withRelay<T>(
  url: string,
  credentials: Credentials,
  action: (relay: RelayConnection) => Promise<T>,
): Promise<T> {
  let relay: RelayConnection;
  try {
    relay = await RelayConnection.connect(url, credentials);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new CliError(
      `Couldn't connect to the relay at ${url}: ${(error as Error).message}`,
    );
  }
  try {
    return await action(relay);
  } finally {
    await relay.close();
  }
}
