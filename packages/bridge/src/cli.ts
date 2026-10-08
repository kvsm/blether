import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  AgentName,
  BLETHER_VERSION,
  DEFAULT_INVITE_TTL_HOURS,
  DeveloperName,
  DeviceLabel,
  InviteLinkError,
  PairingError,
  RoleName,
  TeamName,
  acceptInvite,
  addDevice,
  addRole,
  createAgent,
  deviceFingerprint,
  formatDeviceGrant,
  formatDeviceRequest,
  parseDeviceGrant,
  parseDeviceRequest,
  createIdentity,
  deleteAgent,
  createInvite,
  createTeam,
  formatInviteLink,
  generateDeviceKey,
  isInviteOpen,
  parseInviteLink,
  removeMember,
  revokeDevice,
  revokeInvite,
  setAgentRoles,
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
import { formatEscalations } from "./escalation-tools.js";
import { DEFAULT_SEND_LIMITS, type SendLimits } from "./rate-limit.js";
import { allPendingEscalations } from "./escalations.js";
import {
  INCOMING_DESCRIPTIONS,
  IncomingLevel,
  OUTGOING_DESCRIPTIONS,
  OutgoingLevel,
  PolicyStore,
  type ApprovalPolicy,
} from "./policy.js";
import { RelayConnection, RelayError } from "./relay-connection.js";
import { SessionFileError, writeSessionFile } from "./session-file.js";
import { watchInbox } from "./watch.js";
import {
  addDenyRules,
  claudeSettingsPath,
  denyRules,
  installClaudePlugin,
  missingDenyRules,
  packageRoot,
  removeDenyRules,
  runClaude,
  uninstallClaudePlugin,
  type ClaudeRunner,
} from "./claude-install.js";

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
  team remove <team> <developer>     Team Admin only: remove a developer and their agents
  invite <team> [--hours <n>]        Create an invite to share (default ${DEFAULT_INVITE_TTL_HOURS} hours)
  revoke-invite <team> <invite-id>   Revoke an invite that hasn't been used
  join <invite> [--as <name>]        Join a team; --as picks your local name for it
  device request                     On a new device: start adding it to your identity
  device add <request> [--label <l>] On an existing device: approve a new device
  device accept <grant>              On the new device: finish adding it
  device list                        List your identity's devices
  device revoke <fingerprint>        Revoke a lost or stolen device, from another of yours
  role add <team> <role>             Add a role to the team's agreed list
  role list <team>                   List the team's roles
  agent create <team> <agent name> [--role <r>]...
                                     Create an agent you own, with roles from the team's list
  agent roles <team> <agent name> [--role <r>]...
                                     Replace the roles of one of your agents
  agent list <team>                  Show the team's agents and who is online
  agent delete <team> <agent name>
                                     Delete one of your agents (or any, as Team Admin)
  use <team> <agent name> [--dir <path>]
                                     Make sessions started in this project (or <path>) act as the agent
  claude install                     Install (or update) the Blether plugin in Claude Code, and offer
                                     deny rules that keep Claude away from ~/.blether
  claude uninstall                   Remove the plugin, and the deny rules it added
  watch --inbox <path> --session <id> [--quiet-start]
                                     Print a line whenever a connected session's agent gets mail
                                     (the bridge gives its agent this command when it connects;
                                     --quiet-start, for a restart, skips mail already reported)
  escalations                        List messages your agents are holding for your decision
  status                             One line for your Claude Code status line: escalations waiting
  policy                             Show your Approval Policy on this device
  policy set [--outgoing <level>] [--incoming <level>]
             [--limit-per-agent <n>] [--limit-per-recipient <n>]
             [--limit-per-thread <n>] [--limit-window <minutes>]
                                     outgoing: ask | ask-others | free
                                     incoming: ask | ask-impactful | free
                                     limits: most messages an agent sends in the window
  --version                          Show which version of Blether is installed

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
  /** Where `blether use` writes by default. Defaults to the working directory. */
  cwd?: string;
  /** Runs the `claude` CLI, for `blether claude install`. */
  claude?: ClaudeRunner;
  /** The installed package's root, for `blether claude install`. Found from this file by default. */
  packageRoot?: string | undefined;
  /** Claude Code's user settings file, where `blether claude install` adds deny rules. */
  claudeSettings?: string;
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
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.claude ? { claude: context.claude } : {}),
    ...("packageRoot" in context ? { packageRoot: context.packageRoot } : {}),
    ...(context.claudeSettings
      ? { claudeSettings: context.claudeSettings }
      : {}),
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
      if (sub === "remove") return teamRemove(args, ctx);
      throw new CliError(
        `Unknown team command: ${sub ?? "(none)"}\n\n${USAGE}`,
      );
    }
    case "escalations":
      return escalationsList(ctx);
    case "status":
      return status(ctx);
    case "policy": {
      const [sub, ...args] = rest;
      if (sub === undefined) return policyShow(ctx);
      if (sub === "set") return policySet(args, ctx);
      throw new CliError(`Unknown policy command: ${sub}\n\n${USAGE}`);
    }
    case "role": {
      const [sub, ...args] = rest;
      if (sub === "add") return roleAdd(args, ctx);
      if (sub === "list") return roleList(args, ctx);
      throw new CliError(
        `Unknown role command: ${sub ?? "(none)"}\n\n${USAGE}`,
      );
    }
    case "agent": {
      const [sub, ...args] = rest;
      if (sub === "create") return agentCreate(args, ctx);
      if (sub === "roles") return agentRoles(args, ctx);
      if (sub === "list") return agentList(args, ctx);
      if (sub === "delete") return agentDelete(args, ctx);
      throw new CliError(
        `Unknown agent command: ${sub ?? "(none)"}\n\n${USAGE}`,
      );
    }
    case "device": {
      const [sub, ...args] = rest;
      if (sub === "request") return deviceRequest(ctx);
      if (sub === "add") return deviceAdd(args, ctx);
      if (sub === "accept") return deviceAccept(args, ctx);
      if (sub === "list") return deviceList(ctx);
      if (sub === "revoke") return deviceRevoke(args, ctx);
      throw new CliError(
        `Unknown device command: ${sub ?? "(none)"}\n\n${USAGE}`,
      );
    }
    case "use":
      return use(rest, ctx);
    case "watch":
      return watch(rest, ctx);
    case "claude": {
      const [sub] = rest;
      if (sub === "install") return claudeInstall(ctx);
      if (sub === "uninstall") return claudeUninstall(ctx);
      throw new CliError(
        `Unknown claude command: ${sub ?? "(none)"}\n\n${USAGE}`,
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
    case "version":
    case "--version":
    case "-v":
      ctx.io.out(BLETHER_VERSION);
      return 0;
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
      "Give your name, as teammates will see it: blether init --name <name>",
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
  const firstDevice = credentials.identity[0]!.entry.device;
  io.out(`Devices for ${identity.name}:`);
  for (const device of identity.deviceInfo) {
    const label =
      device.label ?? (device.key === firstDevice ? "first device" : "unnamed");
    const here =
      device.key === credentials.device.publicKey ? "  (this device)" : "";
    io.out(
      `  ${deviceFingerprint(device.key)}  ${label}, added ${device.addedAt}${here}`,
    );
  }
  if (identity.revoked.length > 0) {
    io.out("Revoked:");
    for (const device of identity.revoked) {
      io.out(`  ${deviceFingerprint(device.key)}  revoked ${device.revokedAt}`);
    }
  }
  return 0;
}

async function deviceRevoke(args: string[], ctx: CliContext): Promise<number> {
  const wanted = args.join("").replaceAll(" ", "");
  if (wanted.length < 4) {
    throw new CliError(
      "Usage: blether device revoke <fingerprint> (from `blether device list`)",
    );
  }
  const credentials = loadCredentials(ctx.store);
  const identityLog = await latestIdentity(ctx, credentials);
  const identity = verifyIdentityLog(identityLog);
  const matches = identity.devices.filter((key) =>
    deviceFingerprint(key).replaceAll(" ", "").startsWith(wanted),
  );
  if (matches.length === 0) {
    throw new CliError(
      `None of your devices has a fingerprint starting ${wanted}. Run \`blether device list\`.`,
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      "More than one device matches; give more of the fingerprint.",
    );
  }
  const [device] = matches as [string];
  if (device === credentials.device.publicKey) {
    throw new CliError(
      "That's this device. Revoke a device from one of your other devices.",
    );
  }

  ctx.io.out(`Revoking device ${deviceFingerprint(device)}.`);
  const confirmed = await confirm(
    ctx,
    "It will no longer be able to connect, read new messages or act for you, and can't be added back. Revoke it?",
  );
  if (!confirmed) {
    ctx.io.err("Not revoked.");
    return 1;
  }
  const updated = revokeDevice(
    identityLog,
    credentials.device,
    device,
    now(ctx),
  );
  ctx.store.saveIdentity(updated);
  new SeenLogs(ctx.store.home).witness("identity", identity.id, updated);

  // Tell every relay you use, so it refuses the device straight away.
  const relays = [...new Set(ctx.teams.list().map((t) => t.relayUrl))];
  const unreached: string[] = [];
  for (const url of relays) {
    try {
      await withRelay(
        ctx,
        url,
        { device: credentials.device, identity: updated },
        async () => {},
      );
    } catch (error) {
      if (!(error instanceof CliError || error instanceof RelayError)) {
        throw error;
      }
      unreached.push(url);
    }
  }
  ctx.io.out(
    `Revoked. Teammates' agents stop encrypting for it within a minute.`,
  );
  if (unreached.length > 0) {
    ctx.io.err(
      `Couldn't reach ${unreached.join(", ")}; it will learn of the revocation the next time any of your devices connects.`,
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
  if (
    !(await confirm(
      ctx,
      `Anyone with it can join ${record.name} and message its agents. Create an invite to ${record.name}?`,
    ))
  ) {
    ctx.io.err("No invite created.");
    return 1;
  }

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

/** Every pending escalation on this device, labelled with its team's local name. */
function pendingByAgent({ store, teams }: CliContext) {
  const names = new Map(teams.list().map((t) => [t.id, t.name]));
  return allPendingEscalations(store.home).map((entry) => ({
    ...entry,
    teamName: names.get(entry.team) ?? entry.team,
  }));
}

function escalationsList(ctx: CliContext): number {
  const pending = pendingByAgent(ctx);
  if (pending.length === 0) {
    ctx.io.out("Nothing is waiting for your decision.");
    return 0;
  }
  for (const { teamName, agent, escalations } of pending) {
    ctx.io.out(`${agent} in ${teamName}:`);
    ctx.io.out(formatEscalations(escalations));
  }
  ctx.io.out("");
  ctx.io.out(
    "Answer in a session as that agent; it will record your decision.",
  );
  return 0;
}

function status(ctx: CliContext): number {
  const pending = pendingByAgent(ctx);
  const count = pending.reduce((n, e) => n + e.escalations.length, 0);
  if (count > 0) {
    const agents = pending.map((e) => e.agent).join(", ");
    ctx.io.out(`⚑ ${count} waiting (${agents})`);
  }
  return 0;
}

function policyShow({ store, io }: CliContext): number {
  const policy = new PolicyStore(store.home).load();
  io.out(
    `Outgoing: ${policy.outgoing} (${OUTGOING_DESCRIPTIONS[policy.outgoing]})`,
  );
  io.out(
    `Incoming: ${policy.incoming} (${INCOMING_DESCRIPTIONS[policy.incoming]})`,
  );
  const limits = policy.limits ?? DEFAULT_SEND_LIMITS;
  io.out(
    `Limits:   ${limits.perAgent} messages per agent, ${limits.perRecipient} to any one agent and ${limits.perThread} in any one thread, per ${limits.windowMinutes} minutes`,
  );
  io.out(
    "Outgoing approval is enforced by the bridge, which asks you through your agent's host. " +
      "Incoming approval is guidance given to your agent with each message; your host's own permission settings are what actually stop it acting.",
  );
  return 0;
}

async function policySet(args: string[], ctx: CliContext): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      outgoing: { type: "string" },
      incoming: { type: "string" },
      "limit-per-agent": { type: "string" },
      "limit-per-recipient": { type: "string" },
      "limit-per-thread": { type: "string" },
      "limit-window": { type: "string" },
    },
  });
  if (Object.values(values).every((v) => v === undefined)) {
    throw new CliError(
      "Say what to change, for example: blether policy set --outgoing ask-others, or --limit-per-recipient 20",
    );
  }
  const policies = new PolicyStore(ctx.store.home);
  const current = policies.load();
  const outgoing = OutgoingLevel.safeParse(values.outgoing ?? current.outgoing);
  const incoming = IncomingLevel.safeParse(values.incoming ?? current.incoming);
  if (!outgoing.success) {
    throw new CliError("--outgoing must be ask, ask-others or free.");
  }
  if (!incoming.success) {
    throw new CliError("--incoming must be ask, ask-impactful or free.");
  }
  const currentLimits = current.limits ?? DEFAULT_SEND_LIMITS;
  const limit = (flag: string, value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new CliError(`--${flag} must be a whole number, 1 or more.`);
    }
    return n;
  };
  const limits = {
    perAgent: limit(
      "limit-per-agent",
      values["limit-per-agent"],
      currentLimits.perAgent,
    ),
    perRecipient: limit(
      "limit-per-recipient",
      values["limit-per-recipient"],
      currentLimits.perRecipient,
    ),
    perThread: limit(
      "limit-per-thread",
      values["limit-per-thread"],
      currentLimits.perThread,
    ),
    windowMinutes: limit(
      "limit-window",
      values["limit-window"],
      currentLimits.windowMinutes,
    ),
  };
  const updated = { outgoing: outgoing.data, incoming: incoming.data, limits };
  // Loosening is what a prompt-injected agent would want, so only the
  // developer, at a terminal, can do it. Tightening needs no confirmation.
  if (
    loosens(current, updated, currentLimits) &&
    !(await confirm(
      ctx,
      "This loosens your Approval Policy, so your agents will ask you less often. Make the change?",
    ))
  ) {
    ctx.io.err("Not changed.");
    return 1;
  }
  policies.save(updated);
  policyShow(ctx);
  ctx.io.out("Restart your agent sessions for the change to take effect.");
  return 0;
}

