export * from "./auth.js";
export * from "./crypto.js";
export * from "./identity.js";
export * from "./wire.js";

/** Version of the message envelope. Bumped when the wire format changes (ADR 0005). */
export const ENVELOPE_VERSION = 1;
