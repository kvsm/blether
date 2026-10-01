# Developers manage membership through a CLI, recorded in signed logs

Who belongs to a team, and which machines belong to a developer, decides who can read and send messages. An agent tricked by an incoming message must never be able to change either. So these actions are commands a developer runs with the `blether` CLI: `blether init`, `blether team create`, `blether invite`, `blether join`, `blether machine add` and so on. The bridge exposes **no** MCP tools for them.

Each change is an entry in an append-only, signed log:

- **Identity log, one per developer.** It starts with an entry for their first machine. Later entries add or revoke machines, each signed by a machine already in the log. The developer's identity id is the hash of the first entry.
- **Membership log, one per team.** It starts with "team created", signed by the Team Admin. A member inviting someone appends "invite created", which carries only the invite's public key (derived from the invite secret) and its expiry. The invitee appends "member added", signed both by their own machine and by the invite key, which proves they hold the secret. Each invite can be used once, and only before it expires. Only the admin can sign "member removed".
- **Every entry includes the hash of the entry before it**, and the relay only accepts an entry that extends the current end of the log. That stops a relay from keeping two diverging versions of a team.

The relay stores the logs and rejects entries that don't verify. Bridges verify the whole log themselves, so a malicious relay can't quietly add a machine or a member (ADR 0005).

**Invites** are a single string, `blether://<relay-host>/<team-id>/<invite-id>#<secret>`, for a relay reached over `wss://`. `blether+ws://` is only for local dev relays. Each invite works once, expires after 72 hours, and can be revoked by the inviter or the Team Admin. The relay enforces the expiry when it appends "member added". The secret, after the `#`, is never sent to the relay.

The CLI keeps a local record of each team the developer belongs to (its name, id and relay URL). A bridge names its team with `BLETHER_TEAM`. Agent names are unique within a team, the relay only accepts sessions from the team's members, and messages never leave a team.

**Machine keys** are stored in files under `~/.blether/`, readable only by the developer's OS account, behind a small key-storage interface. Using the OS keychain is a later option. A passphrase was ruled out, because the agent starts the bridge for every session.

## Considered Options

- **CLI only, with signed logs** (chosen).
- **The inviter countersigns each join.** This was the original design. It's just as secure, but joining would need the inviter online at the same time as the invitee.
- **MCP tools for membership, gated by the Approval Policy.** This is more convenient, but a prompt-injected agent would be one approval click away from inviting an attacker.
- **The relay as the authority on membership, with no signatures.** This is simpler, but a compromised relay could add members and read new messages, which contradicts ADR 0002.

## Consequences

- Joining a team or adding a machine always needs a person at a terminal.
- Bridges download and verify logs. The logs are small, because teams are small.
