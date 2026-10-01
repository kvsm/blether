import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  DEFAULT_INVITE_TTL_HOURS,
  DeveloperName,
  DeviceLabel,
  InviteLinkError,
  PairingError,
  TeamName,
  acceptInvite,
  addDevice,
  deviceFingerprint,
  formatDeviceGrant,
  formatDeviceRequest,
  parseDeviceGrant,
  parseDeviceRequest,
  createIdentity,
  createInvite,
  createTeam,
  formatInviteLink,
  generateDeviceKey,
  isInviteOpen,
  parseInviteLink,
  revokeInvite,
  verifyIdentityLog,
  type Signer,
} from "@blether/protocol";
import {
  FileKeyStore,
  OutdatedBletherHomeError,
  SeenLogs,
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
  init --name <name>                 Create this device's key and your Blether identity
  whoami                             Show your identity
  team create <name> --relay <url>   Start a team on a relay; you become its Team Admin
  team list                          List the teams you belong to
  team members <team>                Show a team's members and open invites
  invite <team> [--hours <n>]        Create an invite to share (default ${DEFAULT_INVITE_TTL_HOURS} hours)
  revoke-invite <team> <invite-id>   Revoke an invite that hasn't been used
  join <invite> [--as <name>]        Join a team; --as picks your local name for it
  device request                     On a new device: start adding it to your identity
  device add <request> [--label <l>] On an existing device: approve a new device
  device accept <grant>              On the new device: finish adding it
  device list                        List your identity's devices

Set BLETHER_HOME to keep Blether's files somewhere other than ~/.blether.`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks a yes/no question. Defaults to prompting on an interactive terminal, and "no" otherwise. */
  confirm?: (question: string) => Promise<boolean>;
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
      error instanceof InviteLinkError ||
      error instanceof PairingError ||
      error instanceof OutdatedBletherHomeError
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
    case "device": {
      const [sub, ...args] = rest;
      if (sub === "request") return deviceRequest(ctx);
      if (sub === "add") return deviceAdd(args, ctx);
      if (sub === "accept") return deviceAccept(args, ctx);
      if (sub === "list") return deviceList(ctx);
      throw new CliError(
        `Unknown device command: ${sub ?? "(none)"}\n\n${USAGE}`,
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

  const device = generateDeviceKey();
  const identity = createIdentity(device, name.data);
  store.save({ device, identity });

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
  io.out(`Device:   ${deviceFingerprint(credentials.device.publicKey)}`);
  return 0;
}

function deviceRequest({ store, io }: CliContext): number {
  if (store.exists()) {
    throw new CliError(
      `This device already has a Blether identity in ${store.home}. Run \`blether device add\` on it to approve other devices instead.`,
    );
  }
  const device = store.loadPendingDevice() ?? generateDeviceKey();
  store.savePendingDevice(device);
  io.out("On a device that already has your identity, run:");
  io.out("");
  io.out(`  blether device add ${formatDeviceRequest(device.publicKey)}`);
  io.out("");
  io.out(
    `It will show this fingerprint. Check it matches: ${deviceFingerprint(device.publicKey)}`,
  );
  return 0;
}

async function deviceAdd(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { label: { type: "string" } },
  });
  if (!positionals[0]) {
    throw new CliError("Usage: blether device add <request> [--label <label>]");
  }
  const newDevice = parseDeviceRequest(positionals[0]);
  const label =
    values.label === undefined
      ? undefined
      : DeviceLabel.safeParse(values.label);
  if (label && !label.success) {
    throw new CliError(
      "--label must be 1 to 32 characters, for example: laptop",
    );
  }
  const credentials = loadCredentials(ctx.store);
  // Pick up devices added elsewhere, so the new entry extends the latest log.
  const identity = await latestIdentity(ctx, credentials);

  ctx.io.out(`New device fingerprint: ${deviceFingerprint(newDevice)}`);
  const confirmed = await confirm(
    ctx,
    "Does this match the fingerprint shown on the new device? Only approve devices you control.",
  );
  if (!confirmed) {
    ctx.io.err("Not added.");
    return 1;
  }

  const updated = addDevice(identity, credentials.device, newDevice, {
    ...(label?.success ? { label: label.data } : {}),
    now: now(ctx),
  });
  ctx.store.saveIdentity(updated);
  new SeenLogs(ctx.store.home).witness(
    "identity",
    verifyIdentityLog(updated).id,
    updated,
  );
  const grant = formatDeviceGrant({
    identity: updated,
    teams: ctx.teams.list(),
  });
  ctx.io.out("Added. On the new device, run:");
  ctx.io.out("");
  ctx.io.out(`  blether device accept ${grant}`);
  ctx.io.out("");
  ctx.io.out(
    "The grant holds your identity and your list of teams. It isn't secret.",
  );
  return 0;
}

