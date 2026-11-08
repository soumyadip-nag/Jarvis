"""Listens for "Hey Jarvis", offline, on the laptop's microphone.

It uses openWakeWord's free "hey jarvis" model (github.com/dscripka/openWakeWord; the models are for
non-commercial use), run directly with onnxruntime. The openwakeword package itself isn't used, because
Windows Smart App Control blocks a library it loads. The desktop app runs this as its own process:

    python -m Backend.WakeWord        prints "WAKE <score>" each time it hears the phrase

The models are downloaded into Data/wakeword the first time.
"""
import sys
import time
import urllib.request
from collections import deque

import numpy as np

from Backend.config import DATA_DIR

MODELS = DATA_DIR / "wakeword"
RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
FILES = ("melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx")
RATE = 16000
CHUNK = 1280            # 80 ms: the step the models were built for
THRESHOLD = 0.35  # ordinary speech scores under 0.1; an accented "Hey Jarvis" can be 0.4 to 0.7
QUIET_AFTER_WAKE = 2.0  # seconds: one "Hey Jarvis" shouldn't count twice


def download_models():
    MODELS.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        path = MODELS / name
        if not path.exists():
            urllib.request.urlretrieve(RELEASE + name, path)


class Detector:
    """Feed it 80 ms of 16 kHz audio at a time; it returns how sure it is that "Hey Jarvis" was just said (0 to 1).

    The same steps as openWakeWord: audio to a mel spectrogram, every 76 spectrogram frames to a speech embedding,
    and the last 16 embeddings to the "hey jarvis" score.
    """

    def __init__(self):
        import onnxruntime as ort
        download_models()
        options = ort.SessionOptions()
        options.inter_op_num_threads = options.intra_op_num_threads = 1  # it runs all day, so stay light
        load = lambda name: ort.InferenceSession(str(MODELS / name), options, providers=["CPUExecutionProvider"])
        self.mel, self.embed, self.wake = (load(name) for name in FILES)
        self.reset()

    def reset(self):
        self.audio = deque(maxlen=RATE * 10)
        self.mels = np.ones((76, 32), dtype=np.float32)
        noise = np.random.randint(-1000, 1000, RATE * 4).astype(np.int16)
        self.features = deque(self._embeddings(noise), maxlen=120)
        self.warmup = 5

    def _mel(self, samples):
        x = samples.astype(np.float32)[None, :]
        return self.mel.run(None, {"input": x})[0].squeeze() / 10 + 2

    def _embeddings(self, samples):
        mels = self._mel(samples)
        windows = [mels[i:i + 76] for i in range(0, mels.shape[0] - 76, 8)]
        batch = np.array(windows, dtype=np.float32)[:, :, :, None]
        return list(self.embed.run(None, {"input_1": batch})[0].squeeze(axis=(1, 2)))

    def process(self, chunk):
        """`chunk` is 1280 int16 samples. Returns the score for the audio heard so far."""
        self.audio.extend(chunk)
        recent = np.array(list(self.audio)[-(CHUNK + 160 * 3):], dtype=np.int16)
        self.mels = np.vstack([self.mels, self._mel(recent)])[-970:]
        window = self.mels[-76:].astype(np.float32)[None, :, :, None]
        self.features.append(self.embed.run(None, {"input_1": window})[0].squeeze())
        score = float(self.wake.run(None, {"x.1": np.array(list(self.features)[-16:], dtype=np.float32)[None]})[0][0][0])
        if self.warmup:
            self.warmup -= 1
            return 0.0
        return score


def main():
    import queue

    import sounddevice as sd

    detector = Detector()
    heard = queue.Queue()
    last_wake = 0.0
    print("READY", flush=True)
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK, callback=lambda d, f, t, s: heard.put(d[:, 0].copy())):
        while True:
            score = detector.process(heard.get())
            if score >= THRESHOLD and time.time() - last_wake > QUIET_AFTER_WAKE:
                last_wake = time.time()
                print(f"WAKE {score:.2f}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
