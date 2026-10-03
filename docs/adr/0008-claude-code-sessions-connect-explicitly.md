# In Claude Code, a session uses Blether only once the developer connects it

ADR 0007 delivered mail notices to every Claude Code session: a hook told the agent to read waiting mail before anything else, and a monitor woke it when mail arrived. That made every session a Blether session, including ones opened for unrelated work. The agent read untrusted messages with nobody expecting it to, and it could message teammates or act on their requests unprompted. Changing work another agent might be busy with should be intentional, so it should happen only in a session the developer has chosen to use Blether in.

So in the Claude Code plugin, sessions start without Blether, and the developer connects one with `/blether:connect`:

- **Before connecting**, the bridge doesn't connect to the relay. It gives no instructions, and its only tool is `connect`, which the agent is told to call only when the developer asks. The agent can't send or read messages, nothing mentions Blether, and teammates see the agent as offline.
- **Connecting** opens the relay connection and installs the bridge's tools. If another session holds the agent, it's taken over: the developer asked for this one. The result tells the agent to read its mailbox and to start `blether watch` with the Monitor tool. The watch prints a line when mail arrives, waking an idle session, in the terminal and in VS Code alike.
- **The watch belongs to one connection.** The bridge's inbox state file names the connection that wrote it. The watch stops when that connection disconnects or another session takes the agent over, so only the connected session hears about mail.
- **`/blether:disconnect`** removes the tools and closes the connection, and the watch stops. Ending the session does the same.

The plugin turns this on with `BLETHER_CONNECT=manual`. Without it, the bridge connects at start-up as before, for agents other than Claude Code, which have no slash commands.

This replaces ADR 0007's plugin monitor and hooks.

## Considered Options

- **Connect explicitly; nothing before** (chosen).
- **Connect automatically, but stay quiet until the developer connects.** The agent could still send (for example a heads-up before changing someone's code), and its developer would see an unread count. But sending is exactly what should be intentional, and the developer doesn't want to hear about Blether in sessions they aren't using it in.
- **Ask the developer to confirm `connect` (MCP elicitation)**, so the agent can't connect on its own. The VS Code extension doesn't support elicitation. The tool description and skill are a convention, not a guarantee, which is acceptable: connecting only makes the agent reachable, and the Approval Policy still governs what it sends and acts on.
- **Keep the plugin monitor and hooks, silent until the session connects.** They can't tell which session they belong to. In a second, unconnected session on the same project, they would report the connected session's mail.

## Consequences

- Nothing reaches a session until the developer runs `/blether:connect`, and teammates' messages wait on the relay meanwhile. "Online" in the roster now means a session is connected, which is what teammates want to know.
- A Monitor tool watch lasts 30 minutes at most, so the agent restarts it when it expires, in the terminal too. While mail stays unread, each restart repeats the notice.
- `blether hook` and the plugin's monitor and hooks are gone. `blether watch` takes the inbox file and the connection to follow.
