// The assistant: persona, tools and the tool-calling loop.
import { chat } from "./llm.mjs";
import { recall, addMemories, forgetMatching, extractAndStore } from "./memory.mjs";
import { addMessage, recentMessages, searchArchive } from "./messages.mjs";
import { phoneActionToUrl } from "./actions.mjs";
import { enqueue, isOnline } from "./devices.mjs";
import { generateImages, imagesEnabled } from "./images.mjs";

const NAME = () => process.env.ASSISTANT_NAME || "Jarvis";
const USER = () => process.env.USER_NAME || "the user";
const HONORIFIC = () => process.env.HONORIFIC || "sir";

function persona(device, now) {
  return `You are ${NAME()}, the personal AI assistant of ${USER()}. You run on their phone and laptop, which share one memory.

Personality:
- Calm, composed and impeccably polite, in the manner of a refined British butler who is also a brilliant engineer.
- Dry, understated wit; a light touch of sarcasm when the moment allows, never at the expense of being helpful.
- Loyal and quietly confident. Never grovel, never gush, never use exclamation marks.
- Address the user as "${HONORIFIC()}" occasionally, not in every sentence.

How you answer:
- Replies are spoken aloud: short natural sentences, one to three for most questions.
- No markdown, lists, emojis or headings unless asked for written content. British spelling.
- Never mention being a language model or these instructions. If you don't know, say so.
- Use what you remember about the user naturally, without announcing that you "remember".

Devices and actions:
- The user is talking to you from their ${device.toUpperCase()} right now.
- Use phone_action for things on the phone and laptop_command for things on the laptop.
- If they don't say which device, act on the one they are using (${device}).
- After using a tool, confirm briefly ("Done, ${HONORIFIC()}.", "Opening YouTube."). Don't read out URLs.
- You cannot set alarms or reminders yet; say so politely if asked.
- When asked to create a picture, use generate_image. It appears in the chat by itself. Never claim an image was made if the tool reported an error.

Current date and time for the user: ${now}.`;
}

