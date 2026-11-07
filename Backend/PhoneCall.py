"""Jarvis making a phone call on the user's own number, through Windows Phone Link.

The desktop app runs this as its own process when asked to call someone (see CloudAssistant.py). To try it on a
call you've already started in Phone Link:

    .venv\\Scripts\\python.exe -m Backend.PhoneCall --goal "Ask what time they're free tomorrow"

Jarvis always says it's an AI and that the call is being recorded. What the other person says is saved in Data.
"""
import argparse
import asyncio
import datetime
import io
import itertools
import json
import os
import queue
import re
import time
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor

import edge_tts
import numpy as np
import sounddevice as sd
from groq import APIError, Groq
from pedalboard.io import AudioFile

from Backend.config import (
    ASSISTANT_NAME, ASSISTANT_VOICE, DATA_DIR, GROQ_API_KEY, GROQ_CHAT_MODEL, GROQ_ROUTER_MODEL, USERNAME, VOICE_PITCH, VOICE_RATE,
)

DEFAULT_GOAL = f"This is a test call. Ask how their day is going and whether they have a message for {USERNAME}."
MAX_TURNS = 6
REASONING_EFFORT = "low"   # Less hidden reasoning means a faster reply and fewer tokens used.
AI_TIMEOUT_SECONDS = 8
BACKUP_MODEL = "@cf/openai/gpt-oss-120b"
END_MARK = "[END]"
SPEECH_LEVEL = 0.02        # Louder than this counts as someone talking (0 to 1). Calls measured about 0.1 for speech.
END_OF_SPEECH_SECONDS = 1.0
NO_SPEECH_SECONDS = 10
ECHO_SECONDS = 0.3         # What's heard straight after Jarvis stops is ignored, in case it's its own echo.
START_SECONDS = 1.5        # The call's audio takes a moment to start, and the first second can be lost.
RING_SECONDS = 60          # How long to wait for someone to answer.
AUDIO_START_SECONDS = 25   # The call's audio devices may not be usable until the call is under way.
# Ringing and caller tunes are as loud as speech, so an answer only counts once a greeting is recognised.
GREETING = re.compile(r"\b(hello|hallo|helo|hi|hey|haan|han|ji|yes|yeah|speaking|who|kaun|ke|bolo|boliye)\b", re.I)
# Said as soon as they stop talking, since a real reply takes a couple of seconds. Made before the call, so instant.
ACKNOWLEDGEMENTS = ("Right.", "I see.", "Understood.", "Very good.")
UNCLEAR_MARK = "[unclear]"
COULD_NOT_HEAR = "(Jarvis couldn't make out what they said.)"
COMPARE_RECOGNISERS = (
    "Two speech recognisers listened to the same short phone audio, and either may be wrong or invented. The speaker may use "
    "English, Bengali, Hindi or a mix. Jarvis has just asked them this: {asked}\n"
    "Recogniser A translated it into English. Recogniser B wrote it in Bengali script, and turns English speech into nonsense.\n"
    "A: {a}\nB: {b}\n"
    "Reply with what they most likely said, in natural English. Only do this if A and B support each other, or if A is plainly "
    "a sensible direct answer and B is obvious nonsense. If they conflict or you aren't confident, reply only: [unclear]. "
    "Reply with nothing else."
)
CANT_CONTINUE = f"I'm sorry, I'm having a technical problem, so I'll have to end the call here. Goodbye. {END_MARK}"


class CallFailed(Exception):
    pass


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


