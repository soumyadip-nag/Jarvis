from googlesearch import search
from groq import Groq

from Backend.config import USERNAME, ASSISTANT_NAME, GROQ_API_KEY, GROQ_CHAT_MODEL, require_key
from Backend.ChatLog import load_chatlog, save_chatlog, recent, clean_answer
from Backend.Chatbot import RealtimeInformation

client = Groq(api_key=require_key(GROQ_API_KEY, "GROQ_API_KEY"))

System = f"""Hello, I am {USERNAME}. You are a very accurate and advanced AI assistant named {ASSISTANT_NAME} which has real-time up-to-date information from the internet.
*** Provide answers in a professional way, make sure to add full stops, commas, question marks, and use proper grammar.***
*** Just answer the question from the provided data in a professional way. ***"""

SystemChatBot = [
    {"role": "system", "content": System},
    {"role": "user", "content": "Hi"},
    {"role": "assistant", "content": "Hello, how can I help you?"},
]


def GoogleSearch(query):
    try:
        results = list(search(query, advanced=True, num_results=5))
    except Exception as e:
        print(f"Google search failed: {e}")
        results = []
    Answer = f"The search results for '{query}' are:\n[start]\n"
    for i in results:
        Answer += f"Title: {i.title}\nDescription: {i.description}\n\n"
    Answer += "[end]"
    return Answer


def RealtimeSearchEngine(prompt):
    messages = load_chatlog()
    messages.append({"role": "user", "content": prompt})

    # Search results are added for this request only (the old code mutated a global list).
    context = [
        {"role": "system", "content": GoogleSearch(prompt)},
        {"role": "system", "content": RealtimeInformation()},
    ]

    try:
        completion = client.chat.completions.create(
            model=GROQ_CHAT_MODEL,
            messages=SystemChatBot + context + recent(messages),
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
        print(f"RealtimeSearchEngine error: {e}")
        return "Sorry, I couldn't fetch live information right now."

    Answer = clean_answer(Answer)
    messages.append({"role": "assistant", "content": Answer})
    save_chatlog(messages)
    return Answer


if __name__ == "__main__":
    while True:
        print(RealtimeSearchEngine(input("Enter your query: ")))
