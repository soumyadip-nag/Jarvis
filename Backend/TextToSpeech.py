"""Text to speech with a J.A.R.V.I.S.-style voice.

1. edge-tts renders a calm British voice (en-GB-RyanNeural by default).
2. If `pedalboard` is installed and VOICE_FX is on, a subtle effects chain is applied:
   low-cut, gentle compression, a touch of chorus and a very short room reverb.
   That faint "processed" quality is a big part of the movie-AI feel.
3. pygame plays the result. Playback can be interrupted via the `func` callback.
"""
import asyncio
import re

import edge_tts
import pygame

from Backend.config import (
    ASSISTANT_VOICE, VOICE_RATE, VOICE_PITCH, VOICE_FX, SPEECH_PATH, SPEECH_FX_PATH,
)
from Backend.Personality import MORE_ON_SCREEN, pick

try:
    from pedalboard import (
        Pedalboard, HighpassFilter, LowShelfFilter, HighShelfFilter, Compressor, Chorus, Reverb, Gain,
    )
    from pedalboard.io import AudioFile

    VOICE_BOARD = Pedalboard([
        HighpassFilter(cutoff_frequency_hz=90),
        LowShelfFilter(cutoff_frequency_hz=220, gain_db=2.0),      # a little more chest
        HighShelfFilter(cutoff_frequency_hz=6500, gain_db=2.5),     # crisp, "digital" air
        Compressor(threshold_db=-20, ratio=3, attack_ms=5, release_ms=120),
        Chorus(rate_hz=0.35, depth=0.12, centre_delay_ms=7.0, feedback=0.0, mix=0.12),
        Reverb(room_size=0.12, damping=0.6, wet_level=0.07, dry_level=0.95, width=0.6),
        Gain(gain_db=1.0),
    ])
except Exception:  # pedalboard is optional
    VOICE_BOARD = None


async def TextToAudioFile(text) -> None:
    communicate = edge_tts.Communicate(text, ASSISTANT_VOICE, rate=VOICE_RATE, pitch=VOICE_PITCH)
    await communicate.save(str(SPEECH_PATH))


def apply_voice_fx(src=SPEECH_PATH, dst=SPEECH_FX_PATH):
    """Apply the effects chain. Returns the file to play (original if FX unavailable)."""
    if not (VOICE_FX and VOICE_BOARD):
        return src
    try:
        with AudioFile(str(src)) as f:
            audio = f.read(f.frames)
            samplerate = f.samplerate
        processed = VOICE_BOARD(audio, samplerate)
        with AudioFile(str(dst), "w", samplerate, processed.shape[0]) as f:
            f.write(processed)
        return dst
    except Exception as e:
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
