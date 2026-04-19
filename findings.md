# Replacing Pusher / Laravel Reverb with Cloudflare Workers + Durable Objects (2026)

**TL;DR:** Yes, it's technically viable and in many cases **dramatically cheaper** than Pusher or a self-hosted Reverb VPS — *if* your traffic pattern is bursty/idle-heavy (hibernation is the whole game). You are **not** running "an infinite worker"; you're running a fleet of stateful actor-like objects (Durable Objects, DOs) that hold the WebSocket connections and hibernate when idle. The catch is that CF doesn't ship a Pusher-protocol server — you either (a) implement the Pusher protocol yourself on top of DOs, (b) use Soketi's experimental Cloudflare Workers build, (c) use PartyKit/PartyServer (now Cloudflare-owned) with its own protocol and rewrite your Laravel Echo usage to plain WebSockets, or (d) ditch the Pusher protocol entirely.

---

## 1. The primitive you'd actually use

**Durable Objects** = globally-addressable, single-threaded actor instances with built-in storage. One DO per "room" / "channel" is the standard pattern. Each DO can hold many WebSockets; the DO is where broadcast fan-out happens. You don't run "an infinite Worker" — a Worker routes an upgrade request to a DO, and the DO owns the socket state.

**WebSocket Hibernation API** (the thing that makes this cheap): instead of keeping a JS isolate pinned in memory per room, the runtime evicts the DO from memory while leaving sockets connected at the CF edge. When a message arrives, CF rehydrates the DO, calls its constructor, fires `webSocketMessage(ws, msg)`, then it goes back to sleep. **No duration billing accrues during hibernation.**

Key mechanics to internalize:
- Ping/pong is handled by the runtime and does **not** wake the DO.
- Anything that pins the DO in memory defeats hibernation: `setTimeout`/`setInterval`, active alarms, outgoing (client) WebSockets, in-flight HTTP fetches.
- In-memory state is **wiped** on hibernation. Persist per-socket state via `ws.serializeAttachment(value)` (max 2 KB, structured-clone compatible). For bigger state use SQLite storage and keep only a key in the attachment.
- On wake, you have to rebuild in-memory indexes from `this.ctx.getWebSockets()` + each socket's `deserializeAttachment()`. Do this in the constructor.
- `web_socket_auto_reply_to_close` (compat date ≥ 2026-04-07): the runtime now auto-replies to Close frames without waking the DO. This is new and important — means disconnect churn no longer un-hibernates you.

## 2. Limits that actually matter

| Thing | Limit | Notes |
|---|---|---|
| Hibernated WebSockets per DO | **32,768** | Hard ceiling. |
| Practical broadcast fan-out per DO | ~500–1,000 | Community/Cloudflare guidance. Past this you eat CPU burn on every broadcast. |
| WebSocket inbound message size | **32 MiB** | Raised from 1 MiB in Oct 2025. |
| CPU per request (SQLite DO) | 30 s default, up to 5 min | Per tick, not cumulative. |
| Per-DO request throughput (soft) | ~1,000 req/s | Shard rooms if you need more. |
| DO classes per account | 500 (Paid) / 100 (Free) | Instances of each class: unlimited. |
| SQLite storage per DO | 10 GB | |
| Attachment size (per socket) | 2,048 bytes | |

**Implication:** for a Pusher-style fan-out on a single "channel" with > ~1k subscribers, shard the channel across N DOs and have your ingest Worker fan out to all shards. This is the same trick Pusher uses internally.

## 3. Pricing — the honest numbers (Workers Paid, Apr 2026)

Workers Paid plan: **$5/mo minimum** (covers the bundle).

**Requests** (HTTP + RPC + WebSocket messages + alarms):
- Included: 1M/month
- Overage: **$0.15 per million**
- **WebSocket messages bill at 20:1** — 1M incoming WS messages = 50k billable requests. Outgoing and protocol pings are free.

**Duration** (GB-seconds, wall clock while awake or un-hibernatable):
- Included: 400,000 GB-s/month
- Overage: **$12.50 per million GB-s**
- **Zero during hibernation.**

**Storage** (SQLite DOs — billing starts **2026-01-07**):
- 25B reads/mo + $0.001/M rows
- 50M writes/mo + $1.00/M rows
- $0.20/GB-month

**Egress: $0.** There are no bandwidth/egress charges on Workers or DOs. This is the single biggest structural win vs. anything you'd self-host on a hyperscaler.

**Cloudflare's own published example:** 100 DOs × 50 WebSockets each, ~1 msg/client/min, 8 hr/day → **~$0.41/month**. That is not a typo.

## 4. Cost comparison for a realistic workload

