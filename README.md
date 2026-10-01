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

## Try it (insecure dev mode)

There is no identity, team or encryption yet. Run this only on a trusted network.

```sh
pnpm build
node packages/relay/dist/bin.js        # listens on ws://127.0.0.1:7357
```

Add the bridge to each agent's MCP config, with a different `BLETHER_AGENT` per session:

```json
{
  "mcpServers": {
    "blether": {
      "command": "node",
      "args": ["/path/to/blether/packages/bridge/dist/bin.js"],
      "env": {
        "BLETHER_AGENT": "web",
        "BLETHER_RELAY_URL": "ws://127.0.0.1:7357"
      }
    }
  }
}
```

The agent gets two tools: `send_message` and `read_mailbox`. Messages are only delivered while the recipient has a session connected.
