"""The setup tool of the home camera recorder.

Run it with Docker only:

    docker compose run --rm setup init [options]   write .env, make the push keys
    docker compose run --rm setup sync             put the cameras and settings in Frigate
    docker compose run --rm setup remove <camera>  take a camera out of Frigate
    docker compose run --rm setup doctor [--wait]  check the install

The project folder is mounted at /work. The tool never writes a secret to the
terminal or to a log: it says only whether a secret is set.

On Linux the container runs as root, so each file that the tool writes is
given to the owner of the project folder (own()). On Windows and macOS,
Docker Desktop does that itself.
"""

import argparse
import base64
import json
import os
import platform
import re
import socket
import sys
import time
import urllib.error
import urllib.request
import zoneinfo

import doctor
import envfile
import frigate_config
import wyze
from docker_api import Docker

WORK = os.environ.get("SETUP_WORK", "/work")
SECRETS = ("WYZE_PASSWORD", "API_ID", "API_KEY", "WYZE_TOTP_KEY")
FRIGATE = "http://frigate:5000"
BRIDGE_WAIT_S = 120
# How long sync waits for a Frigate that is still starting.
FRIGATE_WAIT_S = 120

# init option -> .env key
OPTIONS = {
    "tz": "TZ", "media_dir": "MEDIA_DIR", "record_days": "RECORD_DAYS",
    "clip_keep_days": "CLIP_KEEP_DAYS",
    "app_port": "APP_PORT", "admin_port": "ADMIN_PORT",
    "frigate_https_port": "FRIGATE_HTTPS_PORT", "webrtc_port": "WEBRTC_PORT",
    "frigate_bind_address": "FRIGATE_BIND_ADDRESS",
    "app_host": "APP_HOST", "admin_host": "ADMIN_HOST",
    "webrtc_candidates": "WEBRTC_CANDIDATES", "vapid_subject": "VAPID_SUBJECT",
    "indoor_cameras": "INDOOR_CAMERAS", "detector": "FRIGATE_DETECTOR",
    "pet_name": "PET_NAME", "pet_camera": "PET_CAMERA", "pet_label": "PET_LABEL",
    "pet_sex": "PET_SEX", "ollama_url": "OLLAMA_URL", "gpu_gate": "GPU_GATE",
    "wyze_email": "WYZE_EMAIL", "wyze_password": "WYZE_PASSWORD",
    "wyze_api_id": "API_ID", "wyze_api_key": "API_KEY", "wyze_totp_key": "WYZE_TOTP_KEY",
}


def say(text=""):
    print(text, flush=True)


def path(*parts):
    return os.path.join(WORK, *parts)


