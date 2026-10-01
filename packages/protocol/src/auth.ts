import { sign, verify, type DeviceKey } from "./crypto.js";

/**
 * When a bridge or the CLI connects, the relay sends a random challenge. The
 * client proves it holds a device's secret key by signing the challenge
 * together with the team and agent it wants to act as (empty for a CLI
 * session), so a signature can't be replayed on another connection, or for
 * another team or agent.
 */
const AUTH_CONTEXT = "blether-auth-v2";

export interface SessionScope {
  team?: string | undefined;
  agent?: string | undefined;
}

function authMessage(challenge: string, scope: SessionScope): string {
  return [AUTH_CONTEXT, challenge, scope.team ?? "", scope.agent ?? ""].join(
    "\n",
  );
}

export function signChallenge(
  device: DeviceKey,
  challenge: string,
  scope: SessionScope,
): string {
  return sign(device, authMessage(challenge, scope));
}

export function verifyChallenge(
  devicePublicKey: string,
  challenge: string,
  scope: SessionScope,
  signature: string,
): boolean {
  return verify(devicePublicKey, authMessage(challenge, scope), signature);
}
