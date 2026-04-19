# gondor-ws

> _"The beacons! The beacons of Minas Tirith! The beacons are lit — Gondor calls for aid!"_

A **Pusher-protocol-compatible** WebSocket broadcaster that runs on Cloudflare Workers + Durable Objects. **One does not simply pay Pusher fees.**

Because it speaks the Pusher Channels protocol v7, every existing Pusher client — `pusher-js` in the browser, `pusher-php-server` on the backend, the Swift/Android/Flutter SDKs, Laravel Echo, anything that connects to `pusher.com` today — works against this server with only a hostname change.

Idle beacons hibernate (zero billing while unlit), there are no egress fees, and a typical small-to-medium app runs on the Cloudflare free tier or for **$5/month flat**.

> ⚠️ Update the repo URL below to point at your fork before publishing.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/gondor-ws)

---

## The lore

In the films, each beacon on the White Mountains holds a single purpose: watch, and when lit, relay to the next. That's exactly what a Cloudflare Durable Object does here. One `Beacon` per app holds every subscriber, stays dark (hibernates) until an event arrives, then fans the event out to every watcher.

## What you get

- **Pusher protocol v7** — full handshake, subscribe/unsubscribe, ping/pong, error frames
- **Public / private / presence channels** with HMAC-SHA256 signature verification
- **Client events** (`client-*`) relayed between subscribers on private/presence channels
- **Server REST API** — `/events`, `/batch_events`, `/channels`, `/channels/{ch}`, `/channels/{ch}/users` — fully signed and replay-protected
- **Hibernation-safe** — per-socket state in `serializeAttachment`, presence roster in SQLite, nothing pins the isolate. Unlit beacons stop billing duration.
- **Rate limited + size capped** — 10 client events/sec/connection, 10 KiB payloads, 100 channels/socket

## Light the beacon (one-click deploy)

1. Click the button above. Cloudflare forks this repo into your GitHub and sets up a Worker with the default `APP_ID` and `APP_KEY`.
2. Set the shared secret — this is what lets the receiver trust the signal is real:
   ```bash
   # In your local clone:
   npx wrangler secret put APP_SECRET
   # Paste a 32+ char random value. Generate with: openssl rand -hex 32
   ```
3. **(Recommended)** Change `APP_KEY` in `wrangler.jsonc` from `gondor-calls-for-aid` to something non-obvious, then `npx wrangler deploy`.

Until step 2 is done the server returns `503 APP_SECRET is unset` — by design. A freshly-forked beacon will not light without a real secret.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # put a real dev secret inside
npm run dev                      # wrangler dev on http://127.0.0.1:8787
```

## Framework integrations

Because gondor-ws speaks the Pusher wire protocol, it works with any Pusher-compatible client. The common path is:

1. Point your backend's Pusher SDK at `https://<your-worker-host>` (signs REST calls with `APP_SECRET`).
2. Point your browser/app Pusher client at `wss://<your-worker-host>/app/<APP_KEY>`.
3. Your backend signs subscription auth tokens for private/presence channels using the same `APP_SECRET`; the Worker verifies them.

### Setup guides

- [**Laravel** (Echo + pusher-js + Broadcasting)](./docs/setup-laravel.md)
- Node.js (`pusher` package) — PRs welcome
- Ruby on Rails (`pusher` gem) — PRs welcome
- Python (`pusher-http-python`) — PRs welcome
- Go (`pusher-http-go`) — PRs welcome

If you've wired it up to a stack not listed here, please contribute a guide.

## Generic configuration reference

You'll use exactly the same three values in both your backend and frontend:

| Env var | What it is | Where it goes |
|---|---|---|
| `APP_ID` | Public identifier for REST URLs (`/apps/{APP_ID}/events`) | Backend Pusher SDK config |
| `APP_KEY` | Public key sent on WS handshake (`wss://host/app/{APP_KEY}`) | Frontend + backend |
| `APP_SECRET` | **Secret** HMAC key, ≥ 16 chars | Backend only. Never ships to the client. |

And point the Pusher client at the Worker:

```
host:   <your-subdomain>.workers.dev   (or your custom domain)
port:   443
scheme: https
useTLS: true
```

## How session authorization works

The handshake is deliberately public — it only validates `APP_KEY`. Per-user authorization happens at **channel subscribe time**, exactly like Pusher does it:

1. Client connects and is assigned a `socket_id`.
2. Client attempts to subscribe to a private or presence channel.
3. The Pusher client POSTs `{ socket_id, channel_name }` to your backend's signing endpoint.
4. Your backend's auth logic decides whether this user is allowed on this channel.
5. If allowed, the backend signs `HMAC_SHA256("{socket_id}:{channel}", APP_SECRET)` and returns the token.
6. Client sends `pusher:subscribe` with the token to this Worker, which verifies the signature.

The `APP_SECRET` never leaves your backend or the Worker. The `socket_id` binding prevents token replay across connections — one signed token lights one beacon on one socket, not the whole chain.

## Architecture

One `Beacon` per app. Holds every WebSocket for that app, maintains channel subscription indexes in memory, persists the presence roster and per-socket metadata so it can rebuild after hibernation. The Worker entry routes both WS upgrades (`/app/{APP_KEY}`) and the REST API (`/apps/{APP_ID}/...`) to the same beacon.

### Scaling past one beacon

Single-beacon ceiling is ~5,000 concurrent sockets or ~1,000 subscribers on a single broadcast. If you need more, light more beacons: hash the channel name to one of N beacons, route both WS upgrades (by the first channel a socket subscribes to) and REST triggers (by channel) to the matching shard. Nothing crosses shards.

### Hibernation rules this repo follows

- No `setInterval` / `setTimeout` / outgoing WebSockets / alarms
- Per-socket state is in `serializeAttachment` (≤ 2 KB)
- Presence `user_info` (potentially large) is in SQLite, not the attachment
- In-memory Maps are rebuilt in the constructor from `getWebSockets()` + SQL

Unlit beacons evict from memory and stop billing duration. Ping/pong is handled by the runtime and does **not** wake a hibernating beacon.

## Security

| Threat | Mitigation |
|---|---|
| Unauthorized channel access | Backend's signing endpoint + signed subscribe |
| Auth token replay across connections | Signature binds to `socket_id` |
| Signed REST request replay | Rejects `auth_timestamp` older than 10 min |
| Client event DoS / amplification | 10 events/sec/conn, 10 KiB/event caps |
| Large REST trigger amplification | 10 KiB payload cap, 10 events/batch cap |
| Channel name pollution | Pusher-regex validation, 164 char max |
| Unset secret in fresh deploy | Server returns 503 until a real `APP_SECRET` is configured |
| Predictable socket IDs weakening binding | IDs generated via `crypto.getRandomValues()` |

## What's not implemented

- Encrypted channels (`private-encrypted-*`)
- Webhooks back to your app (channel_occupied, member_added, etc.)
- Cache channels (last-message replay)
- Per-user terminate-connections endpoint
- Multi-tenant (multiple `APP_KEY`s on one Worker) — deliberately single-tenant

None of these block everyday real-time use. PRs welcome. _And Rohan will answer._

## License

_Add your license of choice here (MIT, Apache-2.0, etc.)._
