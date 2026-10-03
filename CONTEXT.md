# Blether

Blether is a communication channel that lets the AI agents of developers working on different devices talk to each other asynchronously, so they can coordinate work, hand it off, and keep each other informed. Blether carries messages; it does not own the team's work (tasks, issues), which lives in tools the agents already use.

## Language

### People and agents

**Developer**:
A human who works with one or more agents on their own devices and belongs to one or more teams. A developer has one identity, linked to a team by an invite. A developer who loses every device's key must be removed and invited again as a new identity.
_Avoid_: User, member

**Device**:
A computer a developer uses Blether on. Each device has its own key pair, linked to the developer's identity. A lost device's key can be revoked from another of the developer's devices.
_Avoid_: Machine, computer, host

**Team**:
A flat group of developers and their agents, joined only by secure invite from a developer already in the team. It is the boundary of communication: agents never talk across teams.
_Avoid_: Group, workspace, org

**Team Admin**:
The developer who created a team, and the one exception to a team being flat: they can remove developers from it, which also removes those developers' agents and mailboxes.
_Avoid_: Owner, lead, moderator

**Agent**:
A named participant in exactly one team, created deliberately by the developer who owns it, with its own mailbox. Its name identifies it within the team and outlives any single session. A name can be reused after an agent is deleted, but the roster shows the new agent as a replacement, not a continuation.
_Avoid_: Bot, assistant, peer, teammate

**Session**:
A live run of an AI coding tool (for example, a Claude Code session) on a developer's device, acting as one of that developer's agents. At most one session acts as a given agent at a time. In Claude Code, a session acts as its agent only once the developer connects it (ADR 0008); until then it has nothing to do with Blether.
_Avoid_: Instance, process

**Role**:
A label from the team's agreed list that a developer gives one of their agents to describe what it does within the team (for example, "frontend" or "reviewer"). An agent can hold several roles. A role grants no authority. Messages can be addressed to a role, in which case every agent holding it receives a copy.
_Avoid_: Title, permission

**Roster**:
The list of a team's agents that every agent in the team can see: each agent's name, developer and roles, and whether a session is currently acting as it.
_Avoid_: Directory, registry, member list

### Messaging

**Message**:
A communication sent from one agent to another agent in its team, to every agent holding a role, or to the whole team at once. It may reply to an earlier message. Messages do not expire, and are checked for secrets before they leave the sender's device.
_Avoid_: Event, notification, request

**Broadcast**:
A message sent to every other agent in the team.
_Avoid_: Announcement, all-hands

**Thread**:
A message together with the replies that follow from it.
_Avoid_: Conversation, chain

**Delivery Status**:
What the sender can see of a message's progress: queued, delivered, read, or lost (its mailbox was deleted before it was read, and the sender is notified so it can resend). It never says whether the message was acted on.
_Avoid_: Receipt, acknowledgement

**Mailbox**:
An agent's queue of messages it has not yet read. Messages wait there while no session is acting as that agent. A session that starts acting as the agent reads and assesses everything pending before deciding what to do. Deleting an agent deletes its mailbox, and any unread messages in it become lost.
_Avoid_: Inbox, queue

**Relay**:
The server, hosted centrally or by the team itself, that holds mailboxes and carries messages between the team's devices. It can see who messaged whom and when, but never what was said.
_Avoid_: Server, broker, hub

### Safety

**Approval Policy**:
A developer's setting for how much their agents may send (outgoing) and act on (incoming) without asking them first. Each direction has its own level, and both start at the strictest. Outgoing approval is asked of the developer directly; incoming approval is guidance to the agent, since only the agent's host can stop it acting. For now each device keeps its own policy.
_Avoid_: Permissions, trust level

**Escalation**:
An agent setting a message aside until its developer decides what to do with it. An agent escalates whenever it doubts that acting on a message is safe, whatever its approval policy says ("trust, but verify"), and whenever it reaches a messaging limit. Silence is never approval: an escalation waits, across sessions, until the developer answers in the conversation, and the sender is told it's waiting. Escalations keep questions from being lost; they aren't a security boundary.
_Avoid_: Approval request, prompt

**Safety Number**:
A short code each developer can see for every teammate. If two developers compare it and it matches, they know they are talking to each other and not to someone the relay has slipped in.
_Avoid_: Fingerprint, verification code
