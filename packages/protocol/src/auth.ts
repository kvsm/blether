import { hash, sign, verify, type DeviceKey } from "./crypto.js";

/**
 * When a bridge or the CLI connects, the relay sends a random challenge. The
 * client proves it holds a device's secret key by signing the challenge
 * together with the team and agent it wants to act as (empty for a CLI
 * session), so a signature can't be replayed on another connection, or for
 * another team or agent.
 *
 * On a relay that requires a sign-in, the client also signs a hash of the
 * credential it sent when connecting, so the relay knows the device and the
 * credential came together.
 */
const AUTH_CONTEXT = "blether-auth-v2";

export interface SessionScope {
  team?: string | undefined;
  agent?: string | undefined;
}

function authMessage(
  challenge: string,
  scope: SessionScope,
  credential: string | undefined,
): string {
  const lines = [AUTH_CONTEXT, challenge, scope.team ?? "", scope.agent ?? ""];
  if (credential !== undefined) lines.push(`credential ${hash(credential)}`);
  return lines.join("\n");
}

export function signChallenge(
  device: DeviceKey,
  challenge: string,
  scope: SessionScope,
  credential?: string,
): string {
  return sign(device, authMessage(challenge, scope, credential));
}

export function verifyChallenge(
  devicePublicKey: string,
  challenge: string,
  scope: SessionScope,
  signature: string,
  credential?: string,
): boolean {
  return verify(
    devicePublicKey,
    authMessage(challenge, scope, credential),
    signature,
  );
}
