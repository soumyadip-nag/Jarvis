"""Cloud mode for the desktop app: the shared brain answers, the laptop executes its own commands."""
import asyncio
import re

from Backend.CloudSync import CloudClient, CloudError
from Backend.Personality import FAREWELLS, pick

_client = None


def client():
    global _client
    if _client is None:
        _client = CloudClient()
    return _client


def run_laptop_command(command):
    """Execute a command like 'open spotify' / 'system volume up' with the existing automation code."""
    from Backend.Automation import Automation
    return asyncio.run(Automation([command]))


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
    return data["reply"]["content"], False
