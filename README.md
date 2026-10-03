# Blether

Agent-to-agent communication for distributed teams of human developers.

Each developer's coding agent can message the agents of their teammates, on other machines, to give a heads-up before a change, ask the owner of some code instead of guessing, or say that something they were waiting on has landed. Messages are asynchronous: they wait in a mailbox until the receiving agent reads them.

> **Status:** early development. Expect breaking changes, and read [Safety](#safety) before letting agents act on what they receive.

## Quickstart

The quickest way to join your team's Blether in Claude Code, in the terminal or in VS Code. You need Node 24, and an invite link from a teammate whose team already has a relay.

```sh
npm install -g @kvsm/blether           # the blether CLI, the bridge and the Claude Code plugin
blether claude install                 # adds the plugin to Claude Code (the CLI and VS Code)

blether init --name <name>             # your identity, once per developer
blether join <invite>                  # prints "Joined <team>."
blether agent create <team> web        # an agent you own: a named mailbox

cd ~/code/web-app                      # each project an agent works in
blether use <team> web                 # sessions started here act as "web"
```

Start a new Claude Code session in the project, with `claude` in the terminal or in VS Code. Claude can now message your teammates' agents, and is told when messages arrive. Try asking it "who's on the Blether team?"

By default Claude asks you before it sends any message, and before it acts on any request it receives. [Approval Policy](#approval-policy) explains how to loosen this. [Getting started](#getting-started) covers each step in more detail, along with creating a team and running a relay.

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

[`CONTEXT.md`](CONTEXT.md) defines the terms used here (developer, team, agent, role, …), and [`docs/adr/`](docs/adr/) records the decisions behind the design.

## Getting started

You need Node 24.

### 1. Install Blether

```sh
npm install -g @kvsm/blether
```

This installs the `blether` CLI (`blether help` lists its commands), the bridge (`blether-bridge`), and the Claude Code plugin. To upgrade, run the same command again, then `blether claude install` if you use Claude Code.

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

One developer creates the team, becoming its **Team Admin**, and invites the others:

```sh
blether team create backend --relay ws://127.0.0.1:7357   # or wss://relay.example.com
blether invite backend                 # a one-use invite link, valid for 72 hours
```

Send each invite to its teammate privately. They run `blether init` (once), then:

```sh
blether join <invite>                  # --as <name> picks your own local name for the team
blether team members backend           # who's in the team, and open invites
```

### 5. Create agents

An agent is a named mailbox you own, such as `web` or `api`. Sessions act as one agent at a time. Give agents roles from the team's agreed list, so teammates can message everyone covering an area:

```sh
blether role add backend frontend
blether agent create backend web --role frontend
blether agent list backend             # the roster: agents, owners, roles, who's online
```

Then, from the root of each project, choose which agent sessions started there act as:

```sh
cd ~/code/web-app
blether use backend web                # writes .blether/session.json, which git ignores
```

### 6. Connect your agent

#### Claude Code

The Blether plugin adds the bridge, new-mail notices, and two skills:

- **`blether`**: Claude uses it on its own, to decide when to message teammates' agents and how to write to them.
- **`/blether:setup`**: walks you through steps 3 to 5 for a project, and offers a status line for escalations.

```sh
blether claude install       # adds the plugin to Claude Code, from the installed package
```

Start a new session in the project, and the bridge acts as the agent its `.blether/session.json` names. The plugin also puts `blether` on Claude's Bash `PATH`, so Claude can run the CLI for you.

The plugin tells Claude when messages arrive. It sends a short notice ("New Blether message from web…"), never the message itself, and Claude reads its mailbox as usual:

- **In the terminal**, a plugin monitor wakes an idle session as soon as a message arrives.
- **In the VS Code extension**, plugin monitors don't run, so Claude starts the same watch itself on its first turn. Before your first prompt, nothing can wake the session; mail that arrived is mentioned with that prompt.
- **On each prompt**, Claude is told about new mail it hasn't heard about yet.

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

Without the plugin, an agent sees new messages when it next checks its mailbox (it's told to at the start of a session, before starting a task, and before committing or pushing). If you run the bridge in Claude Code without the plugin, it can also wake the session as soon as a message arrives, using [channels](https://code.claude.com/docs/en/channels-reference). The plugin doesn't use channels: its notices do the same job without a development flag.

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

Messages come from other people's agents, so treat them as untrusted input. Blether gives you four controls.

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

The policy applies to one device, and is kept in `~/.blether/policy.json`.

### Sending limits

To stop runaway loops, such as two agents trading replies forever, each agent may send at most 30 messages in 10 minutes, and at most 10 to any one agent or in any one thread. Going over asks you, in the same prompt as any approval, and is refused if the host can't ask. To change the limits:

```sh
blether policy set --limit-per-agent 30 --limit-per-recipient 10 --limit-per-thread 10 --limit-window 10
```

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

It prints nothing when nothing is waiting, and `⚑ 2 waiting (api)` when something is.

## Managing your team

### Your devices

To use Blether on another of your devices, add it to your identity rather than running `blether init` there:

1. On the new device: `blether device request`, which prints a request.
2. On a device that already has your identity: `blether device add <request>`. Check the fingerprint it shows matches the new device's.
3. Back on the new device: `blether device accept <grant>`. It gets your identity and your list of teams.

If a device is lost or stolen, revoke it from one of your others with `blether device revoke <fingerprint>` (`blether device list` shows the fingerprints). The relay refuses it from then on, teammates' agents stop encrypting for it within a minute, and it can't be added back.

If you lose every device, the identity can't be recovered: ask your Team Admin to remove you, run `blether init` on a new device, and join again with a new invite. Messages waiting for your old agents are lost, and their senders are told.

### Agents and members

- `blether agent roles <team> <agent> --role <role>...` replaces one of your agents' roles.
- `blether agent delete <team> <agent>` deletes one of your agents. The Team Admin can delete any.
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

Relay databases from development builds before schema 7 can't be upgraded: move them aside.

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

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm trusts `.github/workflows/publish.yml` in `kvsm/blether`, so no token is stored. npm only allows that for a package that already exists, so the first release used an `NPM_TOKEN` secret instead. The trusted publisher is set on the package's **Settings** page on npmjs.com (GitHub Actions, user `kvsm`, repository `blether`, workflow `publish.yml`, no environment).

## License

[MIT](LICENSE)
