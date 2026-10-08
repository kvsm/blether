import { z } from "zod";
import { PublicKey, Signature } from "./crypto.js";
import { Audience, Envelope } from "./envelope.js";
import { IdentityLog } from "./identity.js";
import { AgentName } from "./names.js";
import { SignedTeamEntry, TeamLog } from "./team.js";

/**
 * Who a send was addressed to, told to a relay that asked for it (in its
 * welcome) so it can count role messages and broadcasts. Unverified: the
 * relay uses it for statistics and nothing else. `fanout` is shared by every
 * copy of one send, so the relay can count the send once.
 */
export const AudienceHint = z.object({
  audience: z.union([z.object({ kind: z.literal("agent") }), Audience]),
  fanout: z.uuid(),
});
export type AudienceHint = z.infer<typeof AudienceHint>;

/**
 * Frames exchanged between a bridge and the relay over a WebSocket, one JSON
 * object per WebSocket message.
 *
 * On connecting, the relay sends a `challenge`. The client answers with
 * `hello`, carrying its developer's identity log and a signature of the
 * challenge by one of that identity's devices (see auth.ts).
 *
 * A bridge's hello names a team and an agent: the session then acts as that
 * agent and can message other agents in the team. The CLI's hello names
 * neither: the session can only read and extend team membership logs.
 * Message content travels only as end-to-end encrypted envelopes.
 *
 * A session receives every message still unread in its agent's mailbox when
 * it says hello, so a bridge may see the same message again after
 * reconnecting and should ignore ids it already holds.
 */

/**
 * A message as the relay holds and delivers it. The content is an end-to-end
 * encrypted envelope the relay can't read; `from` is stamped by the relay
 * from the sending session, and `receivedAt` is when the relay accepted it.
 */
export const Message = z.object({
  id: z.uuid(),
  from: AgentName,
  to: AgentName,
  envelope: Envelope,
  receivedAt: z.iso.datetime(),
});
export type Message = z.infer<typeof Message>;

/** How far a message has got, as its sender sees it. Never says whether it was acted on (ADR 0001). */
/**
 * How far a message has got, as its sender sees it. `lost`: the recipient
 * agent was deleted (or its developer removed) before it was read. Never
 * says whether a message was acted on (ADR 0001).
 */
