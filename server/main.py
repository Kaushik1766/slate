"""Slate - a local dashboard server for this PC.

Serves the web UI and pushes a telemetry frame once a second over a websocket.
Nothing leaves the machine; bind to 0.0.0.0 so the tablet on your LAN can
reach it, and keep it behind your router.
"""

import asyncio
import contextlib
import os
import socket
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import access  # noqa: E402
from server.hardware import HardwareMonitor  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
INTERVAL = float(os.environ.get("SLATE_INTERVAL", "1.0"))
HISTORY_LEN = 120

try:
    from server.media import MediaHub, SystemVolume

    MEDIA_IMPORT_ERROR = None
except Exception as exc:  # non-Windows, or winrt/pycaw missing
    MediaHub = SystemVolume = None
    MEDIA_IMPORT_ERROR = "{0}: {1}".format(type(exc).__name__, exc)


class Hub:
    """Owns the sampler task, the client set, and the rolling history."""

    def __init__(self):
        self.clients = set()
        self.hw = None
        self.media = None
        self.volume = None
        self.latest_stats = None
        self.latest_media = None
        self.history = {
            "t": deque(maxlen=HISTORY_LEN),
            "cpu": deque(maxlen=HISTORY_LEN),
            "gpu": deque(maxlen=HISTORY_LEN),
            "ram": deque(maxlen=HISTORY_LEN),
            "down": deque(maxlen=HISTORY_LEN),
            "up": deque(maxlen=HISTORY_LEN),
        }
        self._hw_ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="slate-hw")
        self._task = None

    async def start(self):
        loop = asyncio.get_running_loop()
        # Build the monitor inside the worker thread: LibreHardwareMonitor keeps
        # per-thread state, so every later sample() must run on this thread too.
        self.hw = await loop.run_in_executor(self._hw_ex, HardwareMonitor)
        if MediaHub is not None:
            self.volume = SystemVolume()
            self.media = MediaHub(self.volume)
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self.hw:
            await asyncio.get_running_loop().run_in_executor(
                self._hw_ex, self.hw.close
            )
        if self.volume:
            self.volume.close()
        self._hw_ex.shutdown(wait=False)

    def _record(self, stats):
        h = self.history
        h["t"].append(round(stats["ts"], 1))
        h["cpu"].append(stats["cpu"]["load"])
        h["gpu"].append((stats["gpu"] or {}).get("load"))
        h["ram"].append(stats["ram"]["pct"])
        h["down"].append(stats["net"]["down_bps"])
        h["up"].append(stats["net"]["up_bps"])

    def history_payload(self):
        return {k: list(v) for k, v in self.history.items()}

    async def sample_once(self):
        """One out-of-band frame, for callers that are not on the socket."""
        loop = asyncio.get_running_loop()
        self.latest_stats = await loop.run_in_executor(self._hw_ex, self.hw.sample)
        if self.media is not None:
            self.volume.refresh()
            self.latest_media = await self.media.snapshot()
        return self.latest_stats

    async def _run(self):
        loop = asyncio.get_running_loop()
        while True:
            started = time.perf_counter()
            if self.clients:
                try:
                    stats = await loop.run_in_executor(self._hw_ex, self.hw.sample)
                    self.latest_stats = stats
                    self._record(stats)
                    await self.broadcast(dict(stats, type="stats"))
                except Exception as exc:
                    await self.broadcast({"type": "error", "where": "stats",
                                          "message": str(exc)})
                if self.media is not None:
                    try:
                        self.volume.refresh()
                        snap = await self.media.snapshot()
                        self.latest_media = snap
                        await self.broadcast(dict(snap, type="media"))
                    except Exception as exc:
                        await self.broadcast({"type": "error", "where": "media",
                                              "message": str(exc)})
            elapsed = time.perf_counter() - started
            await asyncio.sleep(max(0.05, INTERVAL - elapsed))

    async def broadcast(self, payload):
        if not self.clients:
            return
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()


