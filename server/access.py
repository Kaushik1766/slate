"""Connection logging.

Answers one question quickly: did the tablet actually reach this machine?

Every request and websocket is written to the console and to
``logs/slate-YYYY-MM-DD.log``. Devices are named on first sight, so the log
reads as a list of who connected rather than a wall of request lines.
"""

import datetime
import logging
import logging.handlers
import os
import re
import time

LOG_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs"
)

log = logging.getLogger("slate")

# Requests the browser makes constantly and that say nothing about who is
# connected. Kept out of the file unless SLATE_LOG_ASSETS is set.
QUIET = re.compile(r"^/(css|js|vendor|icon\.svg|favicon\.ico)")

_seen = {}


def _describe(agent):
    """A short, human name for a device from its user agent."""
    if not agent:
        return "unknown device"
    a = agent.lower()
    if "ipad" in a:
        os_name = "iPad"
    elif "iphone" in a:
        os_name = "iPhone"
    elif "android" in a:
        os_name = "Android"
        m = re.search(r"android (\d+)", a)
        if m:
            os_name = "Android " + m.group(1)
    elif "windows" in a:
        os_name = "Windows"
    elif "mac os" in a or "macintosh" in a:
        os_name = "Mac"
    elif "linux" in a:
        os_name = "Linux"
    else:
        os_name = "unknown OS"

    if "edg/" in a:
        browser = "Edge"
    elif "opr/" in a or "opera" in a:
        browser = "Opera"
    elif "samsungbrowser" in a:
        browser = "Samsung Internet"
    elif "firefox" in a:
        browser = "Firefox"
    elif "chrome" in a or "crios" in a:
        browser = "Chrome"
    elif "safari" in a:
        browser = "Safari"
    elif "curl" in a:
        browser = "curl"
    else:
        browser = "unknown browser"
    return "{0} / {1}".format(os_name, browser)


def note_device(ip, agent):
    """Log a line the first time an address appears, then stay quiet."""
    if ip in _seen:
        return False
    _seen[ip] = {"agent": agent, "first": time.time()}
    log.info("new device on the network: %s  (%s)", ip, _describe(agent))
    return True


def known_devices():
    return [
        {
            "ip": ip,
            "device": _describe(info["agent"]),
            "first_seen": datetime.datetime.fromtimestamp(info["first"]).isoformat(
                timespec="seconds"
            ),
        }
        for ip, info in sorted(_seen.items())
    ]


def setup(level="INFO"):
    if log.handlers:
        return log
    if not os.path.isdir(LOG_DIR):
        os.makedirs(LOG_DIR)

    log.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    log.propagate = False

    fmt = logging.Formatter("%(asctime)s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

    # One file per day, a fortnight kept. Small enough to open in Notepad.
    path = os.path.join(LOG_DIR, "slate.log")
    handler = logging.handlers.TimedRotatingFileHandler(
        path, when="midnight", backupCount=14, encoding="utf-8"
    )
    handler.suffix = "%Y-%m-%d"
    handler.setFormatter(fmt)
    log.addHandler(handler)

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("  %(message)s"))
    log.addHandler(console)
    return log


def client_ip(scope_client, headers):
    """Real address, honouring a reverse proxy if one is in front."""
    forwarded = headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if scope_client:
        return scope_client[0]
    return "unknown"


async def http_middleware(request, call_next):
    started = time.perf_counter()
    ip = client_ip(
        request.scope.get("client"), request.headers
    )
    agent = request.headers.get("user-agent", "")
    path = request.url.path

    if not QUIET.match(path):
        note_device(ip, agent)

    try:
        response = await call_next(request)
    except Exception:
        log.exception("%s  %s %s  failed", ip, request.method, path)
        raise

    ms = (time.perf_counter() - started) * 1000
    quiet = QUIET.match(path) and not os.environ.get("SLATE_LOG_ASSETS")
    if not quiet:
        log.info(
            "%-15s %s %s -> %s  %.0f ms", ip, request.method, path,
            response.status_code, ms
        )
    return response
