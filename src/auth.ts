import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { REST_TIMESTAMP_TOLERANCE_SEC } from "./protocol";

// Sentinel value that must be replaced before the server will accept traffic.
// Must match wrangler.jsonc's placeholder exactly.
export const DEFAULT_SECRET_SENTINEL = "REPLACE_ME_via_wrangler_secret_put_APP_SECRET";

export function isSecretConfigured(secret: string | undefined): boolean {
  return !!secret && secret !== DEFAULT_SECRET_SENTINEL && secret.length >= 16;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}

export function bodyMd5(body: string): string {
  return createHash("md5").update(body).digest("hex");
}

/**
 * Verify a Pusher channel subscription signature.
 *   private-*:  HMAC_SHA256(socket_id:channel, secret)
 *   presence-*: HMAC_SHA256(socket_id:channel:channel_data, secret)
 * The full auth string from the client is `{app_key}:{signature}`.
 */
export async function verifyChannelAuth(
  key: string,
  secret: string,
  socketId: string,
  channel: string,
  channelData: string | undefined,
  auth: string,
): Promise<boolean> {
  const idx = auth.indexOf(":");
  if (idx < 0) return false;
  const authKey = auth.slice(0, idx);
  const authSig = auth.slice(idx + 1);
  if (!timingSafeEqStr(authKey, key)) return false;
  const base = channelData
    ? `${socketId}:${channel}:${channelData}`
    : `${socketId}:${channel}`;
  const expected = await hmacSha256Hex(secret, base);
  return timingSafeEqStr(expected, authSig);
}

/**
 * Verify the signature on Pusher's server-to-server REST API.
 * See: https://pusher.com/docs/channels/library_auth_reference/rest-api/
 *
 * string_to_sign = METHOD \n PATH \n sorted_query_string_without_signature
 * auth_signature = HMAC_SHA256(string_to_sign, secret)
 *
 * Also checks:
 *   - auth_version == 1.0
 *   - auth_timestamp within ±REST_TIMESTAMP_TOLERANCE_SEC of now (replay guard)
 *   - body_md5 matches request body
 */
export async function verifyRestSignature(
  method: string,
  path: string,
  query: URLSearchParams,
  body: string,
  secret: string,
): Promise<boolean> {
  const providedSig = query.get("auth_signature");
  if (!providedSig) return false;

  if (query.get("auth_version") !== "1.0") return false;

  const ts = query.get("auth_timestamp");
  if (!ts) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > REST_TIMESTAMP_TOLERANCE_SEC) return false;

  const providedMd5 = query.get("body_md5");
  if (body.length > 0) {
    if (!providedMd5) return false;
    if (!timingSafeEqStr(providedMd5, bodyMd5(body))) return false;
  }

  const pairs: [string, string][] = [];
  for (const [k, v] of query) {
    if (k === "auth_signature") continue;
    pairs.push([k.toLowerCase(), v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const stringToSign = `${method.toUpperCase()}\n${path}\n${qs}`;
  const expected = await hmacSha256Hex(secret, stringToSign);
  return timingSafeEqStr(expected, providedSig);
}
