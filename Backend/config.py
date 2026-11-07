"""Central configuration: paths, names, API keys and model names.

Everything secret is read from the `.env` file in the project root (see `.env.example`).
Never hardcode API keys in source files.
"""
from pathlib import Path
import os

from dotenv import dotenv_values, load_dotenv

# Project root = folder that contains Main.py, regardless of the current working directory.
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

DATA_DIR = ROOT_DIR / "Data"
CHATLOG_PATH = DATA_DIR / "ChatLog.json"
SPEECH_PATH = DATA_DIR / "speech.mp3"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# Names
# Read from .env directly: Windows always defines %USERNAME%, and environment variable names
# are case-insensitive there, so os.getenv("Username") would return the login name instead.
USERNAME = dotenv_values(ROOT_DIR / ".env").get("Username") or os.getenv("Username", "Sir")
ASSISTANT_NAME = os.getenv("Assistantname", "Jarvis")
HONORIFIC = os.getenv("Honorific", "sir")  # how Jarvis addresses you, e.g. "sir" or "ma'am"

# API keys (only from the environment / .env)
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
HUGGINGFACE_API_KEY = os.getenv("HuggingFaceAPIKey")

# Model names (override in .env when providers retire models)
GROQ_CHAT_MODEL = os.getenv("GROQ_CHAT_MODEL", "openai/gpt-oss-120b")
GROQ_CONTENT_MODEL = os.getenv("GROQ_CONTENT_MODEL", GROQ_CHAT_MODEL)
GROQ_ROUTER_MODEL = os.getenv("GROQ_ROUTER_MODEL", "openai/gpt-oss-20b")
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell")

# Image generation with Cloudflare Workers AI (free daily allowance)
CLOUDFLARE_ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
CLOUDFLARE_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "").strip()
CLOUDFLARE_IMAGE_MODEL = os.getenv("CLOUDFLARE_IMAGE_MODEL", "@cf/black-forest-labs/flux-1-schnell")

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
