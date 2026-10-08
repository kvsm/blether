import { lintSource } from "@secretlint/core";
import { creator as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";

/**
 * Checks outgoing messages for secrets before they're encrypted (ADR 0002:
 * content checks happen on the developer's device), using secretlint's
 * maintained recommended ruleset. A finding isn't proof of a secret, so the
 * developer, never the agent, decides whether to send it anyway.
 */

export interface SecretFinding {
  /** The secretlint rule that matched. */
  rule: string;
  /** secretlint's description of what it found, with the value masked. */
  message: string;
  /** 1-based line number in the message. */
  line: number;
}

/** Finds likely secrets in a message's text. */
export type SecretScanner = (text: string) => Promise<SecretFinding[]>;

export const scanForSecrets: SecretScanner = async (text) => {
  const result = await lintSource({
    source: {
      content: text,
      filePath: "message.txt",
      ext: ".txt",
      contentType: "text",
    },
    options: {
      config: {
        rules: [
          {
            id: "@secretlint/secretlint-rule-preset-recommend",
            rule: recommendedRules,
          },
        ],
      },
      maskSecrets: true,
      noPhysicFilePath: true,
    },
  });
  return result.messages.map((message) => ({
    rule: message.ruleId,
    message: message.message,
    line: message.loc.start.line,
  }));
};