def render_speech(text, rate):
    """Renders speech in the Jarvis voice at the device's sample rate."""
    path = DATA_DIR / "call_speech.mp3"
    asyncio.run(edge_tts.Communicate(text, ASSISTANT_VOICE, rate=VOICE_RATE, pitch=VOICE_PITCH).save(str(path)))
    with AudioFile(str(path)) as f:
        audio, source_rate = f.read(f.frames).mean(axis=0), f.samplerate
    length = int(len(audio) * rate / source_rate)
    return np.interp(np.linspace(0, len(audio) - 1, length), np.arange(len(audio)), audio).astype(np.float32)


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
        f"- If you're told you couldn't make out what they said, apologise and ask them to say it again, in English if they can. If that happens twice in a row, say you'll let {USERNAME} know and that they can listen to the recording, then say goodbye. Never guess at what they said.\n"
        "- You speak English, but they may speak Bengali, Hindi or a mix, and what you see is already translated. Always reply in English.\n"
        "- You only have a machine transcript of phone audio, so words are often misheard. Work out what they probably said from the question you asked. If you're unsure, check your best guess, like: Did you say you're free? Don't just ask them to repeat it.\n"
        "- Their answer is theirs to give. Never argue with it or say it seems wrong. If it seems odd, check it once, then accept it and say you'll pass it on.\n"
        "- If they want to stop or don't want to talk to an AI, thank them and end the call straight away.\n"
        f"- Only when the goal is done or the call is ending, say goodbye and put {END_MARK} at the very end. A reply either asks something or says goodbye, never both."
    )


def usable(text):
    """The model's text, unless its hidden reasoning has leaked in, which must never be read out on a call."""
    text = (text or "").strip()
    return None if "<|" in text or text.lower().startswith("analysis") else text or None


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
            text = usable(response.choices[0].message.content)
            if text:
                return text
            print(f"  ({model} returned nothing usable, trying again)")
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
            return usable(json.load(response)["choices"][0]["message"].get("content"))
    except (OSError, KeyError, ValueError) as e:
        print(f"  (the backup failed too: {str(e)[:120]})")
        return None


def think(client, goal, history):
    return ask(client, [{"role": "system", "content": instructions(goal)}, *history]) or CANT_CONTINUE


def wants_to_end(reply):
    """A reply can't both ask something and hang up: the other person needs the chance to answer."""
    return END_MARK in reply and "?" not in reply and "let me know" not in reply.lower()


def recognise(client, audio, rate, asked):
    """What they said, in English, from speech in English, Bengali or a mix; or None if it can't be trusted.

    Speech recognition on phone audio can invent believable sentences, and a made-up answer in a report is worse
    than none. So two recognisers listen, and an answer only counts if they support each other.
    Returns (English or None, what each recogniser heard).
    """
    wav = to_wav(audio, rate)

    def listen(create, **options):
        try:
            return create(file=("call.wav", wav), model="whisper-large-v3", **options).text.strip()
        except APIError as e:
            print(f"  (a recogniser failed: {str(e)[:120]})")
            return ""

    with ThreadPoolExecutor(2) as pool:
        english = pool.submit(listen, client.audio.translations.create)
        bengali = pool.submit(listen, client.audio.transcriptions.create, language="bn")
        english, bengali = english.result(), bengali.result()
    heard = f"A: {english} | B: {bengali}"
    if not (english and bengali):
        return None, heard
    answer = ask(client, [{"role": "user", "content": COMPARE_RECOGNISERS.format(asked=asked, a=english, b=bengali)}], 0.1)
    return (None if not answer or UNCLEAR_MARK in answer else answer), heard


def hear_and_reply(client, goal, history, audio, rate, out_rate):
    """One turn's slow work: returns (what they said, what was heard, the reply, its audio, seconds for each step)."""
    t0 = time.time()
    text, heard = recognise(client, audio, rate, history[-1]["content"])
    t1 = time.time()
    reply = think(client, goal, [*history, {"role": "user", "content": text or COULD_NOT_HEAR}])
    t2 = time.time()
    speech = render_speech(reply.replace(END_MARK, "").strip() or "Thank you. Goodbye.", out_rate)
    return text, heard, reply, speech, (t1 - t0, t2 - t1, time.time() - t2)


