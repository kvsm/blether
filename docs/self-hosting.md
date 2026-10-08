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

| Variable                          | Default                                      | What it does                                                                                                        |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BLETHER_RELAY_HOST`              | `127.0.0.1` (image: `0.0.0.0`)               | Address to listen on                                                                                                |
| `BLETHER_RELAY_PORT`              | `7357`                                       | Port to listen on                                                                                                   |
| `BLETHER_RELAY_DB`                | `blether-relay.db` (image: `/data/relay.db`) | The database holding teams, identities and mailboxes                                                                |
| `BLETHER_RELAY_TLS_CERT`          |                                              | Certificate file (PEM), to serve `wss://` without a proxy                                                           |
| `BLETHER_RELAY_TLS_KEY`           |                                              | The certificate's private key (PEM)                                                                                 |
| `BLETHER_RELAY_HEARTBEAT_MS`      | `15000`                                      | How often to check connections are alive; two missed checks drop one                                                |
| `BLETHER_RELAY_STATS_INTERVAL_MS` | `300000`                                     | How often to print [message statistics](#message-statistics), when there are new messages; `0` for only on shutdown |
| `BLETHER_RELAY_DEBUG_AUDIENCE`    | `0`                                          | `1` for [debug mode](#message-statistics): count role messages and broadcasts too                                   |

`GET /healthz` answers `ok` for health checks; everything else is the WebSocket protocol bridges speak.

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