/** Whether going from `current` to `updated` lets anything through that wasn't before. */
function loosens(
  current: ApprovalPolicy,
  updated: ApprovalPolicy & { limits: SendLimits },
  currentLimits: SendLimits,
): boolean {
  // Each list runs from strictest to loosest.
  const looser = <T>(order: readonly T[], from: T, to: T) =>
    order.indexOf(to) > order.indexOf(from);
  return (
    looser(OutgoingLevel.options, current.outgoing, updated.outgoing) ||
    looser(IncomingLevel.options, current.incoming, updated.incoming) ||
    updated.limits.perAgent > currentLimits.perAgent ||
    updated.limits.perRecipient > currentLimits.perRecipient ||
    updated.limits.perThread > currentLimits.perThread ||
    // The limits count messages over the window, so a shorter one lets more through.
    updated.limits.windowMinutes < currentLimits.windowMinutes
  );
}

async function roleAdd(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const role = parseName(
    RoleName,
    args[1],
    "Usage: blether role add <team> <role>",
  );
  const credentials = loadCredentials(ctx.store);

  await withRelay(ctx, record.relayUrl, credentials, async (relay) => {
    const { team } = await relay.getTeam(record.id);
    if (team.roles.includes(role)) {
      throw new CliError(`${record.name} already has a ${role} role.`);
    }
    await relay.appendTeam(
      record.id,
      addRole(team, role, toSigner(credentials), now(ctx)),
    );
  });
  ctx.io.out(`Added the ${role} role to ${record.name}.`);
  return 0;
}

