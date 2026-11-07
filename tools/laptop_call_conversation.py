"""Experiment: a short live conversation by Jarvis on a call running through Windows Phone Link.

Start a call from Phone Link on the laptop, then run this while it's connected:

    .venv\\Scripts\\python.exe tools\\laptop_call_conversation.py --goal "Ask what time they're free tomorrow"

It prints how long each step of every turn took, then a report of the call, and saves both to Data. Only call
someone who knows it's coming: Jarvis says it's an AI and that the call is being recorded.
"""
import argparse
import datetime
import io
import itertools
import json
import os
import queue
import time
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import sounddevice as sd
from groq import APIError, Groq

from laptop_call_test import find_call_devices, render_speech

from Backend.config import ASSISTANT_NAME, DATA_DIR, GROQ_API_KEY, GROQ_CHAT_MODEL, GROQ_ROUTER_MODEL, USERNAME

DEFAULT_GOAL = f"This is a test call. Ask how their day is going and whether they have a message for {USERNAME}."
MAX_TURNS = 6
REASONING_EFFORT = "low"   # Less hidden reasoning means a faster reply and fewer tokens used.
AI_TIMEOUT_SECONDS = 8
BACKUP_MODEL = "@cf/openai/gpt-oss-120b"
END_MARK = "[END]"
SPEECH_LEVEL = 0.02        # Louder than this counts as someone talking (0 to 1). Calls measured about 0.1 for speech.
END_OF_SPEECH_SECONDS = 0.7
NO_SPEECH_SECONDS = 10
ECHO_SECONDS = 0.3         # What's heard straight after Jarvis stops is ignored, in case it's its own echo.
START_SECONDS = 1.5        # The call's audio takes a moment to start, and the first second can be lost.
# Said as soon as they stop talking, since a real reply takes a couple of seconds. Made before the call, so instant.
ACKNOWLEDGEMENTS = ("Right.", "I see.", "Understood.", "Very good.")
CANT_CONTINUE = f"I'm sorry, I'm having a technical problem, so I'll have to end the call here. Goodbye. {END_MARK}"


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
        f"It is now {datetime.datetime.now():%A %d %B %Y, %I:%M %p}. Your goal for this call: {goal}\n"
        "Rules:\n"
        "- You've already said you're an AI and that the call is recorded. If asked, always say again that you're an AI.\n"
        "- Speak in one or two short, natural sentences, in plain words that sound right read aloud, with no lists or symbols.\n"
        f"- Never agree to, confirm or promise anything for {USERNAME}: say you'll pass it on. Don't share anything about them beyond the goal.\n"
        "- If they ask something simple, like the time or a general knowledge question, answer it briefly, then return to the goal.\n"
        "- Look at what you've already said. Never ask the same thing again. If they answer vaguely or not at all, ask differently once; after that, thank them and finish.\n"
        "- Don't start with words like right, I see, understood or very good, since you've already said one.\n"
        "- What they say may be misheard, so only if it makes no sense at all, politely ask them to repeat it.\n"
        "- If they want to stop or don't want to talk to an AI, thank them and end the call straight away.\n"
        f"- Only when the goal is done or the call is ending, say goodbye and put {END_MARK} at the very end. Never put it after a question."
    )


def ask(client, messages, temperature=0.5):
    """The model's text, or None. It sometimes returns nothing, calls a tool that doesn't exist or hits the
    per-minute limit, and a call can't wait long, so this tries the other model instead of waiting."""
    for model in (GROQ_CHAT_MODEL, GROQ_ROUTER_MODEL, GROQ_CHAT_MODEL):
        try:
            response = client.chat.completions.create(
                model=model, messages=messages, temperature=temperature,
                max_completion_tokens=500,  # includes the model's reasoning, which can use most of a small budget
                reasoning_effort=REASONING_EFFORT,
            )
            text = (response.choices[0].message.content or "").strip()
            if text:
                return text
            print(f"  ({model} returned nothing, trying again)")
        except APIError as e:
            print(f"  ({model} failed, trying again: {str(e)[:120]})")
    return ask_backup(messages, temperature)


def ask_backup(messages, temperature):
    """Cloudflare's copy of the same model, for when Groq's limits are used up."""
    account, token = os.getenv("CLOUDFLARE_ACCOUNT_ID"), os.getenv("CLOUDFLARE_API_TOKEN")
    if not (account and token):
        return None
    body = {"model": BACKUP_MODEL, "messages": messages, "temperature": temperature, "max_tokens": 500, "reasoning_effort": REASONING_EFFORT}
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "jarvis-call"},
    )
    try:
        with urllib.request.urlopen(request, timeout=AI_TIMEOUT_SECONDS) as response:
            return (json.load(response)["choices"][0]["message"].get("content") or "").strip() or None
    except (OSError, KeyError, ValueError) as e:
        print(f"  (the backup failed too: {str(e)[:120]})")
        return None


