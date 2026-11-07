from webbrowser import open as webopen
from urllib.parse import quote_plus
import asyncio
import os
import re
import subprocess
import sys

from groq import Groq
from rich import print

from Backend.config import USERNAME, DATA_DIR, GROQ_API_KEY, GROQ_CONTENT_MODEL, require_key

# Windows-only / desktop-only libraries are optional so the module still imports elsewhere.
try:
    from AppOpener import close as appclose, open as appopen
except Exception:  # pragma: no cover - depends on OS
    appclose = appopen = None

try:
    import keyboard
except Exception:  # pragma: no cover - depends on OS / permissions
    keyboard = None

try:
    from pywhatkit import search as pywhatkit_search, playonyt
except Exception:  # pywhatkit needs an internet connection on import
    pywhatkit_search = playonyt = None

client = Groq(api_key=require_key(GROQ_API_KEY, "GROQ_API_KEY"))

SystemChatBot = [{
    "role": "system",
    "content": f"Hello, I am {USERNAME}. You're a content writer. You have to write content like letters, codes, applications, essays, notes, songs, poems etc.",
}]

# Websites to try when an app name isn't an installed application.
KNOWN_SITES = {
    "youtube": "https://www.youtube.com",
    "facebook": "https://www.facebook.com",
    "instagram": "https://www.instagram.com",
    "gmail": "https://mail.google.com",
    "google": "https://www.google.com",
    "twitter": "https://x.com",
    "x": "https://x.com",
    "linkedin": "https://www.linkedin.com",
    "github": "https://github.com",
    "chatgpt": "https://chatgpt.com",
    "netflix": "https://www.netflix.com",
    "whatsapp": "https://web.whatsapp.com",
}


def open_file(path):
    """Open a file with the default program on any OS."""
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def GoogleSearch(Topic):
    webopen(f"https://www.google.com/search?q={quote_plus(Topic)}")
    return True


def YouTubeSearch(Topic):
    webopen(f"https://www.youtube.com/results?search_query={quote_plus(Topic)}")
    return True


def PlayYoutube(query):
    if playonyt is not None:
        try:
            playonyt(query)
            return True
        except Exception as e:
            print(f"playonyt failed: {e}")
    return YouTubeSearch(query)


def Content(Topic):
    def ContentWriterAI(prompt):
        completion = client.chat.completions.create(
            model=GROQ_CONTENT_MODEL,
            messages=SystemChatBot + [{"role": "user", "content": prompt}],
            max_tokens=2048,
            temperature=0.7,
            top_p=1,
            stream=True,
        )
        Answer = ""
        for chunk in completion:
            if chunk.choices and chunk.choices[0].delta.content:
                Answer += chunk.choices[0].delta.content
        return Answer.replace("</s>", "")

    Topic = re.sub(r"^content\s+", "", Topic.strip(), flags=re.IGNORECASE)
    try:
        text = ContentWriterAI(Topic)
    except Exception as e:
        print(f"Content writer error: {e}")
        return False

    # Safe file name: letters, numbers, underscores only.
    filename = re.sub(r"[^a-z0-9]+", "_", Topic.lower()).strip("_")[:60] or "content"
    path = DATA_DIR / f"{filename}.txt"
    path.write_text(text, encoding="utf-8")
    open_file(path)
    return True


def OpenApp(app):
    app = app.strip()
    if appopen is not None:
        try:
            appopen(app, match_closest=True, output=True, throw_error=True)
            return True
        except Exception:
            pass

    # Not an installed app: open the website instead.
    url = KNOWN_SITES.get(app.lower())
    if url is None:
        url = f"https://www.google.com/search?q={quote_plus(app)}&btnI=1"  # "I'm feeling lucky"
    webopen(url)
    return True


def CloseApp(app):
    if appclose is None:
        print("Closing apps is only supported on Windows (AppOpener).")
        return False
    try:
        appclose(app.strip(), match_closest=True, output=True, throw_error=True)
        return True
    except Exception as e:
        print(f"Could not close {app}: {e}")
        return False


def System(command):
    if keyboard is None:
        print("System controls need the 'keyboard' package (Windows).")
        return False

    command = command.strip().lower()
    if command in ("mute", "unmute"):
        # Windows has a single mute *toggle* key.
        keyboard.press_and_release("volume mute")
    elif command == "volume up":
        for _ in range(5):  # one key press is only 2%
            keyboard.press_and_release("volume up")
    elif command == "volume down":
        for _ in range(5):
            keyboard.press_and_release("volume down")
    else:
        print(f"Unknown system command: {command}")
        return False
    return True


async def TranslateAndExecute(commands: list[str]):
    funcs = []

    for command in commands:
        command = command.strip()
        lower = command.lower()

        if lower.startswith("open "):
            target = command[5:]
            if target.lower() in ("it", "file"):
                continue
            funcs.append(asyncio.to_thread(OpenApp, target))
        elif lower.startswith(("general ", "realtime ", "generate image", "reminder", "exit")):
            continue  # handled in Main.py
        elif lower.startswith("close "):
            funcs.append(asyncio.to_thread(CloseApp, command[6:]))
        elif lower.startswith("play "):
            funcs.append(asyncio.to_thread(PlayYoutube, command[5:]))
        elif lower.startswith("content "):
            funcs.append(asyncio.to_thread(Content, command[8:]))
        elif lower.startswith("google search "):
            funcs.append(asyncio.to_thread(GoogleSearch, command[14:]))
        elif lower.startswith("youtube search "):
            funcs.append(asyncio.to_thread(YouTubeSearch, command[15:]))
        elif lower.startswith("system "):
            funcs.append(asyncio.to_thread(System, command[7:]))
        else:
            print(f"No function found for: {command}")

    results = await asyncio.gather(*funcs, return_exceptions=True)
    for result in results:
        if isinstance(result, Exception):
            print(f"Automation error: {result}")
        yield result


async def Automation(commands: list[str]):
    """Run all automation commands; returns True only if every one succeeded."""
    ok = True
    async for result in TranslateAndExecute(commands):
        if result is not True:
            ok = False
    return ok


if __name__ == "__main__":
    print(asyncio.run(Automation([input("Command (e.g. 'open notepad'): ")])))
