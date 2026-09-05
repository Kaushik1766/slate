"""Hardware sampling.

Layered providers, best source wins:
  1. LibreHardwareMonitorLib (vendored DLL, loaded through pythonnet) - temps,
     per-core load, clocks, package power, fans. Most sensors need admin.
  2. nvidia-smi - GPU fallback when LHM is unavailable.
  3. psutil - load, memory, disks, network, battery. Always available.
  4. ACPI thermal zone via PowerShell - last-resort CPU temp, polled slowly.

Every LHM call happens on one dedicated worker thread; the library keeps
per-thread state and dislikes being driven from a pool.
"""

import os
import platform
import socket
import statistics
import subprocess
import sys
import time

import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.join(os.path.dirname(HERE), "vendor", "lhm")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _is_admin():
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _run(cmd, timeout=4.0):
    try:
        out = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=NO_WINDOW,
        )
        return out.stdout if out.returncode == 0 else None
    except Exception:
        return None


class _Lhm:
    """Thin wrapper over LibreHardwareMonitorLib."""

    def __init__(self):
        self.ok = False
        self.computer = None
        self.error = None
        try:
            if not os.path.isdir(DLL_DIR):
                raise RuntimeError("vendor/lhm missing, run tools/fetch_vendor.py")
            sys.path.append(DLL_DIR)
            import clr  # pythonnet

            clr.AddReference(os.path.join(DLL_DIR, "LibreHardwareMonitorLib.dll"))
            from LibreHardwareMonitor.Hardware import Computer

            c = Computer()
            c.IsCpuEnabled = True
            c.IsGpuEnabled = True
            c.IsMemoryEnabled = True
            c.IsMotherboardEnabled = True
            c.IsBatteryEnabled = True
            c.Open()
            self.computer = c
            self.ok = True
        except Exception as exc:  # depends on host machine
            self.error = "{0}: {1}".format(type(exc).__name__, exc)

    def read(self):
        """Return ({hardware_type: {(sensor_type, name): value}}, {type: name})."""
        if not self.ok:
            return {}, {}
        buckets = {}
        names = {}
        try:
            for hw in self.computer.Hardware:
                hw.Update()
                kind = str(hw.HardwareType)
                bucket = buckets.setdefault(kind, {})
                names.setdefault(kind, str(hw.Name))
                for s in hw.Sensors:
                    if s.Value is not None:
                        bucket[(str(s.SensorType), str(s.Name))] = float(s.Value)
                for sub in hw.SubHardware:
                    sub.Update()
                    for s in sub.Sensors:
                        if s.Value is not None:
                            bucket.setdefault(
                                (str(s.SensorType), str(s.Name)), float(s.Value)
                            )
        except Exception as exc:
            self.error = str(exc)
        return buckets, names

    def close(self):
        try:
            if self.computer is not None:
                self.computer.Close()
        except Exception:
            pass


def _pick(bucket, sensor_type, *candidates):
    """First matching sensor value, tolerating vendor naming differences."""
    for name in candidates:
        v = bucket.get((sensor_type, name))
        if v is not None:
            return v
    lowered = [c.lower() for c in candidates]
    for key, v in bucket.items():
        st, nm = key
        if st != sensor_type:
            continue
        low = nm.lower()
        for c in lowered:
            if c in low:
                return v
    return None


def _mean_of(bucket, sensor_type, prefix):
    vals = [
        v
        for key, v in bucket.items()
        if key[0] == sensor_type and key[1].lower().startswith(prefix)
    ]
    return statistics.fmean(vals) if vals else None


