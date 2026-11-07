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
FRONTEND_FILES_DIR = ROOT_DIR / "Frontend" / "Files"
GRAPHICS_DIR = ROOT_DIR / "Frontend" / "Graphics"
CHATLOG_PATH = DATA_DIR / "ChatLog.json"
SPEECH_PATH = DATA_DIR / "speech.mp3"

DATA_DIR.mkdir(parents=True, exist_ok=True)
FRONTEND_FILES_DIR.mkdir(parents=True, exist_ok=True)

# Names
USERNAME = os.getenv("Username", "Sir")
ASSISTANT_NAME = os.getenv("Assistantname", "Jarvis")

# API keys (only from the environment / .env)
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
COHERE_API_KEY = os.getenv("CohereAPIKey")
HUGGINGFACE_API_KEY = os.getenv("HuggingFaceAPIKey")

# Model names (override in .env when providers retire models)
GROQ_CHAT_MODEL = os.getenv("GROQ_CHAT_MODEL", "llama-3.3-70b-versatile")
GROQ_CONTENT_MODEL = os.getenv("GROQ_CONTENT_MODEL", GROQ_CHAT_MODEL)
COHERE_MODEL = os.getenv("COHERE_MODEL", "command-a-03-2025")
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell")

# Voice
ASSISTANT_VOICE = os.getenv("AssistantVoice", "en-CA-LiamNeural")

# How many past chat messages are sent to the LLM (keeps requests inside the context window).
MAX_HISTORY_MESSAGES = int(os.getenv("MAX_HISTORY_MESSAGES", "20"))


def require_key(value, name):
    """Raise a clear error when a required API key is missing."""
    if not value:
        raise RuntimeError(f"{name} is not set. Add it to the .env file (see .env.example).")
    return value
