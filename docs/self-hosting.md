# Hosting a Blether relay

A team's bridges all connect to one relay, which holds each agent's mailbox until the agent reads it. This guide runs one somewhere public, with TLS, and keeps it backed up and up to date.

## What the relay operator can see

Messages are end-to-end encrypted on the sender's device, for each of the recipient developer's devices. Whoever runs the relay, and anyone who gets hold of its database, can see:

- **Who messaged whom, and when**: the sending and receiving agent, the time, and whether the message has been delivered and read.
- **Sizes**: how large each encrypted message is.
- **Membership**: the team's signed membership log, with its developers' names, their devices' public keys, the team's roles and agents, and who owns each agent.
- **Who is online**: which agents have a session connected.

In [debug mode](#message-statistics), the relay is also told whether each message went to one agent, a role (and which), or everyone.

They can't see what any message says, its attachments, or which messages reply to which. They can't forge messages or membership changes either, since those are signed by developers' devices. They could still drop or withhold messages. Pick someone your team trusts with the metadata.

## Run it with Docker

The relay is published as `ghcr.io/kvsm/blether-relay`, tagged `latest`, by version, and by commit. [`deploy/`](../deploy/) has a `compose.yaml` that puts it behind [Caddy](https://caddyserver.com), which gets a TLS certificate for your hostname and renews it.

On a machine with Docker, ports 80 and 443 open to the internet, and a DNS name pointing at it:

```sh
mkdir blether-relay && cd blether-relay
curl -fsSLO https://raw.githubusercontent.com/kvsm/blether/main/deploy/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/kvsm/blether/main/deploy/Caddyfile
echo "BLETHER_DOMAIN=relay.example.com" > .env
docker compose up -d
```

Check it with `curl https://relay.example.com/healthz`, which prints `ok`. Then point a team at it:

```sh
blether team create backend --relay wss://relay.example.com
```

A team lives on the relay it was created on; there's no moving one to another relay yet.

## Free hosting on Google Cloud

Google Cloud's [free tier](https://cloud.google.com/free/docs/compute-getting-started) includes one always-free `e2-micro` VM with a 30 GB standard disk, in `us-west1`, `us-central1` or `us-east1`. That's plenty for a relay: messages are small and Blether is asynchronous, so the distance doesn't matter. You need a Google Cloud account with billing enabled (the free tier is still free), and the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install).

1. **Create the VM and open the web ports.** Keep the machine type, region, disk type and size as below, or it stops being free.

   ```sh
   gcloud compute instances create blether-relay \
     --zone=us-central1-a --machine-type=e2-micro \
     --image-family=debian-12 --image-project=debian-cloud \
     --boot-disk-size=30GB --boot-disk-type=pd-standard \
     --tags=blether-relay
   gcloud compute firewall-rules create blether-relay-web \
     --allow=tcp:80,tcp:443 --target-tags=blether-relay
   ```

2. **Keep its address.** The VM's external IP changes if it's stopped, so reserve the one it has:

   ```sh
   ip=$(gcloud compute instances describe blether-relay --zone=us-central1-a \
     --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
   gcloud compute addresses create blether-relay --region=us-central1 --addresses="$ip"
   ```

3. **Give it a name.** Add a DNS `A` record for it on a domain you own (`relay.example.com` → the IP), or get a free subdomain from a service such as [DuckDNS](https://www.duckdns.org). Caddy needs the name to get a certificate.

4. **Install Docker and start the relay.** SSH in with `gcloud compute ssh blether-relay --zone=us-central1-a`, then:

   ```sh
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker "$USER" && newgrp docker
   # 1 GB of memory is enough to run the relay, but give image pulls some room.
   sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

   Then follow [Run it with Docker](#run-it-with-docker).

5. **Check the bill.** After a day, check the billing report shows nothing owed. Free-tier terms change; the [free tier page](https://cloud.google.com/free/docs/compute-getting-started) has the current ones.

## Run it at home, through a tunnel

A machine at home that stays on (a home server, a Raspberry Pi, a desktop that never sleeps) can host the relay without opening ports on your router: a tunnel makes an outbound connection to a provider, which gives the relay a public `https://` name and handles TLS. Messages are already end-to-end encrypted, so the tunnel provider sees the same metadata the relay does, and no more.

The whole team depends on that machine being on. While it's off, sends fail (the sending agent is told, and nothing is queued on its side), and no one can read their mailbox.

### Cloudflare Tunnel

Free, and gives the relay a hostname on a domain you have on Cloudflare (adding a domain to Cloudflare's free plan is free; you need to own one).

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels**, create a tunnel, and copy its token.
2. Add a **public hostname** for it, such as `relay.example.com`, with service type `HTTP` and URL `relay:7357`.
3. On the home machine, with Docker:

   ```sh
   mkdir blether-relay && cd blether-relay
   curl -fsSLO https://raw.githubusercontent.com/kvsm/blether/main/deploy/compose.tunnel.yaml
   echo "TUNNEL_TOKEN=<the token>" > .env
   docker compose -f compose.tunnel.yaml up -d
   ```

4. Check `https://relay.example.com/healthz` prints `ok`, then create teams with `--relay wss://relay.example.com`.

Cloudflare closes WebSocket connections that are idle for about 100 seconds; the relay's heartbeat, every 15 seconds by default, keeps them open. Cloudflare's quick tunnels (`cloudflared tunnel --url`) need no account, but their random `trycloudflare.com` name changes every time they start, which strands every team created on it.

### Tailscale Funnel

Free on Tailscale's personal plan, and needs no domain: the relay gets a name like `relay-box.your-tailnet.ts.net`. Install [Tailscale](https://tailscale.com/download) on the home machine, enable [Funnel](https://tailscale.com/kb/1223/funnel) for your tailnet, run the relay listening on `127.0.0.1:7357` (with Docker, `-p 127.0.0.1:7357:7357`, or [without Docker](#without-docker)), then:

```sh
tailscale funnel --bg 7357
```

`tailscale funnel status` shows the public URL; create teams with `--relay wss://<that name>`.

## Configuration

The relay reads its settings from the environment. The image sets the host, port and database for you.

| Variable                            | Default                                      | What it does                                                                                                        |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BLETHER_RELAY_HOST`                | `127.0.0.1` (image: `0.0.0.0`)               | Address to listen on                                                                                                |
| `BLETHER_RELAY_PORT`                | `7357`                                       | Port to listen on                                                                                                   |
| `BLETHER_RELAY_DB`                  | `blether-relay.db` (image: `/data/relay.db`) | The database holding teams, identities and mailboxes                                                                |
| `BLETHER_RELAY_TLS_CERT`            |                                              | Certificate file (PEM), to serve `wss://` without a proxy                                                           |
| `BLETHER_RELAY_TLS_KEY`             |                                              | The certificate's private key (PEM)                                                                                 |
| `BLETHER_RELAY_HEARTBEAT_MS`        | `15000`                                      | How often to check connections are alive; two missed checks drop one                                                |
| `BLETHER_RELAY_STATS_INTERVAL_MS`   | `300000`                                     | How often to print [message statistics](#message-statistics), when there are new messages; `0` for only on shutdown |
| `BLETHER_RELAY_DEBUG_AUDIENCE`      | `0`                                          | `1` for [debug mode](#message-statistics): count role messages and broadcasts too                                   |
| `BLETHER_RELAY_ACCESS`              | `open`                                       | `token`, `entra` or `oidc` to [require a sign-in](#require-a-sign-in)                                               |
| `BLETHER_RELAY_TOKENS_FILE`         |                                              | For `token`: the JSON list of tokens the relay accepts                                                              |
| `BLETHER_RELAY_ENTRA_TENANT`        |                                              | For `entra`: the directory (tenant) id                                                                              |
| `BLETHER_RELAY_ENTRA_API_CLIENT_ID` |                                              | For `entra`: the relay API registration's client id                                                                 |
| `BLETHER_RELAY_ENTRA_CLI_CLIENT_ID` |                                              | For `entra`: the CLI registration's client id                                                                       |
| `BLETHER_RELAY_ENTRA_SCOPE`         | `api://<API client id>/Relay.Access`         | For `entra`: the scope the CLI asks for                                                                             |
| `BLETHER_RELAY_OIDC_ISSUER`         |                                              | For `oidc`: the issuer, exactly as tokens' `iss` gives it                                                           |
| `BLETHER_RELAY_OIDC_AUDIENCE`       |                                              | For `oidc`: the audience (`aud`) access tokens must be for                                                          |
| `BLETHER_RELAY_OIDC_CLIENT_ID`      |                                              | For `oidc`: the public client the CLI signs in as                                                                   |
| `BLETHER_RELAY_OIDC_SCOPES`         | `openid offline_access`                      | For `oidc`: the scopes the CLI asks for, space-separated                                                            |
| `BLETHER_RELAY_OIDC_SUBJECT_CLAIM`  | `sub`                                        | For `oidc`: the claim naming who signed in                                                                          |
| `BLETHER_RELAY_OIDC_CLAIMS`         | `roles`                                      | For `oidc`: comma-separated claims the rules can check                                                              |
| `BLETHER_RELAY_ALLOW_CONNECT`       | `signed-in`                                  | Who may connect once signed in: `signed-in`, or comma-separated `claim=value` pairs                                 |
| `BLETHER_RELAY_ALLOW_TEAM_CREATE`   | `signed-in`                                  | Who may create teams once signed in: `signed-in`, or comma-separated `claim=value` pairs                            |

`GET /healthz` answers `ok` for health checks, and `GET /.well-known/blether-relay` tells clients whether the relay requires a sign-in. Everything else is the WebSocket protocol bridges speak.

### Require a sign-in

By default anyone who can reach the relay can use it: they can't read anyone's messages, but they can create identities and teams. To let in only the people you choose, require a sign-in, in one of three ways:

- **[Tokens](#sign-in-with-tokens)** you issue to each developer. Nothing else to set up.
- **[Microsoft Entra ID](#sign-in-with-microsoft-entra-id)**: developers sign in with their work account.
- **[Another OpenID Connect provider](#sign-in-with-another-openid-connect-provider)**, such as Okta, Auth0 or Keycloak.

A relay uses one of them. Whichever it is, developers run `blether sign-in wss://relay.example.com` (or `blether sign-in <invite>`, before joining), and Blether asks for what that relay needs. A sign-in decides who may use the relay, not who is in a team: Team Admins still invite people to their teams.

A sign-in needs TLS: Blether only sends one over `wss://`, or over `ws://` to the same machine.

#### Sign in with tokens

Issue a token with the relay's `token` command, naming who it's for. Claims are optional, for the [rules](#rules) below:

```sh
docker compose run --rm relay token kev roles=team-creator
```

It prints the token, which you send to that developer privately, and a line to add to the tokens file. The relay keeps only the token's hash. Put the lines in a JSON list in `tokens.json`, beside `compose.yaml`:

```json
[
  { "subject": "kev", "sha256": "…", "claims": { "roles": "team-creator" } },
  { "subject": "ann", "sha256": "…" }
]
```

Then turn sign-in on with a `compose.override.yaml` beside it, which Docker Compose reads along with `compose.yaml`, and restart the relay with `docker compose up -d`:

```yaml
services:
  relay:
    environment:
      BLETHER_RELAY_ACCESS: token
      BLETHER_RELAY_TOKENS_FILE: /tokens.json
    volumes:
      - ./tokens.json:/tokens.json:ro
```

Each developer runs `blether sign-in` and pastes their token. To take someone's access away, remove their line and restart the relay. They stay in their teams' membership until the Team Admin removes them, but can't connect.

#### Sign in with Microsoft Entra ID

Developers sign in with their work account, in their browser. The relay checks each connection's access token from Entra, and Entra decides who can get one. You need two app registrations in your tenant, which someone with the Application Administrator role (or Cloud Application Administrator) can create:

- **Blether relay**: the API the access tokens are for. It defines the `Relay.Access` scope, and any app roles you want rules to check.
- **Blether CLI**: the public client that `blether sign-in` signs in as, with no secret.

(If your tenant makes a second registration hard to get, one registration can be both: do every step below on the same registration, and use its client id for both settings. Two keeps the relay's API separate from the app developers sign in with, and is what Microsoft recommends.)

**1. Register the relay's API.** In the [Entra admin center](https://entra.microsoft.com), go to **App registrations → New registration**:

1. Name it `Blether relay`, choose **Accounts in this organizational directory only**, and leave the redirect URI empty. Register it.
2. Note its **Application (client) ID** and **Directory (tenant) ID** from the overview.
3. Under **Expose an API**, set the **Application ID URI** to the default it offers, `api://<its client id>`. Then **Add a scope**: name it `Relay.Access`, let **Admins and users** consent (or admins only, if you'll grant consent for everyone), and give it a display name such as "Use the Blether relay".
4. Under **Manifest**, set `requestedAccessTokenVersion` (inside `api`) to `2`, and save. (In the older manifest format, it's `accessTokenAcceptedVersion`, at the top.) The relay only accepts version 2 access tokens; without this, Entra issues version 1 tokens, and every sign-in is refused.
5. Optionally, under **App roles**, create roles for the [rules](#rules) to check, for **Users/Groups**: say `Relay.User` to connect at all, and `Relay.TeamCreator` to create teams. Assign them to people or groups in **Enterprise applications → Blether relay → Users and groups**. Creating teams needs a connection too, so give team creators both roles.

**2. Register the CLI.** Back in **App registrations → New registration**:

1. Name it `Blether CLI`, choose **Accounts in this organizational directory only**, and under **Redirect URI** choose **Public client/native (mobile & desktop)** with `http://localhost`. Register it. (Entra lets the CLI come back on any port of `http://localhost`.)
2. Note its **Application (client) ID**.
3. Under **Authentication**, set **Allow public client flows** to **Yes**. That's needed for `blether sign-in --device-code`.
4. Under **API permissions**, **Add a permission → APIs my organization uses → Blether relay**, tick `Relay.Access` (delegated), and add it. Add **Microsoft Graph → Delegated → `offline_access`** too: it lets Blether renew the sign-in, and gives no access to anyone's data. Then **Grant admin consent** for both, so developers aren't each asked to consent, or stopped where users can't.

**3. Turn it on.** In `compose.override.yaml`, beside `compose.yaml`, then restart the relay with `docker compose up -d`:

```yaml
services:
  relay:
    environment:
      BLETHER_RELAY_ACCESS: entra
      BLETHER_RELAY_ENTRA_TENANT: <directory (tenant) id>
      BLETHER_RELAY_ENTRA_API_CLIENT_ID: <Blether relay's client id>
      BLETHER_RELAY_ENTRA_CLI_CLIENT_ID: <Blether CLI's client id>
      # Optional: only people with these app roles.
      BLETHER_RELAY_ALLOW_CONNECT: roles=Relay.User
      BLETHER_RELAY_ALLOW_TEAM_CREATE: roles=Relay.TeamCreator
```

The relay only accepts tokens from your tenant, for the relay's API. It knows each person by their Entra object id (`oid`), which never changes, even if their name or email does. [Rules](#rules) can check `roles`, `tid`, `name` and `preferred_username`.

**What developers do.** `blether sign-in wss://relay.example.com` opens their browser at Microsoft's sign-in page, with your tenant's usual sign-in, MFA and Conditional Access. Where there's no browser on the machine (over SSH, say), `blether sign-in --device-code wss://relay.example.com` gives them a code to enter in a browser anywhere. Some tenants block sign-in with a device code with Conditional Access; then they'll need the browser.

After that, Blether renews the sign-in by itself, including on agent sessions that run for days, until Entra stops renewing it. That happens when the person is disabled or deleted, their sessions are revoked, their refresh token expires (after 90 days without use, by default), or Conditional Access asks them to sign in again. Blether then tells them to run `blether sign-in` again.

**Taking access away.** Disable the person in Entra, or remove their app role if you use `BLETHER_RELAY_ALLOW_CONNECT`. Blether can't renew their sign-in after that, so the relay refuses them once the access token they have runs out: Entra's last between 60 and 90 minutes. Revoking their sessions doesn't make that sooner. They stay in their teams' membership until a Team Admin removes them.

**If sign-in fails:**

| What Blether says                                 | Likely cause                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `AADSTS50011` (redirect URI mismatch)             | The CLI registration's redirect URI isn't `http://localhost` under **Public client/native (mobile & desktop)** |
| `AADSTS65001` (consent)                           | Admin consent wasn't granted for `Relay.Access`, and users can't consent themselves                            |
| `AADSTS7000218` or `AADSTS700016`                 | **Allow public client flows** is off, or a client id is wrong                                                  |
| `AADSTS50105` (not assigned)                      | The relay's enterprise application requires assignment, and the person isn't assigned                          |
| The relay refuses a sign-in Entra accepted        | `requestedAccessTokenVersion` isn't `2`, the API client id is wrong, or a rule leaves them out                 |
| `--device-code` is refused, but the browser works | Conditional Access blocks the device code flow                                                                 |

#### Sign in with another OpenID Connect provider

Any provider that issues access tokens as JWTs, signed with a published key (RS256, ES256, EdDSA and the like), works the same way. In it, set up:

- **An API (resource server)** for the relay, so access tokens name it in their `aud` claim. Some providers issue unreadable access tokens unless there is one: Okta needs an authorization server, Auth0 an API.
- **A public client** (no secret) for the CLI, with the authorization code flow and PKCE, and a loopback redirect URI, `http://localhost`, on any port. Allow the device authorization grant too, for `--device-code`, and refresh tokens (usually the `offline_access` scope).

Then:

```yaml
services:
  relay:
    environment:
      BLETHER_RELAY_ACCESS: oidc
      BLETHER_RELAY_OIDC_ISSUER: https://id.example.com/
      BLETHER_RELAY_OIDC_AUDIENCE: <the API's audience>
      BLETHER_RELAY_OIDC_CLIENT_ID: <the CLI's client id>
      BLETHER_RELAY_OIDC_SCOPES: openid offline_access relay
```

The issuer must be exactly what tokens give as `iss`, trailing slash and all. The relay finds the provider's signing keys from its discovery document (`/.well-known/openid-configuration` under the issuer), and picks up new ones when the provider rotates them. It knows people by the `sub` claim, unless `BLETHER_RELAY_OIDC_SUBJECT_CLAIM` names another, and [rules](#rules) can check `roles`, or the claims `BLETHER_RELAY_OIDC_CLAIMS` lists.

#### Rules

Rules decide what a signed-in developer may do. For example, to let anyone signed in connect, but only those with the `team-creator` role create teams:

```yaml
BLETHER_RELAY_ALLOW_TEAM_CREATE: roles=team-creator
```

A claim matches if it equals the value, or is a list that includes it. Several comma-separated `claim=value` pairs allow anyone matching any of them.

### Message statistics

Every five minutes, if messages have arrived since it last said, the relay prints counts since it started, and again when it shuts down (`docker compose logs relay` shows them):

```text
Messages since 2026-10-02T09:00:00.000Z: 6 stored (2 new)
  backend (3_Vm0-wq): 6 stored, by recipient: api 2, docs 2, ui 2
```

Counts are per copy: a message to a role or to everyone is stored once for each recipient. Team names needn't be unique on a relay, so each team is shown with the start of its id.

The relay can't tell a role message or a broadcast from several direct messages, since who a message is addressed to is encrypted inside it. **Debug mode** (`--debug-audience`, or `BLETHER_RELAY_DEBUG_AUDIENCE=1`) asks bridges to tell it, and adds a line counting each send once:

```text
    sends (each counted once, from bridges' hints): 3: direct 1, role frontend 1, everyone 1
```

It's off by default because it tells the relay more than it otherwise knows. Bridges send the hint only to a relay that asks, and say so on their stderr when it does. The hint is the bridge's word, unchecked, and the relay uses it for these counts and nothing else. Messages from bridges that don't send one (older ones, say) are delivered as usual, and counted as `stored without a hint`.

### TLS without a proxy

Caddy is the easy way to TLS. If you'd rather the relay served `wss://` itself, give it a certificate and key with `BLETHER_RELAY_TLS_CERT` and `BLETHER_RELAY_TLS_KEY`, and renew them yourself; the relay reads them when it starts.

Without either, the relay serves plain `ws://`, which is fine on a developer's own machine and wrong anywhere else. Bridges still encrypt every message end to end, but the connection itself (and who's talking to whom) is in the clear.

## Backups

Everything is in the one database file. A backup taken while the relay runs is consistent:

```sh
docker compose exec relay node /app/dist/bin.js backup /data/backup.db
docker compose cp relay:/data/backup.db "relay-$(date +%F).db"
docker compose exec relay rm /data/backup.db
```

Or stop the relay (`docker compose stop relay`) and copy the volume's files.

What a restore from an older backup loses: messages sent since, and delivery statuses that changed since. Developers' identity logs and teams' membership logs aren't lost for good: the bridges and CLI keep their own copies, and bring the relay up to date when they next connect. A device whose developer revoked it after the backup is refused again once another of their devices connects.

## Upgrades

```sh
docker compose pull && docker compose up -d
```

To stay on one release, set `BLETHER_RELAY_VERSION=<version>` in `.env`. When a release changes the database, the relay migrates it on start-up, first saving a copy beside it as `relay.db.before-schema-<n>`. To go back to the earlier release, stop the relay, put that copy back as `relay.db`, and pin the earlier version.

The relay refuses a database written by a newer release, and one from a development build before releases began (schema 6 or older), which can't be migrated.

## Without Docker

The relay needs Node 24. From a clone:

```sh
pnpm install && pnpm build
BLETHER_RELAY_HOST=0.0.0.0 node packages/relay/dist/bin.js
```

`node packages/relay/dist/bin.js help` lists the commands and settings.
