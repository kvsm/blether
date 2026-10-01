/**
 * Invite strings (ADR 0006): `blether://<relay-host>/<team-id>/<invite-id>#<secret>`
 * for a relay reached over wss://, or `blether+ws://…` for a local dev relay
 * over plain ws://. Everything before `#` locates the invite; the secret after
 * it is never sent to the relay.
 */

export interface InviteLink {
  /** WebSocket URL of the team's relay. */
  relayUrl: string;
  teamId: string;
  inviteId: string;
  secret: string;
}

export class InviteLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteLinkError";
  }
}

const PATTERN =
  /^blether(\+ws)?:\/\/([^/\s#]+)\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/;

export function formatInviteLink(link: InviteLink): string {
  const url = new URL(link.relayUrl);
  const scheme =
    url.protocol === "wss:"
      ? "blether"
      : url.protocol === "ws:"
        ? "blether+ws"
        : undefined;
  if (!scheme) {
    throw new InviteLinkError(
      `Relay URL must be ws:// or wss://: ${link.relayUrl}`,
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new InviteLinkError(`Relay URL can't have a path: ${link.relayUrl}`);
  }
  return `${scheme}://${url.host}/${link.teamId}/${link.inviteId}#${link.secret}`;
}

export function parseInviteLink(text: string): InviteLink {
  const match = PATTERN.exec(text.trim());
  if (!match) {
    throw new InviteLinkError(
      "That isn't a Blether invite. It should look like blether://relay.example.com/<team>/<invite>#<secret>.",
    );
  }
  const [, insecure, host, teamId, inviteId, secret] = match;
  return {
    relayUrl: `${insecure ? "ws" : "wss"}://${host}`,
    teamId: teamId!,
    inviteId: inviteId!,
    secret: secret!,
  };
}
