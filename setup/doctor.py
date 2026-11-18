"""doctor: check the install and say, in plain words, what to fix.

Each check gives one line. "OK" lines say what works. A "FIX" line says what
is wrong and what to do. A "NOTE" line is a warning that does not stop the
cameras. The exit code is 1 when any check gives FIX.

The checks run in the setup container, on the compose network of the
install. They reach Frigate, the helper and the app by their service names,
and Docker by its socket.

What this does not do:
- It does not open the app from another device; the remote proxy (for
  example tailscale serve) is not checked.
- It does not fix anything. It changes no file and no container.
"""

import datetime
import json
import os
import shutil
import socket
import time
import urllib.error
import urllib.request
import zoneinfo
from dataclasses import dataclass

import envfile
import frigate_config
import wyze

SERVICES = ("frigate", "clip-exporter", "cam-helper", "ui")
DISK_FIX_GB = 5
DISK_NOTE_GB = 20
RECORDING_FRESH_S = 180
# A camera sends its first pictures to Frigate up to about a minute after a
# start, so a camera with none is not a fault before this.
WARM_UP_S = 120
# Today's rate of a camera needs at least this much recording.
MIN_SPAN_S = 600


@dataclass
class Result:
    level: str  # "OK", "NOTE" or "FIX"
    text: str
    pending: bool = False  # a state that a start clears; doctor --wait waits for it

    def line(self):
        return f"{self.level:<5}{self.text}"


def ok(text):
    return Result("OK", text)


def note(text):
    return Result("NOTE", text)


def fix(text):
    return Result("FIX", text)


