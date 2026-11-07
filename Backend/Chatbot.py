from groq import Groq
import datetime

from Backend.config import USERNAME, ASSISTANT_NAME, GROQ_API_KEY, GROQ_CHAT_MODEL, require_key
from Backend.ChatLog import load_chatlog, save_chatlog, recent, clean_answer

client = Groq(api_key=require_key(GROQ_API_KEY, "GROQ_API_KEY"))

System = f"""Hello, I am {USERNAME}. You are a very accurate and advanced AI assistant named {ASSISTANT_NAME} which also has real-time up-to-date information from the internet.
*** Do not tell time until I ask, do not talk too much, just answer the question.***
*** Reply in only English, even if the question is in Hindi, reply in English.***
*** Do not provide notes in the output, just answer the question and never mention your training data. ***
"""

SystemChatBot = [{"role": "system", "content": System}]


def RealtimeInformation():
    now = datetime.datetime.now()
    return (
        "Please use this real-time information if needed,\n"
        f"Day: {now:%A}\nDate: {now:%d}\nMonth: {now:%B}\nYear: {now:%Y}\n"
        f"Time: {now:%H} hours:{now:%M} minutes: {now:%S} seconds.\n"
    )


def ChatBot(Query):
    """Send the user's query to the chatbot and return the AI's response."""
    messages = load_chatlog()
    messages.append({"role": "user", "content": Query})

    try:
        completion = client.chat.completions.create(
            model=GROQ_CHAT_MODEL,
            messages=SystemChatBot + [{"role": "system", "content": RealtimeInformation()}] + recent(messages),
            max_tokens=1024,
            temperature=0.7,
            top_p=1,
            stream=True,
        )
        Answer = ""
        for chunk in completion:
            if chunk.choices and chunk.choices[0].delta.content:
                Answer += chunk.choices[0].delta.content
    except Exception as e:
        # Keep the history intact and tell the user instead of retrying forever.
        print(f"ChatBot error: {e}")
        return "Sorry, I couldn't reach my language model right now. Please check the internet connection and API key."

    Answer = clean_answer(Answer)
    messages.append({"role": "assistant", "content": Answer})
    save_chatlog(messages)
    return Answer


if __name__ == "__main__":
    while True:
        print(ChatBot(input("Enter Your Question: ")))
