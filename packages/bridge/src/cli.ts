import { parseArgs } from "node:util";
import {
  DeveloperName,
  createIdentity,
  generateMachineKey,
  verifyIdentityLog,
} from "@blether/protocol";
import { FileKeyStore } from "./keystore.js";

/**
 * The `blether` command. Everything that changes who a developer is, or who
 * is in a team, happens here and never through the agent (ADR 0006).
 */

const USAGE = `Usage: blether <command>

Commands:
  init --name <name>   Create this machine's key and your Blether identity
  whoami               Show your identity

Set BLETHER_HOME to keep Blether's files somewhere other than ~/.blether.`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Runs the CLI with `argv` (without the node and script paths). Returns the exit code. */
export function runCli(
  argv: string[],
  store = new FileKeyStore(),
  io: CliIo = { out: console.log, err: console.error },
): number {
  try {
    return dispatch(argv, store, io);
  } catch (error) {
    // node:util parseArgs reports bad options with ERR_PARSE_ARGS_* codes.
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      io.err(`${(error as Error).message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
}

function dispatch(argv: string[], store: FileKeyStore, io: CliIo): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return init(rest, store, io);
    case "whoami":
      return whoami(store, io);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return command === undefined ? 1 : 0;
    default:
      io.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

function init(args: string[], store: FileKeyStore, io: CliIo): number {
  const { values } = parseArgs({
    args,
    options: { name: { type: "string" } },
  });
  const name = DeveloperName.safeParse(values.name);
  if (!name.success) {
    io.err(
      'Give your name, as teammates will see it: blether init --name "Kev"',
    );
    return 1;
  }
  if (store.exists()) {
    io.err(
      `There is already a Blether identity in ${store.home}. Run \`blether whoami\` to see it.`,
    );
    return 1;
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

function whoami(store: FileKeyStore, io: CliIo): number {
  const credentials = store.load();
  if (!credentials) {
    io.err(`No Blether identity in ${store.home}. Run \`blether init\` first.`);
    return 1;
  }
  const identity = verifyIdentityLog(credentials.identity);
  io.out(`Name:     ${identity.name}`);
  io.out(`Identity: ${identity.id}`);
  io.out(`Machine:  ${credentials.machine.publicKey}`);
  return 0;
}
