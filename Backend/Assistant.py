"""The brain: classify a request, run every task in it and build Jarvis's reply."""
import asyncio

from Backend.Model import FirstLayerDMM
from Backend.Chatbot import ChatBot
from Backend.RealtimeSearchEngine import RealtimeSearchEngine
from Backend.Automation import Automation
from Backend.ImageGeneration import GenerateImages
from Backend.Personality import ACKNOWLEDGEMENTS, FAILURES, FAREWELLS, NOT_UNDERSTOOD, pick
from Backend.config import HONORIFIC

AUTOMATION_PREFIXES = ("open ", "close ", "play ", "system ", "content ", "google search ", "youtube search ")


def handle_query(query, on_status=lambda text: None):
    """Return (reply_text, should_exit). `on_status` receives short progress messages for the UI."""
    on_status("Analysing request")
    tasks = FirstLayerDMM(query)
    print(f"Tasks: {tasks}")

    if any(t.startswith("exit") for t in tasks):
        return pick(FAREWELLS), True

    replies = []

    automation = [t for t in tasks if t.startswith(AUTOMATION_PREFIXES)]
    if automation:
        on_status("Executing: " + ", ".join(automation))
        ok = asyncio.run(Automation(automation))
        replies.append(pick(ACKNOWLEDGEMENTS) if ok else pick(FAILURES))

    for task in tasks:
        if task.startswith("generate image"):
            prompt = task.removeprefix("generate image").strip()
            on_status(f"Rendering images: {prompt}")
            count = GenerateImages(prompt)
            replies.append(
                f"I've rendered {count} image{'' if count == 1 else 's'} of {prompt}, {HONORIFIC}." if count
                else f"The image generator isn't cooperating, {HONORIFIC}."
            )
        elif task.startswith("reminder"):
            replies.append(f"Reminders aren't wired up yet, {HONORIFIC}. It's on my list.")

    # A realtime question takes priority over a general one.
    realtime = [t.removeprefix("realtime").strip() for t in tasks if t.startswith("realtime")]
    general = [t.removeprefix("general").strip() for t in tasks if t.startswith("general")]
    if realtime:
        on_status("Searching the web")
        replies.append(RealtimeSearchEngine(" and ".join(realtime)))
    elif general:
        on_status("Thinking")
        replies.append(ChatBot(" and ".join(general)))

    return "\n".join(replies) or pick(NOT_UNDERSTOOD), False
