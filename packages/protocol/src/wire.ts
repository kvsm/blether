import { z } from "zod";

/**
 * Frames exchanged between a bridge and the relay over a WebSocket, one JSON
 * object per WebSocket message. This is the insecure dev-mode wire format of
 * the walking skeleton: no identity, teams or encryption yet.
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
  /** First frame on a connection: the session starts acting as `agent`. */
  z.object({ type: z.literal("hello"), agent: AgentName }),
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
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ErrorCode = z.enum([
  "malformed-frame",
  "not-introduced",
  "already-introduced",
  "agent-in-use",
  "unknown-agent",
  "duplicate-id",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Frames the relay sends to a bridge. */
export const RelayFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), agent: AgentName }),
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
  /** `id` refers to the `send` frame that failed, when there is one. */
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