function deviceAccept(args: string[], ctx: CliContext): number {
  if (!args[0]) throw new CliError("Usage: blether device accept <grant>");
  if (ctx.store.exists()) {
    throw new CliError(
      `This device already has a Blether identity in ${ctx.store.home}.`,
    );
  }
  const pending = ctx.store.loadPendingDevice();
  if (!pending) {
    throw new CliError("Run `blether device request` on this device first.");
  }
  const grant = parseDeviceGrant(args[0]);
  const identity = verifyIdentityLog(grant.identity);
  if (!identity.devices.includes(pending.publicKey)) {
    throw new CliError(
      "That grant doesn't include this device. Check you copied this device's request into `blether device add`.",
    );
  }
  ctx.store.completePendingDevice(grant.identity);
  new SeenLogs(ctx.store.home).witness("identity", identity.id, grant.identity);
  for (const team of grant.teams) {
    if (!ctx.teams.get(team.name)) ctx.teams.save(team);
  }
  ctx.io.out(`This device is now part of ${identity.name}'s identity.`);
  if (grant.teams.length > 0) {
    ctx.io.out(`Teams: ${grant.teams.map((t) => t.name).join(", ")}`);
  }
  return 0;
}

function deviceList({ store, io }: CliContext): number {
  const credentials = loadCredentials(store);
  const identity = verifyIdentityLog(credentials.identity);
  io.out(`Devices for ${identity.name}:`);
  for (const [index, device] of identity.deviceInfo.entries()) {
    const label = device.label ?? (index === 0 ? "first device" : "unnamed");
    const here =
      device.key === credentials.device.publicKey ? "  (this device)" : "";
    io.out(
      `  ${deviceFingerprint(device.key)}  ${label}, added ${device.addedAt}${here}`,
    );
  }
  return 0;
}

/**
 * This developer's newest identity log: the stored one, or a newer one from
 * the relay of one of their teams if another device has added a device.
 */
async function latestIdentity(ctx: CliContext, credentials: Credentials) {
  const [team] = ctx.teams.list();
  if (!team) return credentials.identity;
  try {
    return await withRelay(
      ctx,
      team.relayUrl,
      credentials,
      async (relay) => relay.identity ?? credentials.identity,
    );
  } catch (error) {
    if (error instanceof CliError) {
      ctx.io.err(
        `Couldn't check ${team.relayUrl} for newer devices; using this device's copy.`,
      );
      return credentials.identity;
    }
    throw error;
  }
}

async function confirm(ctx: CliContext, question: string): Promise<boolean> {
  if (ctx.io.confirm) return ctx.io.confirm(question);
  if (!process.stdin.isTTY) {
    ctx.io.err("Run this in an interactive terminal to confirm.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
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

  const { team } = await withRelay(ctx, values.relay, credentials, (relay) =>
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
    ctx,
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
    ctx,
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

  await withRelay(ctx, record.relayUrl, credentials, async (relay) => {
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
    ctx,
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
    device: credentials.device,
  };
}

/**
 * Connects a CLI session to the relay at `url`, runs `action`, and
 * disconnects. Logs from the relay are checked against what this device has
 * seen before, and a newer identity log from the relay is saved.
 */
async function withRelay<T>(
  ctx: CliContext,
  url: string,
  credentials: Credentials,
  action: (relay: RelayConnection) => Promise<T>,
): Promise<T> {
  let relay: RelayConnection;
  try {
    relay = await RelayConnection.connect(url, credentials, {
      witness: new SeenLogs(ctx.store.home),
    });
    if (relay.identity && relay.identity.length > credentials.identity.length) {
      ctx.store.saveIdentity(relay.identity);
    }
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