export const DeliveryStatus = z.enum(["queued", "delivered", "read", "lost"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** A message the agent sent, without its body. */
export const SentMessage = z.object({
  id: z.uuid(),
  to: AgentName,
  sentAt: z.iso.datetime(),
  status: DeliveryStatus,
});
export type SentMessage = z.infer<typeof SentMessage>;

/** Frames a bridge sends to the relay. */
export const ClientFrame = z.discriminatedUnion("type", [
  /** First frame on a connection. `agent` requires `team`. */
  z.object({
    type: z.literal("hello"),
    team: z.string().optional(),
    agent: AgentName.optional(),
    /**
     * If another session is already acting as the agent, disconnect it and
     * take its place. Only ever honoured for the agent's owner.
     */
    takeover: z.boolean().optional(),
    identity: IdentityLog,
    device: PublicKey,
    signature: Signature,
  }),
  z.object({
    type: z.literal("send"),
    id: z.uuid(),
    to: AgentName,
    envelope: Envelope,
    /** Only when the relay asked for hints. A malformed one is dropped, never the message. */
    hint: AudienceHint.optional().catch(undefined),
  }),
  /** The agent has read these messages from its mailbox. */
  z.object({ type: z.literal("read"), ids: z.array(z.uuid()).min(1) }),
  /** Asks for the delivery status of the agent's most recently sent messages. */
  z.object({
    type: z.literal("list-sent"),
    requestId: z.uuid(),
    limit: z.number().int().min(1).max(100),
  }),
  /** Starts a team; `log` is its single team-created entry. */
  z.object({
    type: z.literal("create-team"),
    requestId: z.uuid(),
    log: TeamLog,
  }),
  /**
   * Asks for a team's log. Only members get it, and someone holding an
   * invite, who proves it with `invite` (team.ts, proveInvite).
   */
  z.object({
    type: z.literal("get-team"),
    requestId: z.uuid(),
    team: z.string(),
    invite: z.object({ id: z.string(), proof: Signature }).optional(),
  }),
  /** Appends an entry; it must extend the log's current head. */
  z.object({
    type: z.literal("append-team"),
    requestId: z.uuid(),
    team: z.string(),
    entry: SignedTeamEntry,
  }),
  /** Asks which of a team's agents have a session connected. Members only. */
  z.object({
    type: z.literal("get-presence"),
    requestId: z.uuid(),
    team: z.string(),
  }),
  /** The agent has seen these lost-message notices; the relay can forget them. */
  z.object({ type: z.literal("ack-lost"), ids: z.array(z.uuid()).min(1) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ErrorCode = z.enum([
  "malformed-frame",
  "authentication-failed",
  "agent-owned-by-another",
  "not-a-member",
  "unknown-team",
  "team-rejected",
  "team-conflict",
  "no-agent",
  "identity-conflict",
  "not-introduced",
  "already-introduced",
  "agent-in-use",
  "unknown-agent",
  "duplicate-id",
  /** The relay's rules don't let this developer's sign-in do that. */
  "not-allowed",
  /**
   * The relay refused the connection before it opened: it requires a
   * sign-in and got no credential (sign-in-required) or one it doesn't
   * accept (sign-in-refused). Clients report these; the relay can't send
   * them as frames.
   */
  "sign-in-required",
  "sign-in-refused",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Frames the relay sends to a bridge. */
export const RelayFrame = z.discriminatedUnion("type", [
  /** First frame on a connection: sign this to authenticate. */
  z.object({ type: z.literal("challenge"), challenge: z.string().min(32) }),
  z.object({
    type: z.literal("welcome"),
    team: z.string().optional(),
    agent: AgentName.optional(),
    /** The authenticated developer's identity id. */
    developer: z.string(),
    /**
     * The longest version of the developer's identity log the relay holds,
     * which may be newer than the one the hello carried (another device may
     * have added a device since).
     */
    identity: IdentityLog,
    /** Set when the relay runs in debug mode and wants an AudienceHint with each send. */
    audienceHints: z.boolean().optional(),
  }),
  /** The relay accepted the `send` frame with this id. */
  z.object({
    type: z.literal("sent"),
    id: z.uuid(),
    status: DeliveryStatus.exclude(["read"]),
  }),
  z.object({ type: z.literal("deliver"), message: Message }),
  /**
   * Sent once after an agent session's welcome, when everything that was
   * waiting for it (messages and lost notices) has been sent.
   */
  z.object({ type: z.literal("caught-up") }),
  /** Reply to `list-sent`, newest first. */
  z.object({
    type: z.literal("sent-list"),
    requestId: z.uuid(),
    messages: z.array(SentMessage),
  }),
  /**
   * Reply to create-team, get-team and append-team: the team's whole log,
   * with the identity log of every author so the client can verify it.
   */
  z.object({
    type: z.literal("team"),
    requestId: z.uuid(),
    log: TeamLog,
    identities: z.array(IdentityLog),
  }),
  /** Reply to get-presence: the agents a session is currently acting as. */
  z.object({
    type: z.literal("presence"),
    requestId: z.uuid(),
    online: z.array(AgentName),
  }),
  /**
   * Messages this agent sent that will never be read, because the recipient
   * agent was deleted first. Sent when it happens and again on every hello
   * until acknowledged. The bridge checks each against the team log.
   */
  z.object({ type: z.literal("lost"), messages: z.array(SentMessage) }),
  /** `id` is the id of the send, or the requestId of the request, that failed. */
  z.object({
    type: z.literal("error"),
    id: z.uuid().optional(),
    code: ErrorCode,
    message: z.string(),
  }),
]);
export type RelayFrame = z.infer<typeof RelayFrame>;

/** Parses one frame, returning `undefined` if it isn't valid JSON or doesn't match. */
export function parseFrame<T>(
  schema: z.ZodType<T>,
  data: string,
): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : undefined;
}
