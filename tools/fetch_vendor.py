"""Download the third-party assets Slate serves locally.

Everything is vendored on purpose: the tablet may sit on a network with no
internet access, and a dashboard that loses its icons when the wifi drops is
not a dashboard.  Run this once after cloning:

    .venv\\Scripts\\python.exe tools\\fetch_vendor.py
"""

import io
import os
import re
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}

LHM_VERSION = "v0.9.6"
LHM_URL = (
    "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/"
    "download/{0}/LibreHardwareMonitor.zip".format(LHM_VERSION)
)
# The WinForms bits are dead weight for a headless sensor read.
LHM_SKIP = {"aga.controls.dll", "oxyplot.dll", "oxyplot.windowsforms.dll"}

PHOSPHOR = "https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/"
GOOGLE_FONTS = (
    "https://fonts.googleapis.com/css2"
    "?family=Geist:wght@300;400;500;600;700"
    "&family=Geist+Mono:wght@400;500;600&display=swap"
)


def get(url, timeout=60):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=UA), timeout=timeout
    ).read()


def ensure(path):
    if not os.path.isdir(path):
        os.makedirs(path)
    return path


def fetch_lhm():
    out = ensure(os.path.join(ROOT, "vendor", "lhm"))
    print("LibreHardwareMonitor {0} ...".format(LHM_VERSION))
    archive = zipfile.ZipFile(io.BytesIO(get(LHM_URL)))
    count = 0
    for entry in archive.namelist():
        if "/" in entry:  # skip localisation subfolders
            continue
        name = os.path.basename(entry)
        if not name.lower().endswith(".dll") or name.lower() in LHM_SKIP:
            continue
        with open(os.path.join(out, name), "wb") as fh:
            fh.write(archive.read(entry))
        count += 1
    print("  {0} assemblies".format(count))


def fetch_phosphor():
    out = ensure(os.path.join(ROOT, "web", "vendor", "phosphor"))
    print("Phosphor icons ...")
    for remote, local in (
        ("regular/style.css", "style.css"),
        ("regular/Phosphor.woff2", "Phosphor.woff2"),
        ("fill/style.css", "style-fill.css"),
        ("fill/Phosphor-Fill.woff2", "Phosphor-Fill.woff2"),
    ):
        with open(os.path.join(out, local), "wb") as fh:
            fh.write(get(PHOSPHOR + remote))
    print("  4 files")


def fetch_fonts():
    out = ensure(os.path.join(ROOT, "web", "vendor", "fonts"))
    print("Geist and Geist Mono ...")
    css = get(GOOGLE_FONTS).decode("utf-8")
    blocks = re.findall(r"/\*\s*([\w\-\[\] ]+)\s*\*/\s*(@font-face\s*\{[^}]*\})", css)
    faces = []
    seen = set()
    for subset, block in blocks:
        if subset.strip() not in ("latin", "latin-ext"):
            continue
        url = re.search(r"url\((https://[^)]+\.woff2)\)", block)
        family = re.search(r"font-family:\s*'([^']+)'", block)
        weight = re.search(r"font-weight:\s*([\d ]+)", block)
        if not (url and family and weight):
            continue
        name = "{0}-{1}-{2}.woff2".format(
            family.group(1).replace(" ", ""),
            weight.group(1).strip().replace(" ", "_"),
            subset.strip(),
        )
        if name in seen:
            continue
        seen.add(name)
        with open(os.path.join(out, name), "wb") as fh:
            fh.write(get(url.group(1)))
        faces.append(block.replace(url.group(1), "./" + name))
    with open(os.path.join(out, "fonts.css"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(faces))
    print("  {0} faces".format(len(faces)))


def main():
    try:
        fetch_lhm()
        fetch_phosphor()
        fetch_fonts()
    except Exception as exc:
        print("Download failed: {0}".format(exc))
        return 1
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
