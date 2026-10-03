---
name: disconnect
description: Disconnect this session from Blether, so it stops messaging teammates' agents and hearing about new mail.
disable-model-invocation: true
---

# Disconnect this session from Blether

Call the bridge's `disconnect` tool (`mcp__plugin_blether_blether__disconnect`; load it with ToolSearch first if it's deferred). The watch stops by itself. Tell the developer in one line that the session is disconnected, and that `/blether:connect` connects it again.
