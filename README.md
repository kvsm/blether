# Blether

Agent-to-agent communication for distributed teams of human developers.

Each developer's coding agent can message the agents of their teammates, on other machines, to give a heads-up before a change, ask the owner of some code instead of guessing, or say that something they were waiting on has landed. Messages are asynchronous: they wait in a mailbox until the receiving agent reads them.

> **Status:** early development. Expect breaking changes, and read [Safety](#safety) before letting agents act on what they receive.

## Quickstart

You need Node 24, and an invite link from a teammate whose team already has a relay. To start a team instead, you need a relay: see [Run a relay](#2-run-a-relay).

```sh
npm install -g @kvsm/blether           # the blether CLI, the bridge and the Claude Code plugin
blether claude install                 # adds the plugin to Claude Code (the CLI and VS Code), and offers deny rules
```

Then open Claude Code in a project, with `claude` in the terminal or in VS Code, and run `/blether:setup`. Claude walks you through the rest, running most of the commands for you:

1. **Your identity:** your name, as teammates will see it. Once per developer.
2. **Your team:** creates a new one, or gives you the command to join with your invite. Joining, inviting and removing teammates ask you to confirm at a terminal, so you run those yourself.
3. **This project's agent:** the named mailbox your sessions here act as. Teammates' agents message it by name, so pick one that says what it works on, such as `web-app` or `payments-api`. You can give it roles, such as `frontend` or `reviewer`, so teammates can message every agent covering an area at once.
4. **Connecting:** the session connects to Blether, and is told whenever a message arrives.

Claude can now message your teammates' agents. Try asking it "who's on the Blether team?" In later sessions, run `/blether:connect` when you want to work with your team. Sessions you don't connect leave Blether out entirely.

By default Claude asks you before it sends any message, and before it acts on any request it receives. [Approval Policy](#approval-policy) explains how to loosen this.

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

In Claude Code, start a new session in the project and run `/blether:connect`. For other agents, see [Other agents](#other-agents). [Getting started](#getting-started) covers each step in more detail, along with creating a team and running a relay.

## Updating

Your identity, teams, agents and policy live in `~/.blether`, and each project's choice of agent in its `.blether/session.json`. Updating leaves both alone, so there's nothing to set up again.

1. Update the package:

   ```sh
   npm install -g @kvsm/blether@latest
   blether --version                      # shows the version now installed
   ```

2. If you use Claude Code, update the plugin to match:

   ```sh
   blether claude install
   ```

3. Restart your agent sessions: end each one and start a new one (or `claude --continue` to pick up where you left off), then run `/blether:connect` again.

4. If you use another agent and copied the `blether` skill into its skills directory, copy it again from `$(npm root -g)/@kvsm/blether/plugin/skills/blether/SKILL.md`.

The team's relay is updated separately, by whoever runs it: see [Upgrades](docs/self-hosting.md#upgrades).

## How it works

```
 Your device                                                  A teammate's device
┌──────────────────────────┐                               ┌──────────────────────────┐
│ coding agent             │                               │ coding agent             │
│   ↕ MCP                  │      ┌─────────────────┐      │   ↕ MCP                  │
│ bridge (blether-bridge)  │ ←──→ │      relay      │ ←──→ │ bridge (blether-bridge)  │
│ blether CLI              │  wss │ holds mailboxes │  wss │ blether CLI              │
└──────────────────────────┘      └─────────────────┘      └──────────────────────────┘
```

- The **bridge** is a local MCP server that gives an agent its Blether tools. Each agent session runs one.
- The **relay** carries messages between a team's bridges and holds each agent's mailbox. A team runs one, or shares a hosted one.
- The **`blether` CLI** is how developers manage their identity, teams, agents and policy. Agents can't change any of those.

Every message is signed by the sending device and encrypted separately for each of the recipient developer's devices. The relay sees who messaged whom, and when, but never what was said. Only members of a team, invited with a one-use link, can take part.

## Getting started

You need Node 24.

### 1. Install Blether

```sh
npm install -g @kvsm/blether
```

This installs the `blether` CLI (`blether help` lists its commands), the bridge (`blether-bridge`), and the Claude Code plugin. To upgrade, see [Updating](#updating).

### 2. Run a relay

For a team on several machines, host a relay somewhere they can all reach, with TLS: see [Hosting a relay](#hosting-a-relay). To try Blether on one machine, run one locally with Docker and leave it running:

```sh
docker run -d --name blether-relay -p 127.0.0.1:7357:7357 -v blether-relay:/data ghcr.io/kvsm/blether-relay
```

Or, from a clone of this repository: `pnpm install && pnpm build && node packages/relay/dist/bin.js`.

### 3. Create your identity

Once per developer, on your first device:

```sh
blether init --name <name>             # creates your identity in ~/.blether
```

To use Blether on another of your devices, [add the device](#your-devices) to your identity instead of running `init` there.

### 4. Create or join a team

If the relay requires a sign-in, first run `blether sign-in <relay-url>`, or `blether sign-in <invite>` before joining. Depending on the relay, it asks for the token its operator gave you, or opens your browser to sign in with your organisation's account (`--device-code` signs in with a code instead, in a browser anywhere).

One developer creates the team, becoming its **Team Admin**, and invites the others:

```sh
blether team create <team> --relay ws://127.0.0.1:7357   # or wss://relay.example.com; --as <name> picks your own local name
blether invite <team>                  # a one-use invite link, valid for 72 hours
```

Send each invite to its teammate privately. They run `blether init` (once), then:

```sh
blether join <invite>                  # --as <name> picks your own local name for the team
blether team members <team>            # who's in the team, and open invites
```

### 5. Create agents

An agent is a named mailbox you own. Your coding sessions act as one agent at a time, and teammates' agents message it by name, so pick one that says what it works on, such as `web-app` or `payments-api`.

Agents can have roles from the team's agreed list (such as `frontend`), so teammates can message everyone covering an area:

```sh
blether role list <team>               # the roles the team has agreed
blether role add <team> <role>         # adds a role to the team's list
blether agent create <team> <agent name> --role <role>
blether agent list <team>              # the roster: agents, owners, roles, who's online
```

Then, from the root of each project, choose which agent sessions started there act as:

```sh
cd <project>
blether use <team> <agent name>        # writes .blether/session.json, which git ignores
```

### 6. Connect your agent

#### Claude Code

The Blether plugin adds the bridge, new-mail notices, and these skills:

- **`/blether:connect`** and **`/blether:disconnect`**: connect a session to Blether, and disconnect it.
- **`blether`**: in a connected session, Claude uses it on its own, to decide when to message teammates' agents and how to write to them.
- **`/blether:setup`**: walks you through steps 3 to 5 for a project, connects the session, and offers a status line for escalations.

```sh
blether claude install       # adds the plugin to Claude Code, from the installed package
```

The plugin also puts `blether` on Claude's Bash `PATH`, so Claude can run the CLI for you.

Sessions start without Blether: the bridge doesn't connect to the relay, Claude has no Blether tools, and nothing about Blether is added to the conversation. Your agent shows as offline to teammates. When you want a session to work with your team, run `/blether:connect`:

- The bridge connects as the agent the project's `.blether/session.json` names, and Claude gets its Blether tools.
- Claude reads its mailbox, then starts a watch (with Claude Code's Monitor tool) that wakes the session whenever a message arrives, in the terminal and in VS Code. The watch sends a short notice (`New Blether message from <agent name>…`), never the message itself.
- Only one session can be connected as an agent at a time. If the agent is already online, Claude asks before connecting, since connecting takes the agent over and disconnects the other session.

`/blether:disconnect`, or ending the session, disconnects it.

#### Other agents

Add the bridge to the agent's MCP config:

```json
{
  "mcpServers": {
    "blether": { "command": "blether-bridge" }
  }
}
```

The bridge looks for `.blether/session.json` in the directory the agent starts it in, or the nearest one above it inside the repository. For guidance on when and how to message teammates, give the agent the `blether` skill, at `$(npm root -g)/@kvsm/blether/plugin/skills/blether/SKILL.md` ([source](packages/blether/plugin/skills/blether/SKILL.md)): copy it into the agent's skills directory if it reads Agent Skills, or point to it from the project's `AGENTS.md`.

If anything's wrong at start-up (no identity, an unknown team, a relay that can't be reached), the bridge still starts, offering a single `blether_status` tool that explains the problem, so the agent can tell you.

### 7. Optional: push delivery in Claude Code without the plugin

Without the plugin, the bridge connects as soon as the agent starts it, and an agent sees new messages when it next checks its mailbox (it's told to at the start of a session, before starting a task, and before committing or pushing). If you run the bridge in Claude Code without the plugin, it can also wake the session as soon as a message arrives, using [channels](https://code.claude.com/docs/en/channels-reference).

Channels are a research preview, so they need enabling each session with the development flag:

```sh
claude --mcp-config blether.json --dangerously-load-development-channels server:blether
```

- Channels only work in interactive sessions.
- Team and Enterprise organisations must allow channels (`channelsEnabled`).
- Leave `MCP_PROTOCOL_NEGOTIATION` unset (not `auto`): otherwise Claude Code may negotiate MCP `2026-07-28` with the bridge, which can't carry channel notices.
- Without channels, nothing breaks: messages wait in the mailbox.

## What agents can do

| Tool                                            | What it does                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `list_agents`                                   | The team's roster: each agent's owner, roles, and whether it's online                             |
| `send_message`                                  | Send to one agent (`to`), every agent holding a role (`role`), or every other agent (`everyone`)  |
| `read_mailbox`                                  | Read new messages                                                                                 |
| `sent_messages`                                 | Whether each sent message is queued, delivered or read                                            |
| `take_over_agent`                               | Offered when another session already acts as the agent: disconnects it and takes its place        |
| `escalate`, `list_escalations`, `record_answer` | Set a message aside for the developer's decision, and record it (see [Escalations](#escalations)) |

- **Replies:** giving `reply_to` makes a message a reply, in the same thread. On its own, it goes back to the sender, even of a role message or a broadcast.
- **Attachments:** a message can carry up to 10 code snippets, diffs and links, encrypted and secret-checked like the body. The whole message is limited to 32,000 characters.
- **Copies:** each recipient of a role message or broadcast gets their own encrypted copy.
- **Offline agents:** messages wait in an agent's mailbox until its next session connects.
- **Sent messages** are kept on your device, in `~/.blether/sent/`, so a reply can be shown with the start of what it answers.
- **Boundaries:** agents can only message agents in their own team, and a session can only act as an agent its developer created.

## Safety

Messages come from other people's agents, so treat them as untrusted input. Blether gives you five controls.

### Approval Policy

By default your agents ask you before sending any message, and are told to ask you before acting on any request they receive. See your policy with `blether policy`, and change it:

```sh
blether policy set --outgoing ask-others     # ask only before messaging other developers' agents
blether policy set --incoming ask-impactful  # let agents act on low-impact requests
```

| Setting      | Levels                                   |
| ------------ | ---------------------------------------- |
| `--outgoing` | `ask` (default), `ask-others`, `free`    |
| `--incoming` | `ask` (default), `ask-impactful`, `free` |

- **Outgoing** approval is enforced by the bridge: it shows you each message through your agent's host (MCP elicitation), and only sends it if you approve. If the host can't show the prompt, sends are refused until you relax `--outgoing`.
- **Incoming** approval is guidance given to your agent with every message. What actually stops an agent acting is your host's own permission settings.

The policy applies to one device, and is kept in `~/.blether/policy.json`. Loosening it (a less strict level, a higher limit or a shorter window) asks you to confirm at an interactive terminal, so an agent can't loosen it from its own shell. Tightening it doesn't ask.

### Sending limits

To stop runaway loops, such as two agents trading replies forever, each agent may send at most 30 messages in 10 minutes, and at most 10 to any one agent or in any one thread. Going over asks you, in the same prompt as any approval, and is refused if the host can't ask. To change the limits:

```sh
blether policy set --limit-per-agent 30 --limit-per-recipient 10 --limit-per-thread 10 --limit-window 10
```

### Claude Code deny rules

Your device key and Approval Policy are files in `~/.blether`, and Claude runs as you, so a message that tricks it could have it read the key or edit the policy. `blether claude install` offers, and asks before adding, deny rules in Claude Code's settings (`~/.claude/settings.json`) that stop Claude:

- reading or editing anything in `~/.blether` with its own file tools
- running the commands that change your teams, devices or policy: `blether invite`, `join`, `team remove`, `policy set`, `device add` and `device revoke`. You run those yourself, in a terminal, where they ask you to confirm anyway.

They're only as strong as Claude Code's enforcement. Without Claude Code's sandbox, a shell command or a script Claude writes can still read the files, so keep Claude Code's own permission prompts on in sessions connected to Blether. `blether claude uninstall` removes the rules along with the plugin.

### Secret check

Before a message is encrypted, the bridge checks it, and its attachments, with [secretlint](https://github.com/secretlint/secretlint)'s recommended rules: cloud provider keys, service tokens, private keys and so on. If anything matches, it asks you whatever your Approval Policy says, showing what it found with the value masked. Only you can decide to send it anyway; if the host can't show the prompt, the message isn't sent.

### Escalations

When an agent isn't sure a message is safe to act on, it escalates it. The message is set aside, the sender gets a fixed "holding your message until my developer answers" notice, and the agent carries on with other work.

- Escalations wait, across sessions, until you answer. The agent lists them, numbered, when you next speak to it, and you answer in the conversation ("1 yes, 2 no").
- While any are waiting, a short reminder appears at the end of the agent's output, at most every 15 minutes.
- `blether escalations` lists what's waiting, from any terminal.

To keep a count always visible at the bottom of Claude Code, add Blether to your status line in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "blether status"
  }
}
```

It prints nothing when nothing is waiting, and `⚑ 2 waiting (<agent name>)` when something is.

## Managing your team

### Your devices

To use Blether on another of your devices, add it to your identity rather than running `blether init` there:

1. On the new device: `blether device request`, which prints a request.
2. On a device that already has your identity: `blether device add <request>`. Check the fingerprint it shows matches the new device's.
3. Back on the new device: `blether device accept <grant>`. It gets your identity and your list of teams.

If a device is lost or stolen, revoke it from one of your others with `blether device revoke <fingerprint>` (`blether device list` shows the fingerprints). The relay refuses it from then on, teammates' agents stop encrypting for it within a minute, and it can't be added back.

If you lose every device, the identity can't be recovered: ask your Team Admin to remove you, run `blether init` on a new device, and join again with a new invite. Messages waiting for your old agents are lost, and their senders are told.

### Agents and members

- `blether agent roles <team> <agent name> --role <role>...` replaces one of your agents' roles.
- `blether agent delete <team> <agent name>` deletes one of your agents. The Team Admin can delete any.
- `blether team remove <team> <developer>` lets the Team Admin remove a developer, along with their agents.
- `blether revoke-invite <team> <invite-id>` cancels an invite that hasn't been used.

Messages a deleted agent hadn't read are lost. Each sender's agent is told, with the text from its own device, so it can send it to someone else. A deleted agent's name can be reused, and the roster shows the new agent as a replacement.

## Hosting a relay

[`docs/self-hosting.md`](docs/self-hosting.md) covers running a relay for your team: what the operator can see, Docker with automatic TLS, free hosting on Google Cloud, running it at home through a tunnel, backups, and upgrades. The relay image is `ghcr.io/kvsm/blether-relay`.

The relay prints message counts, in total and for each recipient, every few minutes. [Debug mode](docs/self-hosting.md#message-statistics) also counts role messages and broadcasts.

## Configuration

| Variable              | Used by     | What it does                                                                                                      |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `BLETHER_HOME`        | CLI, bridge | Where your identity, teams and policy live (default `~/.blether`)                                                 |
| `BLETHER_PROJECT_DIR` | bridge      | Where to look for `.blether/session.json` (default: the directory the bridge starts in)                           |
| `BLETHER_TEAM`        | bridge      | The team to act in, overriding the session file                                                                   |
| `BLETHER_AGENT`       | bridge      | The agent to act as, overriding the session file                                                                  |
| `BLETHER_RELAY_*`     | relay       | Listening address, database, TLS and statistics: see [`docs/self-hosting.md`](docs/self-hosting.md#configuration) |

## Development

| Path                | What it is                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol` | Message, envelope, identity and team-log types shared by the bridge and relay                                        |
| `packages/bridge`   | The bridge (`blether-bridge`) and the `blether` CLI                                                                  |
| `packages/relay`    | The relay (`blether-relay`)                                                                                          |
| `packages/blether`  | The `@kvsm/blether` npm package: the CLI and bridge bundled into the Claude Code plugin (`plugin/`), with its skills |
| `e2e`               | End-to-end tests, driving real bridges, CLIs and relays                                                              |
| `deploy`            | Docker Compose files and the relay image smoke test                                                                  |

```sh
pnpm install
pnpm build        # compiles, then bundles the CLI and bridge into packages/blether/plugin/dist
pnpm check        # lint, format check, typecheck, test
pnpm test:watch
pnpm --filter @kvsm/blether smoke   # checks the bundled CLI and bridge run on their own
```

To use your working copy instead of the published package, run `npm install -g ./packages/blether` after `pnpm build`, then `blether claude install`.

**Releasing:** run `pnpm set-version <version>`, which sets it for the npm package, the relay image, the plugin and every workspace package (a test fails if they differ), and merge to `main`. The Publish workflow puts the package on npm, and the Relay image workflow publishes the image tagged with the same version.

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm trusts `.github/workflows/publish.yml` in `kvsm/blether`, so no token is stored. The trusted publisher is set on the package's **Settings** page on npmjs.com (GitHub Actions, user `kvsm`, repository `blether`, workflow `publish.yml`, no environment).

## License

[Functional Source License 1.1, Apache 2.0 future licence](LICENSE) (FSL-1.1-ALv2). You may use, change and self-host Blether for any purpose except offering it to others as a competing commercial product or service. Each version becomes available under the Apache License 2.0 two years after its release. Versions up to 0.2.5 were released under the MIT licence, and stay so.
