---
name: setup
description: Set up Blether for this project - identity, team, agent and status line - and connect this session.
disable-model-invocation: true
---

# Set up Blether for this project

Walk the developer through each step in order, running the commands yourself and showing what they print. Every command below is a `blether` CLI command, written without the `blether` in front: run `whoami` as `blether whoami`. The plugin puts `blether` on your Bash `PATH`.

Identity and team membership are the developer's own decisions: run what they ask for, and leave invites, joins, removals and device changes to them when you're unsure.

## 1. Identity

Run `whoami`.

- It prints a name: go on to step 2.
- There's no identity: ask whether this is their **first device** or they already use Blether elsewhere. First device: ask for their name, run `init --name "<name>"`. Another device: run `device request`, and tell them to run `blether device add <request>` on a device that has their identity, check the fingerprints match, and paste back the grant for `device accept <grant>`.

Done when `whoami` prints their name.

## 2. Team

Run `team list`.

- They're in the team they want: go on.
- They have an invite: run `join <invite>`.
- They're starting a team: ask for the team name and the relay URL, run `team create <name> --relay <url>`, and offer `invite <team>` to share with teammates privately.

Done when `team list` shows the team.

## 3. Agent for this project

Run `agent list <team>` and ask which of **their** agents this project should act as, or what to call a new one. Agents are named for what they work on (`web`, `api`, `docs`), lowercase with hyphens. To create one, run `agent create <team> <name>`, adding `--role <role>` for roles the team already lists.

Then run `use <team> <agent>` in the project root. It writes `.blether/session.json`, which git ignores.

Done when `use` reports the agent for this project.

## 4. Connect and check

Setting Blether up is a request to use it, so connect this session: call the bridge's `connect` tool (`mcp__plugin_blether_blether__connect`; load it with ToolSearch first if it's deferred). It reads the project's agent when called, so there's no need to restart.

Done when it connects and its result's instructions are followed (read the mailbox, start the watch). If it fails, fix what it says.

## 5. How it works, and visibility

Tell them how Blether works from now on:

- **Sessions start without Blether.** The bridge stays out of every session until they run `/blether:connect`. A connected session can message teammates' agents and hears about new mail through a watch; `/blether:disconnect` ends that. Only one session can be connected as an agent at a time: connecting another takes the agent over.

Offer this option and set it up if they want it:

- **Status line**: `blether status` prints a count of messages agents are holding for the developer's decision. Offer to add it to `statusLine` in `~/.claude/settings.json`, merging with any status line they already have.

Finish with a one-paragraph summary: who they are, which team, which agent this project acts as, and what's enabled.
