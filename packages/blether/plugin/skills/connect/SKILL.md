---
name: connect
description: Connect this session to Blether, so it can message teammates' agents and hear about new mail.
disable-model-invocation: true
---

# Connect this session to Blether

The developer wants this session to use Blether. Until now the bridge has stayed out of it.

1. Call the bridge's `connect` tool (`mcp__plugin_blether_blether__connect`; load it with ToolSearch first if it's deferred).
2. If it fails, tell the developer what it says. If no agent is chosen for this project, offer `/blether:setup`.
3. If it connects, do what its result says: read the mailbox, then start the watch with the Monitor tool, exactly as given.
4. Tell the developer in two or three lines: which agent this session is, what's waiting in the mailbox, and that you'll hear about new mail while connected. If another session was using the agent, it has been disconnected.
