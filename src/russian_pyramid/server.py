"""Local HTTP server: static UI + a small JSON API over the practice session.

Standard library only -- the fewer moving parts, the more robust the packaged
.app.  The API is intentionally tiny:

    GET  /api/state                     full UI state (table, balls, aim, stats)
    POST /api/shoot          {params?}  simulate + apply, returns frames
    POST /api/predict        {params?}  aim-assist runout paths
    POST /api/aim            {params}   persist aim parameters
    POST /api/undo                     repeat the previous situation
    POST /api/balls/move      {id, xy}
    POST /api/balls/add       {xy}
    POST /api/balls/remove    {id}
    POST /api/layout          {balls}
    POST /api/drill           {name}
    POST /api/physics         {preset}
    POST /api/respawn-cue               put the cue ball back after a scratch
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from russian_pyramid import __version__, drills
from russian_pyramid.physics import ShotError
from russian_pyramid.session import PracticeSession

STATIC_DIR = Path(__file__).parent / "static"
_MAX_BODY = 8 * 1024 * 1024


class _Handler(BaseHTTPRequestHandler):
    server_version = f"RussianPyramid/{__version__}"
    protocol_version = "HTTP/1.1"

    # The handler is recreated per request; the session lives on the server.
    @property
    def session(self) -> PracticeSession:
        return self.server.session  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    # -- helpers --------------------------------------------------------------

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > _MAX_BODY:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length))

    def _static(self, rel: str) -> None:
        path = (STATIC_DIR / rel).resolve()
        if not str(path).startswith(str(STATIC_DIR.resolve())) or not path.is_file():
            self._json({"error": "not found"}, 404)
            return
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".woff2": "font/woff2",
        }.get(path.suffix.lower(), "application/octet-stream")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # -- dispatch ---------------------------------------------------------------

    def do_GET(self):  # noqa: N802
        try:
            if self.path in ("/", "/index.html"):
                self._static("index.html")
            elif self.path == "/api/state":
                with self.session.lock:
                    self._json(self.session.state())
            elif self.path == "/api/drills":
                self._json({"drills": drills.catalog()})
            elif self.path.startswith("/api/"):
                self._json({"error": "not found"}, 404)
            else:
                self._static(self.path.lstrip("/"))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc)}, 500)

    def do_POST(self):  # noqa: N802
        try:
            route = self.path.rstrip("/")
            body = self._read_body()
            session = self.session

            if route == "/api/shoot":
                with session.lock:
                    self._json(session.shoot(body.get("params")))
            elif route == "/api/predict":
                with session.lock:
                    self._json(session.predict(body.get("params")))
            elif route == "/api/aim":
                with session.lock:
                    session.set_aim(body)
                    self._json({"aim": session.cue.as_dict()})
            elif route == "/api/undo":
                with session.lock:
                    session.undo()
                    self._json(session.state(include_table=False))
            elif route == "/api/balls/move":
                with session.lock:
                    session.move_ball(str(body["id"]), float(body["xy"][0]), float(body["xy"][1]))
                    self._json(session.state(include_table=False))
            elif route == "/api/balls/add":
                with session.lock:
                    ball_id = session.add_ball(float(body["xy"][0]), float(body["xy"][1]))
                    self._json({"id": ball_id, "state": session.state(include_table=False)})
            elif route == "/api/balls/remove":
                with session.lock:
                    session.remove_ball(str(body["id"]))
                    self._json(session.state(include_table=False))
            elif route == "/api/layout":
                with session.lock:
                    session.set_layout(body["balls"])
                    self._json(session.state(include_table=False))
            elif route == "/api/drill":
                with session.lock:
                    session.set_drill(str(body["name"]))
                    self._json(session.state())
            elif route == "/api/physics":
                with session.lock:
                    session.set_physics_preset(str(body["preset"]))
                    self._json(session.state())
            elif route == "/api/respawn-cue":
                with session.lock:
                    session.respawn_cue()
                    self._json(session.state(include_table=False))
            else:
                self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (KeyError, ValueError) as exc:
            self._json({"error": str(exc)}, 422)
        except ShotError as exc:
            self._json({"error": str(exc)}, 422)
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc)}, 500)


def make_server(session: PracticeSession, host: str, port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), _Handler)
    httpd.session = session  # type: ignore[attr-defined]
    httpd.daemon_threads = True
    return httpd


def warm_up(session: PracticeSession) -> None:
    """First simulate triggers numba compilation; do it before the user shoots."""
    try:
        session.predict({"V0": 0.5})
    except Exception:  # noqa: BLE001 - warm-up is best effort
        pass


def serve(session: PracticeSession, host: str, port: int,
          warm: bool = True) -> ThreadingHTTPServer:
    httpd = make_server(session, host, port)
    if warm:
        threading.Thread(target=warm_up, args=(session,), daemon=True).start()
    return httpd
