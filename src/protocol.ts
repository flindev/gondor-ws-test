import type { PusherFrame } from "./types";

export const PROTOCOL_VERSION = 7;
export const ACTIVITY_TIMEOUT_SECONDS = 120;

// Pusher-compatible size and rate limits. Applied to both client events and
// REST triggers to prevent amplification DoS.
export const MAX_EVENT_DATA_BYTES = 10 * 1024;          // 10 KiB
export const MAX_CLIENT_EVENTS_PER_SEC = 10;
export const MAX_CHANNELS_PER_SOCKET = 100;
export const MAX_CHANNEL_NAME_LENGTH = 164;
export const REST_TIMESTAMP_TOLERANCE_SEC = 600;        // ±10 min

// Pusher's documented channel name grammar.
const CHANNEL_NAME_RE = /^[A-Za-z0-9_\-=@,.;]{1,164}$/;

export function isValidChannelName(name: unknown): name is string {
  return typeof name === "string" && CHANNEL_NAME_RE.test(name);
}

export function frame(event: string, data?: unknown, channel?: string): string {
  const payload: Record<string, unknown> = { event };
  if (channel) payload.channel = channel;
  if (data !== undefined) {
    payload.data = typeof data === "string" ? data : JSON.stringify(data);
  }
  return JSON.stringify(payload);
}

export function errorFrame(code: number, message: string): string {
  return frame("pusher:error", { code, message });
}

export function parseFrame(raw: string): PusherFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.event !== "string") return null;

  // Pusher wraps `data` as a JSON-encoded string; unwrap for convenience.
  let data: unknown = obj.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as-is */ }
  }
  return {
    event: obj.event,
    data,
    channel: typeof obj.channel === "string" ? obj.channel : undefined,
  };
}

export function isPrivateChannel(name: string): boolean {
  return name.startsWith("private-");
}

export function isPresenceChannel(name: string): boolean {
  return name.startsWith("presence-");
}

export function isClientEvent(event: string): boolean {
  return event.startsWith("client-");
}

// Cryptographically random, two-part socket id in Pusher's "a.b" format.
export function generateSocketId(): string {
  const buf = crypto.getRandomValues(new Uint32Array(2));
  return `${buf[0]}.${buf[1]}`;
}
