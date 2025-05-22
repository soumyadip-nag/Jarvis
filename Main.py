import threading
import asyncio
import json
import os
from dotenv import dotenv_values
from Backend.Model import FirstLayerDMM
from Backend.Chatbot import ChatBot as ConversationalAI
from Backend.TextToSpeech import TextToSpeech
from Backend.Automation import Automation
import tkinter as tk
from tkinter import scrolledtext
import speech_recognition as sr
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from webdriver_manager.chrome import ChromeDriverManager
import time

# Load environment variables
env_vars = dotenv_values(".env")
USERNAME = "Ushnish Chowdhury and Soumyadip Nag"
ASSISTANT_NAME = "Jarvis"

# Initialize the Speech Recognition
recognizer = sr.Recognizer()

# Setup the Selenium WebDriver for Speech to Text
driver_path = ChromeDriverManager().install()
options = webdriver.ChromeOptions()
options.add_argument("--headless")  # Run in headless mode to avoid opening a browser window
driver = webdriver.Chrome(service=Service(driver_path), options=options)

# Function to use Speech Recognition
def listen_to_speech():
    with sr.Microphone() as source:
        print("Listening for your command...")
        recognizer.adjust_for_ambient_noise(source)
        audio = recognizer.listen(source)
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

# Function to translate speech
def translate_speech(text):
    # Implements translation logic here if needed
    return text

# Initialize GUI
class JarvisGUI():
    def __init__(self, root):
        self.root = root
        self.root.title(f"{ASSISTANT_NAME} - Voice Assistant")
        self.root.geometry("600x400")
        
        self.chat_display = scrolledtext.ScrolledText(root, wrap=tk.WORD)
        self.chat_display.pack(padx=10, pady=10, fill=tk.BOTH, expand=True)
        
        self.entry = tk.Entry(root)
        self.entry.pack(padx=10, pady=5, fill=tk.X)
        
        self.send_button = tk.Button(root, text="Send", command=self.process_query)
        self.send_button.pack(pady=5)

        self.speech_button = tk.Button(root, text="Speak", command=self.process_speech)
        self.speech_button.pack(pady=5)

        self.root.bind('<Return>', lambda event: self.process_query())
    
    def process_query(self):
        query = self.entry.get().strip()
        if query:
            self.chat_display.insert(tk.END, f"You: {query}\n")
            self.entry.delete(0, tk.END)
            
            response_thread = threading.Thread(target=self.handle_response, args=(query,))
            response_thread.start()
    
    def process_speech(self):
        speech_text = listen_to_speech()
        if speech_text:
            self.chat_display.insert(tk.END, f"You: {speech_text}\n")
            response_thread = threading.Thread(target=self.handle_response, args=(speech_text,))
            response_thread.start()

    def handle_response(self, query):
        classification = FirstLayerDMM(query)  # Classify query
        
        if classification in ["automation", "system", "open", "close", "search", "play", "content"]:
            asyncio.run(Automation([query]))  # Handle automation tasks
            response = "Command executed."
        else:
            response = ConversationalAI(query)  # Generate conversational response
    
        self.chat_display.insert(tk.END, f"{ASSISTANT_NAME}: {response}\n")
        TextToSpeech(response)  # Speak response
        
# Run GUI
if __name__ == "__main__":
    root = tk.Tk()
    app = JarvisGUI(root)
    root.mainloop()