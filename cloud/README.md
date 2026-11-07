# Jarvis Cloud — shared brain + phone app

One private server that your **phone app** and **laptop app** both talk to, so they share one
conversation, one memory and can send commands to each other.

```
 Pixel 8 (web app) ──┐                      ┌── Netlify Blobs: messages, memory, command queue
                     ├──►  /api  (Netlify) ──┤
 Laptop (Jarvis.py) ─┘                      └── Groq (AI) · Cohere (memory search) · SerpAPI (web)
```

## Deploy (once)

1. In Netlify: **Add new project → Import an existing project → GitHub → `Jarvis`**
   - Branch: the branch containing this folder
   - **Base directory: `cloud`** (everything else is read from `netlify.toml`)
2. **Project configuration → Environment variables**, add:

| Variable | Required | What |
|---|---|---|
| `JARVIS_PASSCODE` | ✅ | Your login passcode. Make it long (a sentence works well). |
| `GROQ_API_KEY` | ✅ | AI replies and tool use |
| `CohereAPIKey` | recommended | Smarter memory recall (semantic search). Without it, keyword matching is used. |
| `SERPAPI_KEY` | optional | Live web search (news, weather, scores…) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | optional | Image generation (free daily allowance). The token needs the **Workers AI** permission. |
| `USER_NAME` | optional | Your name, used in Jarvis's personality |
| `HONORIFIC` | optional | `sir` (default), `ma'am`, … |
| `GROQ_MODEL` | optional | Default `openai/gpt-oss-120b` |

3. **Deploys → Trigger deploy** so the variables take effect.

## Install on your phone (Pixel 8)

1. Open your site URL in **Chrome** and sign in with the passcode.
2. Chrome menu **⋮ → Add to Home screen → Install**. Jarvis now opens like a normal app.
3. Allow the microphone when asked. Tap the orb or 🎙 to talk.

## Connect the laptop app

Add to the laptop's `.env` (in the project root) and restart `python Main.py`:

```
JARVIS_SERVER_URL=https://<your-site>.netlify.app
JARVIS_PASSCODE=<same passcode>
```

The footer shows **● PHONE ONLINE** when both are connected.

## What syncs

- **Conversation:** everything said on either device appears on both.
- **Memory:** after every exchange Jarvis extracts lasting facts (people, plans, preferences,
  dates…) and recalls the relevant ones in future conversations, on either device. View, add and
  delete memories in the 🧠 tab. Ask "what do you remember about me?" or "forget my old address".
- **Full history:** every message is archived permanently; Jarvis can search it
  ("what did I say about the robotics project last month?").
- **Cross-device commands:** "open Spotify on my laptop" (from the phone) runs on the laptop;
  "play lo-fi on my phone" (from the laptop) pops up on the phone. Commands wait up to 24 hours
  if the other device is offline.

## Images

Ask for a picture on either device. It appears in the phone chat (tap to save) and opens on the
laptop. Images are stored privately and can only be fetched by a signed-in device.

## Phone actions

Open apps (YouTube, Spotify, WhatsApp, Maps, Gmail, Instagram…), YouTube/Google searches,
play music (YouTube Music), navigation, calls, SMS, WhatsApp messages and email drafts.
Android may ask you to tap the button in the chat the first time an app is opened.

## Security

- Single user: one passcode; each device gets a signed 90-day token.
- 8 wrong passcodes lock logins for an hour.
- API keys live only in Netlify's environment variables, never in the app.

## Develop / test

```
npm install
npm test
```