async function roleList(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const credentials = loadCredentials(ctx.store);
  const { team } = await withRelay(ctx, record.relayUrl, credentials, (relay) =>
    relay.getTeam(record.id),
  );
  if (team.roles.length === 0) {
    ctx.io.out(
      `${record.name} has no roles yet. Add one with: blether role add ${record.name} <role>`,
    );
    return 0;
  }
  ctx.io.out(`Roles in ${record.name}:`);
  for (const role of team.roles) ctx.io.out(`  ${role}`);
  return 0;
}

async function agentCreate(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { role: { type: "string", multiple: true } },
  });
  const record = loadTeam(ctx.teams, positionals[0]);
  const name = parseName(
    AgentName,
    positionals[1],
    "Usage: blether agent create <team> <agent name> [--role <role>]...",
  );
  const roles = values.role ?? [];
  const credentials = loadCredentials(ctx.store);

  await withRelay(ctx, record.relayUrl, credentials, async (relay) => {
    const { team } = await relay.getTeam(record.id);
    if (team.agents.some((a) => a.name === name)) {
      throw new CliError(`${record.name} already has an agent called ${name}.`);
    }
    checkRolesExist(team.roles, roles, record.name);
    await relay.appendTeam(
      record.id,
      createAgent(team, name, roles, toSigner(credentials), now(ctx)),
    );
  });
  ctx.io.out(`Created agent ${name} in ${record.name}.`);
  ctx.io.out(`Use it in a project with: blether use ${record.name} ${name}`);
  return 0;
}

