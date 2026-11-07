"""Image generation. Tries each configured provider in order until one produces images:

1. Cloudflare Workers AI (free daily allowance; needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
2. Hugging Face (needs HuggingFaceAPIKey and remaining credit)
3. Pollinations (no account, but 1 image every 45 seconds and a watermark)
"""
import asyncio
import base64
import io
import re
from random import randint
from time import sleep
from urllib.parse import quote

import requests
from PIL import Image

from Backend.config import (
    CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_IMAGE_MODEL,
    DATA_DIR, HUGGINGFACE_API_KEY, IMAGE_MODEL,
)


def _safe_name(prompt):
    return re.sub(r"[^a-zA-Z0-9]+", "_", prompt).strip("_")[:60] or "image"


def _cloudflare(prompt):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{CLOUDFLARE_IMAGE_MODEL}"
    response = requests.post(
        url,
        headers={"Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}"},
        json={"prompt": prompt, "steps": 4},
        timeout=120,
    )
    response.raise_for_status()
    if response.headers.get("content-type", "").startswith("image/"):
        raw = response.content
    else:
        raw = base64.b64decode(response.json()["result"]["image"])
    return Image.open(io.BytesIO(raw))


def _huggingface(prompt):
    from huggingface_hub import InferenceClient  # imported here so other providers work without it

    client = InferenceClient(provider="auto", api_key=HUGGINGFACE_API_KEY, timeout=120)
    return client.text_to_image(prompt, model=IMAGE_MODEL, seed=randint(0, 1_000_000))


def _pollinations(prompt):
    url = f"https://image.pollinations.ai/prompt/{quote(prompt)}?width=1024&height=1024&seed={randint(0, 1_000_000)}"
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    return Image.open(io.BytesIO(response.content))


def _providers():
    """(name, render function, most images to ask for at once)"""
    providers = []
    if CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN:
        providers.append(("Cloudflare", _cloudflare, 4))
    if HUGGINGFACE_API_KEY:
        providers.append(("Hugging Face", _huggingface, 4))
    providers.append(("Pollinations", _pollinations, 1))  # limited to one image every 45 seconds
    return providers


async def _attempt(name, render, prompt):
    try:
        return await asyncio.to_thread(render, prompt)
    except Exception as e:
        print(f"{name} image error: {str(e)[:300]}")
        return None


async def generate_images(prompt: str, count: int = 4):
    for name, render, limit in _providers():
        results = await asyncio.gather(*(_attempt(name, render, prompt) for _ in range(min(count, limit))))
        images = [image for image in results if image is not None]
        if images:
            print(f"Generated {len(images)} image(s) with {name}.")
            paths = []
            for i, image in enumerate(images, start=1):
                path = DATA_DIR / f"{_safe_name(prompt)}{i}.jpg"
                image.convert("RGB").save(path, "JPEG", quality=95)
                paths.append(path)
            return paths
    return []


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
