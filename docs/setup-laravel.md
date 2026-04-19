# Laravel integration

This document walks through wiring a Laravel app to the `gondor-ws` Worker. The setup is **single-tenant**: one app key, one app secret, one Worker. Every authenticated Laravel user connects with the same public app key; **per-user authorization happens at channel-subscribe time**, not at connection time — exactly like Pusher and Reverb.

## How session authorization actually works

The Pusher protocol (which we speak) deliberately does no user auth on the WebSocket handshake itself. The handshake only checks the public `APP_KEY`. Authorization is done *per channel subscription*, via your Laravel app:

```
Browser                   Laravel                       Worker (DO)
  │                          │                               │
  │  (1) GET /chat page      │                               │
  │◀─────────────────────────│                               │
  │                          │                               │
  │  (2) WS wss://host/app/{APP_KEY}                          │
  │──────────────────────────────────────────────────────────▶│
  │◀─ pusher:connection_established { socket_id } ───────────│
  │                          │                               │
  │  (3) subscribe("private-chat.5")                         │
  │      pusher-js intercepts, POSTs auth challenge          │
  │  POST /broadcasting/auth (cookies attached)              │
  │  body: { socket_id, channel_name: "private-chat.5" }     │
  │─────────────────────────▶│                               │
  │                          │                               │
  │                 (a) Laravel auth middleware runs.        │
  │                     Session cookie → authenticated User. │
  │                 (b) routes/channels.php callback runs.   │
  │                     Checks: can this User join chat.5?   │
  │                 (c) If yes, signs:                       │
  │                     HMAC_SHA256("{socket_id}:private-chat.5", APP_SECRET)
  │                     Returns: { auth: "{APP_KEY}:{sig}" } │
  │◀─────────────────────────│                               │
  │                          │                               │
  │  (4) pusher:subscribe { channel, auth }                   │
  │──────────────────────────────────────────────────────────▶│
  │                          │    Worker verifies sig with APP_SECRET.
  │                          │    Binds to this socket_id only (no replay).
  │◀─ pusher_internal:subscription_succeeded ────────────────│
```

Key points:

- **The `APP_KEY` is public.** It's shipped in your frontend JS bundle. That's fine.
- **The `APP_SECRET` is private.** Only Laravel (which signs) and the Worker (which verifies) ever see it.
- **Laravel authorizes the user** via its normal session/auth middleware. The Worker does not know or care who the user is — it trusts Laravel's signature.
- **`socket_id` binding prevents replay.** A signature issued for socket A cannot be used on socket B.

This is why it's safe to run this as single-tenant with a shared key: the secret is what protects access, and the secret never leaves your servers.

## 1. Install packages

Laravel-side:

```bash
composer require pusher/pusher-php-server
```

Frontend:

```bash
npm install --save-dev laravel-echo pusher-js
```

## 2. `.env`

```dotenv
BROADCAST_CONNECTION=pusher

# These three MUST match the Worker's APP_ID, APP_KEY, APP_SECRET.
PUSHER_APP_ID=gondor-app
PUSHER_APP_KEY=gondor-calls-for-aid
PUSHER_APP_SECRET=<your-real-secret-here>

# Point Pusher PHP SDK + Echo at the Worker.
# In local dev this is usually 127.0.0.1 + wrangler dev's port.
# In production this is your Worker's custom domain (or *.workers.dev).
PUSHER_HOST=gondor-ws.yourdomain.com
PUSHER_PORT=443
PUSHER_SCHEME=https

# Frontend (Vite)
VITE_PUSHER_APP_KEY="${PUSHER_APP_KEY}"
VITE_PUSHER_HOST="${PUSHER_HOST}"
VITE_PUSHER_PORT="${PUSHER_PORT}"
VITE_PUSHER_SCHEME="${PUSHER_SCHEME}"
```

## 3. `config/broadcasting.php`

Nothing unusual — this is Laravel's standard Pusher driver config, with `host`/`port`/`scheme` options pointing at the Worker instead of `pusher.com`:

```php
'connections' => [
    'pusher' => [
        'driver' => 'pusher',
        'key'    => env('PUSHER_APP_KEY'),
        'secret' => env('PUSHER_APP_SECRET'),
        'app_id' => env('PUSHER_APP_ID'),
        'options' => [
            'host'    => env('PUSHER_HOST'),
            'port'    => env('PUSHER_PORT', 443),
            'scheme'  => env('PUSHER_SCHEME', 'https'),
            'useTLS'  => env('PUSHER_SCHEME', 'https') === 'https',
            'encrypted' => true,
        ],
    ],
],
```

## 4. Frontend Echo bootstrap

`resources/js/echo.js` (or wherever you bootstrap Echo):

