from googlesearch import search
from groq import Groq

from Backend.Personality import SYSTEM_PROMPT
from Backend.config import HONORIFIC, GROQ_API_KEY, GROQ_CHAT_MODEL, require_key
from Backend.ChatLog import load_chatlog, save_chatlog, recent, clean_answer
from Backend.Chatbot import RealtimeInformation

client = Groq(api_key=require_key(GROQ_API_KEY, "GROQ_API_KEY"))

SEARCH_INSTRUCTIONS = """You have just been given live web search results between [start] and [end].
Answer the user's question from those results, in your usual concise, spoken style.
If the results don't contain the answer, say so briefly rather than guessing."""

SystemChatBot = [
    {"role": "system", "content": SYSTEM_PROMPT},
    {"role": "system", "content": SEARCH_INSTRUCTIONS},
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
        return f"I'm afraid I couldn't fetch live information just now, {HONORIFIC}."

    Answer = clean_answer(Answer)
    messages.append({"role": "assistant", "content": Answer})
    save_chatlog(messages)
    return Answer


if __name__ == "__main__":
    while True:
        print(RealtimeSearchEngine(input("Enter your query: ")))
