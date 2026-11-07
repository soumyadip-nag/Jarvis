"""Connection between the desktop app and the Jarvis cloud brain (shared with the phone).

Enabled when JARVIS_SERVER_URL and JARVIS_PASSCODE are set in .env. Then:
  * questions typed/spoken on the laptop are answered by the cloud brain (shared memory + history),
  * laptop commands sent from the phone ("open Spotify on my laptop") are executed here,
  * messages from the phone show up in the desktop chat.
Without those settings, the desktop app keeps working fully offline-from-cloud as before.
"""
import json
import time
import urllib.error
import urllib.request

from Backend.config import DATA_DIR, JARVIS_SERVER_URL, JARVIS_PASSCODE

TOKEN_PATH = DATA_DIR / "cloud_token.json"
DEVICE = "laptop"


def enabled():
    return bool(JARVIS_SERVER_URL and JARVIS_PASSCODE)


class CloudError(Exception):
    pass


class CloudClient:
    def __init__(self, base_url=JARVIS_SERVER_URL, passcode=JARVIS_PASSCODE):
        self.base = (base_url or "").rstrip("/")
        self.passcode = passcode
        self.token = self._load_token()
        self.last_ts = 0

    # ── HTTP ──
    def _request(self, method, path, body=None, auth=True, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base}/api/{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", "JarvisDesktop/1.0")
        if auth:
            if not self.token:
                self.login()
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 401 and auth:
                # token expired or passcode changed: log in again once
                self.token = None
                self.login()
                return self._request(method, path, body, auth=True, timeout=timeout)
            try:
                message = json.loads(e.read()).get("error", str(e))
            except Exception:
                message = str(e)
            raise CloudError(message) from None
        except urllib.error.URLError as e:
            raise CloudError(f"Can't reach the Jarvis server ({e.reason}).") from None

    def _load_token(self):
        try:
            data = json.loads(TOKEN_PATH.read_text())
            return data.get("token") if data.get("server") == self.base else None
        except Exception:
            return None

    def login(self):
        data = self._request("POST", "login", {"passcode": self.passcode, "device": DEVICE}, auth=False)
        self.token = data["token"]
        TOKEN_PATH.write_text(json.dumps({"server": self.base, "token": self.token}))

    # ── API ──
    def chat(self, text):
        tz = time.strftime("%Z")
        try:
            import tzlocal  # optional, gives an IANA name like "Asia/Kolkata"
            tz = str(tzlocal.get_localzone())
        except Exception:
            pass
        data = self._request("POST", "chat", {"text": text, "tz": tz}, timeout=60)
        self.last_ts = max(self.last_ts, data["reply"]["ts"])
        return data

    def sync(self):
        data = self._request("GET", f"sync?since={self.last_ts}", timeout=20)
        for m in data.get("messages", []):
            self.last_ts = max(self.last_ts, m["ts"])
        return data

    def download_image(self, image_id):
        """Fetch a generated image's bytes (the download needs the same device token)."""
        if not self.token:
            self.login()
        for attempt in (1, 2):
            req = urllib.request.Request(f"{self.base}/api/images/{image_id}")
            req.add_header("User-Agent", "JarvisDesktop/1.0")
            req.add_header("Authorization", f"Bearer {self.token}")
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    return res.read()
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 1:
                    self.login()
                    continue
                raise CloudError(f"Couldn't download the image (HTTP {e.code}).") from None
            except urllib.error.URLError as e:
                raise CloudError(f"Can't reach the Jarvis server ({e.reason}).") from None

    def report_call(self, name, report, transcript=""):
        self._request("POST", "calls/report", {"name": name, "report": report, "transcript": transcript})

    def done(self, command_id):
        self._request("POST", f"commands/{command_id}/done", {})
