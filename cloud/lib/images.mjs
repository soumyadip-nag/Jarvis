// Image generation for the cloud brain (Cloudflare Workers AI). Images are stored privately in the
// shared store and can only be fetched with a device token (GET /api/images/<id>).
import { store, newId } from "./store.mjs";

const MODEL = () => process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
const key = (id) => `images/${id}`;

export const imagesEnabled = () => !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

async function renderOne(prompt) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, steps: 4 }),
  });
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Some models answer with JSON holding base64, others with the image bytes themselves.
  if ((res.headers.get("content-type") || "").startsWith("image/")) {
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }
  return (await res.json()).result.image;
}

/** Generate up to 4 images, store them and return their ids. Throws if none could be made. */
export async function generateImages(prompt, count = 1) {
  const n = Math.min(4, Math.max(1, Math.round(Number(count)) || 1));
  const results = await Promise.allSettled(Array.from({ length: n }, () => renderOne(prompt)));
  const images = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!images.length) throw results[0].reason;
  const ids = [];
  for (const data of images) {
    const id = newId();
    await store().setJSON(key(id), { data, prompt, ts: Date.now() });
    ids.push(id);
  }
  return ids;
}

/** Returns { bytes, mime } or null. */
export async function getImage(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  const image = await store().get(key(id));
  if (!image) return null;
  return {
    bytes: Buffer.from(image.data, "base64"),
    mime: image.data.startsWith("iVBOR") ? "image/png" : "image/jpeg",
  };
}