class HardwareMonitor:
    def __init__(self):
        self.admin = _is_admin()
        self.lhm = _Lhm()
        self.gpu_kind = None
        self._net_prev = None
        self._acpi_temp = None
        self._acpi_at = 0.0
        self._acpi_supported = None
        self._nvsmi_supported = None
        self._boot = psutil.boot_time()
        psutil.cpu_percent(percpu=True)  # prime the delta counters
        psutil.cpu_percent()

    # ---------------------------------------------------------------- helpers

    def _acpi_cpu_temp(self):
        """ACPI thermal zone, refreshed at most every 8s (spawns PowerShell)."""
        if self._acpi_supported is False:
            return None
        now = time.time()
        if now - self._acpi_at < 8.0:
            return self._acpi_temp
        self._acpi_at = now
        script = (
            "(Get-CimInstance -Namespace root/wmi "
            "-ClassName MSAcpi_ThermalZoneTemperature "
            "-ErrorAction SilentlyContinue | "
            "Measure-Object -Property CurrentTemperature -Maximum).Maximum"
        )
        out = _run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            timeout=6.0,
        )
        val = None
        if out and out.strip():
            try:
                val = round(int(out.strip()) / 10.0 - 273.15, 1)
            except ValueError:
                val = None
        if val is None or not (5 < val < 125):
            val = None
        self._acpi_supported = val is not None
        self._acpi_temp = val
        return val

    def _nvidia_smi(self):
        if self._nvsmi_supported is False:
            return None
        out = _run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,"
                "memory.total,power.draw,clocks.sm,fan.speed",
                "--format=csv,noheader,nounits",
            ]
        )
        if not out or not out.strip():
            self._nvsmi_supported = False
            return None
        self._nvsmi_supported = True
        parts = [p.strip() for p in out.strip().splitlines()[0].split(",")]

        def num(i):
            try:
                return float(parts[i])
            except (ValueError, IndexError):
                return None

        return {
            "name": parts[0],
            "load": num(1),
            "temp": num(2),
            "hotspot": None,
            "vram_used": num(3),
            "vram_total": num(4),
            "power": num(5),
            "clock": num(6),
            "fan": num(7),
        }

    # ----------------------------------------------------------------- sample

    def sample(self):
        now = time.time()
        buckets, names = self.lhm.read()
        cpu_b = buckets.get("Cpu", {})
        mb_b = buckets.get("Motherboard", {})

        # ---- CPU -------------------------------------------------------
        per_core = psutil.cpu_percent(percpu=True)
        cpu_load = _pick(cpu_b, "Load", "CPU Total")
        if cpu_load is None:
            cpu_load = psutil.cpu_percent()

        cpu_temp = _pick(
            cpu_b,
            "Temperature",
            "CPU Package",
            "Core (Tctl/Tdie)",
            "CPU Cores",
            "Core Max",
            "CPU Core",
        )
        temp_source = "sensor"
        if cpu_temp is None:
            cpu_temp = self._acpi_cpu_temp()
            temp_source = "acpi" if cpu_temp is not None else None

        cpu_power = _pick(cpu_b, "Power", "CPU Package", "Package")
        if not cpu_power or cpu_power <= 0:
            cpu_power = None
        cpu_clock = _mean_of(cpu_b, "Clock", "cpu core")
        cpu_fan = _pick(mb_b, "Fan", "CPU Fan", "Fan #1")

        cpu = {
            "name": names.get("Cpu") or platform.processor() or "Processor",
            "load": round(cpu_load, 1),
            "temp": round(cpu_temp, 1) if cpu_temp is not None else None,
            "temp_source": temp_source,
            "power": round(cpu_power, 1) if cpu_power else None,
            "clock": round(cpu_clock) if cpu_clock else None,
            "fan": round(cpu_fan) if cpu_fan else None,
            "cores": [round(c, 1) for c in per_core],
        }

        # ---- GPU -------------------------------------------------------
        gpu = None
        for kind in ("GpuNvidia", "GpuAmd", "GpuIntel"):
            b = buckets.get(kind)
            if not b:
                continue
            load = _pick(b, "Load", "GPU Core", "D3D 3D")
            temp = _pick(b, "Temperature", "GPU Core", "GPU Package")
            if load is None and temp is None:
                continue
            used = _pick(b, "SmallData", "GPU Memory Used", "D3D Dedicated Memory Used")
            total = _pick(b, "SmallData", "GPU Memory Total")
            gpu = {
                "name": names.get(kind, "Graphics"),
                "load": load,
                "temp": temp,
                "hotspot": _pick(b, "Temperature", "GPU Hot Spot"),
                "vram_used": round(used) if used else None,
                "vram_total": round(total) if total else None,
                "power": _pick(b, "Power", "GPU Package", "GPU Power"),
                "clock": _pick(b, "Clock", "GPU Core"),
                "fan": _pick(b, "Fan", "GPU Fan", "GPU"),
            }
            self.gpu_kind = kind
            break
        if gpu is None:
            gpu = self._nvidia_smi()
        if gpu:
            for k in ("load", "temp", "hotspot", "power", "clock", "fan"):
                if gpu.get(k) is not None:
                    gpu[k] = round(gpu[k], 1)
            if gpu.get("vram_used") and gpu.get("vram_total"):
                gpu["vram_pct"] = round(100.0 * gpu["vram_used"] / gpu["vram_total"], 1)
            else:
                gpu["vram_pct"] = None

        # ---- memory ----------------------------------------------------
        vm = psutil.virtual_memory()
        gb = 1024.0 ** 3
        ram = {
            "used_gb": round((vm.total - vm.available) / gb, 1),
            "total_gb": round(vm.total / gb, 1),
            "pct": round(vm.percent, 1),
        }
        sw = psutil.swap_memory()
        swap = {"used_gb": round(sw.used / gb, 1), "total_gb": round(sw.total / gb, 1)}

        # ---- disks -----------------------------------------------------
        disks = []
        for part in psutil.disk_partitions(all=False):
            if "cdrom" in part.opts or not part.fstype:
                continue
            try:
                u = psutil.disk_usage(part.mountpoint)
            except (PermissionError, OSError):
                continue
            disks.append(
                {
                    "mount": part.mountpoint.replace("\\", ""),
                    "used_gb": round(u.used / gb, 1),
                    "total_gb": round(u.total / gb, 1),
                    "pct": round(u.percent, 1),
                }
            )
        disks.sort(key=lambda d: d["mount"])

        # ---- network ---------------------------------------------------
        io = psutil.net_io_counters()
        up = down = 0.0
        if self._net_prev:
            dt = now - self._net_prev[0]
            # After an idle gap the counters would average over minutes and
            # report a rate that was never true. Re-anchor instead.
            if 1e-3 < dt <= 5.0:
                up = max(0.0, (io.bytes_sent - self._net_prev[1]) / dt)
                down = max(0.0, (io.bytes_recv - self._net_prev[2]) / dt)
        self._net_prev = (now, io.bytes_sent, io.bytes_recv)

        # ---- battery ---------------------------------------------------
        battery = None
        try:
            b = psutil.sensors_battery()
            if b is not None:
                mins = None
                if b.secsleft is not None and b.secsleft >= 0:
                    mins = int(b.secsleft // 60)
                battery = {
                    "pct": round(b.percent),
                    "plugged": bool(b.power_plugged),
                    "minutes": mins,
                }
        except Exception:
            battery = None

        return {
            "ts": now,
            "cpu": cpu,
            "gpu": gpu,
            "ram": ram,
            "swap": swap,
            "disks": disks,
            "net": {"up_bps": round(up), "down_bps": round(down)},
            "battery": battery,
            "sys": {
                "host": socket.gethostname(),
                "os": "{0} {1}".format(platform.system(), platform.release()),
                "uptime_s": int(now - self._boot),
                "procs": len(psutil.pids()),
            },
            "caps": {
                "lhm": self.lhm.ok,
                "admin": self.admin,
                "cpu_temp": cpu["temp"] is not None,
                "gpu": gpu is not None,
                "note": self.lhm.error,
            },
        }

    def close(self):
        self.lhm.close()
