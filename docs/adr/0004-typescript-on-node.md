# TypeScript on Node for the bridge and relay

The bridge is an MCP server that every developer installs and that the agent starts for each session. Blether's push delivery into Claude Code (channels, ADR 0003) is documented and demonstrated with the TypeScript MCP SDK, and Claude Code's own MCP client is built on that SDK. We chose TypeScript on Node for both the bridge and the relay. They live in one pnpm workspace with three packages, `bridge`, `relay` and `protocol`, and the shared `protocol` package holds the message and envelope types. The bridge is distributed through npm (`npx`), and for Claude Code also as a plugin that bundles the MCP config and Blether's skills. The relay ships as a container image.

## Considered Options

- **TypeScript on Node** (chosen). It is the closest match to the reference implementation of channels, and Node is almost always present wherever MCP agents run.
- **Go.** Single binaries make installing easier, and there is an official MCP SDK. We would have to add the channel capability by hand and keep it in step with Claude Code's TypeScript reference ourselves.
- **Rust.** It has the best MLS library (OpenMLS), but MCP support is less mature and development is slower. We may reconsider if we move to MLS (ADR 0005).

## Consequences

- Installing the bridge needs Node. That's more friction than a single binary, but most of it is absorbed by `npx` and the Claude Code plugin.
- Crypto comes from libsodium (via its WebAssembly or native bindings), not from code we write ourselves.
