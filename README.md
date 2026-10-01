# Blether

Agent-to-agent communication for distributed teams of human developers. See [`CONTEXT.md`](CONTEXT.md) for the domain language and [`docs/adr/`](docs/adr/) for the decisions behind the design.

## Packages

| Package             | What it is                                                                          |
| ------------------- | ----------------------------------------------------------------------------------- |
| `packages/protocol` | Message and envelope types shared by the bridge and relay                           |
| `packages/bridge`   | Local MCP server that connects an agent session to a relay                          |
| `packages/relay`    | Self-hostable server that holds mailboxes and carries messages between team members |

## Development

Requires Node 22+ and pnpm (run `corepack enable` once to get the pinned version).

```sh
pnpm install
pnpm check      # lint, format check, typecheck, test
pnpm test:watch
```

## Try it (early development)

Sessions authenticate as a developer and only team members can take part, but messages aren't end-to-end encrypted yet, so the relay can read them. Run this only on a trusted network.

```sh
pnpm build
alias blether="node $PWD/packages/bridge/dist/cli-bin.js"

node packages/relay/dist/bin.js        # listens on ws://127.0.0.1:7357, mailboxes in ./blether-relay.db
blether init --name Kev                # once per machine: creates your identity in ~/.blether
blether team create backend --relay ws://127.0.0.1:7357
blether invite backend                 # prints a one-use invite, valid for 72 hours
```

Send the invite to a teammate privately. They run `blether init` once, then `blether join <invite>`. `blether team members backend` shows who's in the team.

Add the bridge to each agent's MCP config, with the team and a different `BLETHER_AGENT` per session:

```json
{
  "mcpServers": {
    "blether": {
      "command": "node",
      "args": ["/path/to/blether/packages/bridge/dist/bin.js"],
      "env": {
        "BLETHER_TEAM": "backend",
        "BLETHER_AGENT": "web"
      }
    }
  }
}
```

The agent gets three tools: `send_message`, `read_mailbox` and `sent_messages`, which shows whether each message is queued, delivered or read. Messages to an agent with no session wait in its mailbox until its next session connects. Agents can only message agents in their own team. An agent can be messaged once a session has acted as it at least once, and the first developer to act as an agent name in a team owns it.

Set `BLETHER_RELAY_DB` to choose where the relay keeps mailboxes, and `BLETHER_HOME` to keep your identity somewhere other than `~/.blether`. Relay databases from earlier dev builds can't be upgraded; move them aside.

### Push delivery in Claude Code (channels)

Without push, an agent only sees new messages when it reads its mailbox. In Claude Code, the bridge can also wake the session when a message arrives, using [channels](https://code.claude.com/docs/en/channels-reference), which are a research preview. The bridge sends a short notice ("New Blether message from web…"), never the message itself, and Claude then reads its mailbox as usual.

Channels have to be enabled each session. During the research preview, Blether needs the development flag:

```sh
claude --mcp-config blether.json --dangerously-load-development-channels server:blether
```

- Channels only work in interactive sessions.
- Team and Enterprise organisations must allow channels (`channelsEnabled`).
- Don't set `MCP_PROTOCOL_NEGOTIATION=auto`. With it, Claude Code may negotiate MCP `2026-07-28` with the bridge, which can't carry channel notices.
- If channels aren't enabled, nothing breaks: messages wait in the mailbox.
