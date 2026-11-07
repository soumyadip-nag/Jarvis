"""Text to speech with a J.A.R.V.I.S.-style voice.

1. edge-tts renders a calm British voice (en-GB-RyanNeural by default).
2. If `pedalboard` is installed and VOICE_FX is on, a subtle effects chain is applied (see VoiceFx.py):
   low-cut, gentle compression, a touch of chorus and a very short room reverb.
   That faint "processed" quality is a big part of the movie-AI feel.
3. pygame plays the result. Playback can be interrupted via the `func` callback.
"""
import asyncio
import re
import subprocess
import sys
from pathlib import Path

import edge_tts
import pygame

from Backend.config import (
    ASSISTANT_VOICE, VOICE_RATE, VOICE_PITCH, VOICE_FX, SPEECH_PATH, SPEECH_FX_PATH,
)
from Backend.Personality import MORE_ON_SCREEN, pick

FX_SCRIPT = Path(__file__).with_name("VoiceFx.py")
FX_TIMEOUT_SECONDS = 8


async def TextToAudioFile(text) -> None:
    communicate = edge_tts.Communicate(text, ASSISTANT_VOICE, rate=VOICE_RATE, pitch=VOICE_PITCH)
    await communicate.save(str(SPEECH_PATH))


def apply_voice_fx(src=SPEECH_PATH, dst=SPEECH_FX_PATH):
    """Apply the effects in their own process, so they can't crash or freeze the app.

    Returns the file to play: the plain voice if the effects fail or take too long.
    """
    if not VOICE_FX:
        return src
    try:
        subprocess.run(
            [sys.executable, str(FX_SCRIPT), str(src), str(dst)],
            check=True, capture_output=True, text=True, timeout=FX_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return dst
    except subprocess.CalledProcessError as e:
        print(f"Voice FX skipped: {e.stderr.strip()[-300:]}")
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"Voice FX skipped: {e}")
    return src


def _release_mixer():
    if pygame.mixer.get_init():
        pygame.mixer.music.stop()
        try:
            pygame.mixer.music.unload()
        except Exception:
            pass
        pygame.mixer.quit()


def TTS(Text, func=lambda r=None: True, retries: int = 2):
    """Speak `Text`. `func()` is polled during playback; returning False stops speaking."""
    for attempt in range(retries + 1):
        try:
            _release_mixer()  # free the audio file before overwriting it
            asyncio.run(TextToAudioFile(Text))
            path = apply_voice_fx()

            pygame.mixer.init()
            pygame.mixer.music.load(str(path))
            pygame.mixer.music.play()

            clock = pygame.time.Clock()
            while pygame.mixer.music.get_busy():
                if func() is False:
                    break
                clock.tick(20)
            return True
        except Exception as e:
            print(f"Error in TTS (attempt {attempt + 1}): {e}")
        finally:
            try:
                func(False)
                _release_mixer()
            except Exception as e:
                print(f"Error in TTS cleanup: {e}")
    return False


def split_sentences(text):
    # Split on . ! ? followed by whitespace, so numbers like 3.14 stay intact.
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def TextToSpeech(Text, func=lambda r=None: True):
    """Speak short answers fully; for long ones speak the first two sentences and point at the screen."""
    Text = str(Text)
    sentences = split_sentences(Text)

    if len(sentences) > 4 and len(Text) >= 250:
        return TTS(" ".join(sentences[:2]) + " " + pick(MORE_ON_SCREEN), func)
    return TTS(Text, func)


if __name__ == "__main__":
    while True:
        TextToSpeech(input("Enter the text: "))
