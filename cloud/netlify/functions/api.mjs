// Jarvis cloud API. Every route except /api/login needs a device token.
//
//   POST   /api/login              {passcode, device: "phone"|"laptop"} -> {token}
//   POST   /api/chat               {text, tz}                -> {user, reply, actions}
//   GET    /api/sync?since=<ts>    -> {messages, commands, devices}  (one cheap call for polling)
//   POST   /api/commands/<id>/done
//   GET    /api/memories           -> {memories}
//   POST   /api/memories           {text}
//   DELETE /api/memories/<id>
//   GET    /api/images/<id>        -> image bytes
//   DELETE /api/history            clears the on-screen conversation (archive and memory are kept)
import { login, verify } from "../../lib/auth.mjs";
import { respond } from "../../lib/brain.mjs";
import { messagesSince, clearRecent } from "../../lib/messages.mjs";
import { listMemories, addMemories, deleteMemory } from "../../lib/memory.mjs";
import { getImage } from "../../lib/images.mjs";
import { touch, pending, done, status } from "../../lib/devices.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

export default async (req, context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = `${req.method} /${parts.join("/")}`;

  try {
    if (route === "POST /login") {
      const { passcode, device } = await body(req);
      const result = await login(passcode, device);
      return result.error ? json({ error: result.error }, result.status) : json(result);
    }

    const device = verify(req);
    if (!device) return json({ error: "Unauthorised" }, 401);
    await touch(device);

    if (route === "POST /chat") {
      const { text, tz } = await body(req);
      if (!text || typeof text !== "string" || text.length > 4000) return json({ error: "Invalid text" }, 400);
      const defer = (promise) => (context?.waitUntil ? context.waitUntil(promise) : promise);
      return json(await respond({ text: text.trim(), device, tz, defer }));
    }

    if (route === "GET /sync") {
      const since = Number(url.searchParams.get("since") || 0);
      const [messages, commands, devices] = await Promise.all([messagesSince(since), pending(device), status()]);
      return json({ messages, commands, devices });
    }

    if (req.method === "POST" && parts[0] === "commands" && parts[2] === "done") {
      await done(device, parts[1]);
      return json({ ok: true });
    }

    if (req.method === "GET" && parts[0] === "images" && parts[1]) {
      const image = await getImage(parts[1]);
      if (!image) return json({ error: "Not found" }, 404);
      return new Response(image.bytes, {
        headers: { "Content-Type": image.mime, "Cache-Control": "private, max-age=86400" },
      });
    }

    if (route === "GET /memories") return json({ memories: await listMemories() });

    if (route === "POST /memories") {
      const { text } = await body(req);
      return json({ added: await addMemories([String(text || "")], "manual") });
    }

    if (req.method === "DELETE" && parts[0] === "memories" && parts[1]) {
      return json({ ok: await deleteMemory(parts[1]) });
    }

    if (route === "DELETE /history") {
      await clearRecent();
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(route, e);
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/api/*" };
