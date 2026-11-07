import asyncio
import threading
import tkinter as tk
from tkinter import scrolledtext

from Backend.config import ASSISTANT_NAME
from Backend.Model import FirstLayerDMM
from Backend.Chatbot import ChatBot
from Backend.RealtimeSearchEngine import RealtimeSearchEngine
from Backend.TextToSpeech import TextToSpeech
from Backend.Automation import Automation
from Backend.ImageGeneration import GenerateImages
from Backend.SpeechToText import listen_to_speech

AUTOMATION_PREFIXES = ("open ", "close ", "play ", "system ", "content ", "google search ", "youtube search ")


def handle_query(query):
    """Classify a query, run every task in it and return the text to show/speak."""
    tasks = FirstLayerDMM(query)
    print(f"Tasks: {tasks}")

    replies = []
    automation = [t for t in tasks if t.startswith(AUTOMATION_PREFIXES)]

    if any(t == "exit" or t.startswith("exit") for t in tasks):
        return "Goodbye, sir.", True

    if automation:
        ok = asyncio.run(Automation(automation))
        replies.append("Done, sir." if ok else "I couldn't complete all of those tasks, sir.")

    for task in tasks:
        if task.startswith("generate image"):
            prompt = task.removeprefix("generate image").strip()
            count = GenerateImages(prompt)
            replies.append(f"I've generated {count} images of {prompt}." if count else "Image generation failed.")
        elif task.startswith("reminder"):
            replies.append("Reminders aren't supported yet, sir.")

    # Answer questions. A realtime question takes priority over a general one.
    realtime = [t.removeprefix("realtime").strip() for t in tasks if t.startswith("realtime")]
    general = [t.removeprefix("general").strip() for t in tasks if t.startswith("general")]
    if realtime:
        replies.append(RealtimeSearchEngine(" and ".join(realtime)))
    elif general:
        replies.append(ChatBot(" and ".join(general)))

    return "\n".join(replies) or "Sorry, I didn't understand that.", False


class JarvisGUI:
    def __init__(self, root):
        self.root = root
        self.busy = False
        self.root.title(f"{ASSISTANT_NAME} - Voice Assistant")
        self.root.geometry("600x400")

        self.chat_display = scrolledtext.ScrolledText(root, wrap=tk.WORD, state=tk.DISABLED)
        self.chat_display.pack(padx=10, pady=10, fill=tk.BOTH, expand=True)

        self.entry = tk.Entry(root)
        self.entry.pack(padx=10, pady=5, fill=tk.X)
        self.entry.focus()

        self.send_button = tk.Button(root, text="Send", command=self.process_query)
        self.send_button.pack(pady=5)

        self.speech_button = tk.Button(root, text="Speak", command=self.process_speech)
        self.speech_button.pack(pady=5)

        self.root.bind("<Return>", lambda event: self.process_query())

    # --- thread-safe UI helpers (Tkinter must only be touched from the main thread) ---
    def show(self, text):
        self.root.after(0, self._append, text)

    def _append(self, text):
        self.chat_display.configure(state=tk.NORMAL)
        self.chat_display.insert(tk.END, text + "\n")
        self.chat_display.configure(state=tk.DISABLED)
        self.chat_display.see(tk.END)

    def set_busy(self, busy):
        self.busy = busy
        state = tk.DISABLED if busy else tk.NORMAL
        self.root.after(0, lambda: (self.send_button.config(state=state), self.speech_button.config(state=state)))

    # --- actions ---
    def process_query(self):
        query = self.entry.get().strip()
        if query and not self.busy:
            self.entry.delete(0, tk.END)
            self.show(f"You: {query}")
            self.start(self.handle_response, query)

    def process_speech(self):
        if not self.busy:
            self.start(self.listen_then_respond)

    def start(self, target, *args):
        self.set_busy(True)
        threading.Thread(target=target, args=args, daemon=True).start()

    def listen_then_respond(self):
        self.show("(Listening...)")
        text = listen_to_speech()
        if text:
            self.show(f"You: {text}")
            self.handle_response(text)
        else:
            self.show("(Didn't catch that.)")
            self.set_busy(False)

    def handle_response(self, query):
        try:
            response, should_exit = handle_query(query)
        except Exception as e:
            print(f"Error handling query: {e}")
            response, should_exit = "Sorry, something went wrong.", False

        self.show(f"{ASSISTANT_NAME}: {response}")
        TextToSpeech(response)
        self.set_busy(False)
        if should_exit:
            self.root.after(0, self.root.destroy)


if __name__ == "__main__":
    root = tk.Tk()
    app = JarvisGUI(root)
    root.mainloop()
