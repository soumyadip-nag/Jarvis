// Jarvis cloud API. Every route except /api/login needs a device token.
//
//   POST   /api/login              {passcode, device: "phone"|"laptop"} -> {token}
//   POST   /api/chat               {text, tz}                -> {user, reply, actions}
//                                   With "Accept: text/event-stream": "sentence" events as the reply is written, then "done".
//                                   With {voice: true} too, "audio" events carry each sentence's MP3 (or null: fetch it)
//   GET    /api/sync?since=<ts>    -> {messages, commands, devices, user}  (one cheap call for polling)
//   POST   /api/commands/<id>/done
//   POST   /api/calls              {name, number, goal}: asks the laptop to make a call for the user
//   POST   /api/calls/report       {name, report, transcript}: the laptop shares how a call went
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
import { addMessage, messagesSince, clearRecent } from "../../lib/messages.mjs";
import { listMemories, addMemories, deleteMemory } from "../../lib/memory.mjs";
import { getImage } from "../../lib/images.mjs";
import { transcribe } from "../../lib/llm.mjs";
import { synthesize, voiceSession, MAX_SPEECH_CHARS } from "../../lib/voice.mjs";

const VOICED_SENTENCES = 4;
import { enqueue, touch, pending, done, status } from "../../lib/devices.mjs";

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
    const { text, tz, voice: wantsVoice } = await body(req);
    if (!text || typeof text !== "string" || text.length > 4000) return json({ error: "Invalid text" }, 400);
    const defer = (promise) => (context?.waitUntil ? context.waitUntil(promise) : promise);
    if ((req.headers.get("accept") || "").includes("text/event-stream")) {
      // Sentences are sent as they're written, so the phone can show and speak them straight away.
      // With voice, each sentence's audio follows it, made over one connection opened while the AI is thinking.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const event = (name, data) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
          const voice = wantsVoice ? voiceSession() : null;
          const voiced = [];
          let count = 0;
          const onSentence = (sentence) => {
            const index = count++;
            event("sentence", { index, text: sentence });
            // Only the first few: the phone shows long replies on screen rather than reading them all out.
            if (voice && index < VOICED_SENTENCES) {
              voiced.push(voice.say(sentence).then((mp3) => event("audio", { index, audio: mp3 ? mp3.toString("base64") : null })));
            }
          };
          try {
            event("done", await respond({ text: text.trim(), device, tz, defer, onSentence }));
            await Promise.all(voiced);
          } catch (e) {
            console.error("chat failed:", e);
            event("error", { error: "Something went wrong on my side." });
          }
          await voice?.close();
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    return json(await respond({ text: text.trim(), device, tz, defer }));
  }

  if (route === "GET /sync") {
    const since = Number(url.searchParams.get("since") || 0);
    const [messages, commands, devices] = await Promise.all([messagesSince(since), pending(device), status()]);
    return json({ messages, commands, devices, user: { name: user.name, honorific: user.honorific } });
  }

  if (route === "POST /calls") {
    const { name, number, goal } = await body(req);
    const digits = String(number || "").replace(/[^\d+]/g, "");
    if (!/^\+?\d{3,15}$/.test(digits)) return json({ error: "Invalid number" }, 400);
    if (!goal || typeof goal !== "string" || goal.length > 1000) return json({ error: "Invalid goal" }, 400);
    await enqueue("laptop", { type: "ai_call", name: String(name || digits).slice(0, 100), number: digits, goal });
    return json({ ok: true });
  }

  if (route === "POST /calls/report") {
    const { name, report, transcript } = await body(req);
    if (!report || typeof report !== "string") return json({ error: "Invalid report" }, 400);
    const content = `📞 Call to ${String(name || "them").slice(0, 100)}: ${report}${transcript ? `\n\nWhat was said:\n${transcript}` : ""}`;
    return json({ message: await addMessage({ role: "assistant", content: content.slice(0, 8000), device: "laptop" }) });
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
