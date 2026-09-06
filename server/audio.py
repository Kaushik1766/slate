"""System audio spectrum.

Taps the WASAPI loopback of the default output device, so the visualiser
follows whatever the machine is actually playing rather than a microphone.

Only band magnitudes ever leave this module. Audio is analysed in a rolling
in-memory window and discarded immediately; nothing is recorded or written to
disk.

Capture runs on its own thread with its own lifetime: if the default output
device changes, or an interface is unplugged, the stream is torn down and
reopened without disturbing the rest of the server.

PortAudio only enumerates devices, and only learns the default output device,
at Pa_Initialize() time. A long-lived PyAudio instance answers "what is the
default now" from that same startup snapshot forever, so asking it never
notices a later switch. The fix is to ask something that is not a snapshot:
pycaw (already a dependency, see server/media.py) reads the default endpoint
straight from Core Audio, live, every time. `_capture()` already builds a
fresh `PyAudio()` on every reopen, which is what lets the new instance
re-enumerate and actually see the change.

That live check has to run on the supervisor thread, not inside the capture
loop. An idle WASAPI loopback device - nothing currently playing through it -
does not hand back silent frames. Its `stream.read()` simply never returns
until something plays again. Measured directly: with Spotify the only source
of audio on this machine, every loopback device except the one Spotify was
using blocked in read() for the full length of a 12s probe. A check placed
after `stream.read()` in the capture loop is therefore not "occasionally
delayed", it is unreachable for as long as the tapped device stays quiet -
which is the normal resting state of this app. So the supervisor thread polls
the live default on its own timer, independent of whether the capture thread
is blocked, and only a genuine endpoint id change ends a generation.

Ending a generation still never means touching its stream. Closing a
PortAudio stream from a thread other than the one blocked in read() on it is
not safe (a live segfault, not a hypothetical, reproduced twice while
building this). So a superseded generation is abandoned, not preempted: the
supervisor bumps the generation token and moves on, leaving the old thread
blocked in its own read(). If nothing ever plays on that old device again, it
stays blocked forever - one leaked daemon thread per device switch, which is
bounded by how often a person actually changes their output device, not by
time. If audio does resume on it, its read() returns, it notices the token
moved on, and it quietly cleans up its own stream and exits.

Set `SLATE_AUDIO_DEVICE` to a case-insensitive substring of a device name to
pin capture to that device and stop following the default entirely.
"""

import math
import os
import threading
import time

BANDS = 28
LOW_HZ = 42.0
HIGH_HZ = 15000.0
CHUNK = 4096
DEFAULT_CHECK_EVERY = 1.0   # how often the supervisor asks Core Audio for the live default
SUPERVISOR_POLL = 0.3       # supervisor wake-up granularity (shutdown responsiveness, mostly)

# Below the floor a bar reads as silence. The ceiling adapts, so quietly
# mastered music still fills the field instead of hugging the baseline.
FLOOR_DB = -72.0
CEILING_DB = -18.0

ATTACK = 0.55          # how fast a bar rises to a new peak
DECAY = 0.12           # how slowly it falls, which is what reads as motion
IDLE_AFTER = 1.5       # seconds of silence before frames stop being sent


