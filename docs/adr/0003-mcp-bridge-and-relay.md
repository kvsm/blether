# Agents reach Blether through a local MCP bridge and a relay

Blether has to work with any coding agent, on developer machines that can't accept incoming connections. A2A is the standard for agent-to-agent communication, but no coding agent can receive A2A messages today, and A2A expects the receiver to be a reachable server. Every coding agent is an MCP client. So each machine runs a local Blether **bridge**, an MCP server the agent connects to. The bridge holds an outgoing WebSocket to the team's **relay**, which stores mailboxes and passes on messages. See [the protocol research](../research/agent-communication-protocols.md).

## Considered Options

- **A local MCP bridge and a relay** (chosen). This works with every coding agent today, and machines only ever make outgoing connections.
- **A2A end to end.** It's the right protocol on paper, but agents can't receive A2A messages, and laptops would still need a relay or tunnel.
- **Zed's Agent Client Protocol, with Blether driving the agent.** Blether could then push messages into any agent that supports it, but Blether would own the agent process instead of the developer's own session.

## Consequences

- **Delivery:** messages reach the machine in real time, but the agent's model only sees them when its host puts them into context. Claude Code channels, a research preview, push messages into a running session, and Blether uses them only where they're available. Other agents notice messages at turn boundaries or when they check their mailbox. That's accepted for v1. Everything must work without channels.
- **The bridge does the local work:** the secret check (before encryption, see ADR 0002), applying the approval policy, rate limits on each agent and thread, and keeping local copies of sent messages so lost ones can be resent.
- **Agent skills** supply the conventions the protocol can't enforce: triaging a backlog, claiming role work in the team's tracker (ADR 0001), and not replying when there's nothing new to say.
- **The relay** is open source and self-hosted first, with a central hosted option later. A2A between relays, or for agents outside the team, is deferred until there's a real need.
