from groq import Groq
import json
import re
import requests
from json import load, dump
import datetime
from dotenv import dotenv_values

env_vars = dotenv_values(".env")

Username = "Ushnish Chowdhury"
Assistantname = "Jarvis"
GroqAPIKey = "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"
SERPAPI_KEY = "f9eec073f1c42b4edd9e9944da1623178eaf94d3c8aa5888b724445a26b39ce5"

client = Groq(api_key=GroqAPIKey)
messages = []

System = f"""Hello, I am {Username}, You are {Assistantname}, an AI assistant that can access real-time internet information. Follow these steps:

1. If the question requires up-to-date information (e.g., current events, weather, news), output exactly once: [SEARCH:"query"] where "query" is the search term.
2. Use the search results to provide a concise answer.

*** Reply in English only. Avoid extra text. ***
*** Current time: {{current_time}} ***
*** Never mention [SEARCH] or your search capabilities in responses. ***
"""

SystemChatBot = [{"role": "system", "content": System}]

def RealtimeInformation():
    current = datetime.datetime.now()
    return current.strftime("%A, %B %d, %Y %H:%M:%S")

def web_search(query):
    try:
        params = {
            "engine": "google",
            "q": query,
            "api_key": "SERPAPI_KEY",
            "num": 3
        }
        response = requests.get("https://serpapi.com/search", params=params)
        response.raise_for_status()
        data = response.json()
        
        results = []
        if "organic_results" in data:
            for res in data["organic_results"][:3]:
                results.append({
                    "title": res.get("title"),
                    "snippet": res.get("snippet"),
                    "link": res.get("link")
                })
        return results
    except Exception as e:
        print(f"Search Error: {e}")
        return []

def AnswerModifier(Answer):
    return Answer.replace("</s", "").strip()

def ChatBot(Query):
    try:
        with open(r"Data\ChatLog.json", "r") as f:
            messages = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        messages = []
    
    messages.append({"role": "user", "content": Query})
    
    # Update system message with current time
    SystemChatBot[0]["content"] = System.format(current_time=RealtimeInformation())
    
    # Initial completion to check for search
    initial_response = client.chat.completions.create(
        model="llama3-70b-8192",
        messages=SystemChatBot + messages,
        temperature=0.7,
        max_tokens=512,
        stream=False
    )
    initial_answer = initial_response.choices[0].message.content
    messages.append({"role": "assistant", "content": initial_answer})
    
    Answer = ""  # Make sure Answer is initialized here
    
    # Check if search needed
    if '[SEARCH:' in initial_answer:
        match = re.search(r'\[SEARCH:"(.+?)"\]', initial_answer)
        if match:
            search_query = match.group(1)
            search_results = web_search(search_query)
            
            # Format results
            search_msg = f"Search Results for '{search_query}':\n"
            for idx, res in enumerate(search_results, 1):
                search_msg += f"{idx}. {res['title']}\n{res['snippet']}\n{res['link']}\n\n"
            
            # Remove initial assistant message and add search results
            messages.pop()
            messages.append({"role": "system", "content": search_msg.strip()})
            
            # Generate final answer
            final_response = client.chat.completions.create(
                model="llama3-70b-8192",
                messages=SystemChatBot + messages,
                temperature=0.7,
                max_tokens=1024,
                stream=True
            )
            
            Answer = ""
            for chunk in final_response:
                if chunk.choices[0].delta.content:
                    Answer += chunk.choices[0].delta.content
            Answer = AnswerModifier(Answer)
            messages.append({"role": "assistant", "content": Answer})
    
    else:
        # If no search is needed, use the initial answer
        Answer = initial_answer
    
    # Save chat log
    with open(r"Data\ChatLog.json", "w") as f:
        json.dump(messages, f, indent=4)
    
    return Answer


if __name__ == "__main__":
    while True:
        user_input = input("You: ")
        if user_input.lower() in ["exit", "quit"]:
            break
        print(f"{Assistantname}: {ChatBot(user_input)}")