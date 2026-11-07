"""Experiment: a short live conversation by Jarvis on a call running through Windows Phone Link.

Start a call from Phone Link on the laptop, then run this while it's connected:

    .venv\\Scripts\\python.exe tools\\laptop_call_conversation.py --goal "Ask what time they're free tomorrow"

It prints how long each step of every turn took, then a report of the call, and saves both to Data. Only call
someone who knows it's coming: Jarvis says it's an AI and that the call is being recorded.
"""
import argparse
import datetime
import io
import queue
import time
import wave

import numpy as np
import sounddevice as sd
from groq import Groq

from laptop_call_test import find_call_devices, render_speech

from Backend.config import ASSISTANT_NAME, DATA_DIR, GROQ_API_KEY, GROQ_ROUTER_MODEL, USERNAME

DEFAULT_GOAL = f"This is a test call. Ask how their day is going and whether they have a message for {USERNAME}."
MAX_TURNS = 6
END_MARK = "[END]"
SPEECH_LEVEL = 0.02        # Louder than this counts as someone talking (0 to 1). Calls measured about 0.1 for speech.
END_OF_SPEECH_SECONDS = 0.9
NO_SPEECH_SECONDS = 10
ECHO_SECONDS = 0.3         # What's heard straight after Jarvis stops is ignored, in case it's its own echo.
START_SECONDS = 1.5        # The call's audio takes a moment to start, and the first second can be lost.


class SpeechDetector:
    """Collects one person's turn from chunks of audio: from when they start talking until they stop."""

    def __init__(self, rate, level=SPEECH_LEVEL, end_seconds=END_OF_SPEECH_SECONDS, longest_seconds=20,
                 min_speech_seconds=0.15, lead_in_seconds=0.3):
        self.rate, self.level = rate, level
        self.end_samples = int(end_seconds * rate)
        self.longest_samples = int(longest_seconds * rate)
        self.min_speech_samples = int(min_speech_seconds * rate)
        self.lead_in_samples = int(lead_in_seconds * rate)
        self.lead_in, self.speech = [], []
        self.loud_samples = self.quiet_samples = self.total_samples = 0

    @property
    def talking(self):
        return self.loud_samples >= self.min_speech_samples

    def feed(self, chunk):
        """Returns the finished turn's audio, or None while it's still going."""
        loud = np.sqrt(np.mean(np.square(chunk))) >= self.level
        if not self.talking:
            # Clicks are too short to count as talking, so keep only a little audio until it's clearly speech.
            self.lead_in.append(chunk)
            while sum(map(len, self.lead_in)) > self.lead_in_samples + self.min_speech_samples:
                self.lead_in.pop(0)
            self.loud_samples = self.loud_samples + len(chunk) if loud else 0
            if self.talking:
                self.speech, self.lead_in = self.lead_in, []
                self.total_samples = sum(map(len, self.speech))
            return None
        self.speech.append(chunk)
        self.total_samples += len(chunk)
        self.quiet_samples = 0 if loud else self.quiet_samples + len(chunk)
        if self.quiet_samples >= self.end_samples or self.total_samples >= self.longest_samples:
            return np.concatenate(self.speech)
        return None


def to_wav(audio, rate):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    return buffer.getvalue()


def instructions(goal):
    return (
        f"You are {ASSISTANT_NAME}, an AI assistant, speaking on a live phone call on behalf of {USERNAME}. "
        f"Your goal for this call: {goal}\n"
        "Rules:\n"
        "- You've already said you're an AI and that the call is recorded. If asked, always say again that you're an AI.\n"
        "- Speak in one or two short, natural sentences, in plain words that sound right read aloud, with no lists or symbols.\n"
        f"- Don't make promises or commitments for {USERNAME}, and don't share anything about them beyond the goal.\n"
        "- What they say may be misheard, so if it makes no sense, politely ask them to repeat it.\n"
        "- If they want to stop or don't want to talk to an AI, thank them and end the call straight away.\n"
        f"- When the goal is done or the call is ending, say goodbye and put {END_MARK} at the very end."
    )


def think(client, goal, history):
    response = client.chat.completions.create(
        model=GROQ_ROUTER_MODEL,
        messages=[{"role": "system", "content": instructions(goal)}, *history],
        temperature=0.5,
        max_completion_tokens=500,  # includes the model's reasoning, which can use most of a small budget
    )
    return (response.choices[0].message.content or "").strip() or "Sorry, could you say that again?"


def write_report(client, goal, history):
    transcript = "\n".join(
        f"{ASSISTANT_NAME if m['role'] == 'assistant' else 'Them'}: {m['content']}" for m in history
    )
    report = client.chat.completions.create(
        model=GROQ_ROUTER_MODEL,
        messages=[{"role": "user", "content": (
            f"Report this phone call to {USERNAME} in two or three sentences: what happened and what the other "
            f"person's response was. Only say what's in the transcript.\n\nGoal: {goal}\n\n{transcript}"
        )}],
        temperature=0.2,
        max_completion_tokens=500,
    ).choices[0].message.content or "(no report)"
    return transcript, report.strip()


