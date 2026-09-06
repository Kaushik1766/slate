"""Windows media session bridge.

Reads whatever is currently playing through GlobalSystemMediaTransportControls
(the same source that backs the Windows volume-key overlay), so it works with
Spotify, browsers, VLC, Groove, and anything else that registers a session.

Album art is fetched only when the track identity changes and is cached in
memory. The browser addresses it by a hash of the track, not by a counter: a
counter restarts from zero every time the server does, so "revision 4" would
mean a different picture after a restart while the browser still had the old
one cached under that name.
"""

import hashlib
import re
import time
from concurrent.futures import ThreadPoolExecutor

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
)
from winrt.windows.storage.streams import DataReader

PLAYBACK = {
    0: "closed",
    1: "opened",
    2: "changing",
    3: "stopped",
    4: "playing",
    5: "paused",
}

# Windows hands back an AUMID, not a name. Map the common ones, fall back to a
# cleaned-up version of whatever we were given.
APP_NAMES = [
    (r"spotify", "Spotify"),
    (r"msedge", "Edge"),
    (r"chrome", "Chrome"),
    (r"firefox", "Firefox"),
    (r"brave", "Brave"),
    (r"vlc", "VLC"),
    (r"mpc-hc", "MPC-HC"),
    (r"foobar", "foobar2000"),
    (r"itunes|apple.*music", "Apple Music"),
    (r"zune|groove", "Groove"),
    (r"tidal", "TIDAL"),
    (r"deezer", "Deezer"),
    (r"youtube", "YouTube"),
    (r"potplayer", "PotPlayer"),
    (r"windowsmediaplayer|wmplayer", "Media Player"),
]


def _pretty_app(aumid):
    if not aumid:
        return None
    low = aumid.lower()
    for pattern, label in APP_NAMES:
        if re.search(pattern, low):
            return label
    name = aumid.split("!")[-1].split(".")[0]
    return name.replace("_", " ").strip() or None


class MediaHub:
    def __init__(self, volume):
        self._mgr = None
        self._volume = volume
        self.art = None            # bytes
        self.art_type = "image/png"
        self.art_rev = 0
        self._art_key = None
        self._last_error = None

    async def _manager(self):
        if self._mgr is None:
            self._mgr = await SessionManager.request_async()
        return self._mgr

    async def _session(self):
        try:
            mgr = await self._manager()
            return mgr.get_current_session()
        except Exception as exc:
            self._last_error = str(exc)
            self._mgr = None
            return None

    # ------------------------------------------------------------------ art

    async def _load_art(self, props, key):
        if key == self._art_key:
            return
        thumb = props.thumbnail
        if thumb is None:
            self._art_key = key
            self.art = None
            self.art_rev += 1
            return
        try:
            stream = await thumb.open_read_async()
            size = stream.size
            if not size:
                raise ValueError("empty thumbnail")
            reader = DataReader(stream)
            await reader.load_async(size)
            buf = bytearray(size)
            reader.read_bytes(buf)
            self.art = bytes(buf)
            self.art_type = stream.content_type or "image/png"
        except Exception:
            self.art = None
        self._art_key = key
        self.art_rev += 1

    # ------------------------------------------------------------- snapshot

    async def snapshot(self):
        session = await self._session()
        vol = self._volume.state()
        if session is None:
            return {
                "active": False,
                "status": "closed",
                "volume": vol,
                "ts": time.time(),
            }

        try:
            props = await session.try_get_media_properties_async()
            info = session.get_playback_info()
            timeline = session.get_timeline_properties()
        except Exception as exc:
            self._last_error = str(exc)
            return {
                "active": False,
                "status": "closed",
                "volume": vol,
                "ts": time.time(),
            }

        title = (props.title or "").strip()
        artist = (props.artist or "").strip()
        album = (props.album_title or "").strip()
        key = hashlib.sha1(
            ("{0}|{1}|{2}".format(title, artist, album)).encode("utf-8", "ignore")
        ).hexdigest()
        await self._load_art(props, key)

        try:
            status_code = int(info.playback_status)
        except (TypeError, ValueError):
            status_code = -1
        controls = info.controls

        position = timeline.position.total_seconds() if timeline.position else 0.0
        end = timeline.end_time.total_seconds() if timeline.end_time else 0.0
        start = timeline.start_time.total_seconds() if timeline.start_time else 0.0
        duration = max(0.0, end - start)
        try:
            updated = timeline.last_updated_time.timestamp()
        except Exception:
            updated = time.time()

        return {
            "active": bool(title or artist),
            "status": PLAYBACK.get(status_code, "unknown"),
            "title": title,
            "artist": artist,
            "album": album,
            "source": _pretty_app(session.source_app_user_model_id),
            "position": round(max(0.0, position - start), 2),
            "duration": round(duration, 2),
            "updated_at": updated,
            "has_art": self.art is not None,
            "art_rev": self.art_rev,
            # Content-addressed, so the URL changes exactly when the picture
            # does and never collides across restarts.
            "art_key": self._art_key,
            "can": {
                "play": bool(controls.is_play_enabled or controls.is_pause_enabled),
                "next": bool(controls.is_next_enabled),
                "prev": bool(controls.is_previous_enabled),
                "seek": bool(controls.is_playback_position_enabled),
            },
            "volume": vol,
            "ts": time.time(),
        }

    # ------------------------------------------------------------- controls

    async def command(self, action, value=None):
        if action in ("volume", "mute"):
            if action == "volume":
                self._volume.set_level(float(value))
            else:
                self._volume.set_mute(bool(value))
            return True

        session = await self._session()
        if session is None:
            return False
        try:
            if action == "playpause":
                return bool(await session.try_toggle_play_pause_async())
            if action == "play":
                return bool(await session.try_play_async())
            if action == "pause":
                return bool(await session.try_pause_async())
            if action == "next":
                return bool(await session.try_skip_next_async())
            if action == "prev":
                return bool(await session.try_skip_previous_async())
            if action == "seek":
                ticks = int(float(value) * 10_000_000)  # 100ns units
                return bool(await session.try_change_playback_position_async(ticks))
        except Exception as exc:
            self._last_error = str(exc)
            return False
        return False


