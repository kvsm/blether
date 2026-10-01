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
