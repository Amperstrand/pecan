#!/usr/bin/env python3
"""ev-device-fake — a device gateway for testing the ev rail until the
Atom hardware is back. Implements the exact contract ev-charge.py speaks
(see its docstring): trigger starts a timed session, status reports
idle/running/done. The real bridge (hermes webhook or MQTT publish to
charger/<device>/start with an {"end": epochSec} payload — the atom
firmware already anchors to end times) drops in behind the same URL.

Usage: python3 ev-device-fake.py [--port 8899] [--key s3cret]
"""
import argparse
import json
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sessions: dict[str, dict] = {}

    def trigger(self, device: str, seconds: int) -> dict:
        with self.lock:
            session = secrets.token_hex(4)
            self.sessions[device] = {
                "session": session,
                "seconds": seconds,
                "done_at": time.time() + seconds,
                "state": "running",
            }
        return {"triggered": True, "session": session}

    def status(self, device: str) -> dict:
        with self.lock:
            s = self.sessions.get(device)
            if not s:
                return {"state": "idle", "session": None, "seconds": 0}
            if s["state"] == "running" and time.time() >= s["done_at"]:
                s["state"] = "done"
            return {"state": s["state"], "session": s["session"],
                    "seconds": s["seconds"]}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8899)
    p.add_argument("--key", default="", help="require this X-API-Key if set")
    p.add_argument("--min-seconds", type=int, default=1,
                   help="floor for requested windows (keeps tests fast)")
    a = p.parse_args()
    state = State()

    class Handler(BaseHTTPRequestHandler):
        def _json(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 — stdlib naming
            if self.path.startswith("/device/") and self.path.endswith("/status"):
                device = self.path[len("/device/"):-len("/status")]
                self._json(200, state.status(device))
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 — stdlib naming
            if not self.path.startswith("/device/") or not self.path.endswith("/trigger"):
                self._json(404, {"error": "not found"})
                return
            if a.key and self.headers.get("X-API-Key") != a.key:
                self._json(401, {"triggered": False, "reason": "bad key"})
                return
            device = self.path[len("/device/"):-len("/trigger")]
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._json(400, {"triggered": False, "reason": "bad json"})
                return
            seconds = max(a.min_seconds, int(payload.get("seconds", 0)))
            print(f"[fake] trigger {device} seconds={seconds}", flush=True)
            self._json(200, state.trigger(device, seconds))

        def log_message(self, fmt: str, *args) -> None:
            print(f"[fake] {fmt % args}", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    # server_address carries the BOUND port (the argument may be 0 = pick).
    print(f"[fake] device gateway on 127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
