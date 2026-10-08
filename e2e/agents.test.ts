import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type Relay } from "@blether/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, type Device } from "./support.js";

describe("agents, roles and the roster", () => {
  let relay: Relay;
  let root: string;
  let kev: Device;
  let carol: Device;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    relay = await startRelay();
    root = mkdtempSync(join(tmpdir(), "blether-agents-"));
    kev = device(root, "kev");
    carol = device(root, "carol");
    await kev.run("init", "--name", "Kev");
    await carol.run("init", "--name", "Carol");
    await kev.run("team", "create", "product", "--relay", relay.url);
    await carol.run("join", await kev.invite("product"));
    await kev.run("role", "add", "product", "frontend");
    await carol.run("role", "add", "product", "backend");
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates agents with roles and lists them with who's online", async () => {
    expect(
      await kev.run("agent", "create", "product", "web", "--role", "frontend"),
    ).toMatchObject({ code: 0 });
    await carol.run("agent", "create", "product", "api", "--role", "backend");
    const web = await kev.session("product", "web");
    cleanups.push(web.close);

    const listed = await carol.run("agent", "list", "product");

    expect(listed.out).toBe(
      [
        "Agents in product:",
        "  web  Kev, frontend, online",
        "  api  Carol, backend, offline",
        "Roles: frontend, backend",
      ].join("\n"),
    );
  });

  it("lists the team's roles", async () => {
    const listed = await carol.run("role", "list", "product");

    expect(listed).toMatchObject({
      code: 0,
      out: ["Roles in product:", "  frontend", "  backend"].join("\n"),
    });
  });

  it("says how to add a role when the team has none", async () => {
    await kev.run("team", "create", "empty", "--relay", relay.url);

    const listed = await kev.run("role", "list", "empty");

    expect(listed.out).toBe(
      "empty has no roles yet. Add one with: blether role add empty <role>",
    );
  });

  it("shows the roles in the agent list before any agents exist", async () => {
    const listed = await kev.run("agent", "list", "product");

    expect(listed.out).toBe(
      [
        "product has no agents yet. Create one with: blether agent create product <agent name>",
        "Roles: frontend, backend",
      ].join("\n"),
    );
  });

  it("gives agents a roster through the list_agents tool", async () => {
    await kev.run("agent", "create", "product", "web", "--role", "frontend");
    await carol.run("agent", "create", "product", "api");
    const web = await kev.session("product", "web");
    cleanups.push(web.close);

    expect(await web.call("list_agents")).toBe(
      [
        "web (you): Kev's agent, frontend, online",
        "api: Carol's agent, no roles, offline",
      ].join("\n"),
    );

    const api = await carol.session("product", "api");
    cleanups.push(api.close);
    expect(await web.call("list_agents")).toContain(
      "api: Carol's agent, no roles, online",
    );
  });

  it("refuses a second agent with the same name", async () => {
    await kev.run("agent", "create", "product", "web");

    const result = await carol.run("agent", "create", "product", "web");

    expect(result.code).toBe(1);
    expect(result.err).toContain("already has an agent called web");
  });

  it("refuses a role that isn't on the team's list", async () => {
    const result = await kev.run(
      "agent",
      "create",
      "product",
      "web",
      "--role",
      "design",
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain("blether role add product design");
  });

  it("lets an agent's owner, and only its owner, change its roles", async () => {
    await kev.run("agent", "create", "product", "web", "--role", "frontend");

    expect(
      await kev.run(
        "agent",
        "roles",
        "product",
        "web",
        "--role",
        "frontend",
        "--role",
        "backend",
      ),
    ).toMatchObject({ code: 0 });
    expect((await kev.run("agent", "list", "product")).out).toContain(
      "web  Kev, frontend, backend",
    );

    const byCarol = await carol.run("agent", "roles", "product", "web");
    expect(byCarol.code).toBe(1);
    expect(byCarol.err).toContain("belongs to another developer");
  });

  it("only lets a developer act as agents they created", async () => {
    await kev.run("agent", "create", "product", "web");

    await expect(carol.session("product", "web")).rejects.toMatchObject({
      code: "agent-owned-by-another",
    });
    await expect(carol.session("product", "nobody")).rejects.toMatchObject({
      code: "unknown-agent",
      message: expect.stringContaining("blether agent create product nobody"),
    });
  });
});
