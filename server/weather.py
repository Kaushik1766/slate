"""Weather for the clock panel.

Open-Meteo: no API key, no account, no attribution requirement, and it
returns the local timezone for the coordinates so the hourly strip lines up
with the clock sitting next to it.

Set SLATE_LAT / SLATE_LON / SLATE_PLACE to move it somewhere else.
"""

import json
import os
import time
import urllib.request

DEFAULT_LAT = 28.5355          # Noida, Uttar Pradesh
DEFAULT_LON = 77.3910
DEFAULT_PLACE = "Noida"

REFRESH = 600.0                # ten minutes; the data updates every fifteen
RETRY = 120.0                  # after a failure, try again sooner than that
HOURS_AHEAD = 6

ENDPOINT = (
    "https://api.open-meteo.com/v1/forecast"
    "?latitude={lat}&longitude={lon}"
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,"
    "weather_code,is_day,wind_speed_10m"
    "&hourly=temperature_2m,weather_code"
    "&daily=temperature_2m_max,temperature_2m_min"
    "&timezone=auto&forecast_days=2"
)

# WMO weather codes, grouped the way a person would describe them.
CODES = {
    0: ("Clear", "clear"),
    1: ("Mainly clear", "clear"),
    2: ("Partly cloudy", "partly"),
    3: ("Overcast", "cloud"),
    45: ("Fog", "fog"),
    48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "drizzle"),
    57: ("Freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"),
    67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"),
    80: ("Showers", "rain"),
    81: ("Showers", "rain"),
    82: ("Violent showers", "rain"),
    85: ("Snow showers", "snow"),
    86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "storm"),
    96: ("Thunderstorm, hail", "storm"),
    99: ("Thunderstorm, hail", "storm"),
}


def describe(code):
    return CODES.get(code, ("Unknown", "cloud"))


class WeatherFeed:
    def __init__(self):
        self.lat = float(os.environ.get("SLATE_LAT", DEFAULT_LAT))
        self.lon = float(os.environ.get("SLATE_LON", DEFAULT_LON))
        self.place = os.environ.get("SLATE_PLACE", DEFAULT_PLACE)
        self.latest = None
        self.error = None
        self._next_due = 0.0

    def due(self):
        return time.time() >= self._next_due

    def fetch(self):
        """Blocking. Call from a worker thread, never from the event loop."""
        url = ENDPOINT.format(lat=self.lat, lon=self.lon)
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "slate-dashboard"}
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                data = json.load(response)
            self.latest = self._shape(data)
            self.error = None
            self._next_due = time.time() + REFRESH
        except Exception as exc:
            self.error = "{0}: {1}".format(type(exc).__name__, exc)
            self._next_due = time.time() + RETRY
        return self.latest

    def _shape(self, data):
        current = data["current"]
        hourly = data.get("hourly") or {}
        daily = data.get("daily") or {}

        times = hourly.get("time") or []
        temps = hourly.get("temperature_2m") or []
        codes = hourly.get("weather_code") or []

        # The API hands back local times for the coordinates, so the strip
        # lines up with the clock beside it without any timezone maths here.
        now = current.get("time", "")
        start = 0
        for i, stamp in enumerate(times):
            if stamp >= now:
                start = i
                break

        hours = []
        for i in range(start, min(start + HOURS_AHEAD, len(times))):
            label = times[i][11:13] if len(times[i]) >= 13 else "--"
            hours.append({
                "at": label,
                "temp": round(temps[i]) if i < len(temps) else None,
                "code": codes[i] if i < len(codes) else 0,
            })

        text, icon = describe(current.get("weather_code", 0))
        highs = daily.get("temperature_2m_max") or []
        lows = daily.get("temperature_2m_min") or []

        return {
            "place": self.place,
            "temp": round(current.get("temperature_2m", 0)),
            "feels": round(current.get("apparent_temperature", 0)),
            "humidity": current.get("relative_humidity_2m"),
            "wind": round(current.get("wind_speed_10m", 0)),
            "code": current.get("weather_code", 0),
            "text": text,
            "icon": icon,
            "day": bool(current.get("is_day", 1)),
            "high": round(highs[0]) if highs else None,
            "low": round(lows[0]) if lows else None,
            "hours": hours,
            "updated": time.time(),
        }

    def state(self):
        if self.latest is None:
            return {"ok": False, "error": self.error, "place": self.place}
        payload = dict(self.latest)
        payload["ok"] = True
        payload["error"] = self.error
        return payload
