"""The Jarvis voice effects, run as their own process: python VoiceFx.py <input> <output>

pedalboard has crashed and frozen the app when loaded alongside PyQt5, so it stays out of the app's process.
This only imports pedalboard, to start quickly.
"""
import sys

from pedalboard import Chorus, Compressor, Gain, HighpassFilter, HighShelfFilter, LowShelfFilter, Pedalboard, Reverb
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

if __name__ == "__main__":
    source, target = sys.argv[1:3]
    with AudioFile(source) as f:
        audio = f.read(f.frames)
        samplerate = f.samplerate
    processed = VOICE_BOARD(audio, samplerate)
    with AudioFile(target, "w", samplerate, processed.shape[0]) as f:
        f.write(processed)
