"""Cloud mode for the desktop app: the shared brain answers, the laptop executes its own commands."""
import asyncio
import json
import re
import subprocess
import sys
import threading
import time

from Backend.CloudSync import CloudClient, CloudError
from Backend.config import DATA_DIR, ROOT_DIR
from Backend.Personality import FAREWELLS, pick

_client = None

call_active = threading.Event()  # While it's set, the desktop app doesn't listen or speak.
# A call must happen when it was asked for: a laptop waking up later mustn't ring someone out of the blue.
CALL_REQUEST_MAX_AGE_SECONDS = 120
LONGEST_CALL_SECONDS = 15 * 60


def client():
    global _client
    if _client is None:
        _client = CloudClient()
    return _client


def run_laptop_command(command):
    """Execute a command like 'open spotify' / 'system volume up' with the existing automation code."""
    from Backend.Automation import Automation
    return asyncio.run(Automation([command]))


def show_image(image_id):
    """Download an image the cloud generated, save it in Data and open it."""
    from Backend.ImageGeneration import open_images

    path = DATA_DIR / f"jarvis_{image_id}.jpg"
    path.write_bytes(client().download_image(image_id))
    open_images([path])


def start_ai_call(cmd, cloud, on_message, on_status):
    """Runs a call that was asked for, in the background. The report goes to the shared chat on every device."""
    name, goal = cmd.get("name", "them"), cmd.get("goal", "")

    def report(text, transcript=""):
        try:
            cloud.report_call(name, text, transcript)
        except CloudError as e:
            print(f"Couldn't share the call report: {e}")
        on_message("jarvis", f"Call to {name}: {text}")

    if time.time() - cmd.get("ts", 0) / 1000 > CALL_REQUEST_MAX_AGE_SECONDS:
        report("I didn't make this call, because the request had waited too long. Please ask again.")
        return
    if call_active.is_set():
        report("I didn't make this call, because I'm already on one. Please ask again when it's finished.")
        return

    def run():
        result_path = DATA_DIR / f"call_result_{cmd.get('id', 'latest')}.json"
        on_status(f"On a call with {name}")
        on_message("jarvis", f"Calling {name}. I'll report back when the call ends.")
        try:
            # Its own process: it uses the audio library that clashes with the window's, and a crash can't take the app down.
            subprocess.run(
                [sys.executable, "-m", "Backend.PhoneCall", "--goal", goal, "--number", cmd["number"], "--result", str(result_path)],
                cwd=ROOT_DIR, check=True, timeout=LONGEST_CALL_SECONDS,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            result = json.loads(result_path.read_text(encoding="utf-8"))
            report(result["report"], result.get("transcript", ""))
        except subprocess.TimeoutExpired:
            report("I stopped this call because it ran too long. Please check that it has ended in Phone Link.")
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
            print(f"The call failed: {e}")
            report("Something went wrong during this call, so I have no report. Please check that it has ended in Phone Link.")
        finally:
            result_path.unlink(missing_ok=True)
            call_active.clear()
            on_status("Awaiting your command")

    call_active.set()
    threading.Thread(target=run, daemon=True).start()


def handle_query(query, on_status=lambda text: None):
    """Same contract as Backend.Assistant.handle_query: returns (reply_text, should_exit)."""
    if re.fullmatch(r"(bye|goodbye|exit|quit|shut ?down)( jarvis)?[.!]?", query.strip().lower()):
        return pick(FAREWELLS), True

    on_status("Consulting the cloud")
    try:
        data = client().chat(query)
    except CloudError as e:
        return f"I can't reach my cloud systems at the moment. {e}", False

    for action in data.get("actions", []):
        if action.get("type") == "laptop_command" and not action.get("queued"):
            on_status(f"Executing: {action['command']}")
            try:
                run_laptop_command(action["command"])
            except Exception as e:
                print(f"Laptop command failed: {e}")
        elif action.get("type") == "image":
            on_status("Opening image")
            try:
                show_image(action["id"])
            except Exception as e:
                print(f"Couldn't open image: {e}")
    return data["reply"]["content"], False
