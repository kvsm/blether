import { sign, verify, type MachineKey } from "./crypto.js";

/**
 * When a bridge connects, the relay sends a random challenge. The bridge
 * proves it holds a machine's secret key by signing the challenge together
 * with the agent it wants to act as, so a signature can't be replayed on
 * another connection or for another agent.
 */
const AUTH_CONTEXT = "blether-auth-v1";

function authMessage(challenge: string, agent: string): string {
  return `${AUTH_CONTEXT}\n${challenge}\n${agent}`;
}

export function signChallenge(
  machine: MachineKey,
  challenge: string,
  agent: string,
): string {
  return sign(machine, authMessage(challenge, agent));
}

export function verifyChallenge(
  machinePublicKey: string,
  challenge: string,
  agent: string,
  signature: string,
): boolean {
  return verify(machinePublicKey, authMessage(challenge, agent), signature);
}