def think(client, goal, history):
    return ask(client, [{"role": "system", "content": instructions(goal)}, *history]) or CANT_CONTINUE


def wants_to_end(reply):
    """A reply can't both ask something and hang up: the other person needs the chance to answer."""
    return END_MARK in reply and "?" not in reply and "let me know" not in reply.lower()


def hear_and_reply(client, args, history, audio, rate, out_rate):
    """One turn's slow work: returns (what they said, the reply, its audio, seconds for each step)."""
    t0 = time.time()
    try:
        text = client.audio.transcriptions.create(
            file=("call.wav", to_wav(audio, rate)), model="whisper-large-v3-turbo", language=args.language,
        ).text.strip()
    except APIError as e:
        print(f"  (transcribing failed: {str(e)[:120]})")
        text = ""
    t1 = time.time()
    reply = think(client, args.goal, [*history, {"role": "user", "content": text or "(something too unclear to make out)"}])
    t2 = time.time()
    speech = render_speech(reply.replace(END_MARK, "").strip() or "Thank you. Goodbye.", out_rate)
    return text, reply, speech, (t1 - t0, t2 - t1, time.time() - t2)


def write_report(client, goal, history):
    transcript = "\n".join(
        f"{ASSISTANT_NAME if m['role'] == 'assistant' else 'Them'}: {m['content']}" for m in history
    )
    report = ask(client, [{"role": "user", "content": (
        f"Report this phone call to {USERNAME} in two or three sentences: what happened and what the other "
        f"person's response was. Only say what's in the transcript, and don't describe anything as agreed "
        f"unless it clearly was.\n\nGoal: {goal}\n\n{transcript}"
    )}], temperature=0.2)
    return transcript, report or "(The report couldn't be written, but the transcript above is complete.)"


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
    client = Groq(api_key=GROQ_API_KEY, max_retries=0, timeout=AI_TIMEOUT_SECONDS)
    first_line = ask(client, [
        {"role": "system", "content": instructions(args.goal)},
        {"role": "user", "content": "(The call has just connected and you've introduced yourself. Say your first line.)"},
    ])
    if not first_line:
        raise SystemExit("The AI isn't available, probably because a Groq limit is used up, so Jarvis won't start.")
    opening = (
        f"Hello, this is {ASSISTANT_NAME}, an A I assistant calling on behalf of {USERNAME}. "
        "This call is being recorded. " + first_line.replace(END_MARK, "")
    )
    acknowledgements = itertools.cycle([render_speech(a, call.out_rate) for a in ACKNOWLEDGEMENTS])
    input("\nWith the call connected, press Enter and Jarvis will start...")

    history, timings, silences = [{"role": "assistant", "content": opening}], [], 0
    block = int(call.mic_rate * 0.03)
    with ThreadPoolExecutor(1) as background, sd.InputStream(
        device=call.mic_index, samplerate=call.mic_rate, channels=1, dtype="float32", blocksize=block,
        callback=call.on_audio, latency="high",
    ):
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

            started = time.time()
            work = background.submit(hear_and_reply, client, args, history, audio, call.mic_rate, call.out_rate)
            call.say(next(acknowledgements))
            text, reply, speech, steps = work.result()
            pause = time.time() - started + END_OF_SPEECH_SECONDS
            timings.append((*steps, pause))
            print(f"Them: {text}")
            history.append({"role": "user", "content": text or "(something too unclear to make out)"})
            ending = wants_to_end(reply) or turn == MAX_TURNS - 1
            reply = reply.replace(END_MARK, "").strip() or "Thank you. Goodbye."
            print(f"{ASSISTANT_NAME}: {reply}")
            print(f"  [{steps[0]:.1f}s hearing, {steps[1]:.1f}s thinking, {steps[2]:.1f}s voice; {pause:.1f}s until the full reply]")
            history.append({"role": "assistant", "content": reply})
            call.say(speech)
            if ending:
                break

    transcript, report = write_report(client, args.goal, history)
    lines = [f"Goal: {args.goal}", "", transcript, "", f"Report: {report}", "", f"Audio dropouts: {call.dropouts}"]
    if timings:
        average = lambda step: np.mean([t[step] for t in timings])
        lines.append(f"Average: {average(0):.1f}s hearing, {average(1):.1f}s thinking, {average(2):.1f}s voice")
        lines.append(f"Average pause until the full reply: {average(3):.1f}s (slowest {max(t[3] for t in timings):.1f}s)")
    path = DATA_DIR / f"call_{datetime.datetime.now():%Y%m%d_%H%M%S}.txt"
    path.write_text("\n".join(lines), encoding="utf-8")
    print("\n" + "\n".join(lines[lines.index(f"Report: {report}"):]))
    print(f"\nSaved to {path}")


if __name__ == "__main__":
    main()