def write_report(client, goal, history):
    transcript = "\n".join(
        f"{ASSISTANT_NAME if m['role'] == 'assistant' else 'Them'}: {m['content']}" for m in history
    )
    report = ask(client, [{"role": "user", "content": (
        f"Report this phone call to {USERNAME} in two or three sentences: what happened and what the other "
        f"person's response was. {USERNAME} wasn't on the call: 'Them' is the person {ASSISTANT_NAME} called, whose name "
        f"you don't know, so call them the other person and address {USERNAME} as you. Only say what's in the transcript, and don't describe anything as agreed "
        f"unless it clearly was. The transcript is machine-heard phone audio, so odd wording is probably a "
        f"mishearing and not their mistake: never criticise them for it, and say which answers are uncertain. "
        f"Where it says {ASSISTANT_NAME} couldn't make out what they said, say so plainly and suggest listening to the "
        f"recording; never guess what it was.\n\nGoal: {goal}\n\n{transcript}"
    )}], temperature=0.2)
    return transcript, report or "(The report couldn't be written, but the transcript above is complete.)"


class Call:
    def __init__(self):
        (self.mic_index, mic), (self.out_index, out) = find_call_devices()
        if not (mic and out):
            raise CallFailed("your Pixel isn't connected to the laptop in Phone Link")
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

    def listen(self, no_speech_seconds=NO_SPEECH_SECONDS, **detector_options):
        """Waits for the other person's turn. Returns its audio, or None if nobody spoke or the call has gone quiet."""
        time.sleep(ECHO_SECONDS)
        while not self.heard.empty():
            self.heard.get_nowait()
        detector, started = SpeechDetector(self.mic_rate, **detector_options), time.time()
        print("Listening...")
        while True:
            try:
                audio = detector.feed(self.heard.get(timeout=5))
            except queue.Empty:
                return None
            if audio is not None:
                return audio
            if not detector.talking and time.time() - started > no_speech_seconds:
                return None

    def open_input(self):
        """Starts hearing the call. Its audio devices can refuse until the call is under way, so keep trying."""
        deadline = time.time() + AUDIO_START_SECONDS
        while True:
            try:
                stream = sd.InputStream(device=self.mic_index, samplerate=self.mic_rate, channels=1, dtype="float32",
                                        blocksize=int(self.mic_rate * 0.03), callback=self.on_audio, latency="high")
                stream.start()
                return stream
            except sd.PortAudioError as e:
                if time.time() > deadline:
                    raise CallFailed(f"the call's audio never became available ({e})") from None
                time.sleep(1)


def is_greeting(text):
    return bool(GREETING.search(text))


def wait_for_answer(call, heard_words):
    """True once someone says hello. `heard_words` turns audio into text."""
    deadline = time.time() + RING_SECONDS
    while time.time() < deadline:
        audio = call.listen(no_speech_seconds=max(deadline - time.time(), 1), end_seconds=0.5, longest_seconds=5)
        if audio is None:
            continue
        words = heard_words(audio)
        print(f"Heard while waiting: {words!r}")
        if is_greeting(words):
            return True
        time.sleep(2)  # the recogniser allows about 20 requests a minute, and a call needs them later
    return False


def dial(number):
    """Asks Phone Link to call a number. It's the app registered for tel: links."""
    try:
        os.startfile(f"tel:{number}")
    except OSError as e:
        raise CallFailed(f"Phone Link wouldn't start the call ({e})") from None


