// Jarvis cloud API. Every route except /api/login needs a device token.
//
//   POST   /api/login              {passcode, device: "phone"|"laptop"} -> {token}
//   POST   /api/chat               {text, tz}                -> {user, reply, actions}
//   GET    /api/sync?since=<ts>    -> {messages, commands, devices, user}  (one cheap call for polling)
//   POST   /api/commands/<id>/done
//   GET    /api/memories           -> {memories}
//   POST   /api/memories           {text}
//   DELETE /api/memories/<id>
//   GET    /api/images/<id>        -> image bytes
//   POST   /api/speak              {text} -> MP3 of the Jarvis voice
//   POST   /api/transcribe         {audio: base64 WAV} -> {text}; the audio is not stored
//   DELETE /api/history            clears the on-screen conversation (archive and memory are kept)
import { login, verify } from "../../lib/auth.mjs";
import { runAsUser } from "../../lib/users.mjs";
import { respond } from "../../lib/brain.mjs";
import { messagesSince, clearRecent } from "../../lib/messages.mjs";
import { listMemories, addMemories, deleteMemory } from "../../lib/memory.mjs";
import { getImage } from "../../lib/images.mjs";
import { transcribe } from "../../lib/llm.mjs";
import { synthesize, MAX_SPEECH_CHARS } from "../../lib/voice.mjs";
import { touch, pending, done, status } from "../../lib/devices.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

/** Everything here runs as the signed-in person, so store() only sees their data. */
async function signedIn(req, context, { url, parts, route, device, user }) {
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
    return json({ messages, commands, devices, user: { name: user.name, honorific: user.honorific } });
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

  if (route === "POST /transcribe") {
    const { audio } = await body(req);
    if (!audio || typeof audio !== "string" || audio.length > 4_000_000) return json({ error: "Invalid audio" }, 400);
    return json({ text: await transcribe(Buffer.from(audio, "base64")) });
  }

  if (route === "POST /speak") {
    const { text } = await body(req);
    if (!text || typeof text !== "string" || text.length > MAX_SPEECH_CHARS) return json({ error: "Invalid text" }, 400);
    try {
      return new Response(await synthesize(text), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
    } catch (e) {
      console.error("voice failed:", e.message);
      return json({ error: "The voice service isn't available." }, 502);
    }
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
}

export default async (req, context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = `${req.method} /${parts.join("/")}`;

  try {
    if (route === "POST /login") {
      const { passcode, device } = await body(req);
      const result = await login(passcode, device, context?.ip);
      return result.error ? json({ error: result.error }, result.status) : json(result);
    }

    const auth = verify(req);
    if (!auth) return json({ error: "Unauthorised" }, 401);
    return await runAsUser(auth.user, () => signedIn(req, context, { url, parts, route, device: auth.device, user: auth.user }));
  } catch (e) {
    console.error(route, e);
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/api/*" };
