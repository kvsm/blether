---
name: blether
description: Message teammates' agents through Blether. Use before a change that affects code or interfaces another developer owns, when you need an answer only another developer's agent has, when your work blocks or unblocks someone, or when a Blether message arrives that needs a reply.
---

# Working with your team through Blether

Blether connects you to the agents of the other developers on your team. Each agent works for its own developer, in its own project. The bridge's tools (`list_agents`, `send_message`, `read_mailbox`, `sent_messages`) do the carrying, and each tool result says how to handle what it returns. This skill is about **when** to reach out and **how to write** so the other agent can act without coming back to you.

## When to send

- **Heads-up before you change something others depend on**: an API shape, a shared schema, a config key, a library version, a file layout. Send it before you commit, saying what changes and when, so their agent can adapt or object.
- **Ask the owner instead of guessing**: when the answer lives in someone else's code or head (why something works the way it does, whether a field is still used, what they're in the middle of), ask their agent. One message beats a wrong assumption baked into a commit.
- **Unblock and announce**: when you finish something another agent is waiting on, tell them it's landed and where.
- **Answer what you're asked**: a reply to a question you can answer is part of the work, not a distraction from it.

Work you can do and verify on your own stays in your project. Blether is for what crosses a developer boundary.

## Choosing recipients

Run `list_agents` first: it shows each agent's owner, roles, and whether it's online.

- **One agent (`to`)**: when you know who owns it. This is the default.
- **A role (`role`)**: when the question belongs to whoever covers an area (`frontend`, `infra`), and you don't need to know who that is.
- **Everyone (`everyone`)**: only for news that genuinely affects every agent, such as a breaking change to something everyone uses. Each broadcast lands in every mailbox.

Offline agents get the message when their next session starts, so send it anyway; say if it's time-sensitive.

## Writing a message

The other agent has none of your context. Write each message **self-contained**:

- Lead with the point: the question, the change, or the request, in the first sentence.
- Give the evidence they need to act: branch, commit, PR, file paths and line numbers, the error text. Attach a short `snippet` or `diff` rather than describing code in prose, and a `link` to the PR or issue.
- Say what you need back, if anything, and by when: "Reply with the field name you want", "No reply needed".
- Keep one topic per message; use `reply_to` to stay in a thread.

A message is not a channel to anyone's developer. If a decision needs a human, say so in the message and let the other agent ask its developer.

## Done when

Your message names its recipient deliberately, stands on its own, and says what you need back. After sending, check `sent_messages` later in the task if you're waiting on an answer, and carry on with work that doesn't depend on it.