async function agentRoles(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { role: { type: "string", multiple: true } },
  });
  const record = loadTeam(ctx.teams, positionals[0]);
  const name = parseName(
    AgentName,
    positionals[1],
    "Usage: blether agent roles <team> <agent name> [--role <role>]...",
  );
  const roles = values.role ?? [];
  const credentials = loadCredentials(ctx.store);
  const me = verifyIdentityLog(credentials.identity).id;

  await withRelay(ctx, record.relayUrl, credentials, async (relay) => {
    const { team } = await relay.getTeam(record.id);
    const agent = team.agents.find((a) => a.name === name);
    if (!agent)
      throw new CliError(`${record.name} has no agent called ${name}.`);
    if (agent.owner !== me) {
      throw new CliError(`${name} belongs to another developer.`);
    }
    checkRolesExist(team.roles, roles, record.name);
    await relay.appendTeam(
      record.id,
      setAgentRoles(team, name, roles, toSigner(credentials), now(ctx)),
    );
  });
  ctx.io.out(
    roles.length > 0
      ? `${name}'s roles are now: ${roles.join(", ")}.`
      : `${name} now has no roles.`,
  );
  return 0;
}

async function teamRemove(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const who = args[1];
  if (!who) throw new CliError("Usage: blether team remove <team> <developer>");
  const credentials = loadCredentials(ctx.store);
  const me = verifyIdentityLog(credentials.identity).id;

  const removed = await withRelay(
    ctx,
    record.relayUrl,
    credentials,
    async (relay) => {
      const { team, identities } = await relay.getTeam(record.id);
      if (team.admin !== me) {
        throw new CliError(
          `Only the Team Admin of ${record.name} can remove developers.`,
        );
      }
      // A developer is named by their name, or the start of their identity id.
      const matches = team.members.filter(
        (id) =>
          identities.get(id)?.name === who ||
          (who.length >= 8 && id.startsWith(who)),
      );
      if (matches.length === 0) {
        throw new CliError(`${record.name} has no member called ${who}.`);
      }
      if (matches.length > 1) {
        throw new CliError(
          `More than one member is called ${who}. Use the start of their identity id instead: ${matches.join(", ")}`,
        );
      }
      const [member] = matches as [string];
      if (member === me) {
        throw new CliError("The Team Admin can't remove themselves.");
      }
      const agents = team.agents.filter((a) => a.owner === member);
      const name = identities.get(member)?.name ?? member;
      if (
        !(await confirm(
          ctx,
          `Remove ${name} from ${record.name}? Their agents are deleted, and unread messages to them are lost.`,
        ))
      ) {
        throw new CliError("Not removed.");
      }
      await relay.appendTeam(
        record.id,
        removeMember(team, member, toSigner(credentials), now(ctx)),
      );
      return { name, agents };
    },
  );
  ctx.io.out(`Removed ${removed.name} from ${record.name}.`);
  if (removed.agents.length > 0) {
    ctx.io.out(
      `Deleted their agents: ${removed.agents.map((a) => a.name).join(", ")}. Unread messages to them are lost, and their senders will be told.`,
    );
  }
  return 0;
}