def http_get(url, host=None, timeout=5):
    """(status, body bytes) of GET url. Raises OSError when nobody answers."""
    req = urllib.request.Request(url, headers={"Host": host} if host else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


# --- the checks ----------------------------------------------------------------------

def check_docker(docker):
    try:
        if docker.ping():
            return ok("Docker answers.")
    except OSError:
        pass
    return fix("The setup tool cannot reach Docker. Start Docker Desktop (or the Docker "
               "service), wait until it says it is running, and run doctor again.")


def check_time_zone(settings, now=None):
    tz = (settings.get("TZ") or "").strip()
    if not tz:
        return fix("No time zone is set. Run: docker compose run --rm setup init --tz "
                   "<Area/City>, for example --tz Europe/Berlin.")
    try:
        zone = zoneinfo.ZoneInfo(tz)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        return fix(f'The time zone "{tz}" is not a known name. Use a name such as '
                   "Europe/Berlin or America/New_York (init --tz).")
    clock = (now or datetime.datetime.now(datetime.timezone.utc)).astimezone(zone)
    text = f"The time zone is {tz}. The time there is {clock:%H:%M} on {clock:%Y-%m-%d}."
    if tz in ("UTC", "Etc/UTC"):
        return note(text + " If you do not live in UTC, set your own time zone with "
                           "init --tz, or the times in the app are wrong.")
    return ok(text + " Compare it with your own clock.")


def wanted_services(settings):
    profiles = {p.strip() for p in (settings.get("COMPOSE_PROFILES") or "").split(",")}
    return SERVICES + (("wyze-bridge",) if "wyze" in profiles else ())


def check_containers(containers, settings):
    """containers: the Docker API list of this compose project."""
    by_service = {}
    for c in containers:
        service = (c.get("Labels") or {}).get("com.docker.compose.service")
        if service and service != "setup":
            by_service[service] = c
    results = []
    for service in wanted_services(settings):
        c = by_service.get(service)
        if c is None:
            results.append(fix(f"The container {service} does not exist. Run: docker compose up -d"))
        elif c.get("State") != "running":
            results.append(fix(f"The container {service} is {c.get('State')} ({c.get('Status')}). "
                               f"Read its log: docker compose logs --tail 50 {service}"))
        elif "unhealthy" in (c.get("Status") or ""):
            results.append(fix(f"The container {service} runs but is unhealthy. "
                               f"Read its log: docker compose logs --tail 50 {service}"))
        else:
            results.append(ok(f"The container {service} is running."))
    return results


def check_frigate(get):
    try:
        status, body = get("http://frigate:5000/api/version")
    except OSError:
        status, body = None, b""
    if status == 200:
        return ok(f"Frigate answers (version {body.decode().strip()}).")
    return fix("Frigate does not answer. It needs about one minute after a start. If this "
               "stays, read its log: docker compose logs --tail 50 frigate")


def check_cameras(get):
    cameras, uptime = None, None
    try:
        status, body = get("http://frigate:5000/api/stats")
        if status == 200:
            stats = json.loads(body)
            cameras = stats.get("cameras") or {}
            uptime = (stats.get("service") or {}).get("uptime")
    except (OSError, ValueError):
        pass
    if cameras is None:
        return [fix("Frigate gives no camera numbers. Fix the Frigate line above first.")], []
    if not cameras:
        return [fix("Frigate has no camera. Add a camera (cameras.yml, or the Wyze settings "
                    "in .env), then run: docker compose run --rm setup sync")], []
    out = []
    for name, cam in sorted(cameras.items()):
        fps = (cam or {}).get("camera_fps") or 0
        if fps > 0:
            out.append(ok(f"The camera {name} sends pictures ({fps:.1f} per second)."))
        elif isinstance(uptime, (int, float)) and uptime < WARM_UP_S:
            out.append(Result("NOTE", f"The camera {name} sends no pictures yet: Frigate "
                                      f"started {uptime:.0f} s ago. Run doctor again in one "
                                      "minute.", pending=True))
        else:
            out.append(fix(f"The camera {name} sends no pictures. Check that it has power and "
                           "network, and that its RTSP address in cameras.yml is right (or, for "
                           "a Wyze camera, that it shows live in the Wyze app). Then: docker "
                           "compose logs --tail 50 frigate"))
    return out, sorted(cameras)


def newest_recording(root, now):
    """The age in seconds of the newest file in today's and yesterday's
    recording folders under root, or None. Frigate names these folders by
    the UTC date, not the local date."""
    newest = None
    for days in (0, 1):
        day = time.strftime("%Y-%m-%d", time.gmtime(now - days * 86400))
        folder = os.path.join(root, "recordings", day)
        for dirpath, _, files in os.walk(folder):
            for f in files:
                t = os.path.getmtime(os.path.join(dirpath, f))
                newest = t if newest is None else max(newest, t)
    return None if newest is None else now - newest


def check_recording(media, now):
    age = newest_recording(media, now)
    if age is None:
        return fix("No recording is in the media folder yet. Frigate writes its first "
                   "segment a minute after a camera sends pictures. If the cameras are fine "
                   "and this stays, check MEDIA_DIR in .env.")
    if age > RECORDING_FRESH_S:
        return fix(f"The newest recording is {age / 60:.0f} minutes old: Frigate does not "
                   "record now. Read: docker compose logs --tail 50 frigate")
    # A segment that Frigate still writes can carry a time a little after now.
    return ok(f"Frigate records (the newest segment is {max(age, 0):.0f} s old).")


def folder_bytes(folder):
    total = 0
    for dirpath, _, files in os.walk(folder):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def recording_rates(media, now):
    """{camera: (bytes a day, how it was measured)} from the recording
    folders (recordings/<UTC date>/<hour>/<camera>/). A camera with 20 or
    more hours yesterday is measured on that day. Else its files of today
    are scaled from the time between the first and the last segment to 24
    hours; under MIN_SPAN_S of recording gives no rate yet."""
    root = os.path.join(media, "recordings")
    rates = {}
    yesterday = time.strftime("%Y-%m-%d", time.gmtime(now - 86400))
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    for day in (yesterday, today):
        folder = os.path.join(root, day)
        if not os.path.isdir(folder):
            continue
        per_camera = {}  # camera -> [hours, bytes, first mtime, last mtime]
        for hour in os.listdir(folder):
            hour_dir = os.path.join(folder, hour)
            if not os.path.isdir(hour_dir):
                continue
            for camera in os.listdir(hour_dir):
                entry = per_camera.setdefault(camera, [0, 0, None, None])
                entry[0] += 1
                for dirpath, _, files in os.walk(os.path.join(hour_dir, camera)):
                    for f in files:
                        try:
                            st = os.stat(os.path.join(dirpath, f))
                        except OSError:
                            continue
                        entry[1] += st.st_size
                        entry[2] = st.st_mtime if entry[2] is None else min(entry[2], st.st_mtime)
                        entry[3] = st.st_mtime if entry[3] is None else max(entry[3], st.st_mtime)
        for camera, (hours, size, first, last) in per_camera.items():
            if camera in rates:
                continue
            if day == yesterday and hours >= 20:
                rates[camera] = (size * 24 / hours, "measured on yesterday")
            elif day == today and first is not None and last - first >= MIN_SPAN_S:
                span = last - first
                rates[camera] = (size * 86400 / span,
                                 f"estimated from {span / 60:.0f} min of recording today")
    return rates


def oldest_mtime(folder):
    oldest = None
    for dirpath, _, files in os.walk(folder):
        for f in files:
            try:
                t = os.path.getmtime(os.path.join(dirpath, f))
            except OSError:
                continue
            oldest = t if oldest is None else min(oldest, t)
    return oldest


def check_storage(media, settings, now, usage=shutil.disk_usage):
    """Free space, the measured size of the recordings and the clips, and in
    how many days the disk is full at this rate."""
    try:
        free = usage(media).free
    except OSError:
        return [fix("The media folder cannot be read. Check MEDIA_DIR in .env.")]
    gb = 1e9
    days = int(settings.get("RECORD_DAYS") or 7)
    keep = int(settings.get("CLIP_KEEP_DAYS") or 0)
    rates = recording_rates(media, now)
    out = []
    for camera, (rate, how) in sorted(rates.items()):
        out.append(ok(f"The recordings of {camera} take {rate / gb:.1f} GB a day ({how})."))
    per_day = sum(r for r, _ in rates.values())
    root = os.path.join(media, "recordings")
    present = len([d for d in os.listdir(root)]) if os.path.isdir(root) else 0
    # Recordings grow until RECORD_DAYS days are there, then old ones go.
    record_growth = per_day * max(0, days - present)
    exports = os.path.join(media, "exports")
    clips = folder_bytes(exports) if os.path.isdir(exports) else 0
    first = oldest_mtime(exports) if clips else None
    clip_rate = clips / max(1.0, (now - first) / 86400) if first else 0
    # With CLIP_KEEP_DAYS the clips stop growing at keep days of clips.
    clip_growth = max(0, clip_rate * keep - clips) if keep else None
    text = f"The disk of the media folder has {free / gb:.0f} GB free."
    if clips:
        text += f" The event clips take {clips / gb:.1f} GB, about {clip_rate / gb:.2f} GB a day"
        text += f", kept {keep} days." if keep else ", kept for ever."
    if free < DISK_FIX_GB * gb or free < record_growth:
        out.append(fix(text + f" The recordings need {record_growth / gb:.0f} GB more to reach "
                              f"{days} days. Free space, lower RECORD_DAYS, or set MEDIA_DIR to "
                              "a larger disk and run: docker compose up -d"))
        return out
    left = free - record_growth - (clip_growth or 0)
    if keep or not clip_rate:
        out.append(ok(text + (" At this rate the recordings and clips fit on the disk."
                              if per_day else "")))
    else:
        full_in = left / clip_rate
        line = text + f" At this rate the disk is full in about {full_in:.0f} days."
        if full_in < 30:
            out.append(note(line + " Free space, or set CLIP_KEEP_DAYS in .env (init "
                                   "--clip-keep-days) so that old clips are deleted."))
        else:
            out.append(ok(line))
    return out


def check_helper(get):
    try:
        status, _ = get("http://cam-helper:8000/healthz")
    except OSError:
        status = None
    if status == 200:
        return ok("The helper (alerts, summaries, pet day) answers.")
    return fix("The helper does not answer. Read its log: docker compose logs --tail 50 cam-helper")


def check_app(get, settings, ui_container):
    port = settings.get("APP_PORT") or "5010"
    try:
        status, body = get("http://ui:80/", host="localhost")
    except OSError:
        status, body = None, b""
    if status != 200 or b"<html" not in body.lower():
        return fix("The app does not answer. Read: docker compose logs --tail 50 ui")
    published = []
    for c in ([ui_container] if ui_container else []):
        for p in c.get("Ports") or []:
            if p.get("PrivatePort") == 80 and p.get("PublicPort"):
                published.append(str(p["PublicPort"]))
    if port not in published:
        return fix(f"The app answers, but not on port {port} of this computer. Run: "
                   "docker compose up -d")
    return ok(f"The app answers. Open http://127.0.0.1:{port} on this computer.")


def check_env(env_text):
    """FIX for each .env value that Docker reads in another way (envfile.problems)."""
    found = envfile.problems(env_text or "")
    if not found:
        return [ok("The values in .env are written so that Docker reads them as typed.")]
    return [fix(f".env, {key}: {what}") for key, what in found]


def check_config(work, settings):
    """Where the Frigate config comes from, and whether its days match .env."""
    folder = os.path.join(work, "frigate", "config")
    try:
        with open(os.path.join(folder, "config.yml"), encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        if os.path.exists(os.path.join(folder, "config.yaml")):
            return fix("Frigate started before sync and made its own empty config. Run: "
                       "docker compose run --rm setup sync")
        return fix("There is no Frigate config yet. Run: docker compose run --rm setup sync")
    days = frigate_config.record_days(frigate_config.load(text))
    want = int(settings.get("RECORD_DAYS") or 7)
    if not frigate_config.made_by_sync(text):
        return note("The Frigate config was not made from the template by sync. sync adds "
                    "cameras to it, but does not set its detector, its days of recording "
                    f"({days}), or its WebRTC addresses from .env.")
    if days != want:
        return fix(f"The Frigate config keeps {days} days of recordings, and .env says "
                   f"RECORD_DAYS={want}. Run: docker compose run --rm setup sync")
    return ok(f"The Frigate config was made by sync from the template ({days} days of "
              "recordings).")


def check_wyze(settings, get):
    if "wyze" not in (settings.get("COMPOSE_PROFILES") or ""):
        return []
    state, cameras = wyze.status(settings, get)
    text = wyze.message(state, settings, cameras)
    return [ok(text) if state == "ok" else fix(text)]


def websocket_status(host, origin, src, timeout=5):
    """The HTTP status of a websocket opening on the live path of the app,
    sent to the ui service with this Host and Origin."""
    lines = [f"GET /live/mse/api/ws?src={src} HTTP/1.1", f"Host: {host}",
             "Upgrade: websocket", "Connection: Upgrade",
             "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13",
             f"Origin: {origin}", "", ""]
    sock = socket.create_connection(("ui", 80), timeout=timeout)
    try:
        sock.sendall("\r\n".join(lines).encode())
        first = sock.recv(256).split(b"\r\n", 1)[0].decode(errors="replace")
    finally:
        sock.close()
    parts = first.split()
    return int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None


def check_remote(get, settings, ui_container, camera, ws=websocket_status):
    """Send the app and its live socket the Host and Origin that a phone
    sends through the remote proxy (https://APP_HOST)."""
    host = (settings.get("APP_HOST") or "").strip()
    if not host:
        return note("APP_HOST is empty: only this computer can open the app. For a phone, "
                    "see INSTALL.md, Step 12.")
    running = None
    for item in ((ui_container or {}).get("Config") or {}).get("Env") or []:
        if item.startswith("APP_HOST="):
            running = item.split("=", 1)[1]
    if running is not None and running != host:
        return fix(f"The app runs with APP_HOST={running}, but .env says {host}. Run: "
                   "docker compose up -d")
    try:
        status, body = get("http://ui:80/", host=host)
    except OSError:
        status, body = None, b""
    if status != 200 or b"<html" not in body.lower():
        return fix(f"The app refuses the name {host} (answer {status}). Check APP_HOST in .env, "
                   "then run: docker compose up -d")
    if camera:
        try:
            live = ws(host, f"https://{host}", camera)
        except OSError:
            live = None
        if live != 101:
            return fix(f"The app page opens as https://{host}, but its live view refuses it "
                       f"(answer {live}). Run: docker compose up -d")
    return ok(f"The app accepts https://{host}, the page and the live view. That name must be "
              "the one that tailscale serve shows.")


def run(settings, docker, get, media, project, now=None, work="/work", env_text="",
        ws=websocket_status):
    """All checks, in order, as Results."""
    now = now or time.time()
    results = [check_docker(docker)]
    containers = []
    if results[0].level == "OK":
        try:
            containers = docker.project_containers(project)
        except OSError:
            containers = []
        results += check_containers(containers, settings)
    results += check_env(env_text)
    results.append(check_time_zone(settings))
    results.append(check_config(work, settings))
    results += check_wyze(settings, lambda url: json.loads(get(url)[1]))
    results.append(check_frigate(get))
    camera_results, cameras = check_cameras(get)
    results += camera_results
    results.append(check_recording(media, now))
    results += check_storage(media, settings, now)
    results.append(check_helper(get))
    ui = next((c for c in containers
               if (c.get("Labels") or {}).get("com.docker.compose.service") == "ui"), None)
    results.append(check_app(get, settings, ui))
    ui_full = None
    if ui is not None:
        try:
            ui_full = docker.container(ui["Id"])
        except (OSError, KeyError):
            ui_full = None
    results.append(check_remote(get, settings, ui_full, cameras[0] if cameras else None, ws))
    return results
