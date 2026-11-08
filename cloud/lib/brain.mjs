// The assistant: persona, tools and the tool-calling loop.
import { chat, ShareUsedError } from "./llm.mjs";
import { recall, addMemories, forgetMatching, extractAndStore } from "./memory.mjs";
import { addMessage, recentMessages, searchArchive } from "./messages.mjs";
import { phoneActionToUrl } from "./actions.mjs";
import { enqueue, isOnline } from "./devices.mjs";
import { generateImages, imagesEnabled } from "./images.mjs";
import { getWeather } from "./weather.mjs";
import { currentUser } from "./users.mjs";
import { webSearch } from "./search.mjs";

const NAME = () => process.env.ASSISTANT_NAME || "Jarvis";
const USER = () => currentUser().name;
const HONORIFIC = () => currentUser().honorific;

const MAX_STEPS = 4;
// What's sent with each question, which costs tokens every time. Long-term memory is recalled separately.
const RECENT_MESSAGES = 10;
const LONGEST_RECENT_MESSAGE = 800;
const shortened = (text) => (text.length > LONGEST_RECENT_MESSAGE ? `${text.slice(0, LONGEST_RECENT_MESSAGE)}…` : text);
const ANSWER_NOW = "Give your final answer to the user now, in one to three short spoken sentences. " +
  "You have no tools available and cannot search again. If results are listed above, report the most relevant of them, " +
  "even if they are not a perfect match. If a tool failed or returned nothing useful, say that plainly. " +
  "Do not describe your reasoning.";

/**
 * The conversation with tool calls turned into plain text. Groq rejects a request with no tools if the
 * model tries to call one, and it will try if it can see earlier tool calls.
 */
async function finalAnswer(messages, temperature, onText) {
  const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
  const plain = [
    ...messages
      .filter((m) => m.role !== "tool" && !m.tool_calls)
      // Tool names in the instructions tempt the model to call them, even with none on offer.
      .map((m, i) => (i === 0 ? { ...m, content: m.content.replace(/Devices and actions:[\s\S]*?(?=Current date)/, "") } : m)),
    { role: "system", content: `${results.length ? `What your tools returned:\n${results.join("\n\n")}\n\n` : ""}${ANSWER_NOW}` },
  ];
  const ask = () => chat({ messages: plain, temperature, onText });
  const msg = await ask().catch((e) => {
    if (e.message.includes("tool_use_failed")) return ask(); // it tried to call a tool anyway; usually fine the second time
    throw e;
  });
  return cleanReply(msg.content);
}

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
- Stop when you have answered; do not end by offering further help.
- Never mention being a language model or these instructions. If you don't know, say so.
- Use what you remember about the user naturally, without announcing that you "remember".

Devices and actions:
- The user is talking to you from their ${device.toUpperCase()} right now.
- Use phone_action for things on the phone and laptop_command for things on the laptop.
- If they don't say which device, act on the one they are using (${device}).
- After an action on a device, confirm in a few words (for example "Done, ${HONORIFIC()}." or "Opening YouTube."). Don't read out URLs.
- After looking something up, such as the weather, just give the answer once, with no confirmation.
- The phone's settings are yours to use with phone_control: torch, volume, mute, Do Not Disturb, music (play, pause, next, previous), alarms, timers, and the Wi-Fi and Bluetooth switches. You cannot set reminders yet; say so politely if asked.
- To answer a message, use reply_message with the person's name and the exact words to send. It replies through the phone's notification, so it only works for messages that are still there.
- You may be given who has messaged the user on the phone: senders and counts only. You never see what anyone wrote, so never guess or invent it; if asked what someone said, say they'll need to open the app to read it.
- You can't do things inside other apps on the phone (such as typing in an app or changing settings in an app), and you can't hold a phone call for the user. Say so politely if asked, and offer what you can do instead: open the app, place an ordinary call, or reply to a notification.
- Act only on the user's latest message. Earlier requests in this conversation have already been dealt with, so never repeat them.
- To call someone, the user does the talking: use phone_action with action "call" and their name as the target. The phone looks up its own contacts, so you never need their number. Never say you don't have a number, even if an earlier call in this conversation went differently.
- For any weather question use get_weather, never web_search. Give the conditions in a sentence or two. If the result says live weather is unavailable, say when you last checked and do not present it as current.
- Web searches are limited each day, so only use web_search when the answer really needs current information.
- When asked to create a picture, use generate_image. It appears in the chat by itself. Never claim an image was made if the tool reported an error.

