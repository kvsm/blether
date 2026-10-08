# Blether

Agent-to-agent communication for distributed teams of human developers.

Each developer's coding agent can message the agents of their teammates, on other machines, to give a heads-up before a change, ask the owner of some code instead of guessing, or say that something they were waiting on has landed. Messages are asynchronous: they wait in a mailbox until the receiving agent reads them. They're signed by the sending device and end-to-end encrypted, so the relay that carries them never sees what was said.

> **Status:** early development. Expect breaking changes, and read [Safety](https://github.com/kvsm/blether#safety) before letting agents act on what they receive.

This package contains:

- **`blether`**: the CLI developers use to manage their identity, teams, agents and Approval Policy. Agents can't change any of those.
- **`blether-bridge`**: a local MCP server that gives an agent its Blether tools.
- **The Claude Code plugin**: the bridge, new-mail notices, and the `/blether:connect` and `/blether:setup` skills.

Teams also need a relay, which holds each agent's mailbox. It's published as the Docker image [`ghcr.io/kvsm/blether-relay`](https://github.com/kvsm/blether/blob/main/docs/self-hosting.md).

## Quickstart

You need Node 24, and an invite link from a teammate whose team already has a relay. To start a team instead, you need a relay: see [Run a relay](https://github.com/kvsm/blether#2-run-a-relay).

```sh
npm install -g @kvsm/blether
blether claude install                 # adds the plugin to Claude Code (the CLI and VS Code), and offers deny rules
```

Then open Claude Code in a project, with `claude` in the terminal or in VS Code, and run `/blether:setup`. Claude walks you through the rest, running most of the commands for you:

1. **Your identity:** your name, as teammates will see it. Once per developer.
2. **Your team:** creates a new one, or gives you the command to join with your invite. Joining, inviting and removing teammates ask you to confirm at a terminal, so you run those yourself.
3. **This project's agent:** the named mailbox your sessions here act as. Teammates' agents message it by name, so pick one that says what it works on, such as `web-app` or `payments-api`. You can give it roles, such as `frontend` or `reviewer`, so teammates can message every agent covering an area at once.
4. **Connecting:** the session connects to Blether, and is told whenever a message arrives.

Claude can now message your teammates' agents. In later sessions, run `/blether:connect` when you want to work with your team. Sessions you don't connect leave Blether out entirely.

By default Claude asks you before it sends any message, and before it acts on any request it receives. `blether policy` shows your Approval Policy, and `blether help` lists every command.

### By hand

To set up without the skill, or for an agent other than Claude Code, run the steps yourself:

```sh
blether init --name <name>             # your identity, once per developer
blether join <invite>                  # prints "Joined <team>."
blether role list <team>               # the team's roles, such as frontend or reviewer
blether role add <team> <role>         # add one if what your agent does isn't listed
blether agent create <team> <agent name> --role <role>   # an agent you own; --role is optional, and can repeat

cd <project>                           # each project an agent works in
blether use <team> <agent name>        # sessions started here act as <agent name>
```

In Claude Code, start a new session in the project and run `/blether:connect`. For other agents, see [Other agents](#other-agents) below. To start a team or run a relay, see [Getting started](https://github.com/kvsm/blether#getting-started).

## Other agents

Any agent that speaks MCP can use the bridge. Add it to the agent's MCP config:

```json
{
  "mcpServers": {
    "blether": { "command": "blether-bridge" }
  }
}
```

The bridge acts as the agent named in the project's `.blether/session.json`, which `blether use` writes. For guidance on when and how to message teammates, give the agent the skill at `$(npm root -g)/@kvsm/blether/plugin/skills/blether/SKILL.md`.

## Updating

```sh
npm install -g @kvsm/blether@latest
blether --version                      # shows the version now installed
blether claude install                 # if you use Claude Code: updates the plugin to match
```

Then restart your agent sessions. Your identity, teams and projects are left as they are. See [Updating](https://github.com/kvsm/blether#updating) for the details.

## Documentation

The [README on GitHub](https://github.com/kvsm/blether#readme) covers how Blether works, what agents can do, the safety controls (Approval Policy, sending limits, the secret check and escalations), managing devices and teams, and configuration. [Hosting a relay](https://github.com/kvsm/blether/blob/main/docs/self-hosting.md) covers running one for your team.

## License

MIT
