import { z } from "zod";

/**
 * How a relay decides who may connect (ADR 0009). A relay that requires a
 * sign-in refuses a WebSocket upgrade without a valid credential, sent as
 * `Authorization: Bearer <credential>`. Clients learn what kind of
 * credential to get from the relay's discovery document.
 */
export const RelayAccess = z.discriminatedUnion("kind", [
  /** Anyone may connect, with no credential. */
  z.object({ kind: z.literal("open") }),
  /** A bearer token the relay's operator gave the developer. */
  z.object({ kind: z.literal("token") }),
]);
export type RelayAccess = z.infer<typeof RelayAccess>;

/** What a relay serves at DISCOVERY_PATH. */
export const RelayDiscovery = z.object({ access: RelayAccess });
export type RelayDiscovery = z.infer<typeof RelayDiscovery>;

export const DISCOVERY_PATH = "/.well-known/blether-relay";
