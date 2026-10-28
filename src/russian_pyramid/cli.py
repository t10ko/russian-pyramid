"""Command line entry point: ``russian-pyramid`` starts the practice table."""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser

from russian_pyramid import __version__, config
from russian_pyramid.session import PracticeSession

DEFAULT_PORT = 8765


def _find_port(host: str, preferred: int) -> int:
    for port in (preferred, 0):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind((host, port))
                return sock.getsockname()[1]
        except OSError:
            continue
    raise SystemExit("could not bind a port")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="russian-pyramid",
        description="Russian Pyramid practice table (pooltool physics).",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default {DEFAULT_PORT})")
    parser.add_argument("--drill", default="free", help="drill to start on (default 'free')")
    parser.add_argument("--physics", default=config.DEFAULT_PHYSICS_PRESET,
                        choices=sorted(config.PHYSICS_PRESETS),
                        help="cushion physics preset")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = parser.parse_args(argv)

    from russian_pyramid import drills as drills_mod

    if args.drill not in drills_mod.DRILLS:
        parser.error(f"unknown drill {args.drill!r} (one of: {', '.join(drills_mod.names())})")

    session = PracticeSession(drill=args.drill, physics_preset=args.physics)
    port = _find_port(args.host, args.port)

    from russian_pyramid.server import serve

    httpd = serve(session, args.host, port)
    url = f"http://{args.host}:{port}"

    print(f"Russian Pyramid {__version__}")
    print(f"  table  : {args.drill} drill, '{args.physics}' cushions")
    print(f"  serving: {url}  (Ctrl+C to quit)")
    sys.stdout.flush()

    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
