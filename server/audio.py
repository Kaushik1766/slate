"""System audio spectrum.

Taps the WASAPI loopback of the default output device, so the visualiser
follows whatever the machine is actually playing rather than a microphone.

Only band magnitudes ever leave this module. Audio is analysed in a rolling
in-memory window and discarded immediately; nothing is recorded or written to
disk.

Capture runs on its own thread with its own lifetime: if the default output
device changes, or an interface is unplugged, the stream is torn down and
reopened without disturbing the rest of the server.
"""

import math
import threading
import time

BANDS = 28
LOW_HZ = 42.0
HIGH_HZ = 15000.0
CHUNK = 4096

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

        self._levels = [0.0] * bands
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._last_sound = 0.0
        self._ceiling = CEILING_DB
        self._edges = None
        self._window = None

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
        }

    # --------------------------------------------------------------- worker

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

    def _run(self):
        while not self._stop.is_set():
            try:
                self._capture()
            except Exception as exc:
                self.error = "{0}: {1}".format(type(exc).__name__, exc)
                self.available = False
                self._stop.wait(3.0)   # device probably went away; look again

    def _capture(self):
        import numpy as np
        import pyaudiowpatch as pa

        audio = pa.PyAudio()
        stream = None
        try:
            device = audio.get_default_wasapi_loopback()
            rate = int(device["defaultSampleRate"])
            channels = max(1, int(device["maxInputChannels"]))
            self.device_name = device["name"].replace(" [Loopback]", "")
            self._edges = self._band_edges(rate)
            self._window = np.hanning(CHUNK).astype(np.float32)
            current = device["index"]

            stream = audio.open(
                format=pa.paFloat32, channels=channels, rate=rate, input=True,
                frames_per_buffer=CHUNK, input_device_index=current,
            )
            self.available = True
            self.error = None
            checked = 0.0

            while not self._stop.is_set():
                raw = stream.read(CHUNK, exception_on_overflow=False)
                samples = np.frombuffer(raw, dtype=np.float32)
                if channels > 1:
                    samples = samples.reshape(-1, channels).mean(axis=1)
                if samples.size < CHUNK:
                    continue
                self._analyse(samples[:CHUNK], np)

                # Has the default output moved under us? Cheap, and only twice
                # a second.
                now = time.time()
                if now - checked > 2.0:
                    checked = now
                    try:
                        if audio.get_default_wasapi_loopback()["index"] != current:
                            return
                    except Exception:
                        return
        finally:
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
