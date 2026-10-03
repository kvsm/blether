---
name: setup
description: Set up Blether for this project - identity, team, agent and status line.
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

## 4. Reload and check

Tell the developer to restart this session (or run `/mcp` and reconnect the `blether` server) so the bridge picks up the project's agent.

Done when the bridge's `list_agents` shows the roster. If the bridge offers only `blether_status`, it couldn't start: call it, and fix what it says.

## 5. New-mail notices and visibility

Tell them how they'll hear about new messages. This needs no setup:

- **New-mail notices**: the plugin tells the agent when messages arrive. In the terminal CLI, a monitor wakes an idle session. In the VS Code extension, plugin monitors don't run, so the agent starts its own watch on its first turn. Until then, mail that arrives is mentioned when they next send a prompt.

Offer this option and set it up if they want it:

- **Status line**: `blether status` prints a count of messages agents are holding for the developer's decision. Offer to add it to `statusLine` in `~/.claude/settings.json`, merging with any status line they already have.

Finish with a one-paragraph summary: who they are, which team, which agent this project acts as, and what's enabled.
