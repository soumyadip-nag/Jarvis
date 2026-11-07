# Jarvis — personal desktop assistant

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then put your own API keys in .env
python Main.py
```

API keys are read **only** from `.env`, which is git-ignored. Never paste keys into `.py` files.

## Layout

- `Main.py` — GUI; routes each request to the right backend.
- `Backend/config.py` — paths, names, API keys and model names (override models in `.env`).
- `Backend/Model.py` — decides what kind of request it is (chat, realtime, open app, …).
- `Backend/Chatbot.py`, `Backend/RealtimeSearchEngine.py` — answers questions.
- `Backend/Automation.py` — opens/closes apps, searches, plays YouTube, volume, writes content.
- `Backend/TextToSpeech.py`, `Backend/SpeechToText.py` — voice in/out.
- `Backend/ImageGeneration.py` — image generation via Hugging Face.
