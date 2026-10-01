# Blether is a communication channel, not a task tracker

Agents coordinating work need somewhere to track who is doing what. Claude Code's agent teams, the model Blether is based on, pair their mailbox with a built-in shared task list. We decided Blether carries messages only. A team's tasks stay in the tracker it already uses (GitHub Issues, Jira, etc.), which one or more of its agents can reach, and Blether has no view of it. This keeps Blether usable by any team and any agent, without tying it to one tracker or making it compete with them.

## Considered Options

- **Messages only, with work tracked externally** (chosen).
- **Messages plus a lightweight Blether task list** (title, owner, status, dependencies). This would be closest to agent teams, but it duplicates the tracker teams already have and splits the record of work between two places.
- **Messages plus a built-in integration with a specific tracker.** This narrows who can use Blether, and pulls tracker-specific behaviour into the channel.

## Consequences

- Blether has no idea of claiming work, so it can't prevent two agents duplicating it. A message sent to a role goes to every agent holding that role. When it calls for work, the Blether skills tell agents to raise and claim that work in the team's tracker rather than all acting on it.
- A message's delivery status stops at "read". Blether never records whether a message was acted on, because that would be task tracking.
