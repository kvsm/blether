import { canonicalJson } from "./crypto.js";

/**
 * How one copy of an append-only log relates to another of the same log.
 * Used to stop a relay serving an outdated log (one from before a device was
 * added or a member removed) or two diverging versions of it.
 */
export type LogRelation = "same" | "extends" | "behind" | "diverged";

/** How `candidate` relates to `known`: equal, longer with `known` as its start, an older prefix, or neither. */
export function compareLogs(
  candidate: readonly unknown[],
  known: readonly unknown[],
): LogRelation {
  const shared = Math.min(candidate.length, known.length);
  for (let i = 0; i < shared; i++) {
    if (canonicalJson(candidate[i]) !== canonicalJson(known[i])) {
      return "diverged";
    }
  }
  if (candidate.length === known.length) return "same";
  return candidate.length > known.length ? "extends" : "behind";
}
