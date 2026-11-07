import asyncio
import re
from random import randint
from time import sleep

import requests
from PIL import Image

from Backend.config import DATA_DIR, HUGGINGFACE_API_KEY, IMAGE_MODEL

API_URL = f"https://router.huggingface.co/hf-inference/models/{IMAGE_MODEL}"


def _safe_name(prompt):
    return re.sub(r"[^a-zA-Z0-9]+", "_", prompt).strip("_")[:60] or "image"


def _headers():
    if not HUGGINGFACE_API_KEY:
        raise RuntimeError("HuggingFaceAPIKey is not set. Add it to the .env file (see .env.example).")
    return {"Authorization": f"Bearer {HUGGINGFACE_API_KEY}"}


async def query(payload):
    try:
        response = await asyncio.to_thread(requests.post, API_URL, headers=_headers(), json=payload, timeout=120)
        if response.status_code == 200 and response.headers.get("content-type", "").startswith("image/"):
            return response.content
        print(f"Image API error: {response.status_code}, {response.text[:300]}")
    except Exception as e:
        print(f"Error during image API call: {e}")
    return None


async def generate_images(prompt: str, count: int = 4):
    tasks = [
        query({"inputs": f"{prompt}, ultra high detail, high resolution, seed={randint(0, 1_000_000)}"})
        for _ in range(count)
    ]
    image_bytes_list = await asyncio.gather(*tasks)

    paths = []
    for i, image_bytes in enumerate(image_bytes_list, start=1):
        if image_bytes:
            path = DATA_DIR / f"{_safe_name(prompt)}{i}.jpg"
            path.write_bytes(image_bytes)
            paths.append(path)
    return paths


def open_images(paths):
    for path in paths:
        try:
            Image.open(path).show()
            sleep(1)
        except Exception as e:
            print(f"Unable to open image {path}: {e}")


def GenerateImages(prompt: str):
    """Generate images for a prompt and open them. Returns the number of images created."""
    paths = asyncio.run(generate_images(prompt))
    open_images(paths)
    return len(paths)


if __name__ == "__main__":
    print(GenerateImages(input("Image prompt: ")))
