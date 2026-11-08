// Jarvis on Cloudflare Workers: the same API and site as on Netlify, with D1 for storage (see wrangler.toml).
// /api/* goes to the same handler as Netlify's function; everything else is the phone app's files in public/.
import api from "./netlify/functions/api.mjs";
import refreshWeather from "./netlify/functions/weather-refresh.mjs";
import { useD1 } from "./lib/store.mjs";

export default {
  async fetch(request, env, ctx) {
    useD1(env.DB);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return api(request, { ip: request.headers.get("CF-Connecting-IP"), waitUntil: (promise) => ctx.waitUntil(promise) });
    }
    return env.ASSETS.fetch(request);
  },

  // Every hour, as Netlify's scheduled function did.
  async scheduled(event, env, ctx) {
    useD1(env.DB);
    ctx.waitUntil(refreshWeather());
  },
};
