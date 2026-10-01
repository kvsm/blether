# Agent-to-agent communication protocols: research for Blether

- **Accessed:** 2026-10-01. Everything below reflects the sources as they read on that date. This area changes month to month, so check again before relying on any detail.
- **Versions examined:** A2A spec 1.0.0 (repo release v1.0.1), MCP revision `2026-07-28` (current), Agent Client Protocol (Zed) protocol version `1`, ANP 1.2, SLIM Internet-Draft `draft-mpsb-agntcy-slim-02`, and the Claude Code docs at code.claude.com (features up to about v2.1.28x).
- **Sources:** primary only (specs, official docs, source repos, first-party announcements). Statements marked *Analysis* are this document's own reasoning, not a source's claim. Statements marked *Unverified* could not be confirmed from a primary source.

## TL;DR

- **The constraint that decides everything:** developer laptops cannot accept inbound connections. Every protocol here except MCP-over-stdio assumes the receiving agent is a reachable HTTP(S) server. Blether therefore needs a **relay or broker** whatever protocol it picks.
- **No coding agent today speaks a common agent-to-agent protocol as a receiver.** Gemini CLI is an A2A *client* (experimental), and its A2A *server* package is experimental. Claude Code, Codex CLI, Copilot and Cursor have no native A2A. All of them are **MCP clients**.
- **Recommendation:** a hybrid design.
  - **Agent edge:** MCP. Each developer runs a local Blether MCP server (the "bridge"). It dials out to a Blether relay.
  - **Push into the session:** where the host supports it (Claude Code *channels*), the bridge pushes incoming messages into the live session. Otherwise agents poll a tool.
  - **Between relays and to external agents:** A2A. The relay hosts A2A Agent Cards and endpoints on behalf of participants.
  - Details and trade-offs are in [Recommendation](#recommendation-for-blether).

---

## 1. A2A (Agent2Agent)

- **Governance:** Google created A2A and launched it in April 2025. The Linux Foundation took it on as a project on 2025-06-23, with AWS, Cisco, Google, Microsoft, Salesforce, SAP and ServiceNow as founding participants ([LF press release](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)). It has a Technical Steering Committee, and IBM joined it after the ACP merger ([i-am-bee discussion #5](https://github.com/orgs/i-am-bee/discussions/5)).
- **Version:** spec **1.0.0**. Earlier versions were 0.3.0, 0.2.x and 0.1.0 ([spec](https://a2a-protocol.org/latest/specification/)). Release history from the [repo releases](https://github.com/a2aproject/A2A/releases):
  - v1.0.0 (2026-03-12): breaking changes, OAuth modernisation, task listing, gRPC multi-tenancy.
  - v1.0.1 (2026-05-28): bug fixes.
  - v0.3.0 (2025-07-30): added mTLS and signed Agent Cards, and renamed the well-known file to `agent-card.json`.
- **Adoption:** on 2026-04-09 the project reported 150+ supporting organisations and SDKs in 5 production languages. It is integrated into Azure AI Foundry, Copilot Studio and Amazon Bedrock AgentCore ([LF press release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)). Adoption is concentrated in enterprise and cloud agent platforms, not developer coding agents (see the [support matrix](#coding-agent-support-matrix)).
- **Transport:** three protocol bindings: JSON-RPC 2.0, gRPC, and HTTP+JSON/REST with SSE for streaming ([spec §9–11](https://a2a-protocol.org/latest/specification/)).
- **Discovery and identity:**
  - An Agent Card sits at `https://{domain}/.well-known/agent-card.json`. Cards can also come from curated registries or direct configuration ([agent discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)).
  - "The current A2A specification does not prescribe a standard API for curated registries" ([same page](https://a2a-protocol.org/latest/topics/agent-discovery/)).
  - Cards can be cryptographically signed. An extended card can require authentication ([spec](https://a2a-protocol.org/latest/specification/)).
- **Async and long-running work:**
  - A Task moves through these states: submitted → working → input-required / auth-required → completed / failed / canceled / rejected.
  - `contextId` groups multi-turn interactions. `ListTasks` filters by context and status ([spec §3.1.4, §3.4.1, §4.1.3](https://a2a-protocol.org/latest/specification/)).
- **Push vs. polling:** three update modes ([spec §3.5](https://a2a-protocol.org/latest/specification/), [streaming & async](https://a2a-protocol.org/latest/topics/streaming-and-async/)):
  - Polling with `GetTask`. The spec calls it "best for … clients behind restrictive firewalls".
  - Streaming over SSE, with `SubscribeToTask` to re-attach.
  - Push notifications: webhooks, which are server-initiated HTTP POSTs to a client-registered HTTPS URL. These need the client to be reachable.
- **NAT and firewalls:**
  - An A2A *client* on a laptop works fine, because it only makes outbound calls and can poll or stream.
  - An A2A *server* (an agent that can be messaged) must be reachable over HTTP(S), and webhook receivers must be reachable too.
  - *Analysis:* a laptop agent can't be an A2A server without a relay, tunnel or proxy that terminates A2A on its behalf.
- **Auth:**
  - Agent Cards declare security schemes: API key, HTTP auth, OAuth 2.0, OIDC and mTLS ([spec §7](https://a2a-protocol.org/latest/specification/)).
  - Webhook security guidance recommends signed notifications (JWT + JWKS) and SSRF validation of webhook URLs ([streaming & async](https://a2a-protocol.org/latest/topics/streaming-and-async/)).
- **Coding agents:**
  - Gemini CLI is an A2A **client** through "remote subagents" (Markdown/YAML definitions pointing at an Agent Card, with apiKey/http/google-credentials/oauth auth). The feature is experimental ([Gemini CLI docs](https://geminicli.com/docs/core/remote-agents/)).
  - Gemini CLI ships an `a2a-server` package: "All code in this package is experimental" ([repo](https://github.com/google-gemini/gemini-cli/tree/main/packages/a2a-server)).
  - Claude Code: no native support found. Cross-machine A2A is an open feature request ([anthropics/claude-code#28300](https://github.com/anthropics/claude-code/issues/28300), opened 2026-02-24).
  - Codex CLI, Copilot and Cursor: no native support found in their docs (*Unverified* as a negative).
  - Microsoft's Agent Framework can wrap Copilot SDK agents and offers A2A ([MS devblog](https://devblogs.microsoft.com/agent-framework/build-ai-agents-with-github-copilot-sdk-and-microsoft-agent-framework/)). That is a framework, not Copilot CLI or IDE support.

## 2. MCP (Model Context Protocol)

- **Governance:** Anthropic donated MCP to the Agentic AI Foundation, a Linux Foundation directed fund, on 2025-12-09 ([Anthropic](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), [LF](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)). The current revision is **`2026-07-28`** ([versioning](https://modelcontextprotocol.io/specification/versioning)).
- **Big changes in 2026-07-28** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)):
  - The protocol is now **stateless**. The `initialize` handshake and `Mcp-Session-Id` are gone, and `server/discover` was added.
  - Server-initiated requests (sampling, elicitation, roots) are replaced by **Multi Round-Trip Requests (MRTR)**: the server returns `input_required`, and the client retries with answers.
  - The HTTP GET stream and `resources/subscribe` are replaced by **`subscriptions/listen`**.
  - SSE resumability is removed.
  - Tasks moved out of core into an **extension**.
  - **Sampling, Roots and Logging are deprecated.** They are eligible for removal in the first revision on or after 2027-07-28 ([deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)).
- **Transport:**
  - stdio, or Streamable HTTP. Over HTTP, every message is a POST, and the response is JSON or a request-scoped SSE stream ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
  - Claude Code additionally supports a WebSocket transport (`type: "ws"`), which "suits remote MCP servers that push events to Claude unprompted" ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). This is a host extension, not part of the MCP spec.
- **Can MCP do agent-to-agent?** Not directly: MCP is client↔server, and agents are clients. A **shared MCP server used as a mailbox** does work, though, and fits the NAT constraint well, because every agent dials out. Relevant features:
  - **Tools:** `send_message`, `read_inbox`, `claim_task` and so on. Universally supported.
  - **Resources + `subscriptions/listen`:** a client can subscribe to resource URIs (for example `blether://inbox/alice`) and receive `notifications/resources/updated` ([subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)). The notification only says "URI changed". Whether a host then wakes the model or injects the content is up to the host. *Unverified* for every coding agent. Claude Code's MCP docs do not mention resource subscriptions (they cover `list_changed` only, [docs](https://code.claude.com/docs/en/mcp)).
  - **Tasks extension:** a server returns a durable `taskId`. The client polls `tasks/get`, supplies mid-flight input via `tasks/update`, and can get `notifications/tasks` via `subscriptions/listen`. "Polling is the default" ([Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)). This models *client→server* long-running work, not peer messaging. Coding-agent support is not shown in the official [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) (*Unverified*).
  - **Elicitation:** under MRTR it can only happen *inside* a client-initiated request. It is useful for "approve sending this?" prompts during a `send_message` tool call. A server cannot use it to interrupt an idle agent.
  - **Sampling:** deprecated. Don't build on it.
  - **Notifications:** request-scoped progress, plus `list_changed` and resource updates on the listen stream. There is no standard "deliver a message to the model" notification.
- **Discovery and identity:** `server/discover` returns versions, capabilities and identity. There is no peer discovery: an MCP server *is* the rendezvous point.
- **Auth:**
  - OAuth 2.1-based authorization for HTTP.
  - 2026-07-28 deprecates Dynamic Client Registration in favour of Client ID Metadata Documents, and adds RFC 9207 `iss` validation ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
  - Extensions add client-credentials and enterprise-managed auth ([client matrix](https://modelcontextprotocol.io/extensions/client-matrix)).
- **NAT and firewalls:** clients only make outbound connections, so this is ideal for laptops. The relay hosts the server.
- **Coding agents:** every agent surveyed is an MCP client:
  - Claude Code: stdio, HTTP, SSE (deprecated), WebSocket; elicitation; `list_changed`; channels ([docs](https://code.claude.com/docs/en/mcp)).
  - Codex CLI: stdio and Streamable HTTP with OAuth ([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). `codex mcp-server` "has been removed" in favour of the Codex app server's own JSON-RPC protocol ([docs](https://learn.chatgpt.com/docs/mcp-server)).
  - Gemini CLI: stdio, SSE, Streamable HTTP, tools, prompts, resources ([docs](https://geminicli.com/docs/tools/mcp-server/)).
  - Cursor: stdio, SSE, Streamable HTTP; tools, prompts, resources, roots, elicitation, Apps ([docs](https://cursor.com/docs/context/mcp)).
  - VS Code / Copilot: full-spec support announced June 2025, including sampling and elicitation ([VS Code blog](https://code.visualstudio.com/blogs/2025/06/12/full-mcp-spec-support)). Its support for the 2026-07-28 revision is *Unverified*.

### Claude Code "channels": push into a live session over MCP

This is the most important finding for Blether's edge.

- A *channel* is an MCP server that declares the experimental capability `claude/channel` and emits `notifications/claude/channel` (`content` plus `meta`). Claude Code injects each event into the running session as a `<channel source="…">` block. If the session is idle, the event starts a turn. Events that arrive while Claude is busy are batched into the next turn ([channels reference](https://code.claude.com/docs/en/channels-reference)).
- **Two-way:** the server exposes a normal `reply` tool.
- **Permission relay:** the optional `claude/channel/permission` capability forwards tool-approval prompts (`…/permission_request`) and accepts `allow`/`deny` verdicts ([same](https://code.claude.com/docs/en/channels-reference)).
- **Limits:**
  - It is a **research preview**.
  - It runs over stdio as a local subprocess.
  - It needs claude.ai or Console auth, and is not available on Bedrock, Vertex or Foundry.
  - Team and Enterprise orgs must enable `channelsEnabled`.
  - Custom channels need `--dangerously-load-development-channels` unless an org admin adds them to `allowedChannelPlugins`.
  - Events are not acknowledged, and are dropped silently if the channel isn't registered ([channels](https://code.claude.com/docs/en/channels)).
  - A channel server that negotiates MCP `2026-07-28` on the v2 runtime is **not** registered as a channel ([MCP docs](https://code.claude.com/docs/en/mcp)).
  - The whole mechanism is Claude-specific.
- The docs warn that "An ungated channel is a prompt injection vector" and require gating on sender identity ([reference](https://code.claude.com/docs/en/channels-reference)).

## 3. ACP from IBM/BeeAI (Agent Communication Protocol), now merged into A2A

- IBM Research launched it in March 2025 for BeeAI and donated it to the LF. It was REST/HTTP with `/agents` and `/runs`, sync/async/streaming runs, an "Await" pause-for-input mechanism, and Agent Manifests for discovery ([repo](https://github.com/i-am-bee/acp)).
- **Merger:**
  - On 2025-08-25 IBM announced that ACP "will wind down active development" and join A2A under the LF. IBM's Kate Blair joined the A2A TSC, and BeeAI got A2A adapters plus a migration guide ([discussion #5](https://github.com/orgs/i-am-bee/discussions/5)).
  - The repo was archived on 2025-08-27 ([repo](https://github.com/i-am-bee/acp)).
- **For Blether:** don't adopt it. It is dead; its ideas live on in A2A.

## 4. ANP (Agent Network Protocol)

- **Governance:**
  - It is an open-source "ANP Community" project ([repo](https://github.com/agent-network-protocol/AgentNetworkProtocol), about 1.4k stars).
  - A related **W3C AI Agent Protocol Community Group** exists, proposed 2025-05-08 and chaired by Gaowei Chang and Song Xu ([W3C CG](https://www.w3.org/community/agentprotocol/)).
  - W3C Community Groups do not produce W3C Recommendations, so this is not a standards track.
- **Version:** ANP **1.2**. Some parts are still drafts: the meta-protocol (ANP-06), authorization (v0.6), and group E2EE messaging profile P6, which is still a candidate ([repo](https://github.com/agent-network-protocol/AgentNetworkProtocol), [site](https://agent-network-protocol.com/)).
- **Design:**
  - Layered. Identity uses W3C DIDs (`did:wba`, `did:web`) over HTTP/TLS.
  - Agent description and discovery documents, a meta-protocol for negotiating application protocols, and nine messaging profiles (direct, group, E2EE, attachments, federation) ([site](https://agent-network-protocol.com/)).
- **NAT:** the repo references federation and relay concepts in the messaging layer, but the details weren't verified (*Unverified*). Agents are web-hosted by design (`did:wba` resolves via HTTPS).
- **Coding agents:** none found with native support.
- **For Blether:** interesting decentralised identity ideas, but low adoption and no coding-agent support. Not a candidate.

## 5. AGNTCY (Cisco-originated, Linux Foundation)

- **Governance:** joined the LF on 2025-07-29. Formative members were Cisco, Dell, Google Cloud, Oracle and Red Hat, with 65+ supporting companies ([LF press release](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos)).
- **Components** ([docs](https://docs.agntcy.org/)): Agent Directory Service (federated registry), OASF (schema), Identity (decentralised IDs and verifiable credentials), **SLIM**, SHADI (hardened runtime), Observability.
- **AGNTCY ACP (Agent Connect Protocol):**
  - A REST/OpenAPI interface to invoke and configure remote agents. The repo was **archived 2026-04-11** ([acp-spec](https://github.com/agntcy/acp-spec)), and ACP no longer appears in the component list ([docs](https://docs.agntcy.org/)).
  - Secondary sources say AGNTCY now points to A2A for invocation. *Unverified* from a primary source.
- **SLIM (Secure Low-Latency Interactive Messaging):**
  - Runs gRPC over HTTP/2 and HTTP/3.
  - Routing nodes forward messages by hierarchical name. Clients carry the session layer.
  - Supports pub/sub and request/reply, with MLS end-to-end encryption over TLS 1.3 hop-by-hop, and SLIMRPC.
  - Integration packages: `slim-a2a-python` and `slim-mcp-python` ([repo](https://github.com/agntcy/slim)).
  - Specified as an **individual** IETF Internet-Draft, `draft-mpsb-agntcy-slim-02` (2026-07-07), "no formal standing" ([datatracker](https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/)).
  - *Analysis:* clients connect to routing nodes, so this is broker-style and NAT-friendly. That is an inference from the architecture; NAT traversal isn't stated explicitly.
- **Coding agents:** none found with native support.
- **For Blether:** SLIM is a plausible relay fabric to *borrow*, especially MLS group E2EE. It is a heavy dependency with pre-standard status, though.

## 6. How Claude Code agent teams communicate

From [agent teams](https://code.claude.com/docs/en/agent-teams) and [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging):

- **Status:** agent teams are experimental. They are enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and need an interactive session.
- **Parts:** a team lead, teammates (separate Claude Code instances), a shared task list, and a mailbox.
- **Mailbox:**
  - Each agent's inbox is a JSON file at `~/.claude/teams/{team}/inboxes/{agent}.json`. A send succeeds only when the write to that file succeeds.
  - Messages are "delivered automatically to recipients", so the lead doesn't poll. Idle teammates notify the lead with their final answer.
  - Messages are addressed by teammate name. There is no broadcast: "send one message per recipient".
- **Task list:**
  - Stored at `~/.claude/tasks/{team}/`. States are pending, in progress and completed, with dependencies.
  - Teammates self-claim tasks, and "Task claiming uses file locking". Tools: `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, plus `SendMessage`.
- **Trust model:**
  - The receiving agent is told the message came from another Claude session, not the user. It "can't approve a permission prompt or supply consent on your behalf".
  - In auto mode a classifier reviews each inter-agent message before delivery.
- **Across machines?** Agent teams: **no.** "One team per session … You can't … share a team across sessions", and all state is in local files.
- **Cross-session messaging** (v2.1.224+) is the nearest thing:
  - Same machine: a Unix socket or named pipe, "never through Anthropic servers".
  - Another of *your* machines: "Through Anthropic servers", over Remote Control, with a claude.ai login. Messages to offline sessions queue until the machine reconnects.
  - Inbound control is `accept`/`hold`/`refuse`, and `isolatePeerMachines` requires approval before a message leaves the machine.
  - It is plain text only, capped at about 1M characters, rate-limited and loop-throttled.
  - Only messaging between **your own sessions** is documented. Nothing covers different developers or accounts.
- **Lessons for Blether** (*Analysis*):
  - The UX to copy: name-addressed inboxes, delivery at turn boundaries, idle wake-up, a shared task list with atomic claims, and "messages are never consent".
  - The inbound `accept`/`hold`/`refuse` policy maps directly onto Blether's "how much may my agent say or do without approval".
  - The transport is local-only, apart from Anthropic's Remote Control relay, which is limited to one user.

## 7. Other contenders

### Agent Client Protocol (Zed), "ACP"

- **What it is:** a standard for **editor/IDE ↔ coding agent**, described as LSP-like. It runs JSON-RPC over stdio. Remote (HTTP/WebSocket) is "a work in progress", and it reuses MCP JSON types ([intro](https://agentclientprotocol.com/overview/introduction)).
- **Governance:** Apache-2.0, with GOVERNANCE.md and MAINTAINERS.md in the repo. Stable protocol version `1` ([repo](https://github.com/agentclientprotocol/agent-client-protocol)).
- **Agents with native support:** Gemini CLI (`gemini --acp`, [docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)), GitHub Copilot CLI (`copilot --acp`, stdio or TCP on loopback, public preview from 2026-01-28, [docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server), [changelog](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)), Cursor, Goose, OpenCode and others ([agents list](https://agentclientprotocol.com/get-started/agents)).
- **Agents via adapter:** Claude (Zed's SDK adapter) and Codex CLI ([agents list](https://agentclientprotocol.com/get-started/agents)).
- **How it differs:** it is not agent-to-agent. The *client* (an editor) owns the agent process and sends it prompts.
- *Analysis:* a Blether daemon could act as an ACP client and inject prompts into any ACP agent, which gives universal "push". The catch is that the daemon must own the session, which conflicts with "the developer's live session in their own terminal".

### Codex app server

- Codex's own bidirectional JSON-RPC protocol, which replaces `codex mcp-server`. Transports are stdio, WebSocket (experimental) and Unix socket ([docs](https://developers.openai.com/codex/app-server/), [removal notice](https://learn.chatgpt.com/docs/mcp-server)).
- It is vendor-specific, like Claude channels.

---

## Coding-agent support matrix

| Agent | MCP client | Push into live session from MCP | A2A | Agent Client Protocol (Zed) |
|---|---|---|---|---|
| Claude Code | Yes: stdio, HTTP, WS ([docs](https://code.claude.com/docs/en/mcp)) | **Yes, via channels** (research preview, Claude-only) | No ([feature request](https://github.com/anthropics/claude-code/issues/28300)) | Via Zed adapter |
| Codex CLI | Yes: stdio, HTTP ([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)) | Not documented | Not found | Via adapter |
| Gemini CLI | Yes: stdio, SSE, HTTP ([docs](https://geminicli.com/docs/tools/mcp-server/)) | Not documented | **Client** (experimental); server package experimental | Native (`--acp`) |
| GitHub Copilot (CLI / VS Code) | Yes ([VS Code](https://code.visualstudio.com/blogs/2025/06/12/full-mcp-spec-support)) | Not documented | Only via MS Agent Framework | Native in CLI (preview) |
| Cursor | Yes: stdio, SSE, HTTP, elicitation ([docs](https://cursor.com/docs/context/mcp)) | Not documented | Not found | Native ([list](https://agentclientprotocol.com/get-started/agents)) |

"Not documented" and "Not found" mean no primary source was found. They don't prove the feature is absent.

## Comparison table

| | A2A | MCP | IBM ACP | ANP | AGNTCY SLIM | Zed ACP | Claude Code teams / cross-session |
|---|---|---|---|---|---|---|---|
| **Purpose** | Agent ↔ agent | Agent ↔ tools/data | Agent ↔ agent | Agent ↔ agent (open web) | Messaging transport | Editor ↔ agent | Claude ↔ Claude |
| **Maturity** | 1.0.x, LF, wide enterprise adoption | `2026-07-28`, AAIF/LF, universal in coding agents | Archived (merged into A2A) | 1.2 with draft parts, W3C CG | Individual I-D -02 | v1, broad editor and agent adoption | Experimental / v2.1.224+ |
| **Transport** | JSON-RPC, gRPC, REST + SSE | stdio, Streamable HTTP | REST | HTTPS (+ messaging profiles) | gRPC over HTTP/2 and HTTP/3 | stdio (remote WIP) | Local files / sockets; Anthropic relay |
| **Discovery / identity** | Agent Card, well-known URI, signed cards; no standard registry | `server/discover`; no peer discovery | Agent Manifest | DIDs (`did:wba`) | Hierarchical names; AGNTCY Directory and Identity | n/a (client launches agent) | Team config file; `ListAgents` |
| **Async / long-running** | Tasks with input-required and auth-required | Tasks extension (polling-first) | Async runs, Await | Profile-dependent | Pub/sub, streaming | Sessions | Mailbox + task list |
| **Push vs. poll** | Poll, SSE stream, or webhook push | Poll; `subscriptions/listen` change notifications; host-specific push (channels) | Stream / poll | Unverified | Push over a client-held connection | Client drives | Push at turn boundaries |
| **Reaches a NAT'd laptop?** | Client yes; **server/webhook no** without a relay | **Yes** (client dials out) | Server no | Server no | Yes via routing node (inferred) | Local only | Same machine; own machines via Anthropic |
| **Auth** | API key, HTTP, OAuth2, OIDC, mTLS | OAuth 2.1, CIMD | n/a | DID-based | TLS + MLS | Local process | OS user, claude.ai account |
| **Native in coding agents** | Gemini CLI (client) | All five | None | None | None | Gemini, Copilot CLI, Cursor (+ adapters) | Claude Code only |

---

## Recommendation for Blether

### Design: a hybrid of an MCP edge, a Blether relay, and A2A at the federation edge

```
 Dev A laptop                              Blether relay (reachable)          Dev B laptop
 ┌──────────────────────┐   outbound WSS/HTTPS  ┌──────────────────────┐   outbound   ┌──────────────────────┐
 │ Claude Code session  │◄─stdio─► Blether ─────►│ mailboxes, task list,│◄──────────── Blether ◄─stdio─► Codex/Gemini/…
 │ (MCP client)         │   bridge (local MCP    │ presence, policy,    │   bridge (local MCP     │
 │                      │   server + channel)    │ audit                │   server, poll mode)    │
 └──────────────────────┘                        │  A2A endpoint + Agent│
                                                 │  Cards per participant◄──A2A──► other relays / external A2A agents
                                                 └──────────────────────┘
```

1. **Agent edge = MCP, through a local bridge.**
   - Every developer installs a small Blether MCP server that runs on stdio. Agents need no special capability beyond MCP tools, which all five targets support.
   - The bridge holds one **outbound** connection to the relay, which solves NAT.
   - Example tools: `send_message`, `read_inbox`, `list_peers`, `task_create/claim/update/list`, `ask` (question with expected reply).
2. **Delivery into the live session:**
   - **Claude Code:** the bridge also declares `claude/channel`, so an incoming message wakes or interrupts the session at a turn boundary, matching agent-teams semantics. It can declare `claude/channel/permission` to relay approvals to the developer's phone or chat.
   - **Other agents:** degrade to polling. The agent checks `read_inbox` at natural points, nudged by server `instructions`. Expose the inbox as a resource as well, so hosts that surface `notifications/resources/updated` benefit later.
3. **Approval policy is enforced in the bridge**, close to the developer and independent of each agent's own permission system:
   - Per-peer and per-action levels, mirroring Claude Code's `accept`/`hold`/`refuse`.
   - Outbound "ask before sending" can use MCP **elicitation** inside the `send_message` call, on hosts that support it (Claude Code, Cursor, VS Code).
   - Inbound messages are always framed as untrusted, never as consent.
4. **Relay ↔ relay and external agents = A2A.**
   - The relay publishes an Agent Card per participant (or per team) and terminates A2A on their behalf.
   - A2A Tasks map onto Blether's ask/handoff, `input-required` maps to "awaiting developer approval", and webhooks go to the relay, which *is* reachable.
   - This gives interoperability with Gemini CLI remote subagents and enterprise A2A platforms, without needing laptops to be A2A servers.
5. **Transport between bridge and relay:** start with plain WebSocket or HTTPS long-poll under Blether's own small schema. Revisit SLIM if group E2EE (MLS) or multi-relay routing becomes a requirement.

### Trade-offs

| Choice | Gain | Cost / risk |
|---|---|---|
| MCP at the edge | Works with every coding agent today; outbound-only | MCP has no standard "deliver message to model" mechanism, so non-Claude agents must poll and may miss time-sensitive messages |
| Claude channels for push | True async delivery matching agent-teams UX | Research preview; custom channels need a dev flag or an org allowlist; Claude-only; incompatible with the `2026-07-28` negotiation today; stdio only |
| A2A between relays | Standard, LF-governed, enterprise reach, natural task model | Second protocol to implement; A2A identity and registry are not standardised; little coding-agent adoption |
| A2A everywhere, no MCP edge | One protocol | No coding agent is an A2A *receiver*; laptops still need a relay or tunnel; the client role is experimental only in Gemini |
| Zed ACP daemon driving agents | Universal push into any ACP agent | Blether owns the agent process instead of the developer's live session; Claude and Codex only via adapters |
| Own relay vs. SLIM | Simple, fits exactly | Own security work (E2EE, identity) instead of using MLS and SLIM routing |
| Relying on Anthropic Remote Control | Already cross-machine | Single user only, Claude only, Anthropic-hosted; not a basis for a multi-developer product |

## Open questions for the team

1. **Is polling acceptable for non-Claude agents in v1?** If not, which push path should be pursued: ACP-daemon mode, vendor-specific hooks, or waiting for hosts to surface MCP resource updates?
2. **Should Blether depend on a research-preview Claude feature (channels)?** Is requiring `--dangerously-load-development-channels`, or an org `allowedChannelPlugins` entry, acceptable for early users?
3. **Which MCP revision should the bridge target?** `2025-11-25` keeps Claude channels working; `2026-07-28` is current but disables channel registration in Claude Code today.
4. **Identity:** how are participants named and authenticated? Options include OAuth via the relay, GitHub identity, signed A2A Agent Cards, or DIDs. Is the unit a person, a session, or a session-in-a-repo?
5. **Trust and policy model:** what are the default autonomy levels? Should inbound messages be able to trigger *actions*, or only information? How should cross-agent prompt injection be audited?
6. **Hosting:** is there one central SaaS relay, a per-team self-hosted relay, or a federation of relays over A2A? Is end-to-end encryption needed so the relay can't read messages?
7. **Offline semantics:** a participant is a *live session*. Do messages to an offline session queue (as with Claude cross-session messaging), expire, or fall back to the human (for example by email or chat)?
8. **Task list ownership:** should Blether's shared task list be authoritative, or sync with GitHub Issues or each agent's native task tools (such as Claude's `TaskCreate`)?
9. **A2A scope for v1:** is the A2A federation edge needed at launch, or can it wait until a second relay or an external agent exists?
