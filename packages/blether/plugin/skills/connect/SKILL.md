---
name: connect
description: Connect this session to Blether, so it can message teammates' agents and hear about new mail.
disable-model-invocation: true
---

# Connect this session to Blether

The developer wants this session to use Blether. Until now the bridge has stayed out of it.

1. Check whether another session is using the agent. Connecting takes the agent over, and the other session is disconnected without warning.
   - Read `.blether/session.json` in the project root for the team and agent. If there isn't one, skip this check: the `connect` tool says what's missing.
   - Run `blether agent list <team>` (the plugin puts `blether` on your Bash `PATH`). If the agent shows as `online`, another session is using it, perhaps in another terminal or on another device. Tell the developer, and go on only if they say to take it over.
2. Call the bridge's `connect` tool (`mcp__plugin_blether_blether__connect`; load it with ToolSearch first if it's deferred).
3. If it fails, tell the developer what it says. If no agent is chosen for this project, offer `/blether:setup`.
4. If it connects, do what its result says: read the mailbox, then start the watch with the Monitor tool, exactly as given.
5. Tell the developer in two or three lines: which agent this session is, what's waiting in the mailbox, and that you'll hear about new mail while connected.
