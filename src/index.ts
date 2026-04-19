import { Beacon } from "./beacon";
import { isSecretConfigured } from "./auth";
import type { Env } from "./types";

export { Beacon };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check — deliberately unauthenticated so uptime probes work.
    if (path === "/" || path === "/health") {
      return new Response("ok");
    }

    // Refuse to accept any traffic with the default/unset/too-short secret.
    if (!isSecretConfigured(env.APP_SECRET)) {
      return new Response(
        "APP_SECRET is unset or using the default placeholder. Set a real secret: `wrangler secret put APP_SECRET`",
        { status: 503 },
      );
    }

    // Client WebSocket handshake: wss://host/app/{app_key}
    if (path.startsWith("/app/")) {
      const key = path.slice("/app/".length);
      if (key !== env.APP_KEY) {
        return new Response("invalid app key", { status: 401 });
      }
      return forwardToBeacon(env, req);
    }

    // Server-to-server REST API: /apps/{app_id}/...
    if (path.startsWith(`/apps/${env.APP_ID}/`)) {
      return forwardToBeacon(env, req);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function forwardToBeacon(env: Env, req: Request): Promise<Response> {
  const id = env.BEACON.idFromName(env.APP_ID);
  return env.BEACON.get(id).fetch(req);
}
