import {
  ACTIVITY_TIMEOUT_SECONDS,
  MAX_CHANNELS_PER_SOCKET,
  MAX_CLIENT_EVENTS_PER_SEC,
  MAX_EVENT_DATA_BYTES,
  errorFrame,
  frame,
  generateSocketId,
  isClientEvent,
  isPresenceChannel,
  isPrivateChannel,
  isValidChannelName,
  parseFrame,
} from "./protocol";
import { verifyChannelAuth, verifyRestSignature } from "./auth";
import type { AppConfig, Env, PresenceMember, SocketAttachment } from "./types";

/**
 * A Beacon holds every WebSocket for a single app and fans out broadcasts
 * locally — one beacon, lit when events arrive, relaying to every watcher
 * (subscriber). Mirrors how Laravel Reverb works in its default
 * single-process mode. Shard across multiple beacons later by hashing the
 * channel name if you outgrow ~5k concurrent sockets.
 *
 * Hibernation model
 * -----------------
 * In-memory state (Maps below) is rebuilt on wake from:
 *   1. `this.ctx.getWebSockets()` — live socket handles
 *   2. `ws.deserializeAttachment()` — per-socket channel list + presence user_id
 *   3. SQLite — full presence user_info (too big for the 2KB attachment cap)
 *
 * Nothing pins the isolate in memory — no setInterval, no outgoing sockets,
 * no alarms. Unlit beacons hibernate and stop billing duration.
 */
export class Beacon {
  private ctx: DurableObjectState;
  private env: Env;
  private app: AppConfig;

  private sockets = new Map<string, WebSocket>();
  private channelSubs = new Map<string, Set<string>>();
  private presenceRoster = new Map<string, Map<string, PresenceMember>>();