class Call:
    def __init__(self):
        (self.mic_index, mic), (self.out_index, out) = find_call_devices()
        if not (mic and out):
            raise SystemExit("The Pixel's hands-free devices are missing. Is it connected in Phone Link?")
        self.mic_rate, self.out_rate = int(mic["default_samplerate"]), int(out["default_samplerate"])
        self.heard = queue.Queue()
        self.dropouts = 0

    def on_audio(self, chunk, frames, time_info, status):
        if status.input_overflow:
            self.dropouts += 1
        self.heard.put(chunk[:, 0].copy())

    def say(self, speech):
        """Plays speech into the call, with a moment of silence first so its start isn't clipped."""
        sd.play(np.concatenate([np.zeros(int(self.out_rate * 0.2), np.float32), speech]), self.out_rate,
                device=self.out_index, blocking=True, latency="high")

    def listen(self):
        """Waits for the other person's turn. Returns (audio, seconds waiting for them), or (None, seconds)."""
        time.sleep(ECHO_SECONDS)
        while not self.heard.empty():
            self.heard.get_nowait()
        detector, started = SpeechDetector(self.mic_rate), time.time()
        print("Listening...")
        while True:
            audio = detector.feed(self.heard.get(timeout=5))
            if audio is not None:
                return audio, time.time() - started
            if not detector.talking and time.time() - started > NO_SPEECH_SECONDS:
                return None, time.time() - started


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--goal", default=DEFAULT_GOAL)
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    call = Call()
    client = Groq(api_key=GROQ_API_KEY)
    opening = (
        f"Hello, this is {ASSISTANT_NAME}, an A I assistant calling on behalf of {USERNAME}. "
        "This call is being recorded. " + think(client, args.goal, [{
            "role": "user", "content": "(The call has just connected and you've introduced yourself. Say your first line.)",
        }]).replace(END_MARK, "")
    )
    input("\nWith the call connected, press Enter and Jarvis will start...")

    history, timings, silences = [{"role": "assistant", "content": opening}], [], 0
    block = int(call.mic_rate * 0.03)
    with sd.InputStream(device=call.mic_index, samplerate=call.mic_rate, channels=1, dtype="float32", blocksize=block,
                        callback=call.on_audio, latency="high"):
        time.sleep(START_SECONDS)
        print(f"{ASSISTANT_NAME}: {opening}")
        call.say(render_speech(opening, call.out_rate))

        for turn in range(MAX_TURNS):
            audio, waited = call.listen()
            if audio is None:
                silences += 1
                if silences == 2:
                    print("(no answer twice, ending the call)")
                    call.say(render_speech("I can't hear anyone, so I'll end the call here. Goodbye.", call.out_rate))
                    history.append({"role": "assistant", "content": "I can't hear anyone, so I'll end the call here. Goodbye."})
                    break
                call.say(render_speech("Sorry, are you still there?", call.out_rate))
                continue
            silences = 0

            t0 = time.time()
            text = client.audio.transcriptions.create(
                file=("call.wav", to_wav(audio, call.mic_rate)), model="whisper-large-v3-turbo", language=args.language,
            ).text.strip()
            t1 = time.time()
            print(f"Them: {text}")
            history.append({"role": "user", "content": text or "(something too unclear to make out)"})
            reply = think(client, args.goal, history)
            t2 = time.time()
            ending = END_MARK in reply or turn == MAX_TURNS - 1
            reply = reply.replace(END_MARK, "").strip() or "Thank you. Goodbye."
            speech = render_speech(reply, call.out_rate)
            t3 = time.time()
            timings.append((t1 - t0, t2 - t1, t3 - t2))
            print(f"{ASSISTANT_NAME}: {reply}")
            print(f"  [{t1 - t0:.1f}s hearing, {t2 - t1:.1f}s thinking, {t3 - t2:.1f}s voice = "
                  f"{t3 - t0:.1f}s, plus {END_OF_SPEECH_SECONDS}s to notice they'd stopped]")
            history.append({"role": "assistant", "content": reply})
            call.say(speech)
            if ending:
                break

    transcript, report = write_report(client, args.goal, history)
    lines = [f"Goal: {args.goal}", "", transcript, "", f"Report: {report}", "", f"Audio dropouts: {call.dropouts}"]
    if timings:
        average = np.mean([sum(t) for t in timings]) + END_OF_SPEECH_SECONDS
        lines.append(f"Average pause before Jarvis replied: {average:.1f}s (slowest {max(map(sum, timings)) + END_OF_SPEECH_SECONDS:.1f}s)")
    path = DATA_DIR / f"call_{datetime.datetime.now():%Y%m%d_%H%M%S}.txt"
    path.write_text("\n".join(lines), encoding="utf-8")
    print("\n" + "\n".join(lines[-4:] if not timings else lines[-5:]))
    print(f"\nSaved to {path}")


if __name__ == "__main__":
    main()