@contextlib.asynccontextmanager
async def lifespan(app):
    access.setup(os.environ.get("SLATE_LOG_LEVEL", "INFO"))
    await hub.start()
    _print_banner()
    try:
        yield
    finally:
        await hub.stop()


app = FastAPI(title="Slate", lifespan=lifespan, docs_url=None, redoc_url=None)
app.middleware("http")(access.http_middleware)


def _lan_addresses():
    addrs = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))       # no packet is sent, just picks a route
        addrs.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addrs.add(ip)
    except Exception:
        pass
    return sorted(addrs)


def _print_banner():
    port = os.environ.get("SLATE_PORT", "8750")
    print("")
    print("  Slate is running.")
    for ip in _lan_addresses():
        print("    tablet:  http://{0}:{1}".format(ip, port))
    print("    here:    http://localhost:{0}".format(port))
    print("")
    print("  Connections are logged to {0}".format(
        os.path.join(access.LOG_DIR, "slate.log")))
    if hub.hw and not hub.hw.admin:
        print("")
        print("  Running unelevated. CPU package temperature, clocks and fan")
        print("  speeds need admin rights; use run-admin.bat for those.")
    if MEDIA_IMPORT_ERROR:
        print("  Media controls unavailable: {0}".format(MEDIA_IMPORT_ERROR))
    print("", flush=True)


# --------------------------------------------------------------------- routes


@app.get("/")
async def index():
    return FileResponse(
        os.path.join(WEB, "index.html"),
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/api/state")
async def state():
    # The sampler idles when no browser is attached, so a bare request would
    # otherwise be served whatever was true when the last tab closed.
    if not hub.clients:
        await hub.sample_once()
    return JSONResponse(
        {
            "stats": hub.latest_stats,
            "media": hub.latest_media,
            "history": hub.history_payload(),
        }
    )


@app.get("/api/clients")
async def clients():
    return JSONResponse(
        {"watching": len(hub.clients), "devices": access.known_devices()}
    )


@app.get("/api/art")
async def art(rev: int = 0):
    if hub.media is None or not hub.media.art:
        raise HTTPException(status_code=404, detail="no artwork")
    return Response(
        content=hub.media.art,
        media_type=hub.media.art_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.post("/api/media/{action}")
async def media_command(action: str, value: float = None):
    if hub.media is None:
        raise HTTPException(status_code=503, detail="media bridge unavailable")
    ok = await hub.media.command(action, value)
    return {"ok": bool(ok)}


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    ip = access.client_ip(websocket.scope.get("client"), websocket.headers)
    access.note_device(ip, websocket.headers.get("user-agent", ""))
    hub.clients.add(websocket)
    access.log.info("%-15s websocket open   (%d watching)", ip, len(hub.clients))
    opened = time.time()
    reason = "closed"
    try:
        await websocket.send_json(
            {
                "type": "hello",
                "interval": INTERVAL,
                "media_available": hub.media is not None,
                "media_error": MEDIA_IMPORT_ERROR,
                "history": hub.history_payload(),
                "stats": hub.latest_stats,
                "media": hub.latest_media,
            }
        )
        while True:
            msg = await websocket.receive_json()
            action = msg.get("action")
            if not action or hub.media is None:
                continue
            await hub.media.command(action, msg.get("value"))
            # Reflect the change immediately rather than waiting for the tick.
            snap = await hub.media.snapshot()
            hub.latest_media = snap
            await hub.broadcast(dict(snap, type="media"))
    except (WebSocketDisconnect, RuntimeError, ValueError) as exc:
        reason = type(exc).__name__
    finally:
        hub.clients.discard(websocket)
        access.log.info(
            "%-15s websocket closed (%s after %.0fs, %d watching)",
            ip, reason, time.time() - opened, len(hub.clients))


app.mount("/", StaticFiles(directory=WEB), name="web")


def main():
    import uvicorn

    host = os.environ.get("SLATE_HOST", "0.0.0.0")
    port = int(os.environ.get("SLATE_PORT", "8750"))
    uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