  // Per-socket rate limiter for client-* events. Ephemeral; reset on wake.
  // Hibernation implies a pause in activity, so resetting is acceptable.
  private clientEventRate = new Map<string, { windowStart: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.app = { id: env.APP_ID, key: env.APP_KEY, secret: env.APP_SECRET };

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence_members (
        channel    TEXT NOT NULL,
        socket_id  TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        user_info  TEXT,
        PRIMARY KEY (channel, socket_id)
      )
    `);

    this.rehydrate();
  }

  // ---------------------------------------------------------------- rehydrate

  private rehydrate(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att) continue;
      this.sockets.set(att.socketId, ws);
      for (const ch of att.channels) {
        let set = this.channelSubs.get(ch);
        if (!set) { set = new Set(); this.channelSubs.set(ch, set); }
        set.add(att.socketId);
      }
    }

    const rows = this.ctx.storage.sql
      .exec<{ channel: string; socket_id: string; user_id: string; user_info: string | null }>(
        "SELECT channel, socket_id, user_id, user_info FROM presence_members",
      )
      .toArray();
    for (const r of rows) {
      let roster = this.presenceRoster.get(r.channel);
      if (!roster) { roster = new Map(); this.presenceRoster.set(r.channel, roster); }
      roster.set(r.socket_id, {
        user_id: r.user_id,
        user_info: r.user_info ? JSON.parse(r.user_info) : null,
      });
    }
  }

  // --------------------------------------------------------------------- HTTP

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.headers.get("Upgrade") === "websocket") {
      return this.handleUpgrade(req, url);
    }

    if (path.startsWith(`/apps/${this.app.id}/`)) {
      return this.handleRest(req, url, path);
    }

    return new Response("not found", { status: 404 });
  }

  private async handleUpgrade(req: Request, url: URL): Promise<Response> {
    const key = url.pathname.split("/").pop() ?? "";
    if (key !== this.app.key) {
      return new Response("invalid app key", { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const socketId = generateSocketId();
    const attachment: SocketAttachment = { socketId, channels: [], presenceUserIds: {} };
    server.serializeAttachment(attachment);

    this.ctx.acceptWebSocket(server);
    this.sockets.set(socketId, server);

    server.send(frame("pusher:connection_established", {
      socket_id: socketId,
      activity_timeout: ACTIVITY_TIMEOUT_SECONDS,
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleRest(req: Request, url: URL, path: string): Promise<Response> {
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    const ok = await verifyRestSignature(req.method, path, url.searchParams, body, this.app.secret);
    if (!ok) return new Response("invalid signature", { status: 401 });

    const base = `/apps/${this.app.id}`;

    if (path === `${base}/events` && req.method === "POST") {
      return this.restTriggerEvent(body);
    }
    if (path === `${base}/batch_events` && req.method === "POST") {
      return this.restBatchEvents(body);
    }
    if (path === `${base}/channels` && req.method === "GET") {
      return this.restListChannels(url.searchParams);
    }
    const channelMatch = path.match(new RegExp(`^${base}/channels/([^/]+)$`));
    if (channelMatch && req.method === "GET") {
      return this.restChannelInfo(decodeURIComponent(channelMatch[1]), url.searchParams);
    }
    const usersMatch = path.match(new RegExp(`^${base}/channels/([^/]+)/users$`));
    if (usersMatch && req.method === "GET") {
      return this.restChannelUsers(decodeURIComponent(usersMatch[1]));
    }

    return new Response("not found", { status: 404 });
  }

  private restTriggerEvent(body: string): Response {
    let payload: { name?: string; data?: unknown; channel?: string; channels?: string[]; socket_id?: string };
    try { payload = JSON.parse(body); } catch { return new Response("invalid json", { status: 400 }); }
    if (!payload.name || payload.data === undefined) {
      return new Response("missing name/data", { status: 400 });
    }
    const channels = payload.channels ?? (payload.channel ? [payload.channel] : []);
    for (const ch of channels) {
      if (!isValidChannelName(ch)) return new Response("invalid channel name", { status: 400 });
    }
    const dataStr = typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data);
    if (Buffer.byteLength(dataStr, "utf8") > MAX_EVENT_DATA_BYTES) {
      return new Response("payload too large", { status: 413 });
    }
    for (const channel of channels) {
      this.broadcast(channel, payload.name, dataStr, payload.socket_id);
    }
    return Response.json({});
  }

  private restBatchEvents(body: string): Response {
    let payload: { batch?: Array<{ name: string; channel: string; data: unknown; socket_id?: string }> };
    try { payload = JSON.parse(body); } catch { return new Response("invalid json", { status: 400 }); }
    if (!Array.isArray(payload.batch)) return new Response("missing batch", { status: 400 });
    if (payload.batch.length > 10) return new Response("batch too large", { status: 413 });
    for (const evt of payload.batch) {
      if (!evt || !evt.name || !evt.channel || evt.data === undefined) {
        return new Response("invalid batch entry", { status: 400 });
      }
      if (!isValidChannelName(evt.channel)) return new Response("invalid channel name", { status: 400 });
      const dataStr = typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data);
      if (Buffer.byteLength(dataStr, "utf8") > MAX_EVENT_DATA_BYTES) {
        return new Response("payload too large", { status: 413 });
      }
    }
    for (const evt of payload.batch) {
      const dataStr = typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data);
      this.broadcast(evt.channel, evt.name, dataStr, evt.socket_id);
    }
    return Response.json({});
  }

  private restListChannels(q: URLSearchParams): Response {
    const filter = q.get("filter_by_prefix") ?? "";
    const info = q.get("info") ?? "";
    const wantUserCount = info.includes("user_count");
    const channels: Record<string, Record<string, number>> = {};
    for (const [ch, subs] of this.channelSubs) {
      if (filter && !ch.startsWith(filter)) continue;
      if (subs.size === 0) continue;
      const entry: Record<string, number> = {};
      if (wantUserCount && isPresenceChannel(ch)) {
        entry.user_count = this.presenceRoster.get(ch)?.size ?? 0;
      }
      channels[ch] = entry;
    }
    return Response.json({ channels });
  }

  private restChannelInfo(channel: string, q: URLSearchParams): Response {
    if (!isValidChannelName(channel)) return new Response("invalid channel name", { status: 400 });
    const info = (q.get("info") ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const subs = this.channelSubs.get(channel);
    const occupied = !!(subs && subs.size > 0);
    const out: Record<string, unknown> = { occupied };
    if (info.includes("subscription_count")) out.subscription_count = subs?.size ?? 0;
    if (info.includes("user_count") && isPresenceChannel(channel)) {
      out.user_count = this.presenceRoster.get(channel)?.size ?? 0;
    }
    return Response.json(out);
  }

  private restChannelUsers(channel: string): Response {
    if (!isValidChannelName(channel)) return new Response("invalid channel name", { status: 400 });
    if (!isPresenceChannel(channel)) return new Response("not a presence channel", { status: 400 });
    const roster = this.presenceRoster.get(channel);
    const seen = new Set<string>();
    const users: Array<{ id: string }> = [];
    if (roster) {
      for (const m of roster.values()) {
        if (seen.has(m.user_id)) continue;
        seen.add(m.user_id);
        users.push({ id: m.user_id });
      }
    }
    return Response.json({ users });
  }

  // ---------------------------------------------------------------- WebSocket

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const msg = parseFrame(raw);
    if (!msg) return;

    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return;

    if (msg.event === "pusher:ping") { ws.send(frame("pusher:pong", {})); return; }
    if (msg.event === "pusher:subscribe") { await this.handleSubscribe(ws, att, msg.data); return; }
    if (msg.event === "pusher:unsubscribe") { this.handleUnsubscribe(ws, att, msg.data); return; }
    if (isClientEvent(msg.event)) { this.handleClientEvent(ws, att, msg); return; }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.teardownSocket(ws);
    try { ws.close(1000, "bye"); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.teardownSocket(ws);
  }

  // --------------------------------------------------------- subscribe / etc.

  private async handleSubscribe(ws: WebSocket, att: SocketAttachment, data: unknown): Promise<void> {
    const d = (data ?? {}) as { channel?: unknown; auth?: unknown; channel_data?: unknown };
    if (!isValidChannelName(d.channel)) {
      ws.send(errorFrame(4009, "invalid channel name")); return;
    }
    const channel = d.channel;
    if (att.channels.includes(channel)) return;

    if (att.channels.length >= MAX_CHANNELS_PER_SOCKET) {
      ws.send(errorFrame(4100, `channel limit reached (${MAX_CHANNELS_PER_SOCKET})`));
      return;
    }

    // Auth for private-* and presence-* channels.
    if (isPrivateChannel(channel) || isPresenceChannel(channel)) {
      if (typeof d.auth !== "string") { ws.send(errorFrame(4009, "auth required")); return; }
      const channelData = isPresenceChannel(channel) && typeof d.channel_data === "string"
        ? d.channel_data
        : undefined;
      if (isPresenceChannel(channel) && typeof d.channel_data !== "string") {
        ws.send(errorFrame(4009, "channel_data required")); return;
      }
      const ok = await verifyChannelAuth(
        this.app.key, this.app.secret, att.socketId, channel, channelData, d.auth,
      );
      if (!ok) { ws.send(errorFrame(4009, "invalid auth signature")); return; }
    }

    att.channels.push(channel);
    let subs = this.channelSubs.get(channel);
    if (!subs) { subs = new Set(); this.channelSubs.set(channel, subs); }
    subs.add(att.socketId);

    if (isPresenceChannel(channel)) {
      let parsed: PresenceMember;
      try { parsed = JSON.parse(d.channel_data as string) as PresenceMember; }
      catch { ws.send(errorFrame(4009, "invalid channel_data")); return; }
      if (!parsed.user_id) { ws.send(errorFrame(4009, "missing user_id")); return; }

      const userId = String(parsed.user_id);
      att.presenceUserIds[channel] = userId;
      let roster = this.presenceRoster.get(channel);
      if (!roster) { roster = new Map(); this.presenceRoster.set(channel, roster); }
      roster.set(att.socketId, parsed);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO presence_members (channel, socket_id, user_id, user_info) VALUES (?, ?, ?, ?)`,
        channel, att.socketId, userId,
        parsed.user_info === undefined ? null : JSON.stringify(parsed.user_info),
      );