class SystemVolume:
    """Master output volume via Core Audio.

    pycaw goes through comtypes, which initialises the calling thread's COM
    apartment as STA.  WinRT media calls on that same thread then deadlock, so
    every audio call is confined to one private worker thread and the event
    loop only ever reads a cached value.
    """

    def __init__(self):
        self._endpoint = None
        self._ready = False
        self._inflight = False
        self._cache = {"supported": False, "level": None, "muted": None}
        self._ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio")
        self._ex.submit(self._setup)

    # ---- worker thread only -------------------------------------------

    def _setup(self):
        try:
            import comtypes

            comtypes.CoInitialize()
            from pycaw.pycaw import AudioUtilities

            self._endpoint = AudioUtilities.GetSpeakers().EndpointVolume
            self._ready = True
            self._read()
        except Exception:
            self._endpoint = None
            self._ready = False

    def _read(self):
        if not self._ready:
            return
        try:
            self._cache = {
                "supported": True,
                "level": round(self._endpoint.GetMasterVolumeLevelScalar() * 100),
                "muted": bool(self._endpoint.GetMute()),
            }
        except Exception:
            self._cache = {"supported": False, "level": None, "muted": None}

    def _read_once(self):
        try:
            self._read()
        finally:
            self._inflight = False

    # ---- callable from the event loop ---------------------------------

    def state(self):
        return dict(self._cache)

    def refresh(self):
        """Queue a non-blocking re-read; the loop never waits on COM."""
        if self._inflight or not self._ready:
            return
        self._inflight = True
        try:
            self._ex.submit(self._read_once)
        except RuntimeError:
            self._inflight = False

    def set_level(self, pct):
        level = min(100.0, max(0.0, float(pct)))
        self._cache = dict(self._cache, level=round(level))  # optimistic
        self._submit(lambda: self._endpoint.SetMasterVolumeLevelScalar(level / 100.0, None))

    def set_mute(self, muted):
        self._cache = dict(self._cache, muted=bool(muted))
        self._submit(lambda: self._endpoint.SetMute(1 if muted else 0, None))

    def _submit(self, fn):
        if not self._ready:
            return

        def run():
            try:
                fn()
            except Exception:
                pass

        try:
            self._ex.submit(run)
        except RuntimeError:
            pass

    def close(self):
        self._ex.shutdown(wait=False)
