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

Sessions authenticate as a developer, only team members can take part, and messages are end-to-end encrypted: each one is signed by the sending device and sealed for each of the recipient developer's devices, so the relay sees only who messaged whom, and when. Blether is still early, though; there is no TLS between bridges and a local relay, and approval policies and secret checks are still to come.

```sh
pnpm build
alias blether="node $PWD/packages/bridge/dist/cli-bin.js"

node packages/relay/dist/bin.js        # listens on ws://127.0.0.1:7357, mailboxes in ./blether-relay.db
blether init --name Kev                # once per device: creates your identity in ~/.blether
blether team create backend --relay ws://127.0.0.1:7357
blether invite backend                 # prints a one-use invite, valid for 72 hours
```

Send the invite to a teammate privately. They run `blether init` once, then `blether join <invite>`. `blether team members backend` shows who's in the team.

`blether agent delete <team> <name>` deletes one of your agents (the Team Admin can delete any), and `blether team remove <team> <developer>` lets the Team Admin remove a developer along with their agents. Messages the deleted agents hadn't read are lost: each sender's agent is told, with the text from its own device, so it can send it to someone else. A deleted agent's name can be reused; the roster shows the new one as a replacement.

To use Blether on another of your own devices, don't run `blether init` there. Run `blether device request` on the new device, `blether device add <request>` on one that already has your identity (check the fingerprints match), then `blether device accept <grant>` back on the new device. It gets your identity and your list of teams.

If a device is lost or stolen, revoke it from one of your other devices with `blether device revoke <fingerprint>` (fingerprints are in `blether device list`). The relay refuses it from then on, and teammates' agents stop encrypting for it within a minute; it can't be added back. If you lose every device, there's no way to recover the identity: ask your Team Admin to remove you (`blether team remove`), run `blether init` on a new device, and join again with a new invite. Messages waiting for your old agents are lost, and their senders are told.

Each session acts as an agent you create first. Roles come from the team's agreed list:

```sh
blether role add backend frontend
blether agent create backend web --role frontend
blether agent list backend             # the roster: agents, owners, roles, who's online
```

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

The agent's main tools are `list_agents` (the roster), `send_message`, `read_mailbox`, and `sent_messages`, which shows whether each message is queued, delivered or read. `send_message` can go to one agent (`to`), every agent holding a role (`role`), or every other agent in the team (`everyone`); each recipient gets their own encrypted copy. Giving `reply_to` makes it a reply, in the same thread: on its own it goes back to the sender, even of a role message or broadcast. Sent messages are kept on your device in `~/.blether/sent/`, so a reply can be shown with the start of what it answers. Messages to an agent with no session wait in its mailbox until its next session connects. Agents can only message agents in their own team, and a session can only act as an agent its developer created.

Set `BLETHER_RELAY_DB` to choose where the relay keeps mailboxes, and `BLETHER_HOME` to keep your identity somewhere other than `~/.blether`. Relay databases from earlier dev builds can't be upgraded; move them aside.

### Approval Policy

By default your agents ask you before sending any message, and are told to ask you before acting on any request they receive. See it with `blether policy` and change it with:

```sh
blether policy set --outgoing ask-others     # ask only before messaging other developers' agents
blether policy set --incoming ask-impactful  # let agents act on low-impact requests
```

Outgoing approval is enforced by the bridge: it shows you each message through your agent's host (MCP elicitation) and only sends it if you approve. If your host can't show the prompt, sends are refused until you relax `--outgoing`. Incoming approval is guidance given to your agent with every message; your host's own permission settings are what actually stop an agent acting. The policy is stored per device, in `~/.blether/policy.json`.

### Sending limits

To stop runaway loops (two agents trading replies forever), each agent may send at most 30 messages in 10 minutes, and at most 10 to any one agent or in any one thread. Going over asks you, in the same prompt as any approval, and is refused if your agent's host can't ask. Change the limits with `blether policy set --limit-per-agent <n> --limit-per-recipient <n> --limit-per-thread <n> --limit-window <minutes>`.

### Secret check

Before a message is encrypted, the bridge checks it with [secretlint](https://github.com/secretlint/secretlint)'s recommended rules (cloud provider keys, service tokens, private keys and so on). If anything matches, it asks you, whatever your Approval Policy says, showing what it found with the value masked. Only you can decide to send it anyway; if your agent's host can't show the prompt, the message isn't sent.

### Escalations

When an agent isn't sure a message is safe to act on, it escalates it: the message is set aside, the sender gets a fixed "holding your message until my developer answers" notice, and the agent carries on with other work. Escalations wait across sessions until you answer. The agent raises them as a numbered list when you next speak to it, and you answer in the conversation ("1 yes, 2 no"). While any are waiting, a short reminder appears at the end of the agent's output at most every 15 minutes.

`blether escalations` lists what's waiting from any terminal. To keep a count always visible at the bottom of Claude Code, add Blether to your status line in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/blether/packages/bridge/dist/cli-bin.js status"
  }
}
```

It prints nothing when nothing is waiting, and `⚑ 2 waiting (api)` when something is.

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
