# Jarvis — personal desktop assistant

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then put your own API keys in .env
python Main.py
```

API keys are read **only** from `.env`, which is git-ignored. Never paste keys into `.py` files.

## Phone app + sync

`cloud/` contains a private cloud brain and an installable phone app that share one
conversation and memory with this desktop app. See [cloud/README.md](cloud/README.md).

## Using it

- **Type** a command and press Enter, or click a **quick command**.
- **Talk**: click the mic, click the arc reactor, or press **Ctrl+Space**.
- **Esc** (or clicking the reactor while it speaks) stops Jarvis mid-sentence.
- The reactor shows what Jarvis is doing: blue = standing by, green = listening,
  amber = processing, pulsing = speaking, red = offline (check the error in the chat).

## Voice & personality

Default voice is `en-GB-RyanNeural` (calm British male), slightly slower and deeper,
with a subtle effects chain (EQ, compression, light chorus and a very short reverb)
for a polished AI sound. Tune it in `.env`:

```
AssistantVoice=en-GB-RyanNeural   # or en-GB-ThomasNeural, en-GB-OliverNeural
VOICE_RATE=-4%
VOICE_PITCH=-2Hz
VOICE_FX=true                     # false = plain voice
Honorific=sir                     # how Jarvis addresses you
```

The personality (dry British wit, concise spoken answers) lives in `Backend/Personality.py`.

## Layout

- `Main.py` — starts the app.
- `Frontend/Gui.py` — the HUD interface (arc reactor, chat, system stats).
- `Backend/Assistant.py` — routes each request to the right backend and builds the reply.
- `Backend/Personality.py` — Jarvis's system prompt and stock phrases.
- `Backend/config.py` — paths, names, API keys and model names (override models in `.env`).
- `Backend/Model.py` — decides what kind of request it is (chat, realtime, open app, …).
- `Backend/Chatbot.py`, `Backend/RealtimeSearchEngine.py` — answers questions.
- `Backend/Automation.py` — opens/closes apps, searches, plays YouTube, volume, writes content.
- `Backend/TextToSpeech.py`, `Backend/SpeechToText.py` — voice in/out.
- `Backend/ImageGeneration.py` — image generation via Hugging Face.
