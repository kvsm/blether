// Checks the bundled CLI and bridge work on their own: sets up a team on a
// real relay with the bundled CLI, then starts the bundled bridge over stdio,
// as an agent's host would, and sends a message through it (which also runs
// the bundled secret check). Run after `pnpm build` and `pnpm bundle`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "@blether/relay";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const dist = join(dirname(fileURLToPath(import.meta.url)), "plugin", "dist");
const root = mkdtempSync(join(tmpdir(), "blether-package-"));
const home = join(root, "home");
const project = join(root, "project");
const env = { ...process.env, BLETHER_HOME: home };
// Asynchronous, since the relay runs in this process and must keep answering.
const blether = (...args) =>
  run(process.execPath, [join(dist, "cli.js"), ...args], { env });

const relay = await startRelay();
try {
  await blether("init", "--name", "Smoke");
  await blether("team", "create", "smoke", "--relay", relay.url);
  await blether("agent", "create", "smoke", "web");
  await blether("agent", "create", "smoke", "api");
  await blether("policy", "set", "--outgoing", "free");
  await blether("use", "smoke", "web", "--dir", project);

  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(dist, "bridge.js")],
      env: { ...env, BLETHER_PROJECT_DIR: project },
      stderr: "ignore",
    }),
  );
  try {
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === "send_message")) {
      throw new Error(
        `The bridge didn't start properly; its tools are: ${tools.map((t) => t.name).join(", ")}`,
      );
    }
    const result = await client.callTool({
      name: "send_message",
      arguments: { to: "api", body: "Hello from the bundled bridge." },
    });
    const text = result.content[0]?.text ?? "";
    // api has no session, so the relay queues it for api's next one.
    if (result.isError || !text.startsWith("Queued message")) {
      throw new Error(`send_message failed: ${text}`);
    }
  } finally {
    await client.close();
  }
  console.log("package smoke test passed");
} finally {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
}
