---
name: setup
description: Set up Blether for this project - identity, team, agent and status line - and connect this session.
disable-model-invocation: true
---

# Set up Blether for this project

Walk the developer through each step in order, running the commands yourself and showing what they print. Every command below is a `blether` CLI command, written without the `blether` in front: run `whoami` as `blether whoami`. The plugin puts `blether` on your Bash `PATH`.

Team membership, devices and sign-ins are the developer's own decisions. `join`, `invite`, `team remove`, `device add`, `device revoke` and `sign-in` need an interactive terminal, and refuse in your shell, so don't run them: give the developer the exact command to run in their own terminal, and wait for them to say it's done.

## 1. Identity

Run `whoami`.

- It prints a name: go on to step 2.
- There's no identity: ask whether this is their **first device** or they already use Blether elsewhere. First device: ask for their name, run `init --name "<name>"`. Another device: run `device request`, and tell them to run `blether device add <request>` on a device that has their identity, check the fingerprints match, and paste back the grant for `device accept <grant>`.

Done when `whoami` prints their name.

## 2. Team

Run `team list`.

- They're in the team they want: go on.
- They have an invite: ask them to run `blether join <invite>` in their own terminal. It shows the team and relay, and asks them to confirm. Then run `team list`.
- They're starting a team: ask for the team name and the relay URL, and run `team create <name> --relay <url>`. To bring teammates in, they run `blether invite <team>` in their own terminal and share the link privately.

If the relay requires a sign-in, `join` or `team create` says so. Ask them to run `blether sign-in <invite>` (before joining) or `blether sign-in <relay-url>` in their own terminal, and paste the token the relay's operator gave them. Then try again.

Done when `team list` shows the team.

## 3. Agent for this project

First read `.blether/session.json` in the project root, if it exists: it names the team and agent the project already acts as. If so, tell them, and ask whether to keep it. Keeping it: go on to step 4, without running `use`.

Otherwise, run `agent list <team>` and ask which of **their** agents this project should act as, or what to call a new one. Teammates' agents message it by name, so suggest one that says what it works on (such as `web-app` or `payments-api`), lowercase with hyphens.

For a new agent, run `role list <team>` and ask which roles describe what it does. Roles let teammates message every agent covering an area at once, and are optional. If one they want isn't listed, run `role add <team> <role>`. Then run `agent create <team> <agent name>`, with `--role <role>` for each role.

Then run `use <team> <agent name>` in the project root. It writes `.blether/session.json`, which git ignores.

Done when the project has the agent they want, kept or set with `use`.

## 4. Connect and check

Setting Blether up is a request to use it, so connect this session. Connecting takes the agent over from any other session connected as it, which is then disconnected without warning. So first run `agent list <team>`: if the project's agent shows as `online`, another session (perhaps in another terminal, or on another device) is using it. Tell them, and connect only if they say to take it over.

To connect, call the bridge's `connect` tool (`mcp__plugin_blether_blether__connect`; load it with ToolSearch first if it's deferred). It reads the project's agent when called, so there's no need to restart.

Done when it connects and its result's instructions are followed (read the mailbox, start the watch). If it fails, fix what it says.

## 5. How it works, and visibility

Tell them how Blether works from now on:

- **Sessions start without Blether.** The bridge stays out of every session until they run `/blether:connect`. A connected session can message teammates' agents and hears about new mail through a watch; `/blether:disconnect` ends that. Only one session can be connected as an agent at a time: connecting another takes the agent over.

Offer this option and set it up if they want it:

- **Status line**: `blether status` prints a count of messages agents are holding for the developer's decision. Read `statusLine` in `~/.claude/settings.json` first: if it already runs `blether status`, say so and skip this. Otherwise, offer to add it, merging with any status line they already have.

Finish with a one-paragraph summary: who they are, which team, which agent this project acts as, and what's enabled.