async function agentDelete(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const name = parseName(
    AgentName,
    args[1],
    "Usage: blether agent delete <team> <agent name>",
  );
  const credentials = loadCredentials(ctx.store);
  const me = verifyIdentityLog(credentials.identity).id;

  await withRelay(ctx, record.relayUrl, credentials, async (relay) => {
    const { team } = await relay.getTeam(record.id);
    const agent = team.agents.find((a) => a.name === name);
    if (!agent)
      throw new CliError(`${record.name} has no agent called ${name}.`);
    if (agent.owner !== me && team.admin !== me) {
      throw new CliError(`${name} belongs to another developer.`);
    }
    await relay.appendTeam(
      record.id,
      deleteAgent(team, name, toSigner(credentials), now(ctx)),
    );
  });
  ctx.io.out(
    `Deleted agent ${name} from ${record.name}. Unread messages to it are lost, and their senders will be told. The name can be used again.`,
  );
  return 0;
}

async function watch(args: string[], ctx: CliContext): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      inbox: { type: "string" },
      session: { type: "string" },
      "quiet-start": { type: "boolean" },
    },
  });
  if (!values.inbox || !values.session) {
    throw new CliError(
      "Usage: blether watch --inbox <path> --session <id> [--quiet-start]",
    );
  }
  const ended = await new Promise<string>((resolve) => {
    const stop = watchInbox(
      values.inbox!,
      values.session!,
      ctx.io.out,
      (why) =>
        resolve(
          why === "taken-over"
            ? "Blether watch stopped: another session took over this agent."
            : why === "lost"
              ? "Blether watch stopped: this session lost its connection to the relay and couldn't reconnect, so it has disconnected from Blether. Tell your developer: /blether:connect connects again."
              : "Blether watch stopped: this session disconnected from Blether.",
        ),
      { quietStart: values["quiet-start"] ?? false },
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        stop();
        resolve("");
      });
    }
  });
  if (ended) ctx.io.out(ended);
  return 0;
}