**Workload:** 5,000 concurrent users, avg 2 msgs/client/min, 50 "rooms" (DOs) of ~100 users each, 10 hr/day active, hibernated the rest.

- **Pusher Channels:** starts at ~$49/mo for the smallest tier, rapidly climbs; the 5k concurrent / message-heavy tier is $199–$499/mo.
- **Laravel Reverb on a Hetzner VPS (€4.90/mo):** ~$6/mo flat. Cheapest option on paper, but you own uptime, TLS, horizontal scaling (Redis pub/sub), and DDoS mitigation.
- **Laravel Cloud managed Reverb:** bundled into their plans; figure ~$20–$60/mo once you include the app.
- **Cloudflare DO + Hibernation:** realistically **$5–$15/mo** at this scale. Duration is dominated by active windows; message billing is trivial thanks to the 20:1 ratio; egress is free; storage is tiny.

Where CF **wins**: bursty workloads, global latency (DOs route to nearest region by default), many sparsely-used rooms (hibernation zeroes them out).

Where CF **loses**: (a) very chatty, always-on fan-out to thousands of clients on one channel — duration + CPU on broadcast adds up; (b) you want a drop-in Pusher replacement with zero code changes; (c) you need Pusher's language SDKs (Swift, Java, .NET) and are unwilling to write a thin protocol adapter.

## 5. Options for the Laravel side

You have four real paths. Pick based on how much protocol work you want to own.

### Option A — Soketi Serverless (Pusher-compatible, runs on CF Workers + DOs)
- Soketi is the mature open-source Pusher-protocol server. The "serverless" build deploys to Workers and uses DOs + KV for state.
- **Pros:** Laravel Echo + `pusher-js` work unchanged. Broadcast driver stays `pusher`. Private + presence channels work. Webhooks work.
- **Cons:** The serverless variant has historically lagged the main Soketi tree and not every edge case is covered. Health status as of early 2026: actively maintained but "use at your own risk" for high-scale production. You're trusting a smallish OSS project.
- **Verdict:** Best path if you want to keep your existing Laravel broadcasting code intact.

### Option B — PartyKit / PartyServer (Cloudflare-owned, first-party)
- PartyKit was acquired by Cloudflare; PartyServer is the canonical CF-blessed library for "one DO per room" with sugar over hibernation, pub/sub, and Yjs support.
- **Pros:** First-party, well-maintained, strong ergonomics, good fit for what you described.
- **Cons:** Not Pusher-protocol. You'd rewrite the client side (drop `pusher-js` / Echo's Pusher driver) and write a broadcast adapter in Laravel that POSTs to a PartyServer HTTP endpoint instead of Pusher's `/events`. Realistically 1–2 days of protocol work.
- **Verdict:** Best path if you're willing to leave the Pusher protocol behind. Fewer moving parts long-term.

### Option C — Roll your own Pusher-protocol server on DOs
- A few hundred lines: one DO class per channel, handle `pusher:subscribe` / `pusher:unsubscribe` / `client-*` events, implement the HMAC signature for private/presence auth, build the `/apps/{id}/events` HTTP endpoint for Laravel to POST to.
- **Pros:** Full control, Echo keeps working, no third-party dependency.
- **Cons:** Protocol corners (encrypted channels, cache channels, user auth, webhook signing) are annoying to get right. You now own a protocol implementation.
- **Verdict:** Worth it only if Soketi's CF build doesn't fit and you've already decided you're committed to the Pusher protocol.

### Option D — Ditch the Pusher protocol
- Use plain WebSockets to DOs. Replace Echo + `pusher-js` with a small client. Trigger broadcasts from Laravel by POSTing to a Worker route that forwards to the right DO via `DurableObjectNamespace::getByName`.
- **Pros:** Simplest mental model, least code, best fit for CF's primitives.
- **Cons:** You lose Echo's channel abstractions and any Pusher SDK you have in mobile apps.

## 6. What's uncomfortable about this migration

- **In-memory state loss on hibernation is a footgun.** Every "map of userId → socket" has to be rebuildable from `getWebSockets()` + attachments. Thomas Gauvin's writeup of sockets "disconnecting after 10 seconds" is actually hibernation wiping his room index — a very common first-attempt bug.
- **Outgoing WebSockets don't hibernate.** If your DO also connects out (e.g. to a backend event bus), you break hibernation for that DO. Use HTTP/RPC instead.
- **Anything pinning the isolate kills the economics.** `setInterval` for heartbeats, long-lived timers, watching for external signals — all defeat the $0 idle cost. Model everything as request-driven.
- **Sharding channels is your problem, not Cloudflare's.** The Pusher server handled this for you. Past ~1k subscribers on a single channel you need your own shard key and fan-out.
- **SQLite storage billing just turned on (Jan 7, 2026).** If your workload has chat history / message replay, that's now a line item. Still cheap ($0.20/GB-month) but no longer free.
- **Observability is weaker than a VPS.** Workers Logs + Tail help but there's no "ps" equivalent. Operational debugging looks different.