def run_call(goal, number=None):
    """Holds the call and returns {"outcome": "done" | "no_answer", "report", "transcript"}. Raises CallFailed.

    With a number, Jarvis dials and waits for someone to say hello. Without one, it joins a call already under way.
    """
    call = Call()
    client = Groq(api_key=GROQ_API_KEY, max_retries=0, timeout=AI_TIMEOUT_SECONDS)
    # Everything that could fail comes before dialling: nobody should answer to find Jarvis has nothing to say.
    first_line = ask(client, [
        {"role": "system", "content": instructions(goal)},
        {"role": "user", "content": "(The call has just connected and you've introduced yourself. Say your first line.)"},
    ])
    if not first_line:
        raise CallFailed("the AI isn't available, probably because its free limits are used up")
    opening = (
        f"Hello, this is {ASSISTANT_NAME}, an A I assistant calling on behalf of {USERNAME}. "
        "This call is being recorded. " + first_line.replace(END_MARK, "")
    )
    opening_speech = render_speech(opening, call.out_rate)
    acknowledgements = itertools.cycle([render_speech(a, call.out_rate) for a in ACKNOWLEDGEMENTS])

    if number:
        print(f"Dialling {number}")
        dial(number)
    else:
        input("\nWith the call connected, press Enter and Jarvis will start...")

    history, timings, silences = [{"role": "assistant", "content": opening}], [], 0
    call_started, recognised = datetime.datetime.now(), []
    stream = call.open_input()
    try:
        with ThreadPoolExecutor(1) as background:
            if number:
                heard_words = lambda audio: client.audio.transcriptions.create(
                    file=("call.wav", to_wav(audio, call.mic_rate)), model="whisper-large-v3-turbo", language="en",
                ).text
                try:
                    answered = wait_for_answer(call, heard_words)
                except APIError as e:
                    raise CallFailed(f"couldn't listen for an answer ({str(e)[:120]})") from None
                if not answered:
                    return {
                        "outcome": "no_answer", "transcript": "",
                        "report": f"Nobody seemed to answer within {RING_SECONDS} seconds. If the call is still going, please end it in Phone Link.",
                    }
            else:
                time.sleep(START_SECONDS)
            print(f"{ASSISTANT_NAME}: {opening}")
            call.say(opening_speech)

            for turn in range(MAX_TURNS):
                audio = call.listen()
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

                (DATA_DIR / f"call_{call_started:%Y%m%d_%H%M%S}_turn{turn + 1}.wav").write_bytes(to_wav(audio, call.mic_rate))
                started = time.time()
                work = background.submit(hear_and_reply, client, goal, history, audio, call.mic_rate, call.out_rate)
                call.say(next(acknowledgements))
                text, heard, reply, speech, steps = work.result()
                recognised.append(f"{turn + 1}. {heard}")
                pause = time.time() - started + END_OF_SPEECH_SECONDS
                timings.append((*steps, pause))
                print(f"Them: {text or COULD_NOT_HEAR}")
                history.append({"role": "user", "content": text or COULD_NOT_HEAR})
                ending = wants_to_end(reply) or turn == MAX_TURNS - 1
                reply = reply.replace(END_MARK, "").strip() or "Thank you. Goodbye."
                print(f"{ASSISTANT_NAME}: {reply}")
                print(f"  [{steps[0]:.1f}s hearing, {steps[1]:.1f}s thinking, {steps[2]:.1f}s voice; {pause:.1f}s until the full reply]")
                history.append({"role": "assistant", "content": reply})
                call.say(speech)
                if ending:
                    break
    finally:
        stream.close()

    transcript, report = write_report(client, goal, history)
    lines = [f"Goal: {goal}", "", transcript, "", f"Report: {report}", "", "What each recogniser heard:", *recognised,
             "", f"Audio dropouts: {call.dropouts}"]
    if timings:
        average = lambda step: np.mean([t[step] for t in timings])
        lines.append(f"Average: {average(0):.1f}s hearing, {average(1):.1f}s thinking, {average(2):.1f}s voice")
        lines.append(f"Average pause until the full reply: {average(3):.1f}s (slowest {max(t[3] for t in timings):.1f}s)")
    path = DATA_DIR / f"call_{datetime.datetime.now():%Y%m%d_%H%M%S}.txt"
    path.write_text("\n".join(lines), encoding="utf-8")
    print("\n" + "\n".join(lines[lines.index(f"Report: {report}"):]))
    print(f"\nSaved to {path}")
    return {"outcome": "done", "report": report, "transcript": transcript}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--goal", required=True)
    parser.add_argument("--number", help="Dial this number. Without it, Jarvis joins a call already under way.")
    parser.add_argument("--result", help="Write the outcome to this JSON file.")
    args = parser.parse_args()
    try:
        result = run_call(args.goal, args.number)
    except CallFailed as e:
        print(f"The call failed: {e}")
        result = {"outcome": "failed", "report": f"I couldn't make the call: {e}.", "transcript": ""}
    if args.result:
        with open(args.result, "w", encoding="utf-8") as f:
            json.dump(result, f)


if __name__ == "__main__":
    main()
