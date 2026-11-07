// Turn phone actions into links Android can open (https app links open the native app when installed).
const APPS = {
  youtube: "https://www.youtube.com",
  "youtube music": "https://music.youtube.com",
  spotify: "https://open.spotify.com",
  instagram: "https://www.instagram.com",
  whatsapp: "whatsapp://send",
  gmail: "https://mail.google.com",
  mail: "https://mail.google.com",
  maps: "https://maps.google.com",
  "google maps": "https://maps.google.com",
  calendar: "https://calendar.google.com",
  drive: "https://drive.google.com",
  photos: "https://photos.google.com",
  keep: "https://keep.google.com",
  google: "https://www.google.com",
  facebook: "https://www.facebook.com",
  twitter: "https://x.com",
  x: "https://x.com",
  linkedin: "https://www.linkedin.com",
  reddit: "https://www.reddit.com",
  telegram: "https://t.me",
  netflix: "https://www.netflix.com",
  amazon: "https://www.amazon.in",
  github: "https://github.com",
  chatgpt: "https://chatgpt.com",
  "play store": "https://play.google.com/store",
};

const q = encodeURIComponent;
const digits = (s = "") => s.replace(/[^\d+]/g, "");

export function phoneActionToUrl({ action, target = "", text = "" }) {
  const t = target.trim();
  switch (action) {
    case "open_app": {
      const url = APPS[t.toLowerCase()];
      return url
        ? { url, label: `Open ${t}` }
        : { url: `https://play.google.com/store/search?q=${q(t)}&c=apps`, label: `Find ${t}` };
    }
    case "open_url":
      return { url: /^https?:\/\//.test(t) ? t : `https://${t}`, label: `Open ${t}` };
    case "youtube_search":
      return { url: `https://www.youtube.com/results?search_query=${q(t)}`, label: `YouTube: ${t}` };
    case "play_music":
      return { url: `https://music.youtube.com/search?q=${q(t)}`, label: `Play ${t}` };
    case "web_search":
      return { url: `https://www.google.com/search?q=${q(t)}`, label: `Search: ${t}` };
    case "navigate":
      return { url: `https://www.google.com/maps/dir/?api=1&destination=${q(t)}`, label: `Directions to ${t}` };
    case "call":
      if (t && !/^[+\d][\d\s()-]{2,}$/.test(t)) return { contact: t, label: `Call ${t}` }; // a name: the phone looks it up
      return { url: `tel:${digits(t)}`, label: t ? `Call ${t}` : "Open dialler" };
    case "sms":
      return { url: `sms:${digits(t)}${text ? `?body=${q(text)}` : ""}`, label: `Text ${t}` };
    case "whatsapp":
      return digits(t)
        ? { url: `https://wa.me/${digits(t).replace("+", "")}${text ? `?text=${q(text)}` : ""}`, label: `WhatsApp ${t}` }
        : { url: `whatsapp://send${text ? `?text=${q(text)}` : ""}`, label: "Open WhatsApp" };
    case "email":
      return { url: `mailto:${t}${text ? `?body=${q(text)}` : ""}`, label: `Email ${t}` };
    default:
      return null;
  }
}