```js
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';

window.Pusher = Pusher;

window.Echo = new Echo({
    broadcaster: 'pusher',
    key: import.meta.env.VITE_PUSHER_APP_KEY,
    wsHost: import.meta.env.VITE_PUSHER_HOST,
    wsPort: Number(import.meta.env.VITE_PUSHER_PORT),
    wssPort: Number(import.meta.env.VITE_PUSHER_PORT),
    forceTLS: import.meta.env.VITE_PUSHER_SCHEME === 'https',
    enabledTransports: ['ws', 'wss'],
    disableStats: true,
    // Optional: Laravel's built-in auth endpoint. This is the default; shown
    // here so you know what it is.
    authEndpoint: '/broadcasting/auth',
});
```

## 5. Enable the auth endpoint

In `routes/web.php` or a service provider, make sure the broadcasting auth route is registered. Laravel does this for you if you uncomment `App\Providers\BroadcastServiceProvider` in `config/app.php` (Laravel ≤10) or call `Broadcast::routes()` (Laravel 11+):

```php
// app/Providers/AppServiceProvider.php (Laravel 11+)
public function boot(): void
{
    Broadcast::routes(['middleware' => ['web', 'auth']]);
    require base_path('routes/channels.php');
}
```

The `auth` middleware is the critical line — it ensures `/broadcasting/auth` requires a logged-in user.

## 6. Defining who can subscribe to what

`routes/channels.php` is where authorization rules live. The Worker never sees any of this — it just trusts the resulting HMAC signature.

```php
use App\Models\User;
use Illuminate\Support\Facades\Broadcast;

// Private channel: return true/false.
Broadcast::channel('chat.{chatId}', function (User $user, int $chatId) {
    return $user->chats()->where('chats.id', $chatId)->exists();
});

// Presence channel: return the "user info" payload (shown to other members),
// or null to deny.
Broadcast::channel('room.{roomId}', function (User $user, int $roomId) {
    if (! $user->canJoinRoom($roomId)) {
        return null;
    }
    return [
        'id'   => $user->id,
        'name' => $user->name,
        'avatar' => $user->avatar_url,
    ];
});
```

These callbacks run inside `/broadcasting/auth` after Laravel's auth middleware. If they return truthy, Laravel signs and returns the auth token. If they throw or return falsy, the client gets a 403 and never reaches the Worker.

## 7. Broadcasting events from Laravel

Same as stock Pusher/Reverb. Create a broadcast event:

```bash
php artisan make:event MessageSent
```

```php
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;

class MessageSent implements ShouldBroadcast
{
    public function __construct(public Message $message) {}

    public function broadcastOn(): array
    {
        return [new PrivateChannel("chat.{$this->message->chat_id}")];
    }

    public function broadcastAs(): string
    {
        return 'MessageSent';
    }

    public function broadcastWith(): array
    {
        return [
            'id' => $this->message->id,
            'body' => $this->message->body,
            'user_id' => $this->message->user_id,
            'sent_at' => $this->message->created_at->toIso8601String(),
        ];
    }
}
```

Fire it anywhere:

```php
MessageSent::dispatch($message);            // normal
broadcast(new MessageSent($message))->toOthers();  // skip the sender's socket
```

Laravel's Pusher PHP SDK POSTs to `/apps/{APP_ID}/events` on the Worker with a full HMAC signature — which the Worker verifies against `APP_SECRET` before fanning out. No extra glue required.

## 8. Listening on the client

### Public channel

```js
window.Echo.channel('announcements')
    .listen('.AnnouncementPosted', (e) => {
        console.log('new announcement', e);
    });
```

### Private channel

```js
window.Echo.private(`chat.${chatId}`)
    .listen('.MessageSent', (e) => {
        console.log(e);
    });
```

> Leading dot in `.MessageSent` tells Echo to match on the exact name returned by `broadcastAs()`. Without the dot, Echo expects `App\Events\MessageSent` (the FQCN).

### Presence channel

```js
window.Echo.join(`room.${roomId}`)
    .here((users) => { /* initial roster */ })
    .joining((user) => { /* someone joined */ })
    .leaving((user) => { /* someone left */ })
    .listen('.SomeEvent', (e) => { /* ... */ });
```

### Client events (browser-to-browser, no server round-trip)

```js
// Sender:
const channel = window.Echo.private(`chat.${chatId}`);
channel.whisper('typing', { user: 'Mitch' });

// Receivers:
channel.listenForWhisper('typing', (e) => {
    console.log(`${e.user} is typing…`);
});
```

Client events are only allowed on private/presence channels, capped at 10/sec per connection and 10 KiB per payload.

## 9. Local development

Two terminals:

```bash
# Terminal 1 — Worker
cd gondor-ws
wrangler dev            # starts on http://127.0.0.1:8787
```

Set a real dev secret via `.dev.vars` in the `broadcast` directory:

```dotenv
# broadcast/.dev.vars (gitignored)
APP_SECRET=dev-secret-at-least-sixteen-chars
```

```bash
# Terminal 2 — Laravel
cd my-laravel-app
php artisan serve       # or Herd / Sail / etc.
```