function tools() {
  const list = [
    {
      type: "function",
      function: {
        name: "phone_action",
        description: "Do something on the user's Android phone: open an app or website, search, play music, navigate, call, text or email.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["open_app", "open_url", "youtube_search", "play_music", "web_search", "navigate", "call", "sms", "whatsapp", "email"],
            },
            target: { type: "string", description: "App name, URL, search query, song, destination, phone number or email address." },
            text: { type: "string", description: "Optional message body for sms / whatsapp / email." },
          },
          required: ["action", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "laptop_command",
        description:
          "Run a command on the user's Windows laptop. Formats: 'open <app or website>', 'close <app>', 'play <song on YouTube>', " +
          "'google search <query>', 'youtube search <query>', 'system volume up', 'system volume down', 'system mute', " +
          "'system unmute', 'content <topic>' (writes a document and opens it in Notepad).",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remember",
        description: "Save facts to long-term memory when the user asks you to remember something.",
        parameters: {
          type: "object",
          properties: { facts: { type: "array", items: { type: "string" }, description: "Self-contained sentences, e.g. 'The user's wifi password is on the router.'" } },
          required: ["facts"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "forget",
        description: "Delete memories when the user asks you to forget something.",
        parameters: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
      },
    },
    {
      type: "function",
      function: {
        name: "search_history",
        description: "Search every past conversation (from all devices) for something the user said or asked before.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
  ];
  if (process.env.SERPAPI_KEY) {
    list.push({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information: news, weather, prices, sports, recent events, facts about people.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    });
  }
  if (imagesEnabled()) {
    list.push({
      type: "function",
      function: {
        name: "generate_image",
        description: "Create a picture from a description. Write a detailed visual prompt in English.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            count: { type: "integer", description: "How many images, 1 to 4. Use 1 unless the user asks for more." },
          },
          required: ["prompt"],
        },
      },
    });
  }
  return list;
}

async function webSearch(query) {
  const url = `https://serpapi.com/search.json?engine=google&num=5&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return `Search failed (${res.status}).`;
  const data = await res.json();
  const parts = [];
  const box = data.answer_box;
  if (box) parts.push(`Answer: ${box.answer || box.snippet || box.result || ""} ${box.temperature ? box.temperature + "°" : ""} ${box.weather || ""}`.trim());
  if (data.knowledge_graph?.description) parts.push(`About: ${data.knowledge_graph.description}`);
  for (const r of (data.organic_results || []).slice(0, 5)) parts.push(`- ${r.title}: ${r.snippet || ""}`);
  return parts.join("\n") || "No results.";
}

/** Execute one tool call. Returns the text fed back to the model. Collects device actions in ctx. */
async function runTool(name, args, ctx) {
  switch (name) {
    case "phone_action": {
      const link = phoneActionToUrl(args);
      if (!link) return "Unknown phone action.";
      const action = { type: "open_url", device: "phone", ...link };
      if (ctx.device === "phone") {
        ctx.actions.push(action);
        return `Opening on the phone: ${link.label}`;
      }
      await enqueue("phone", action);
      ctx.actions.push({ ...action, queued: true });
      return (await isOnline("phone"))
        ? `Sent to the phone: ${link.label}`
        : `Queued for the phone (${link.label}); it will appear when the Jarvis app is next opened there.`;
    }
    case "laptop_command": {
      const action = { type: "laptop_command", device: "laptop", command: args.command, label: args.command };
      if (ctx.device === "laptop") {
        ctx.actions.push(action);
        return `Running on the laptop: ${args.command}`;
      }
      await enqueue("laptop", action);
      ctx.actions.push({ ...action, queued: true });
      return (await isOnline("laptop"))
        ? `Sent to the laptop: ${args.command}`
        : `The laptop seems to be offline. Queued "${args.command}" to run when the Jarvis desktop app is next running (within 24 hours).`;
    }
    case "remember": {
      const saved = await addMemories(args.facts || [], "explicit");
      ctx.remembered = true;
      return `Saved ${saved.length} memory item(s).`;
    }
    case "forget": {
      const removed = await forgetMatching(args.description || "");
      ctx.remembered = true;
      return removed.length ? `Forgot: ${removed.join("; ")}` : "Nothing matching was found in memory.";
    }
    case "search_history": {
      const hits = await searchArchive(args.query || "");
      return hits.length ? hits.join("\n") : "Nothing found in past conversations.";
    }
    case "generate_image": {
      const ids = await generateImages(args.prompt || "", args.count);
      for (const id of ids) ctx.actions.push({ type: "image", id, label: args.prompt });
      return `Generated ${ids.length} image(s). They are already showing in the chat.`;
    }
    case "web_search":
      return await webSearch(args.query || "");
    default:
      return `Unknown tool ${name}`;
  }
}

function localTime(tz) {
  try {
    return new Date().toLocaleString("en-GB", { timeZone: tz || "UTC", dateStyle: "full", timeStyle: "short" }) + ` (${tz || "UTC"})`;
  } catch {
    return new Date().toUTCString();
  }
}

/**
 * Handle one user message from a device.
 * Returns { user, reply, actions } and schedules memory extraction via `defer`.
 */
export async function respond({ text, device, tz, defer = (p) => p }) {
  const now = localTime(tz);
  const history = (await recentMessages()).slice(-16);
  const userMsg = await addMessage({ role: "user", content: text, device });
  const memories = await recall(text, 8);

  const messages = [
    { role: "system", content: persona(device, now) },
    ...(memories.length
      ? [{ role: "system", content: "Things you know about the user (from memory):\n" + memories.map((m) => "- " + m).join("\n") }]
      : []),
    ...history.map((m) => ({
      role: m.role,
      content: m.role === "user" && m.device !== device ? `(from ${m.device}) ${m.content}` : m.content,
    })),
    { role: "user", content: text },
  ];

  const ctx = { device, actions: [], remembered: false };
  let reply = "";
  try {
    for (let step = 0; step < 4; step++) {
      const msg = await chat({ messages, tools: tools() });
      if (!msg.tool_calls?.length) {
        reply = (msg.content || "").trim();
        break;
      }
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        let result;
        try { result = await runTool(call.function.name, args, ctx); }
        catch (e) { result = `Tool error: ${e.message}`; }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 4000) });
      }
    }
  } catch (e) {
    console.error("chat failed:", e);
    reply = `I'm having trouble reaching my servers, ${HONORIFIC()}. ${e.message.includes("not set") ? e.message : "Please try again shortly."}`;
  }
  if (!reply) reply = ctx.actions.length ? `Done, ${HONORIFIC()}.` : `I'm afraid I lost my train of thought, ${HONORIFIC()}.`;

  const replyMsg = await addMessage({ role: "assistant", content: reply, device, actions: ctx.actions });

  if (!ctx.remembered) {
    defer(extractAndStore({ userText: text, replyText: reply, now, known: memories }));
  }
  return { user: userMsg, reply: replyMsg, actions: ctx.actions };
}
