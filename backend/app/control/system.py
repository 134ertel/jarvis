"""Read-only system performance snapshot (CPU/RAM/disk) and full hardware
telemetry (CPU/GPU/RAM/storage/network) for the System panel.

Backs the "Check PC performance" automation step and can be called on its own.
Purely informational — same no-permission tier as get_current_time/date in
app.ai.manager, not gated by any Scope, since it changes nothing on the
machine.

get_telemetry() only ever returns real sampled values or None — never a
fabricated number. CPU temperature and all GPU fields depend on hardware/
driver support Windows doesn't guarantee (e.g. many desktop boards expose no
ACPI thermal zone at all, and GPU stats currently only cover NVIDIA via
nvidia-smi); when a reading genuinely isn't available, the field is None and
the System panel shows "N/A" rather than guessing.
"""

import subprocess
from pathlib import Path
from typing import Optional

import psutil


def check_performance() -> str:
    cpu = psutil.cpu_percent(interval=0.3)
    ram = psutil.virtual_memory().percent
    disk = psutil.disk_usage(str(Path.home())).percent
    return f"CPU at {cpu:.0f}%, RAM at {ram:.0f}%, disk at {disk:.0f}% used."


def _cpu_temperature_c() -> Optional[float]:
    """ACPI thermal zone via WMI — only populated on some hardware (mostly
    laptops); most desktop boards report nothing here, in which case this
    returns None rather than guessing."""
    try:
        import win32com.client

        wmi = win32com.client.GetObject(r"winmgmts:\\.\root\wmi")
        zones = wmi.ExecQuery("SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature")
        temps = [zone.CurrentTemperature for zone in zones]
        if not temps:
            return None
        # ACPI reports tenths of a Kelvin.
        return round((max(temps) / 10) - 273.15, 1)
    except Exception:
        return None


_GPU_FIELDS = ("gpu_name", "gpu_percent", "gpu_temp_c", "gpu_vram_used_mb", "gpu_vram_total_mb")
_NO_GPU = dict.fromkeys(_GPU_FIELDS, None)


def _gpu_stats() -> dict:
    """NVIDIA only, via nvidia-smi (no extra dependency — ships with the
    driver). AMD/Intel GPUs have no equivalently simple, driver-bundled CLI,
    so they report as unavailable (None) rather than fabricated numbers."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return dict(_NO_GPU)
        # Only the first GPU — fine for the single-GPU desktops/laptops this app targets.
        name, util, temp, used, total = (p.strip() for p in result.stdout.strip().splitlines()[0].split(","))
        return {
            "gpu_name": name,
            "gpu_percent": float(util),
            "gpu_temp_c": float(temp),
            "gpu_vram_used_mb": float(used),
            "gpu_vram_total_mb": float(total),
        }
    except (OSError, subprocess.SubprocessError, ValueError):
        return dict(_NO_GPU)


def _network_up() -> bool:
    try:
        return any(s.isup for name, s in psutil.net_if_stats().items() if "loopback" not in name.lower())
    except Exception:
        return False


def get_telemetry() -> dict:
    """Sampled fresh on every call. cpu_percent's real 1-second sampling
    window is reused to measure network throughput over the same interval,
    so this call blocks for ~1s — callers should invoke it from a worker
    thread (a plain, non-async FastAPI route), not the event loop."""
    net_before = psutil.net_io_counters()
    cpu_percent = psutil.cpu_percent(interval=1.0)
    net_after = psutil.net_io_counters()

    download_kbps = max(0.0, (net_after.bytes_recv - net_before.bytes_recv) / 1024)
    upload_kbps = max(0.0, (net_after.bytes_sent - net_before.bytes_sent) / 1024)

    return {
        "cpu_percent": cpu_percent,
        "cpu_temp_c": _cpu_temperature_c(),
        "ram_percent": psutil.virtual_memory().percent,
        "storage_percent": psutil.disk_usage(str(Path.home())).percent,
        "download_kbps": round(download_kbps, 1),
        "upload_kbps": round(upload_kbps, 1),
        "network_up": _network_up(),
        **_gpu_stats(),
    }