Laravel `.env` during local dev:

```dotenv
PUSHER_APP_SECRET=dev-secret-at-least-sixteen-chars
PUSHER_HOST=127.0.0.1
PUSHER_PORT=8787
PUSHER_SCHEME=http

VITE_PUSHER_HOST=127.0.0.1
VITE_PUSHER_PORT=8787
VITE_PUSHER_SCHEME=http
```

`PUSHER_SCHEME=http` is fine for local; `pusher-js` will use `ws://` instead of `wss://`.

## 10. Deploying to production

```bash
cd gondor-ws
wrangler secret put APP_SECRET    # generate a strong random 32+ char value
wrangler deploy
```

Hook up a custom domain (recommended — `*.workers.dev` can be blocked by corporate/ad blockers):

1. Cloudflare dashboard → your zone → Workers Routes → add `gondor-ws.yourdomain.com/*` → route to the `gondor-ws` Worker.
2. Update Laravel `.env`:
   ```dotenv
   PUSHER_HOST=gondor-ws.yourdomain.com
   PUSHER_PORT=443
   PUSHER_SCHEME=https
   VITE_PUSHER_HOST=gondor-ws.yourdomain.com
   VITE_PUSHER_PORT=443
   VITE_PUSHER_SCHEME=https
   ```
3. Rebuild frontend: `npm run build`.

## 11. Rotating the app secret

1. `wrangler secret put APP_SECRET` → new value.
2. Immediately update Laravel's `PUSHER_APP_SECRET` env var and restart app workers.
3. Existing WebSocket connections stay up (the secret is only used for *new* subscriptions and REST triggers); any in-flight subscribe with an old-secret signature will be rejected.

Plan a tiny window of dropped-then-reconnected sessions during rotation. Echo will auto-reconnect and re-auth.

## 12. Security model recap

| Threat | Mitigation |
|---|---|
| Anyone connecting to your Worker | They can — the handshake is public, like Pusher. They can't read anything sensitive without a signed subscribe. |
| Cross-user channel access | Laravel's `routes/channels.php` callback runs per subscribe; only logged-in users pass. |
| Leaked auth token replay | Signature binds to `socket_id`; one token = one connection. |
| Leaked REST signature replay | Server rejects any request with `auth_timestamp` older than 10 minutes. |
| Client event DoS | 10/sec/connection, 10 KiB/event caps enforced in the Worker. |
| REST trigger amplification | Same 10 KiB payload cap as Pusher. |
| `APP_SECRET` leak | Stored as a Cloudflare secret (encrypted at rest, not in `wrangler.jsonc`). Rotate any time. |

## 13. Troubleshooting

**Browser shows "Pusher connection failed" / 401 on WebSocket.**
The `APP_KEY` in your frontend build doesn't match the Worker's `APP_KEY`. Rebuild with the right `VITE_PUSHER_APP_KEY`.

**Browser connects, but subscribe to a private channel fails silently.**
Open the browser's network tab; look at the `/broadcasting/auth` request.
- 401 → user isn't logged in (check Laravel auth middleware).
- 403 → channel callback returned false (check `routes/channels.php`).
- 200 but subscription still fails → secrets out of sync. The Worker's `APP_SECRET` and Laravel's `PUSHER_APP_SECRET` must match exactly.

**`MessageSent` event fires in Laravel but nothing arrives in the browser.**
Run `wrangler tail` while triggering. You should see a POST to `/apps/gondor-app/events`. If it returns 401, Laravel's `PUSHER_APP_SECRET` is wrong. If it returns 200 but no clients receive it, they aren't subscribed yet or the channel name doesn't match exactly (`private-chat.5` ≠ `chat.5`).

**Server returns 503 "APP_SECRET is unset or using the default placeholder".**
You haven't run `wrangler secret put APP_SECRET` yet (prod) or haven't set it in `.dev.vars` (local). This is by design — the server refuses to run without a real secret.

**Presence shows duplicate users / members never leave.**
This is a real bug if you see it. The Worker emits `member_added` on first socket and `member_removed` on last socket for a given `user_id`, across all connections of that user on the same channel. If you see stale members, it usually means the client died without a graceful close and we're waiting on the TCP timeout — CF will clean it up, but it can take a minute.

**How do I know how many connections are live?**

```bash
# Signed REST call — use Laravel's Pusher PHP SDK since it handles signing:
php artisan tinker
>>> app(\Pusher\Pusher::class)->get('/channels', ['info' => 'subscription_count,user_count']);
```

## 14. What's not implemented

- Encrypted channels (`private-encrypted-*`)
- Webhooks back to your Laravel app (channel_occupied, member_added, etc.)
- Cache channels (last-message replay)
- Per-user terminate-connections endpoint
- Multi-tenant (multiple `APP_KEY`s on one Worker)

None of these block everyday Laravel real-time use. Open an issue / ask to have any added.