async function claudeInstall(ctx: CliContext): Promise<number> {
  const root = "packageRoot" in ctx ? ctx.packageRoot : packageRoot();
  if (!root) {
    throw new CliError(
      "This blether isn't from the @kvsm/blether package, which carries the plugin. Install it with `npm install -g @kvsm/blether`, or from a clone run `pnpm build` and then `node packages/blether/plugin/dist/cli.js claude install`.",
    );
  }
  try {
    await installClaudePlugin(root, ctx.claude ?? runClaude, ctx.io.out);
  } catch (error) {
    const missing = (error as { code?: unknown }).code === "ENOENT";
    throw new CliError(
      missing
        ? "Couldn't run `claude`. Install Claude Code, or check it's on your PATH."
        : (error as Error).message,
    );
  }
  const denied = await offerDenyRules(ctx);
  ctx.io.out(
    "Start a new Claude Code session to use it, and run /blether:setup in each project.",
  );
  return denied ? 0 : 1;
}

/**
 * Offers to add Claude Code deny rules for the Blether home and the
 * trust-changing commands, asking first since they change the
 * developer's own settings. Resolves to false if the settings couldn't be read.
 */
async function offerDenyRules(ctx: CliContext): Promise<boolean> {
  const path = ctx.claudeSettings ?? claudeSettingsPath();
  const rules = denyRules(ctx.store.home);
  let missing: string[];
  try {
    missing = missingDenyRules(path, rules);
  } catch (error) {
    ctx.io.err(
      `${(error as Error).message}\nFix it, then run blether claude install again to add Blether's deny rules.`,
    );
    return false;
  }
  if (missing.length === 0) {
    ctx.io.out(
      `Claude Code's deny rules for Blether are already in place in ${path}.`,
    );
    return true;
  }
  ctx.io.out("");
  ctx.io.out(
    `Blether can add deny rules to Claude Code's settings (${path}), so Claude can't read or edit your device key and Approval Policy in ${ctx.store.home}, or run the commands that change your teams, devices or policy:`,
  );
  for (const rule of missing) ctx.io.out(`  ${rule}`);
  ctx.io.out(
    "They cover Claude's own file tools and those commands. Without Claude Code's sandbox, a shell command or script Claude writes can still read the files. You'll run those commands yourself, in a terminal.",
  );
  if (!(await confirm(ctx, "Add these deny rules?"))) {
    ctx.io.out(
      "Skipped the deny rules. To add them later, run blether claude install again in a terminal.",
    );
    return true;
  }
  addDenyRules(path, missing);
  ctx.io.out(`Added ${missing.length} deny rules to ${path}.`);
  return true;
}

async function claudeUninstall(ctx: CliContext): Promise<number> {
  const path = ctx.claudeSettings ?? claudeSettingsPath();
  try {
    const removed = removeDenyRules(path, denyRules(ctx.store.home));
    if (removed > 0) ctx.io.out(`Removed ${removed} deny rules from ${path}.`);
  } catch (error) {
    ctx.io.err(
      `${(error as Error).message}\nRemove Blether's deny rules from it yourself.`,
    );
  }
  try {
    await uninstallClaudePlugin(ctx.claude ?? runClaude, ctx.io.out);
  } catch (error) {
    const missing = (error as { code?: unknown }).code === "ENOENT";
    throw new CliError(
      missing
        ? "Couldn't run `claude`. Install Claude Code, or check it's on your PATH."
        : (error as Error).message,
    );
  }
  return 0;
}

