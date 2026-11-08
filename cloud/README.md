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
| `SERPAPI_KEY` | optional | Live web search (news, scores, prices…), capped at 8 searches a day |
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
JARVIS_SERVER_URL=https://jarvis.<your-subdomain>.workers.dev   (or https://<your-site>.netlify.app on Netlify)
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

## Several people

Each person gets their own chat, memory, images, weather and device sync. They can't see each other's.
Add people in Netlify with `JARVIS_USERS`, then redeploy:

```
[{"id":"sam","name":"Sam Example","honorific":"Sam","passcode":"a long passphrase"}]
```

`id` is lower-case letters, numbers and dashes, and shouldn't change later, because it decides where that
person's data lives. Removing someone ends their sessions but keeps their data.

Every limit is split equally between everyone, adjusting by itself as people are added. Unused shares aren't
passed on. With N people, each gets 8/N web searches a day, 170/N images a day, and 8,000/N Groq tokens a minute
on each model. The owner's own data stays where it has always been.

## Weather

Weather uses [Open-Meteo](https://open-meteo.com), which is free for private, non-commercial use and
needs no key. Tell Jarvis where you live once ("I live in Kolkata") and it saves that as your home region.

- An hourly job checks the home region up to 5 times a day (about 6am, 10am, 2pm, 6pm and 10pm), so a
  report is ready and major changes get noticed.
- A question uses a reading under 15 minutes old, otherwise it checks live. There is no daily cap.
- If a check fails, Jarvis tells you what it was the last time it checked.
- A major change (rain or a storm starting or stopping, a swing of 8°C, strong wind) posts a message
  in the shared chat. You see it the next time the app is open; it is not a phone notification.

Open-Meteo's free limits are 10,000 calls a day and 600 a minute, and shared cloud addresses such as
Netlify's may be limited sooner. The data is CC BY 4.0, so the settings screen credits Open-Meteo.

## Web search

SerpAPI's free plan allows 250 searches a month, so Jarvis stops at 8 a day (250/30). After that it says
the limit has been reached until the next day. Weather never uses a search.

## Images

Ask for a picture on either device. It appears in the phone chat (tap to save) and opens on the
laptop. Images are stored privately and can only be fetched by a signed-in device.

## Calling

In Settings, import the people Jarvis can call. Their numbers stay on the phone: the AI and the server
only receive the name you said. "Call Ravi" finds the closest match and opens the dialler with the number,
and you tap Call. If two people match, Jarvis asks which one.

A web app can't read WhatsApp's contacts, see contacts you haven't imported, or place a call by itself.
Those would need a native Android app.

## Android app

`mobile/` wraps this web app in a Capacitor shell that adds what a browser can't: reading all contacts
(including WhatsApp ones where Android lists them), placing calls directly, and native listening and speech.
The app loads the live site, so web changes reach it without reinstalling. GitHub Actions builds it and
publishes `jarvis.apk` to the `apk-latest` release of the public `jarvis-updates` repo.

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
