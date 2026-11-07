from groq import Groq
import datetime

from Backend.Personality import SYSTEM_PROMPT
from Backend.config import GROQ_API_KEY, HONORIFIC, GROQ_CHAT_MODEL, require_key
from Backend.ChatLog import load_chatlog, save_chatlog, recent, clean_answer

client = Groq(api_key=require_key(GROQ_API_KEY, "GROQ_API_KEY"))


SystemChatBot = [{"role": "system", "content": SYSTEM_PROMPT}]


def RealtimeInformation():
    now = datetime.datetime.now()
    return (
        "Current date and time (use only if relevant):\n"
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
        return f"I'm having trouble reaching my servers, {HONORIFIC}. Please check the internet connection and the API key."

    Answer = clean_answer(Answer)
    messages.append({"role": "assistant", "content": Answer})
    save_chatlog(messages)
    return Answer


if __name__ == "__main__":
    while True:
        print(ChatBot(input("Enter Your Question: ")))