      const ids: string[] = [];
      const hash: Record<string, unknown> = {};
      const seen = new Set<string>();
      for (const m of roster.values()) {
        if (seen.has(m.user_id)) continue;
        seen.add(m.user_id);
        ids.push(m.user_id);
        hash[m.user_id] = m.user_info ?? null;
      }
      ws.send(frame("pusher_internal:subscription_succeeded", {
        presence: { count: ids.length, ids, hash },
      }, channel));

      // Fire member_added only when this is the user's first socket on the channel.
      let alreadyPresent = 0;
      for (const m of roster.values()) if (m.user_id === userId) alreadyPresent++;
      if (alreadyPresent === 1) {
        this.broadcastFrame(channel, frame("pusher_internal:member_added", {
          user_id: userId, user_info: parsed.user_info ?? null,
        }, channel), att.socketId);
      }
    } else {
      ws.send(frame("pusher_internal:subscription_succeeded", {}, channel));
    }

    ws.serializeAttachment(att);
  }

  private handleUnsubscribe(ws: WebSocket, att: SocketAttachment, data: unknown): void {
    const d = (data ?? {}) as { channel?: unknown };
    if (typeof d.channel !== "string") return;
    this.removeFromChannel(att, d.channel);
    ws.serializeAttachment(att);
  }

  private handleClientEvent(
    ws: WebSocket,
    att: SocketAttachment,
    msg: { event: string; data?: unknown; channel?: string },
  ): void {
    const channel = msg.channel;
    if (!channel || !isValidChannelName(channel)) return;
    // Pusher restricts client events to private/presence channels the sender is subscribed to.
    if (!isPrivateChannel(channel) && !isPresenceChannel(channel)) return;
    if (!att.channels.includes(channel)) return;

    const dataStr = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data ?? {});
    if (Buffer.byteLength(dataStr, "utf8") > MAX_EVENT_DATA_BYTES) {
      ws.send(errorFrame(4301, "client event payload too large"));
      return;
    }

    // Sliding 1-second window rate limit.
    const now = Date.now();
    const rec = this.clientEventRate.get(att.socketId);
    if (!rec || now - rec.windowStart >= 1000) {
      this.clientEventRate.set(att.socketId, { windowStart: now, count: 1 });
    } else {
      rec.count++;
      if (rec.count > MAX_CLIENT_EVENTS_PER_SEC) {
        ws.send(errorFrame(4301, "client event rate limit exceeded"));
        return;
      }
    }

    this.broadcastFrame(channel, frame(msg.event, dataStr, channel), att.socketId);
  }

  // -------------------------------------------------------- fan-out / cleanup

  private broadcast(channel: string, event: string, dataStr: string, excludeSocketId?: string): void {
    this.broadcastFrame(channel, frame(event, dataStr, channel), excludeSocketId);
  }

  private broadcastFrame(channel: string, raw: string, excludeSocketId?: string): void {
    const subs = this.channelSubs.get(channel);
    if (!subs) return;
    for (const sid of subs) {
      if (sid === excludeSocketId) continue;
      const ws = this.sockets.get(sid);
      if (!ws) continue;
      try { ws.send(raw); } catch { /* socket gone; close handler will clean up */ }
    }
  }

  private removeFromChannel(att: SocketAttachment, channel: string): void {
    const idx = att.channels.indexOf(channel);
    if (idx < 0) return;
    att.channels.splice(idx, 1);

    const subs = this.channelSubs.get(channel);
    if (subs) {
      subs.delete(att.socketId);
      if (subs.size === 0) this.channelSubs.delete(channel);
    }

    if (isPresenceChannel(channel)) {
      const userId = att.presenceUserIds[channel];
      delete att.presenceUserIds[channel];
      const roster = this.presenceRoster.get(channel);
      if (roster) {
        roster.delete(att.socketId);
        if (roster.size === 0) this.presenceRoster.delete(channel);
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM presence_members WHERE channel = ? AND socket_id = ?`,
        channel, att.socketId,
      );

      if (userId) {
        const stillHere = roster && [...roster.values()].some(m => m.user_id === userId);
        if (!stillHere) {
          this.broadcastFrame(channel, frame("pusher_internal:member_removed", {
            user_id: userId,
          }, channel));
        }
      }
    }
  }

  private teardownSocket(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return;
    for (const ch of [...att.channels]) this.removeFromChannel(att, ch);
    this.sockets.delete(att.socketId);
    this.clientEventRate.delete(att.socketId);
  }
}
