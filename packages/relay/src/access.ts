import { createHash } from "node:crypto";
import { z } from "zod";
import type { RelayAccess } from "@blether/protocol";

/**
 * Who a connection's credential belongs to, as its sign-in provider says.
 * Claims are what rules can check, such as roles.
 */
export interface Principal {
  /** The provider kind that admitted it. */
  provider: RelayAccess["kind"];
  /** Who vouches for the subject: the token file, or an OIDC issuer. */
  issuer: string;
  /** Who signed in, unique within the issuer. Empty on an open relay. */
  subject: string;
  claims: Claims;
  /** When the credential stops being valid, if it expires. */
  expiresAt?: Date;
}

export type Claims = Record<string, string | string[]>;

/**
 * Decides who may connect to a relay (ADR 0009). There is one per relay.
 * Adding a kind of sign-in means adding a provider; the relay itself only
 * calls these two methods.
 */
export interface AccessProvider {
  /** What a client needs to know to sign in, for the discovery document. */
  describe(): RelayAccess;
  /**
   * Checks the credential a connection presented (undefined if none), and
   * returns who it belongs to, or undefined to refuse the connection.
   */
  authenticate(credential: string | undefined): Promise<Principal | undefined>;
}

/** Anyone may connect, as an anonymous principal. */
export function openAccess(): AccessProvider {
  const anonymous: Principal = {
    provider: "open",
    issuer: "",
    subject: "",
    claims: {},
  };
  return {
    describe: () => ({ kind: "open" }),
    authenticate: () => Promise.resolve(anonymous),
  };
}

/** One bearer token the operator issued, as the relay stores it. */
export const TokenEntry = z.object({
  /** Who the token was issued to: the principal's subject. */
  subject: z.string().min(1),
  /** The token's SHA-256, hex-encoded. The relay never stores the token. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  claims: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
});
export type TokenEntry = z.infer<typeof TokenEntry>;

export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Connections need one of the operator's bearer tokens. */
export function tokenAccess(entries: readonly TokenEntry[]): AccessProvider {
  const byHash = new Map(entries.map((e) => [e.sha256, e]));
  return {
    describe: () => ({ kind: "token" }),
    authenticate: (credential) => {
      const entry = credential && byHash.get(tokenHash(credential));
      return Promise.resolve(
        entry
          ? {
              provider: "token",
              issuer: "tokens",
              subject: entry.subject,
              claims: entry.claims ?? {},
            }
          : undefined,
      );
    },
  };
}

/** What a signed-in principal might be allowed to do. */
export type Action = "connect" | "team.create";

/**
 * Who may take an action: anyone the provider admitted, or only principals
 * with one of these claim values. A claim matches if it equals the value,
 * or is a list that includes it.
 */
export type Rule = "signed-in" | { claim: string; value: string }[];

export type Rules = Record<Action, Rule>;

export const ALLOW_SIGNED_IN: Rules = {
  connect: "signed-in",
  "team.create": "signed-in",
};

export function allows(rules: Rules, principal: Principal, action: Action) {
  const rule = rules[action];
  if (rule === "signed-in") return true;
  return rule.some(({ claim, value }) => {
    const held = principal.claims[claim];
    return Array.isArray(held) ? held.includes(value) : held === value;
  });
}

/**
 * Reads a rule as an operator writes it: `signed-in`, or comma-separated
 * `claim=value` pairs, any of which allows the action.
 */
export function parseRule(text: string): Rule | undefined {
  const trimmed = text.trim();
  if (trimmed === "signed-in") return "signed-in";
  const pairs = trimmed.split(",").map((pair) => {
    const at = pair.indexOf("=");
    return at > 0
      ? { claim: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() }
      : undefined;
  });
  if (pairs.some((p) => !p || !p.claim || !p.value)) return undefined;
  return pairs as { claim: string; value: string }[];
}
