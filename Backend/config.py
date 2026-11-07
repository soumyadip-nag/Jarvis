"""Central configuration: paths, names, API keys and model names.

Everything secret is read from the `.env` file in the project root (see `.env.example`).
Never hardcode API keys in source files.
"""
from pathlib import Path
import os

from dotenv import load_dotenv

# Project root = folder that contains Main.py, regardless of the current working directory.
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

DATA_DIR = ROOT_DIR / "Data"
CHATLOG_PATH = DATA_DIR / "ChatLog.json"
SPEECH_PATH = DATA_DIR / "speech.mp3"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# Names
USERNAME = os.getenv("Username", "Sir")
ASSISTANT_NAME = os.getenv("Assistantname", "Jarvis")
HONORIFIC = os.getenv("Honorific", "sir")  # how Jarvis addresses you, e.g. "sir" or "ma'am"

# API keys (only from the environment / .env)
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
COHERE_API_KEY = os.getenv("CohereAPIKey")
HUGGINGFACE_API_KEY = os.getenv("HuggingFaceAPIKey")

# Model names (override in .env when providers retire models)
GROQ_CHAT_MODEL = os.getenv("GROQ_CHAT_MODEL", "llama-3.3-70b-versatile")
GROQ_CONTENT_MODEL = os.getenv("GROQ_CONTENT_MODEL", GROQ_CHAT_MODEL)
COHERE_MODEL = os.getenv("COHERE_MODEL", "command-a-03-2025")
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell")

# Voice: a calm British male voice, slightly slower and deeper than default.
ASSISTANT_VOICE = os.getenv("AssistantVoice", "en-GB-RyanNeural")
VOICE_RATE = os.getenv("VOICE_RATE", "-4%")
VOICE_PITCH = os.getenv("VOICE_PITCH", "-2Hz")
# Subtle studio/"AI" processing (needs the optional `pedalboard` package).
VOICE_FX = os.getenv("VOICE_FX", "true").lower() in ("1", "true", "yes", "on")
SPEECH_FX_PATH = DATA_DIR / "speech_fx.wav"

# Cloud brain shared with the phone app (optional). See cloud/README.md.
JARVIS_SERVER_URL = os.getenv("JARVIS_SERVER_URL", "").strip()
JARVIS_PASSCODE = os.getenv("JARVIS_PASSCODE", "").strip()

# How many past chat messages are sent to the LLM (keeps requests inside the context window).
MAX_HISTORY_MESSAGES = int(os.getenv("MAX_HISTORY_MESSAGES", "20"))


def require_key(value, name):
    """Raise a clear error when a required API key is missing."""
    if not value:
        raise RuntimeError(f"{name} is not set. Add it to the .env file (see .env.example).")
    return value