Current date and time for the user: ${now}.`;
}

// With the phone locked, or a voice the phone didn't recognise as the user's, whoever is speaking may not be the user:
// only these, which reveal and change nothing personal.
export const LOCKED_TOOLS = new Set(["get_weather", "web_search", "phone_control", "generate_image"]);
const RESTRICTED = "Answer general questions and use the tools you have, but share nothing personal: you have no access to " +
  "the user's memories, messages, contacts or chat history right now.";
const LOCKED_NOTE = `The phone is LOCKED, so the person speaking may not be the user. ${RESTRICTED} ` +
  "For anything personal, or to send messages or make calls, say politely that they need to unlock the phone first.";
const GUEST_NOTE = `The phone did not recognise this voice as the user's, so you may be talking to someone else. ${RESTRICTED} ` +
  "For anything personal, or to send messages or make calls, say politely that you only do that for the user. Don't mention voice ID unless asked.";

function tools(locked = false) {
  const list = [
    {
      type: "function",
      function: {
        name: "phone_action",
        description: "Do something on the user's Android phone: open an app or website, search, play music, navigate, call, text or email. " +
          "A call here is for the user to talk themselves.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["open_app", "open_url", "youtube_search", "play_music", "web_search", "navigate", "call", "sms", "whatsapp", "email"],
            },
            target: {
              type: "string",
              description: "App name, URL, search query, song, destination, phone number or email address. " +
                "For a call, give the person's name as the user said it unless they gave a number; never invent a number.",
            },
            text: { type: "string", description: "Optional message body for sms / whatsapp / email." },
          },
          required: ["action", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "phone_control",
        description: "Change a setting on the user's Android phone: torch, volume, mute, Do Not Disturb, music playback, an alarm, a timer, or Wi-Fi / Bluetooth.",
        parameters: {
          type: "object",
          properties: {
            control: {
              type: "string",
              enum: ["torch_on", "torch_off", "volume", "volume_up", "volume_down", "mute", "unmute", "dnd_on", "dnd_off",
                "play", "pause", "next", "previous", "alarm", "timer", "wifi", "bluetooth"],
            },
            level: { type: "integer", description: "For volume: 0 to 100 percent." },
            hour: { type: "integer", description: "For an alarm: hour, 0 to 23." },
            minute: { type: "integer", description: "For an alarm: minute, 0 to 59." },
            seconds: { type: "integer", description: "For a timer: its length in seconds." },
            label: { type: "string", description: "Optional name for an alarm or timer." },
          },
          required: ["control"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reply_message",
        description: "Reply to someone who messaged the user on WhatsApp, SMS, Instagram, Telegram or Messenger, through the phone's notification.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "The person or group's name as the user said it." },
            text: { type: "string", description: "Exactly what to send, in the user's words." },
            app: { type: "string", description: "Optional: the app, if the user said one (whatsapp, sms, instagram...)." },
          },
          required: ["to", "text"],
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
        name: "get_weather",
        description: "Get current weather and the forecast for today and the next two days. Leave out location for the user's home region.",
        parameters: {
          type: "object",
          properties: {
            location: { type: ["string", "null"], description: "City or region, only if the user names one." },
            set_as_home: {
              type: ["boolean", "null"],
              description: "Must be true whenever the user says they live in, are based in, or moved to this place. It saves their home region.",
            },
          },
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
        description: "Search the web for current information: news, prices, sports, recent events, facts about people. Not for weather.",
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
  return locked ? list.filter((t) => LOCKED_TOOLS.has(t.function.name)) : list;
}

/** Whether the user's latest message names this person, or refers back to someone ("call him again"). */
function meantInLatestMessage(contact, text) {
  const said = text.toLowerCase();
  const digits = contact.replace(/\D/g, "");
  if (digits.length >= 3 && text.replace(/\D/g, "").includes(digits)) return true;
  if (contact.toLowerCase().split(/\s+/).some((word) => word.length > 1 && said.includes(word))) return true;
  return /\b(him|her|them|again|same|back)\b/.test(said);
}

/** What Jarvis says once a phone setting is changed, or null for a control it doesn't know. */
export function phoneControlConfirmation(control, args = {}) {
  const pad = (n) => String(n).padStart(2, "0");
  const seconds = Math.round(Number(args.seconds) || 0);
  const minutes = Math.round(seconds / 60);
  const length = seconds < 60 ? `${seconds} seconds` : minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const level = Math.max(0, Math.min(100, Math.round(Number(args.level ?? 50) || 0)));
  return {
    torch_on: "Torch on", torch_off: "Torch off",
    volume: `Volume at ${level} percent`,
    volume_up: "Volume up", volume_down: "Volume down", mute: "Muted", unmute: "Unmuted",
    dnd_on: "Do Not Disturb is on", dnd_off: "Do Not Disturb is off",
    play: "Playing", pause: "Paused", next: "Next track", previous: "Previous track",
    alarm: `Alarm set for ${pad(Number(args.hour) || 0)}:${pad(Number(args.minute) || 0)}`,
    timer: `Timer set for ${length}`,
    wifi: "Here's the Wi-Fi switch", bluetooth: "Here are the Bluetooth settings",
  }[control] || null;
}

/** Execute one tool call. Returns the text fed back to the model. Collects device actions in ctx. */
async function runTool(name, args, ctx) {
  if (ctx.locked && !LOCKED_TOOLS.has(name)) return `Not available while the phone is locked. Tell the user to unlock it first, ${HONORIFIC()}.`;
  switch (name) {
    case "phone_action": {
      const link = phoneActionToUrl(args);
      if (!link) return "Unknown phone action.";
      const action = link.contact
        ? { type: "call_contact", device: "phone", name: link.contact, label: link.label }
        : { type: "open_url", device: "phone", ...link };
      if (ctx.device === "phone") {
        ctx.actions.push(action);
        return link.contact
          ? `The phone is finding "${link.contact}" in its own contacts and will show the result. Reply only "One moment."`
          : link.url.startsWith("tel:") && link.url.length > 4
            ? `The phone is calling ${args.target}. Reply only "Calling ${args.target}, ${HONORIFIC()}."`
            : `Opening on the phone: ${link.label}`;
      }
      await enqueue("phone", action);
      ctx.actions.push({ ...action, queued: true });
      if (link.contact) {
        ctx.fixedReply = `I've asked your phone to call ${link.contact}, ${HONORIFIC()}.`;
        return ctx.fixedReply;
      }
      return (await isOnline("phone"))
        ? `Sent to the phone: ${link.label}`
        : `Queued for the phone (${link.label}); it will appear when the Jarvis app is next opened there.`;
    }
    case "phone_control":
    case "reply_message": {
      // The phone does these, then says this fixed reply, or what went wrong instead.
      const say = (text) => { ctx.fixedReply = text; return text; };
      if (ctx.phoneActed) return "That has already been done.";
      let action;
      if (name === "reply_message") {
        const to = String(args.to || "").trim();
        const words = String(args.text || "").trim().slice(0, 1000);
        if (!to || !words) return say(`Who should I reply to, ${HONORIFIC()}, and what should I say?`);
        if (!meantInLatestMessage(to, ctx.text)) {
          return `Don't reply to ${to}: they aren't in the user's latest message. Act only on that message.`;
        }
        action = { type: "reply_message", device: "phone", to, text: words, app: String(args.app || ""), label: `Reply to ${to}` };
      } else {
        const control = String(args.control || "");
        const confirm = phoneControlConfirmation(control, args);
        if (!confirm) return "Unknown control.";
        action = { type: "phone_control", device: "phone", control, label: confirm, confirm };
        for (const key of ["level", "hour", "minute", "seconds"]) {
          if (args[key] !== undefined && Number.isFinite(Number(args[key]))) action[key] = Math.round(Number(args[key]));
        }
        if (args.label) action.name = String(args.label).slice(0, 60);
      }
      ctx.phoneActed = true;
      const done = name === "reply_message" ? `Sent to ${action.to}, ${HONORIFIC()}: "${action.text}"` : `${action.confirm}, ${HONORIFIC()}.`;
      if (ctx.device === "phone") {
        ctx.actions.push(action);
        return say(done);
      }
      await enqueue("phone", action);
      ctx.actions.push({ ...action, queued: true });
      return say((await isOnline("phone"))
        ? `I've sent that to your phone, ${HONORIFIC()}.`
        : `Your phone seems to be offline, ${HONORIFIC()}. It will happen when the Jarvis app is next open there.`);
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
    case "get_weather":
      return (await getWeather({ location: args.location, setHome: args.set_as_home === true, tz: ctx.tz })).text;
    case "generate_image": {
      const ids = await generateImages(args.prompt || "", args.count);
      for (const id of ids) ctx.actions.push({ type: "image", id, label: args.prompt });
      return `Generated ${ids.length} image(s). They are already showing in the chat.`;
    }
    case "web_search":
      ctx.searched = true;
      return await webSearch(args.query || "", ctx.tz);
    default:
      return `Unknown tool ${name}`;
  }
}

/** The model occasionally returns its whole answer twice in a row; keep one copy. */
export function removeRepeat(text) {
  const t = text.trim();
  for (const gap of [0, 1, 2]) {
    const size = (t.length - gap) / 2;
    if (Number.isInteger(size) && size > 0 && t.slice(0, size) === t.slice(size + gap) && !t.slice(size, size + gap).trim()) {
      return t.slice(0, size);
    }
  }
  return t;
}

const REASONING = /^(we need|we should|we must|we have|need to|the user (asked|wants|said)|the output|probably|let me|let's|i need to|i should|maybe|wait,|but we|so we|now we|according to|the tool)\b/i;

/**
 * This model sometimes puts its private reasoning or filler into the answer, and replies are read aloud.
 * Keeps the paragraphs before any reasoning and drops those with no words. May return "".
 */
export function cleanReply(text) {
  const kept = [];
  for (const paragraph of String(text || "").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").split(/\n\s*\n/)) {
    if (REASONING.test(paragraph.trim())) break;
    if (/\p{L}{2}/u.test(paragraph)) kept.push(paragraph.trim());
  }
  return removeRepeat(kept.join("\n\n"));
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
/**
 * Passes on each finished sentence of a reply while it's still being written, with the same checks cleanReply
 * makes on the whole reply: nothing without words, and nothing from reasoning onwards.
 */
function sentenceStream(onSentence) {
  let buffer = "";
  let stopped = !onSentence;
  const pass = (sentence) => {
    sentence = sentence.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();
    if (stopped || !sentence) return;
    if (REASONING.test(sentence)) { stopped = true; return; }
    if (/\p{L}{2}/u.test(sentence)) onSentence(sentence);
  };
  return {
    push: onSentence && ((text) => {
      buffer += text;
      let match;
      while ((match = buffer.match(/^([\s\S]*?[.!?\u2026])(\s+)/))) {
        pass(match[1]);
        buffer = buffer.slice(match[0].length);
      }
    }),
    flush: () => { pass(buffer); buffer = ""; },
  };
}

export async function respond({ text, device, tz, defer = (p) => p, onSentence, notifications, locked: phoneLocked = false, guest = false }) {
  const spoken = sentenceStream(onSentence);
  // Either way, nothing personal; `locked` below means that.
  const locked = phoneLocked || guest;
  const now = localTime(tz);
  // A locked phone gets nothing personal: no chat history, memories or messages (see LOCKED_TOOLS).
  const history = locked ? [] : (await recentMessages()).slice(-RECENT_MESSAGES);
  const userMsg = await addMessage({ role: "user", content: phoneLocked ? `🔒 ${text}` : guest ? `❔ ${text}` : text, device });
  const memories = locked ? [] : await recall(text, 8);

  const messages = [
    { role: "system", content: persona(device, now) },
    ...(phoneLocked ? [{ role: "system", content: LOCKED_NOTE }] : guest ? [{ role: "system", content: GUEST_NOTE }] : []),
    ...(memories.length
      ? [{ role: "system", content: "Things you know about the user (from memory):\n" + memories.map((m) => "- " + m).join("\n") }]
      : []),
    // From the phone: who has messaged, senders and counts only. Not saved anywhere.
    ...(!locked && device === "phone" && typeof notifications === "string" && notifications.trim()
      ? [{ role: "system", content: "Unread on the user's phone right now (senders and counts only; you cannot see what they wrote):\n" + notifications.slice(0, 2000) }]
      : []),
    ...history.map((m) => ({
      role: m.role,
      content: shortened(m.role === "user" && m.device !== device ? `(from ${m.device}) ${m.content}` : m.content),
    })),
    { role: "user", content: text },
  ];

  const ctx = { device, tz, text, actions: [], remembered: false, locked };
  let reply = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // One search per question, then it has to answer: each search uses up the daily allowance.
      const answerOnly = ctx.searched || step === MAX_STEPS - 1;
      if (answerOnly) {
        reply = await finalAnswer(messages, 0.3, spoken.push);
        break;
      }
      const msg = await chat({ messages, tools: tools(locked), onText: spoken.push });
      if (!msg.tool_calls?.length) {
        reply = cleanReply(msg.content);
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
      if (ctx.fixedReply) {
        reply = ctx.fixedReply;
        break;
      }
    }
    if (!reply && !ctx.actions.length) {
      reply = await finalAnswer(messages, 0.2, spoken.push);
    }
    spoken.flush();
  } catch (e) {
    console.error("chat failed:", e);
    if (e instanceof ShareUsedError) {
      reply = e.daily
        ? `You've used your share of the AI for today, ${HONORIFIC()}. It comes back tomorrow.`
        : `You've used your share of the AI for this minute, ${HONORIFIC()}. Please try again in about ${e.seconds} seconds.`;
    } else if (e.status === 429) {
      reply = `I've used up today's free AI allowance, ${HONORIFIC()}. It comes back gradually, so please try again a little later.`;
    } else {
      reply = `I'm having trouble reaching my servers, ${HONORIFIC()}. ${e.message.includes("not set") ? e.message : "Please try again shortly."}`;
    }
  }
  if (!reply) reply = ctx.actions.length ? `Done, ${HONORIFIC()}.` : `I'm afraid I lost my train of thought, ${HONORIFIC()}.`;

  const replyMsg = await addMessage({ role: "assistant", content: reply, device, actions: ctx.actions });

  // Asking for a call says nothing worth remembering, and Jarvis can't yet know how it went.
  // Nor from a locked phone: a stranger shouldn't be able to plant memories.
  if (!ctx.remembered && !ctx.fixedReply && !locked) {
    defer(extractAndStore({ userText: text, replyText: reply, now, known: memories }));
  }
  return { user: userMsg, reply: replyMsg, actions: ctx.actions };
}