## 7. Recommended architecture (if you go this route)

```
Laravel backend
      │  (HTTP POST to trigger events, signed)
      ▼
Cloudflare Worker (ingest / routing)
      │  (env.CHANNELS.getByName(channelId).fetch(...))
      ▼
ChannelDO (one per channel, sharded if > ~1k subs)
   ├── WebSocket Hibernation API
   ├── this.ctx.getWebSockets() for broadcast
   ├── SQLite for presence roster + recent message cache
   └── serializeAttachment for per-socket { userId, joinedAt }
      ▲
      │  WebSocket
      ▼
Browser (pusher-js via Soketi, or plain WS via custom client)
```

- One Worker script handles both the HTTP ingest (Laravel → events) and the WS upgrade (client → DO).
- One DO class per "channel type" (public, private, presence) is cleaner than one mega-class.
- For broadcast > 1k subs: shard. Channel `room-42` becomes `room-42-shard-0` ... `room-42-shard-N`; ingest fans out to all shards; clients hash onto one shard.
- For presence: keep the roster in SQLite, not memory. Send deltas on join/leave, full snapshot on (re)subscribe.
- For mobile/offline replay: keep last N messages in SQLite per channel and stream them on reconnect.

## 8. Decision matrix

| If you want... | Pick |
|---|---|
| Cheapest at low scale, willing to run a box | **Reverb on a Hetzner VPS** |
| Drop-in Pusher replacement, keep all Echo code, go serverless | **Soketi Serverless on CF** (Option A) |
| Cloudflare-native, long-term path, willing to replace the client lib | **PartyServer** (Option B) |
| Existing Pusher SDKs in mobile apps, committed to protocol, don't trust Soketi's CF build | **Roll your own on DOs** (Option C) |
| Greenfield, no legacy protocol to preserve | **Plain WS on DOs** (Option D) |
| Message-heavy always-on fan-out to one huge channel | Honestly, **stay on Pusher/Ably** or **Reverb + Redis cluster** |

## 9. Bottom line for your case

You said "I could pretty much run an infinite worker using Durable Objects." That framing is close enough to be useful but slightly off: the pitch isn't "infinite worker," it's "the DO is only billed while something is actually happening, and idle sockets cost zero." For a Laravel app that mostly broadcasts occasional events to small rooms, **CF Workers + DOs with Hibernation will be materially cheaper than Pusher and competitive with a self-hosted Reverb VPS, without the ops burden of the VPS.**

The real question isn't "is it technically possible" (yes) — it's "which of the four Laravel-integration paths do you want to own?" If you want to keep Echo + `pusher-js` intact, evaluate **Soketi Serverless on CF** first and fall back to rolling your own protocol implementation if it doesn't hold up. If you're open to a rewrite, **PartyServer** is the cleanest long-term bet.

---

## Sources

- [Cloudflare Durable Objects — WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Objects — Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Durable Objects — Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare Durable Objects — Release notes](https://developers.cloudflare.com/durable-objects/release-notes/)
- [Cloudflare Durable Objects — WebSocket Hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [Thomas Gauvin — Debugging WebSocket Hibernation (practical gotchas)](https://thomasgauvin.com/writing/how-cloudflare-durable-objects-websocket-hibernation-works/)
- [Ably — Cloudflare Durable Objects vs Pusher (2026)](https://ably.com/compare/cloudflare-durable-objects-vs-pusher)
- [Soketi — Next-gen Pusher-compatible WebSockets server](https://github.com/soketi/soketi)
- [Soketi — Cloudflare Workers Support discussions](https://github.com/soketi/soketi/discussions/categories/cloudflare-workers-support)
- [PartyKit / PartyServer — repo](https://github.com/cloudflare/partykit)
- [Cloudflare acquires PartyKit](https://blog.cloudflare.com/cloudflare-acquires-partykit/)
- [Laravel Reverb](https://reverb.laravel.com/)
- [Laravel Broadcasting docs (13.x)](https://laravel.com/docs/13.x/broadcasting)
- [Pusher Channels Protocol reference](https://pusher.com/docs/channels/library_auth_reference/pusher-websockets-protocol/)
- [Laravel Reverb — Say Goodbye to Pusher Fees (cost framing)](https://medium.com/@s.h.siddiqui5830/laravel-reverb-say-goodbye-to-pusher-fees-09b14dd06d0a)
- [Community — Durable Object max WebSocket connections (~32,768)](https://community.cloudflare.com/t/durable-object-max-websocket-connections/303138)
