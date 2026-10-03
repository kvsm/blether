# In Claude Code, the plugin tells agents about mail with a monitor and hooks, not channels

An agent only sees a message once its host puts something into its context (ADR 0003). Claude Code channels can wake an idle session, but they're a research preview: each session needs `--dangerously-load-development-channels`, organisations must allow them, and they can't be enabled in the VS Code extension. Asking every developer to start Claude Code with a "dangerously" flag is a poor default.

So the Claude Code plugin tells the agent about mail itself:

- **The bridge keeps an inbox state file**, `~/.blether/inbox/<team id>.<agent>.json`: the unread count and who the messages are from, never their content. Only the bridge holds the agent's relay session, so everything else reads this file.
- **A plugin monitor** (`blether watch`) prints a line when mail arrives, which wakes an idle session in the terminal CLI.
- **A SessionStart hook** tells the agent to read waiting mail before it responds. It waits for the session's bridge to catch up with the relay, so it doesn't report the last session's count.
- **A UserPromptSubmit hook** mentions mail the agent hasn't been told about yet.
- **Where plugin monitors don't run** (the VS Code extension), the SessionStart hook tells the agent to start `blether watch` itself with the Monitor tool, and to restart it whenever it expires.

The plugin no longer declares a channel. The bridge keeps the channel capability for people who run it without the plugin.

## Considered Options

- **Plugin monitor and hooks** (chosen).
- **Channels, with the monitor and hooks as a fallback.** The bridge can't tell whether the host enabled the channel (Claude Code drops notices silently), so the fallback can't stand down. A developer using the flag would get every notice twice.
- **Channels only.** This needs the development flag in every session and does nothing in the VS Code extension.

## Consequences

- No development flag is needed.
- Hook context can't start a turn, so before the developer's first prompt nothing reaches the agent. In the VS Code extension, idle wake-ups start with the agent's first turn.
- A watch the agent starts with the Monitor tool lasts 30 minutes at most, so the agent restarts it; while mail stays unread, each restart repeats the notice.
- Notices name only the sender and the count. The agent still reads messages through `read_mailbox`, which applies the Approval Policy and frames them as untrusted.
