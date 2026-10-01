import { z } from "zod";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME_RULE =
  "lowercase letters, digits and hyphens, starting with a letter or digit";

/** An agent's name, unique within its team. */
export const AgentName = z.string().regex(NAME, NAME_RULE);
export type AgentName = z.infer<typeof AgentName>;

/** A role from a team's agreed list, such as "frontend" or "reviewer". */
export const RoleName = z.string().regex(NAME, NAME_RULE);
export type RoleName = z.infer<typeof RoleName>;
