import asyncio
import random
import re

import edge_tts
import pygame

from Backend.config import ASSISTANT_VOICE, SPEECH_PATH


async def TextToAudioFile(text) -> None:
    communicate = edge_tts.Communicate(text, ASSISTANT_VOICE, pitch="+5Hz", rate="+13%")
    await communicate.save(str(SPEECH_PATH))


def TTS(Text, func=lambda r=None: True, retries: int = 2):
    for attempt in range(retries + 1):
        try:
            # Release the file from any previous playback before overwriting it.
            if pygame.mixer.get_init():
                pygame.mixer.quit()
            asyncio.run(TextToAudioFile(Text))

            pygame.mixer.init()
            pygame.mixer.music.load(str(SPEECH_PATH))
            pygame.mixer.music.play()

            clock = pygame.time.Clock()
            while pygame.mixer.music.get_busy():
                if func() is False:
                    break
                clock.tick(10)
            return True
        except Exception as e:
            print(f"Error in TTS (attempt {attempt + 1}): {e}")
        finally:
            try:
                func(False)
                if pygame.mixer.get_init():
                    pygame.mixer.music.stop()
                    pygame.mixer.music.unload()
                    pygame.mixer.quit()
            except Exception as e:
                print(f"Error in TTS cleanup: {e}")
    return False


responses = [
    "The rest of the result has been printed to the chat screen, kindly check it out sir.",
    "The rest of the text is now on the chat screen, sir, please check it.",
    "You can see the rest of the text on the chat screen, sir.",
    "The remaining part of the text is now on the chat screen, sir.",
    "Sir, you'll find more text on the chat screen for you to see.",
    "The rest of the answer is now on the chat screen, sir.",
    "Sir, please look at the chat screen, the rest of the answer is there.",
    "You'll find the complete answer on the chat screen, sir.",
    "Sir, please check the chat screen for more information.",
    "Sir, look at the chat screen for the complete answer.",
]


def split_sentences(text):
    # Split on . ! ? followed by whitespace, so numbers like 3.14 stay intact.
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def TextToSpeech(Text, func=lambda r=None: True):
    Text = str(Text)
    sentences = split_sentences(Text)

    if len(sentences) > 4 and len(Text) >= 250:
        return TTS(" ".join(sentences[:2]) + " " + random.choice(responses), func)
    return TTS(Text, func)


if __name__ == "__main__":
    while True:
        TextToSpeech(input("Enter the text: "))
