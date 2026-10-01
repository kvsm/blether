# Each message is sealed for every recipient machine, with signed machine lists and invite secrets

This puts ADR 0002 into practice. For v1:

- **Messages:** the sending bridge signs each message with its machine's Ed25519 key. It then encrypts a separate copy for each of the recipient developer's machine keys (X25519), using libsodium. The message envelope is versioned.
- **Identity:** a developer's first machine creates their identity. Every later machine is added by an entry signed by one of their existing machines, after a short pairing code is exchanged between the two. Revoking a machine is also a signed entry. Bridges accept a machine list only if its signatures trace back to the identity key they first saw for that developer.
- **Invites:** an invite carries a one-time secret that is shared outside Blether. The inviter's machine derives an _invite key pair_ from the secret, and publishes only its public key in a signed "invite created" entry in the team's membership log. The invitee derives the same key pair from the secret and signs their own "member added" entry with it, so the inviter doesn't need to be online, and the secret never reaches the relay (see ADR 0006). Bridges show a **safety number** for each teammate, which people can compare to verify one another.

We chose per-recipient encryption over MLS and double-ratchet sessions because teams are small and it uses simple, well-reviewed primitives. MLS remains the upgrade path, which is why the envelope is versioned.

## Considered Options

- **Per-recipient signed and sealed messages** (chosen). It is simple and uses libsodium primitives. It has no forward secrecy.
- **MLS (RFC 9420).** It offers forward secrecy and efficient group membership changes, but needs relay-ordered updates to group state, and TypeScript implementations are less mature.
- **Pairwise double ratchet, as in Signal.** It gives forward secrecy one conversation at a time, but it is complex and awkward for messages left in a mailbox nobody is reading.

## Threat model notes

- **A malicious relay** can see metadata (who sent to whom, and when), and can drop, delay or replay ciphertext. It cannot read or forge messages, add a machine to someone's identity, or replace an invitee's key without the invite secret. Bridges reject replays by message ID.
- **A removed developer** receives no new messages, because senders stop encrypting for them. They keep whatever they had already received.
- **A stolen laptop**, until it is revoked, can read new messages addressed to its owner and send messages as them. Because there is **no forward secrecy**, it can also decrypt any past ciphertext addressed to its key that an attacker has captured. Revoking the machine stops new messages. The risk is accepted for v1.
- **An intercepted invite secret** lets an attacker join the team in place of the intended invitee. Comparing safety numbers detects this. Invite secrets are single-use and expire.
