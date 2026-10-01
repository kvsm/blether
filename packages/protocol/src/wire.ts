import { z } from "zod";
import { PublicKey, Signature } from "./crypto.js";
import { IdentityLog } from "./identity.js";
import { SignedTeamEntry, TeamLog } from "./team.js";

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
 * neither: the session can only read and extend team membership logs. There
 * is no encryption yet.
 *
 * A session receives every message still unread in its agent's mailbox when
 * it says hello, so a bridge may see the same message again after
 * reconnecting and should ignore ids it already holds.
 */

/** An agent's name, unique within its team. */
export const AgentName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "lowercase letters, digits and hyphens, starting with a letter or digit",
  );
export type AgentName = z.infer<typeof AgentName>;

export const Message = z.object({
  id: z.uuid(),
  from: AgentName,
  to: AgentName,
  body: z.string().min(1),
  sentAt: z.iso.datetime(),
});
export type Message = z.infer<typeof Message>;

/** How far a message has got, as its sender sees it. Never says whether it was acted on (ADR 0001). */
export const DeliveryStatus = z.enum(["queued", "delivered", "read"]);
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
    identity: IdentityLog,
    device: PublicKey,
    signature: Signature,
  }),
  z.object({
    type: z.literal("send"),
    id: z.uuid(),
    to: AgentName,
    body: z.string().min(1),
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
  z.object({
    type: z.literal("get-team"),
    requestId: z.uuid(),
    team: z.string(),
  }),
  /** Appends an entry; it must extend the log's current head. */
  z.object({
    type: z.literal("append-team"),
    requestId: z.uuid(),
    team: z.string(),
    entry: SignedTeamEntry,
  }),
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
  }),
  /** The relay accepted the `send` frame with this id. */
  z.object({
    type: z.literal("sent"),
    id: z.uuid(),
    status: DeliveryStatus.exclude(["read"]),
  }),
  z.object({ type: z.literal("deliver"), message: Message }),
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