class SpectrumTap:
    def __init__(self, bands=BANDS):
        self.bands = bands
        self.available = False
        self.error = None
        self.device_name = None
        self.pin = (os.environ.get("SLATE_AUDIO_DEVICE") or "").strip() or None

        self._levels = [0.0] * bands
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._last_sound = 0.0
        self._ceiling = CEILING_DB
        self._edges = None
        self._window = None

        # Identifies which capture attempt is "current". A generation that
        # gets superseded keeps running in its own thread, blocked in
        # read(), but stops mattering: it is never joined and never touches
        # shared state again once it notices the token has moved on.
        self._current_gen = None
        # The default output endpoint id the current generation opened
        # against, so the supervisor has something live to compare against.
        self._speaker_id = None

    # ------------------------------------------------------------------ api

    def start(self):
        try:
            import numpy  # noqa: F401
            import pyaudiowpatch  # noqa: F401
        except Exception as exc:
            self.error = "audio capture unavailable: {0}".format(exc)
            return False
        self._thread = threading.Thread(
            target=self._run, name="slate-audio", daemon=True
        )
        self._thread.start()
        # Give the device a moment to open so the startup banner can tell the
        # truth about whether the spectrum is live.
        deadline = time.time() + 1.5
        while time.time() < deadline and not self.available and not self.error:
            time.sleep(0.05)
        return self.available

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)

    def frame(self):
        """Bar heights as ints 0-100, or None while there is nothing to show."""
        if not self.available:
            return None
        if time.time() - self._last_sound > IDLE_AFTER:
            return None
        with self._lock:
            return [int(round(v * 100)) for v in self._levels]

    def state(self):
        return {
            "available": self.available,
            "device": self.device_name,
            "bands": self.bands,
            "error": self.error,
            "pinned": self.pin,
        }

    # ---------------------------------------------------------- supervisor

    def _run(self):
        """Owns generations and the one live-default poll that matters.

        Runs its own COM apartment so it can ask pycaw for the live default
        on a plain timer, independent of the capture thread. This thread
        never makes a WinRT media call, so it carries none of the STA/WinRT
        deadlock risk that keeps SystemVolume's COM work off the event loop
        thread.
        """
        try:
            import comtypes

            comtypes.CoInitialize()
            have_com = True
        except Exception:
            have_com = False
        try:
            while not self._stop.is_set():
                gen = object()
                self._current_gen = gen
                self._speaker_id = None
                thread = threading.Thread(
                    target=self._capture_gen, args=(gen,),
                    name="slate-audio-cap", daemon=True,
                )
                thread.start()
                self._await_generation(thread, gen)
                if self._stop.is_set():
                    break
                if self.error:
                    # A real failure (no default device, bad pin, ...). Don't
                    # spin hot retrying something that just failed.
                    self._stop.wait(3.0)
        finally:
            if have_com:
                try:
                    import comtypes

                    comtypes.CoUninitialize()
                except Exception:
                    pass

    def _await_generation(self, thread, gen):
        """Watches one generation until it exits or the default moves on.

        Polls Core Audio directly, not the capture thread: an idle loopback
        device's read() can block indefinitely, so anything waiting for the
        capture thread to check in would wait just as long.
        """
        checked = 0.0
        while not self._stop.is_set():
            if not thread.is_alive():
                return
            if not self.pin:
                now = time.time()
                if now - checked > DEFAULT_CHECK_EVERY:
                    checked = now
                    try:
                        live_id = _default_speaker_id()
                    except Exception:
                        live_id = None
                    known_id = self._speaker_id
                    if live_id is not None and known_id is not None and live_id != known_id:
                        _log("audio: default output device changed, reopening capture")
                        # Bump the token and move on. The old thread is very
                        # possibly blocked in read() right now; we never
                        # touch its stream, only stop caring about it.
                        self._current_gen = object()
                        self.available = False
                        return
            self._stop.wait(SUPERVISOR_POLL)
        # Shutting down. Give the thread a brief chance to exit on its own;
        # never force it, since that means touching its stream cross-thread.
        thread.join(timeout=0.5)

    # -------------------------------------------------------------- worker

    def _band_edges(self, rate):
        """Log-spaced bin ranges: octaves come out even, which is how ears work."""
        import numpy as np

        top = min(HIGH_HZ, (rate / 2.0) * 0.96)
        edges = np.logspace(math.log10(LOW_HZ), math.log10(top), self.bands + 1)
        bins = (edges / rate * CHUNK).astype(int)
        # Every band must own at least one bin or it reads as permanently dead.
        for i in range(1, len(bins)):
            if bins[i] <= bins[i - 1]:
                bins[i] = bins[i - 1] + 1
        return np.clip(bins, 1, CHUNK // 2)

    def _capture_gen(self, gen):
        """Thread entry point for one capture attempt (one open device).

        Owns its own COM apartment too: it needs pycaw once, at open, to
        record the endpoint id the supervisor will later compare against.
        """
        try:
            import comtypes

            comtypes.CoInitialize()
            have_com = True
        except Exception:
            have_com = False
        try:
            self._capture(gen)
        except Exception as exc:
            if self._current_gen is gen:
                self.error = "{0}: {1}".format(type(exc).__name__, exc)
                self.available = False
        finally:
            if have_com:
                try:
                    import comtypes

                    comtypes.CoUninitialize()
                except Exception:
                    pass

    def _capture(self, gen):
        import numpy as np
        import pyaudiowpatch as pa

        audio = pa.PyAudio()
        stream = None
        try:
            if self.pin:
                device = _find_pinned_loopback(audio, self.pin)
            else:
                device = audio.get_default_wasapi_loopback()

            rate = int(device["defaultSampleRate"])
            channels = max(1, int(device["maxInputChannels"]))
            name = device["name"].replace(" [Loopback]", "")

            speaker_id = None
            if not self.pin:
                try:
                    speaker_id = _default_speaker_id()
                except Exception:
                    speaker_id = None

            stream = audio.open(
                format=pa.paFloat32, channels=channels, rate=rate, input=True,
                frames_per_buffer=CHUNK, input_device_index=device["index"],
            )

            if self._current_gen is not gen:
                return   # superseded before the stream even finished opening

            if self.device_name is not None and name != self.device_name:
                _log("audio: switched capture to %s", name)
            self.device_name = name
            # Recomputed on every reopen: a switch can land on a device
            # running at a completely different sample rate.
            self._edges = self._band_edges(rate)
            self._window = np.hanning(CHUNK).astype(np.float32)
            self._speaker_id = speaker_id
            self.available = True
            self.error = None

            while not self._stop.is_set() and self._current_gen is gen:
                # This blocks until the device has something to say, which
                # for an idle device can be indefinitely. That is expected:
                # silence is free, and the supervisor thread is the one
                # watching for a device switch, not this loop.
                raw = stream.read(CHUNK, exception_on_overflow=False)
                if self._current_gen is not gen:
                    return   # superseded while blocked in read(); go quietly

                samples = np.frombuffer(raw, dtype=np.float32)
                if channels > 1:
                    samples = samples.reshape(-1, channels).mean(axis=1)
                if samples.size >= CHUNK:
                    self._analyse(samples[:CHUNK], np)
        finally:
            if self._current_gen is gen:
                self.available = False
            if stream is not None:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            try:
                audio.terminate()
            except Exception:
                pass

    def _analyse(self, samples, np):
        spectrum = np.abs(np.fft.rfft(samples * self._window))
        if float(np.abs(samples).max()) > 0.0004:
            self._last_sound = time.time()

        edges = self._edges
        levels_db = []
        for i in range(self.bands):
            chunk = spectrum[edges[i]:edges[i + 1]]
            if chunk.size == 0:
                levels_db.append(-160.0)
                continue
            # Peak, not mean: averaging across a wide high band flattens the
            # energy away and the top of the field never moves.
            mag = float(chunk.max()) / (CHUNK / 4.0)
            levels_db.append(20.0 * math.log10(mag) if mag > 1e-9 else -160.0)

        loudest = max(levels_db)
        if loudest > self._ceiling:
            self._ceiling = loudest                                # snap to transients
        else:
            self._ceiling += (CEILING_DB - self._ceiling) * 0.002   # drift back down

        span = max(12.0, self._ceiling - FLOOR_DB)
        top = float(self.bands - 1)
        with self._lock:
            for i, db in enumerate(levels_db):
                target = (db - FLOOR_DB) / span
                target = 0.0 if target < 0.0 else (1.0 if target > 1.0 else target)
                # Music carries far less energy up high. Without a tilt the
                # right-hand side of the field just looks broken.
                target *= 0.72 + 0.62 * (i / top)
                if target > 1.0:
                    target = 1.0
                previous = self._levels[i]
                step = ATTACK if target > previous else DECAY
                self._levels[i] = previous + (target - previous) * step


# ---------------------------------------------------------------- free functions


def _default_speaker_id():
    """Live default output endpoint id, read straight from Core Audio.

    pycaw is already a dependency (server/media.py uses it for volume). Going
    through it here is both cheaper and, unlike PortAudio's own idea of the
    default device, actually current: Core Audio has no enumeration-once
    snapshot to go stale.
    """
    from pycaw.pycaw import AudioUtilities

    return AudioUtilities.GetSpeakers().GetId()


def _find_pinned_loopback(audio, pin):
    """First loopback device whose name contains `pin`, case-insensitively."""
    needle = pin.lower()
    for info in audio.get_loopback_device_info_generator():
        if needle in info["name"].lower():
            return info
    raise RuntimeError("no loopback device matching '{0}'".format(pin))


def _log(msg, *args):
    """Best-effort line through the shared logger; never worth crashing over."""
    try:
        from server import access

        access.log.info(msg, *args)
    except Exception:
        pass
