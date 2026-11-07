import speech_recognition as sr

recognizer = sr.Recognizer()


def listen_to_speech(timeout=5, phrase_time_limit=15):
    """Record one phrase from the default microphone and return it as text (or None)."""
    try:
        with sr.Microphone() as source:
            print("Listening for your command...")
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            audio = recognizer.listen(source, timeout=timeout, phrase_time_limit=phrase_time_limit)
    except sr.WaitTimeoutError:
        print("No speech detected.")
        return None
    except OSError as e:
        print(f"Microphone error: {e}")
        return None

    try:
        print("Recognizing...")
        speech_text = recognizer.recognize_google(audio)
        print(f"Recognized: {speech_text}")
        return speech_text
    except sr.UnknownValueError:
        print("Sorry, I couldn't understand that.")
        return None
    except sr.RequestError as e:
        print(f"Error with the speech recognition service: {e}")
        return None


if __name__ == "__main__":
    while True:
        text = listen_to_speech()
        if text:
            print(text)
