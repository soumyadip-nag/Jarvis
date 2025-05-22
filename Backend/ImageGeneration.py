import asyncio
from random import randint
from PIL import Image
import requests
import os
from time import sleep
from dotenv import get_key
from dotenv import load_dotenv
load_dotenv()
api_key = os.getenv("HuggingFaceAPIKey")

def open_images(prompt):
    folder_path = r"Data"
    prompt = prompt.replace(" ", "_")
    Files = {f"{prompt}{i}.jpg" for i in range(1, 5)}

    for jpg_file in Files:
        image_path = os.path.join(folder_path, jpg_file)
        try:
            img = Image.open(image_path)  # Fixed incorrect syntax
            print(f"Opening image: {image_path}")
            img.show()
            sleep(1)
            os.remove(image_path)
            print(f"Deleted image: {image_path}")
        except FileNotFoundError:  # Handle specific error for better debugging
            print(f"Unable to open image: {image_path}")
        except Exception as e:
            print(f"Unexpected error opening image: {e}")


API_URL = "https://api-inference.huggingface.co/models/XLabs-AI/flux-RealismLora"
headers = {"Authorization": f"Bearer {api_key}"}


async def query(payload):
    try:
        response = await asyncio.to_thread(requests.post, API_URL, headers=headers, json=payload)
        if response.status_code == 200:
            return response.content  # Assuming the API returns raw image bytes
        else:
            print(f"API Error: {response.status_code}, {response.text}")
            return None
    except Exception as e:
        print(f"Error during API call: {e}")
        return None


async def generate_images(prompt: str):
    folder_path = r"Data"
    os.makedirs(folder_path, exist_ok=True)  # Ensure the folder exists

    tasks = []
    for i in range(4):
        payload = {
            "inputs": f"{prompt}, quality=4k, sharpness-maximum, Ultra High details high resolution, seed = {randint(0, 1000000)}",
        }
        task = asyncio.create_task(query(payload))
        tasks.append(task)

    image_bytes_list = await asyncio.gather(*tasks)

    for i, image_bytes in enumerate(image_bytes_list):
        if image_bytes:
            with open(os.path.join(folder_path, f"{prompt.replace(' ', '_')}{i + 1}.jpg"), "wb") as f:
                f.write(image_bytes)


def GenerateImages(prompt: str):
    asyncio.run(generate_images(prompt))
    open_images(prompt)


while True:
    try:
        with open(r"Frontend\Files\ImageGeneration.data", "r") as f:
            Data: str = f.read().strip()  # Strip any extra whitespace

        # Split the file content and ensure it has exactly 2 lines
        lines = Data.split("\n")
        if len(lines) != 2:
            raise ValueError("Expected exactly two lines in ImageGeneration.data")

        Prompt, Status = lines
        Status = Status.strip()

        if Status == "True":
            print("Generating Images ...")
            GenerateImages(prompt=Prompt.strip())

            with open(r"Frontend\Files\ImageGeneration.data", "w") as f:
                f.write(f"{Prompt}\nFalse")
            break  # Exit loop after successful generation
        else:
            sleep(1)
    except FileNotFoundError:
        print("ImageGeneration.data file not found. Retrying...")
        sleep(1)
    except ValueError as ve:
        print(f"Invalid data format in ImageGeneration.data: {ve}. Retrying...")
        sleep(1)
    except Exception as e:
        print(f"Unexpected error: {e}")
        sleep(1)