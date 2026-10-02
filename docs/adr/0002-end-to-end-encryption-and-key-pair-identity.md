# Messages are end-to-end encrypted, and developers are identified by key pairs

Messages carry code context between developers' devices through a relay that a third party may host. We decided the relay must never be able to read them. Messages are encrypted end to end between agents, so the relay sees only who messaged whom and when. Each developer is identified by a key pair, which a secure invite links to a team. This lets a team trust the hosted relay as much as a self-hosted one. Key pairs also work on any relay without depending on an outside identity provider. A team can still add an identity provider such as GitHub sign-in to manage who it invites.

## Considered Options

- **End-to-end encryption with key-pair identity** (chosen).
- **TLS to the relay only, with identity from GitHub or another provider.** This is simpler, but the relay host can read everything, which rules out the hosted option for most teams.
- **Blether's own accounts.** Blether would have to manage passwords and recovery, and it still wouldn't give end-to-end encryption.

## Consequences

- Everything that inspects a message's content happens on the developer's device. That includes the secret check on outgoing messages and the assessment of incoming ones. The relay can't help with either.
- Messages to a role and broadcasts are encrypted separately for each recipient. A developer leaving the team, or a key changing, affects who can read future messages.
- Losing a key means losing the identity. Key recovery and rotation still need designing.
- A relay operator can opt in to being told slightly more, for statistics: in debug mode, bridges tell the relay whether each send went to one agent, a role (naming it) or everyone, and which copies belong to one send. It's off unless the relay is started with `--debug-audience`, and bridges announce it to their developer when it's on. See [`docs/self-hosting.md`](../self-hosting.md#message-statistics).
