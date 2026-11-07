"""Experiment: can Jarvis talk and listen on a call running through Windows Phone Link?

Start a call from Phone Link on the laptop, then run this while it's connected:

    .venv\\Scripts\\python.exe tools\\laptop_call_test.py

`--check` only lists the audio devices and doesn't play or record anything. Only call someone who knows it's
coming: Jarvis says it's an AI and that the call is being recorded.
"""
import asyncio
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import edge_tts
import numpy as np
import sounddevice as sd
from groq import Groq
from pedalboard.io import AudioFile

from Backend.config import ASSISTANT_NAME, ASSISTANT_VOICE, DATA_DIR, GROQ_API_KEY, USERNAME, VOICE_PITCH, VOICE_RATE

LISTEN_SECONDS = 10
MESSAGE = (
    f"Hello, this is {ASSISTANT_NAME}, an A I assistant calling on behalf of {USERNAME}. "
    "This is a test call and this call is being recorded. Please say a few words after this message."
)


def find_call_devices():
    """The Pixel's hands-free devices. WASAPI is preferred: it's the host API that handles Bluetooth calls best."""
    wasapi = next((i for i, api in enumerate(sd.query_hostapis()) if "WASAPI" in api["name"]), None)
    candidates = {"input": [], "output": []}
    for index, device in enumerate(sd.query_devices()):
        name = device["name"].lower()
        if "hands-free" not in name or "pixel" not in name:
            continue
        rank = 0 if device["hostapi"] == wasapi else 1
        if device["max_input_channels"]:
            candidates["input"].append((rank, index, device))
        if device["max_output_channels"]:
            candidates["output"].append((rank, index, device))
    pick = lambda found: min(found, key=lambda c: c[:2])[1:] if found else (None, None)
    return pick(candidates["input"]), pick(candidates["output"])


def load_message(rate):
    """Renders the message and converts it to the device's sample rate."""
    path = DATA_DIR / "laptop_call_message.mp3"
    asyncio.run(edge_tts.Communicate(MESSAGE, ASSISTANT_VOICE, rate=VOICE_RATE, pitch=VOICE_PITCH).save(str(path)))
    with AudioFile(str(path)) as f:
        audio, source_rate = f.read(f.frames).mean(axis=0), f.samplerate
    length = int(len(audio) * rate / source_rate)
    return np.interp(np.linspace(0, len(audio) - 1, length), np.arange(len(audio)), audio).astype(np.float32)


def main():
    (mic_index, mic), (out_index, out) = find_call_devices()
    print(f"Sound into the call: {out['name'] if out else 'NOT FOUND'}")
    print(f"Sound from the call: {mic['name'] if mic else 'NOT FOUND'}")
    if "--check" in sys.argv:
        return
    if not (mic and out):
        print("The Pixel's hands-free devices are missing. Is it connected in Phone Link?")
        return

    input("\nWith the call connected, press Enter and Jarvis will speak...")
    out_rate, mic_rate = int(out["default_samplerate"]), int(mic["default_samplerate"])
    message = load_message(out_rate)

    # Record throughout, so it also shows whether Jarvis's own voice comes back.
    recorded, stop = [], threading.Event()

    def on_audio(chunk, frames, time, status):
        if not stop.is_set():
            recorded.append(chunk.copy())

    with sd.InputStream(device=mic_index, samplerate=mic_rate, channels=1, dtype="float32", callback=on_audio):
        print("Speaking...")
        sd.play(message, out_rate, device=out_index, blocking=True)
        print(f"Listening for {LISTEN_SECONDS} seconds. Ask them to talk now.")
        sd.sleep(LISTEN_SECONDS * 1000)
        stop.set()

    audio = np.concatenate(recorded)[:, 0] if recorded else np.zeros(1, dtype=np.float32)
    seconds = [audio[i:i + mic_rate] for i in range(0, len(audio), mic_rate)]
    print("\nLoudest sound each second (0 to 1): " + ", ".join(f"{np.abs(s).max():.3f}" for s in seconds))

    path = DATA_DIR / "laptop_call_heard.wav"
    with AudioFile(str(path), "w", mic_rate, 1) as f:
        f.write(audio[np.newaxis, :])
    print(f"Recording saved to {path}")

    if GROQ_API_KEY:
        with open(path, "rb") as f:
            text = Groq(api_key=GROQ_API_KEY).audio.transcriptions.create(
                file=("call.wav", f.read()), model="whisper-large-v3-turbo"
            ).text
        print(f'\nJarvis heard: "{text.strip() or "(no words)"}"')
    print("\nNow ask them: did they hear Jarvis clearly?")


if __name__ == "__main__":
    main()