def own(p):
    """Give p to the owner of the project folder. A no-op when the tool does
    not run as root, or the file system has no owners (Docker Desktop)."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    st = os.stat(WORK)
    try:
        os.chown(p, st.st_uid, st.st_gid)
    except OSError:
        pass


def makedirs(p):
    """os.makedirs, with each new folder given to the owner (own())."""
    missing = []
    head = p
    while head and not os.path.exists(head):
        missing.append(head)
        head = os.path.dirname(head)
    os.makedirs(p, exist_ok=True)
    for folder in missing:
        own(folder)


def read_text(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return default


def write_text(p, text, mode=None):
    makedirs(os.path.dirname(p))
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    if mode is not None:
        os.chmod(tmp, mode)
    own(tmp)
    os.replace(tmp, p)


def settings():
    """The values of .env, or {} when there is no .env yet."""
    return envfile.parse(read_text(path(".env"), "") or "")


def env_problems():
    """FIX lines for .env values that Docker reads in another way."""
    return [f"FIX  .env, {key}: {what}"
            for key, what in envfile.problems(read_text(path(".env"), "") or "")]


def set_env(changes):
    base = read_text(path(".env")) or read_text(path(".env.example"), "") or ""
    write_text(path(".env"), envfile.update(base, changes))


# --- init ---------------------------------------------------------------------------

def validate(values, current):
    """Plain-word errors for the values that init is about to write."""
    errors = []
    tz = values.get("TZ")
    if not tz and not current.get("TZ"):
        errors.append("Give the time zone: --tz <Area/City>, for example --tz Europe/Berlin or "
                      "--tz America/New_York. Use --tz UTC only if you live in UTC.")
    if tz:
        try:
            zoneinfo.ZoneInfo(tz)
        except (zoneinfo.ZoneInfoNotFoundError, ValueError):
            errors.append(f'--tz "{tz}" is not a time zone name. Use a name such as '
                          "Europe/Berlin or America/New_York.")
    for key in ("APP_PORT", "ADMIN_PORT", "FRIGATE_HTTPS_PORT", "WEBRTC_PORT", "RECORD_DAYS",
                "CLIP_KEEP_DAYS"):
        v = values.get(key)
        if v and not (v.isdigit() and 0 < int(v) < 65536):
            errors.append(f"{key} must be a whole number, not {v!r}.")
    if values.get("CLIP_KEEP_DAYS") and int(values["CLIP_KEEP_DAYS"]) < 3:
        errors.append("--clip-keep-days must be 3 or more (or empty for never).")
    bind = values.get("FRIGATE_BIND_ADDRESS")
    if bind and not re.match(r"^(\d{1,3}(\.\d{1,3}){3})$", bind):
        errors.append("--frigate-bind-address must be an IPv4 address: 127.0.0.1 for this "
                      "computer only, or 0.0.0.0 for every network.")
    for key in ("APP_HOST", "ADMIN_HOST"):
        v = values.get(key)
        if v and not re.match(r"^[A-Za-z0-9.-]+$", v):
            errors.append(f"{key} must be a host name only (no https:// and no port), not {v!r}.")
    if values.get("PET_LABEL") not in (None, "", "dog", "cat"):
        errors.append("--pet-label must be dog or cat.")
    if values.get("PET_SEX") not in (None, "", "male", "female"):
        errors.append("--pet-sex must be male or female.")
    if values.get("PET_CAMERA") and not frigate_config.NAME.match(values["PET_CAMERA"]):
        errors.append("--pet-camera must be a camera name: letters, digits and _ only.")
    if values.get("FRIGATE_DETECTOR") not in (None, "", *frigate_config.DETECTORS):
        errors.append(f"--detector must be one of {', '.join(frigate_config.DETECTORS)}.")
    if values.get("GPU_GATE") not in (None, "", "nvidia"):
        errors.append('--gpu-gate must be "nvidia" or empty.')
    for key, value in values.items():
        try:
            envfile.quote(value)
        except ValueError:
            errors.append(f"{key}: a value with both ' and \\ cannot be stored. Change it.")
    return errors


def init_changes(args, current, machine):
    """The .env keys that init sets, from its arguments and the current .env."""
    changes = {key: getattr(args, opt) for opt, key in OPTIONS.items()
               if getattr(args, opt) is not None}
    # The detector follows the processor of this computer, unless it is
    # given or an earlier init already wrote one.
    if not changes.get("FRIGATE_DETECTOR") and not current.get("FRIGATE_DETECTOR"):
        changes["FRIGATE_DETECTOR"] = frigate_config.detector_for(machine)
    merged = dict(current, **changes)
    profiles = [p for p in (merged.get("COMPOSE_PROFILES") or "").split(",") if p.strip()]
    if merged.get("WYZE_EMAIL") and "wyze" not in profiles and not args.no_wyze:
        changes["COMPOSE_PROFILES"] = ",".join(profiles + ["wyze"])
    if args.no_wyze:
        changes["COMPOSE_PROFILES"] = ",".join(p for p in profiles if p != "wyze")
    return changes


def make_push_keys(p):
    """The VAPID key pair of web push, in the helper's format (push.py).
    False when the file is already there."""
    if os.path.exists(p):
        return False
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    def b64(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    private = ec.generate_private_key(ec.SECP256R1())
    raw = private.private_numbers().private_value.to_bytes(32, "big")
    point = private.public_key().public_bytes(serialization.Encoding.X962,
                                              serialization.PublicFormat.UncompressedPoint)
    write_text(p, json.dumps({"privateKey": b64(raw), "publicKey": b64(point)}), mode=0o600)
    return True


def next_step(final):
    """The one next command for the person, from the state of the folder."""
    wyze_on = "wyze" in (final.get("COMPOSE_PROFILES") or "")
    wyze_set = all((final.get(k) or "").strip() for k in wyze.NEEDED)
    have_list = os.path.exists(path("cameras.yml"))
    if os.path.exists(path("frigate/config/config.yml")):
        # The install exists: this run changed a setting of it. sync puts the
        # setting in the Frigate config, and up -d gives it to the containers.
        return ("Next: docker compose run --rm setup sync, then docker compose up -d, "
                "then docker compose run --rm setup doctor")
    if wyze_on and wyze_set:
        return "Next: docker compose up -d wyze-bridge, then docker compose run --rm setup sync"
    if wyze_on:
        return ("Next: type the Wyze values into .env (INSTALL.md, Step 5), then run "
                "docker compose run --rm setup init again.")
    if have_list:
        return "Next: docker compose run --rm setup sync"
    return ("Next: for Wyze cameras, type the four Wyze values into .env (INSTALL.md, Step 5) "
            "and run init again. For other cameras, copy cameras.example.yml to cameras.yml and "
            "add your cameras. Then run: docker compose run --rm setup sync")


def cmd_init(args):
    current = settings()
    changes = init_changes(args, current, platform.machine())
    errors = validate(changes, current)
    if errors:
        for e in errors:
            say("FIX  " + e)
        return 2
    set_env(changes)
    final = settings()
    say("Wrote .env. The settings are:")
    for key in ("TZ", "MEDIA_DIR", "RECORD_DAYS", "CLIP_KEEP_DAYS", "APP_PORT", "APP_HOST",
                "FRIGATE_BIND_ADDRESS", "FRIGATE_DETECTOR", "COMPOSE_PROFILES", "INDOOR_CAMERAS",
                "PET_NAME", "PET_CAMERA", "OLLAMA_URL"):
        say(f"  {key} = {final.get(key) or '(empty)'}")
    for key in ("WYZE_EMAIL", *SECRETS):
        say(f"  {key} = {'(set)' if final.get(key) else '(empty)'}")
    if (final.get("TZ") or "") in ("UTC", "Etc/UTC"):
        say("NOTE The time zone is UTC. The times in the app are UTC times.")
    problems = env_problems()
    for line in problems:
        say(line)
    if make_push_keys(path("helper", "state", "vapid.json")):
        say("Made the push keys (helper/state/vapid.json). Keep this file: without it every "
            "phone must turn alerts on again.")
    media = final.get("MEDIA_DIR") or "./media"
    if not os.path.isabs(media) and not re.match(r"^[A-Za-z]:[\\/]", media):
        makedirs(path(media))
    say()
    say(next_step(final) if not problems else "Next: fix the FIX lines in .env, then run init again.")
    return 1 if problems else 0


# --- sync ---------------------------------------------------------------------------

def http_json(url, method="GET", timeout=10):
    req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def wyze_wait(env, get=http_json, wait_s=BRIDGE_WAIT_S, sleep=time.sleep):
    """(state, cameras) of wyze.status, after a wait of up to wait_s while the
    bridge starts or reads the account."""
    deadline = time.monotonic() + wait_s
    while True:
        state, cameras = wyze.status(env, get)
        if state in wyze.FINAL or time.monotonic() >= deadline:
            return state, cameras
        sleep(5)


def skipped(env):
    return {c.strip() for c in (env.get("SKIP_CAMERAS") or "").split(",") if c.strip()}


def shm_value_mb(text):
    m = re.match(r"^\s*(\d+)\s*(m|mb)?\s*$", (text or "").lower())
    return int(m.group(1)) if m else None


def restart_frigate(wait_s=FRIGATE_WAIT_S, sleep=time.sleep, resolve=None):
    """Ask Frigate to restart, so that it reads the new config.

    "absent": no frigate container runs (its name does not resolve on the
    compose network). "restarted": Frigate took the request. "no_answer":
    the container runs, but Frigate did not answer within wait_s (it is
    still starting, or it is stuck)."""
    try:
        (resolve or socket.gethostbyname)("frigate")
    except OSError:
        return "absent"
    deadline = time.monotonic() + wait_s
    while True:
        try:
            http_json(FRIGATE + "/api/restart", method="POST", timeout=10)
            return "restarted"
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                return "no_answer"
            sleep(5)


def frigate_is_behind(doc):
    """True when Frigate runs and lacks a camera of the config file. False
    when Frigate does not answer: then there is nothing to compare."""
    try:
        running = set((http_json(FRIGATE + "/api/config", timeout=10) or {}).get("cameras") or {})
    except (OSError, ValueError):
        return False
    return bool(set(doc.get("cameras") or {}) - running)


def say_restart(result, done_text):
    if result == "restarted":
        say(done_text)
    elif result == "no_answer":
        say("FIX  Frigate runs but does not answer, so it has not read the change. Run: "
            "docker compose restart frigate")
    else:
        say("Frigate is not running yet. Start everything: docker compose up -d")


def load_config(config_dir):
    """(text, fault): the text of config.yml (or None), and a FIX text when
    Frigate's own config.yaml is in the way. Frigate's empty default (it
    writes one when it starts with no config) is moved aside."""
    text = read_text(os.path.join(config_dir, "config.yml"))
    other = os.path.join(config_dir, "config.yaml")
    other_text = read_text(other)
    if text is None and other_text is not None:
        if not frigate_config.is_frigate_default(other_text):
            return None, ("frigate/config/config.yaml holds cameras that Frigate wrote. sync "
                          "does not change it. Move it out of frigate/config (keep a copy), "
                          "then run sync again.")
        aside = other + ".frigate-default"
        os.replace(other, aside)
        say("Frigate had started before sync and wrote an empty config.yaml. Moved it to "
            "frigate/config/config.yaml.frigate-default.")
    return text, None


def cmd_sync(args):
    problems = env_problems()
    for line in problems:
        say(line)
    if problems:
        return 1
    env = settings()
    if not env.get("FRIGATE_DETECTOR"):
        env["FRIGATE_DETECTOR"] = frigate_config.detector_for(platform.machine())
    skip = skipped(env)
    cameras, fault = [], 0
    if "wyze" in (env.get("COMPOSE_PROFILES") or ""):
        say("Asking the Wyze bridge for its cameras (this can take two minutes after a start)...")
        state, wyze_cams = wyze_wait(env, wait_s=args.wait)
        if state != "ok":
            say("FIX  " + wyze.message(state, env))
            fault = 1
        for cam in wyze_cams:
            say(f"  Wyze camera {cam['name']}: {cam['label']}")
        cameras += wyze_cams
    listed = read_text(path("cameras.yml"))
    if listed is not None:
        try:
            cameras += frigate_config.rtsp_cameras(frigate_config.load(listed))
        except ValueError as exc:
            say(f"FIX  {exc}")
            return 1
    for name in sorted(skip & {c["name"] for c in cameras}):
        say(f"skip {name} (in SKIP_CAMERAS in .env)")
    cameras = [c for c in cameras if c["name"] not in skip]

    config_dir = path("frigate", "config")
    text, problem = load_config(config_dir)
    if problem:
        say("FIX  " + problem)
        return 1
    changes = []
    if text is None:
        if not cameras:
            say("FIX  No camera found. Add your cameras to cameras.yml (see cameras.example.yml), "
                "or set the Wyze values with init, then run sync again.")
            return 1
        try:
            doc = frigate_config.new_config(read_text(path("frigate", "config.template.yml")), env)
        except ValueError as exc:
            say(f"FIX  {exc}")
            return 1
        say("Made frigate/config/config.yml from the template "
            f"(detector {env['FRIGATE_DETECTOR']}).")
        changes.append("new config")
    else:
        doc = frigate_config.load(text)
        if frigate_config.made_by_sync(text):
            try:
                settings_changes = frigate_config.apply_settings(doc, env)
            except ValueError as exc:
                say(f"FIX  {exc}")
                return 1
            for c in settings_changes:
                say(f"set  {c}")
            changes += settings_changes
        else:
            say("NOTE The Frigate config was not made by sync. sync adds and updates cameras, "
                "but does not set the detector, the days of recording, or the WebRTC addresses.")
    added, updated, kept = frigate_config.sync_cameras(doc, cameras)
    for name in kept:
        say(f"keep {name}")
    for name in updated:
        say(f"update {name} (the address from the bridge or cameras.yml)")
    for name in added:
        say(f"add  {name}")
    changes += added + updated

    shm_needed = frigate_config.shm_mb(doc)
    shm_now = shm_value_mb(env.get("FRIGATE_SHM_SIZE")) or frigate_config.SHM_MIN_MB
    shm_changed = shm_needed > shm_now
    if shm_changed:
        set_env({"FRIGATE_SHM_SIZE": f"{shm_needed}mb"})
        say(f"set  FRIGATE_SHM_SIZE {shm_now}mb -> {shm_needed}mb in .env (for "
            f"{len(doc.get('cameras') or {})} cameras)")

    if not changes and not shm_changed:
        if frigate_is_behind(doc):
            say("The config is complete, but Frigate runs without some of its cameras (it "
                "started before the config was made).")
            result = restart_frigate()
            say_restart(result, "Frigate restarts with the config.")
            return 1 if result == "no_answer" else fault
        say("Nothing to change.")
        return fault
    if changes:
        write_text(path("frigate", "config", "config.yml"), frigate_config.dump(doc))
    if shm_changed:
        say("Restart needed: run docker compose up -d (the shared memory changes only when "
            "the Frigate container is made again).")
    else:
        result = restart_frigate()
        say_restart(result, "Frigate restarts with the new config. The app shows it in about "
                            "one minute.")
        if result == "no_answer":
            return 1
    return fault


def cmd_remove(args):
    name = args.camera
    config_dir = path("frigate", "config")
    text = read_text(os.path.join(config_dir, "config.yml"))
    doc = frigate_config.load(text) if text else None
    if doc is None or not frigate_config.remove_camera(doc, name):
        say(f"FIX  The Frigate config has no camera {name}. The cameras are: "
            + ", ".join(sorted((doc or {}).get("cameras") or {})))
        return 1
    write_text(os.path.join(config_dir, "config.yml"), frigate_config.dump(doc))
    env = settings()
    skip = skipped(env) | {name}
    set_env({"SKIP_CAMERAS": ",".join(sorted(skip))})
    say(f"Removed {name} and its streams from the Frigate config. Its recordings stay in the "
        "media folder until they expire.")
    say(f"Added {name} to SKIP_CAMERAS in .env, so sync does not add it again. To get it "
        "back, take it out of SKIP_CAMERAS and run sync.")
    result = restart_frigate()
    say_restart(result, "Frigate restarts without the camera.")
    return 1 if result == "no_answer" else 0


# --- doctor -------------------------------------------------------------------------

def own_project(docker):
    """The compose project of this setup container (from its own labels)."""
    try:
        me = docker.container(os.environ.get("HOSTNAME", ""))
        return (me.get("Config", {}).get("Labels") or {}).get("com.docker.compose.project")
    except OSError:
        return None


def cmd_doctor(args, sleep=time.sleep):
    docker = Docker()
    env = settings()
    if not env:
        say("FIX  There is no .env yet. Run: docker compose run --rm setup init --tz <Area/City>")
        return 1
    project = own_project(docker)
    deadline = time.monotonic() + max(0, args.wait)
    while True:
        results = doctor.run(env, docker, doctor.http_get, "/media", project,
                             work=WORK, env_text=read_text(path(".env"), ""))
        bad = sum(1 for r in results if r.level == "FIX")
        waiting = bad + sum(1 for r in results if r.pending)
        if not waiting or time.monotonic() >= deadline:
            break
        say(f"... {waiting} thing(s) not ready yet; checking again in 15 s")
        sleep(15)
    for r in results:
        say(r.line())
    say()
    say("Everything works." if not bad else f"{bad} thing(s) to fix: see the FIX lines above.")
    return 1 if bad else 0


def parser():
    p = argparse.ArgumentParser(prog="setup", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="write .env from the options; keep what is not given")
    for opt in OPTIONS:
        init.add_argument("--" + opt.replace("_", "-"), dest=opt)
    init.add_argument("--no-wyze", action="store_true", help="do not run the Wyze bridge")
    sync = sub.add_parser("sync", help="put the cameras and the settings in the Frigate config")
    sync.add_argument("--wait", type=int, default=BRIDGE_WAIT_S,
                      help="seconds to wait for the Wyze bridge (default %(default)s)")
    remove = sub.add_parser("remove", help="take a camera out of the Frigate config")
    remove.add_argument("camera")
    check = sub.add_parser("doctor", help="check the install")
    check.add_argument("--wait", type=int, default=0,
                       help="seconds to wait for a start before the result (default 0)")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    commands = {"init": cmd_init, "sync": cmd_sync, "remove": cmd_remove, "doctor": cmd_doctor}
    return commands[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