async function use(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { dir: { type: "string" } },
  });
  const usage = "Usage: blether use <team> <agent name> [--dir <path>]";
  if (positionals.length === 0) throw new CliError(usage);
  const record = loadTeam(ctx.teams, positionals[0]);
  const name = parseName(AgentName, positionals[1], usage);
  const credentials = loadCredentials(ctx.store);
  const me = verifyIdentityLog(credentials.identity).id;

  const { team } = await withRelay(ctx, record.relayUrl, credentials, (relay) =>
    relay.getTeam(record.id),
  );
  const agent = team.agents.find((a) => a.name === name);
  if (!agent) {
    throw new CliError(
      `${record.name} has no agent called ${name}. Create it with: blether agent create ${record.name} ${name}`,
    );
  }
  if (agent.owner !== me) {
    throw new CliError(
      `${name} belongs to another developer. Use one of yours (blether agent list ${record.name}), or create one.`,
    );
  }
  let path;
  try {
    path = writeSessionFile(
      values.dir ?? ctx.cwd ?? process.cwd(),
      { team: record.name, agent: name },
      ctx.store.home,
    );
  } catch (error) {
    if (error instanceof SessionFileError) throw new CliError(error.message);
    throw error;
  }
  ctx.io.out(
    `Sessions started in this project will act as ${name} in ${record.name}.`,
  );
  ctx.io.out(
    `Wrote ${path}; it's ignored by git, since the agent is yours. Restart any session already running here.`,
  );
  return 0;
}

async function agentList(args: string[], ctx: CliContext): Promise<number> {
  const record = loadTeam(ctx.teams, args[0]);
  const credentials = loadCredentials(ctx.store);
  const { team, identities, online } = await withRelay(
    ctx,
    record.relayUrl,
    credentials,
    async (relay) => ({
      ...(await relay.getTeam(record.id)),
      online: await relay.getPresence(record.id),
    }),
  );
  if (team.agents.length === 0) {
    ctx.io.out(
      `${record.name} has no agents yet. Create one with: blether agent create ${record.name} <agent name>`,
    );
  } else {
    ctx.io.out(`Agents in ${record.name}:`);
    for (const agent of team.agents) {
      const owner = identities.get(agent.owner)?.name ?? "(unknown)";
      const roles =
        agent.roles.length > 0 ? agent.roles.join(", ") : "no roles";
      const presence = online.includes(agent.name) ? "online" : "offline";
      ctx.io.out(`  ${agent.name}  ${owner}, ${roles}, ${presence}`);
    }
  }
  if (team.roles.length > 0) {
    ctx.io.out(`Roles: ${team.roles.join(", ")}`);
  }
  return 0;
}

function checkRolesExist(known: string[], roles: string[], team: string) {
  const unknown = roles.find((r) => !known.includes(r));
  if (unknown) {
    throw new CliError(
      `${team} has no ${unknown} role. Add it first with: blether role add ${team} ${unknown}`,
    );
  }
  if (new Set(roles).size !== roles.length) {
    throw new CliError("A role is listed twice.");
  }
}

function parseName(
  schema: typeof AgentName,
  value: string | undefined,
  usage: string,
): string {
  if (value === undefined) throw new CliError(usage);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `${value} isn't a valid name: use lowercase letters, digits and hyphens.`,
    );
  }
  return parsed.data;
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
      const { team } = await relay
        .getTeam(link.teamId, { id: link.inviteId, secret: link.secret })
        .catch((error: unknown) => {
          // The relay answers a closed or wrong invite as if the team
          // didn't exist, so it can't say which.
          if (error instanceof RelayError && error.code === "unknown-team") {
            throw new CliError(
              "This invite can't be used: it has expired, been used or been revoked, or the link is wrong. Ask for a new one.",
            );
          }
          throw error;
        });
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
      if (
        !(await confirm(
          ctx,
          `Join ${team.name} on the relay at ${link.relayUrl}? Its members' agents will be able to message yours. Only join teams you were expecting an invite to.`,
        ))
      ) {
        throw new CliError("Not joined.");
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
  ctx.io.out(
    `Create an agent with: blether agent create ${record.name} <agent name>, then run blether use ${record.name} <agent name> in your project.`,
  );
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
