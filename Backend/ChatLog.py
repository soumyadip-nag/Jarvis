"""Load and save the conversation history safely."""
import json

from Backend.config import CHATLOG_PATH, MAX_HISTORY_MESSAGES


def load_chatlog():
    try:
        with open(CHATLOG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except json.JSONDecodeError:
        print("Warning: ChatLog.json is corrupted; starting a new conversation.")
        return []


def save_chatlog(messages):
    with open(CHATLOG_PATH, "w", encoding="utf-8") as f:
        json.dump(messages, f, indent=4, ensure_ascii=False)


def recent(messages):
    """Only the last few messages are sent to the model, so the request never overflows."""
    return messages[-MAX_HISTORY_MESSAGES:]


def clean_answer(answer):
    answer = answer.replace("</s>", "").replace("</s", "")
    return "\n".join(line for line in answer.split("\n") if line.strip())
