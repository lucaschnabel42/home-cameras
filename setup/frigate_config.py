"""Make and keep the Frigate config (frigate/config/config.yml).

The first sync copies frigate/config.template.yml. Its first line is MARKER,
which tells a config that sync made from one that a person or Frigate wrote.

Keys that the tool owns, set from .env on every sync, but only in a config
with MARKER (a config of another origin keeps its own values):
- detectors and model    <- FRIGATE_DETECTOR (openvino or cpu)
- record days            <- RECORD_DAYS (continuous, alerts, detections)
- go2rtc webrtc candidates <- WEBRTC_CANDIDATES and WEBRTC_PORT

Cameras, in any config:
- each Wyze camera that the bridge lists, from rtsp://wyze-bridge:8554/<name>;
- each camera of cameras.yml, from its RTSP address (and its sub-stream).
A new camera gets a go2rtc stream, a clean stream (<name>_clean, the "clean"
ffmpeg template of the config), and a camera section. For a camera that the
config has, sync sets only its address: the go2rtc stream <name> and the
path of its sub-stream input. Every other edit to its section stays.
remove_camera takes out a camera, its two streams, and its name in the
camera groups.

Frigate reads the main stream from go2rtc's restream on 127.0.0.1:8554, so
recording and live view share one camera connection. A sub-stream is read
by Frigate directly, for detection only: as a go2rtc stream it would show in
the app as a camera of its own.

The YAML keeps its comments (ruamel).

What this does not do:
- It does not remove a camera that is gone from the bridge or cameras.yml;
  the "remove" command does that on request.
- It does not add or take away a sub-stream input of a camera that the
  config already has. To do that, remove the camera and sync again.
- It does not check that an RTSP address works; "doctor" checks the frames.
"""

import io
import math
import re

from ruamel.yaml import YAML

MARKER = "# home-cameras: made by setup sync from frigate/config.template.yml"
# The app's live proxy passes only these characters in a stream name
# (ui/Caddyfile, @app_live), so a camera name keeps to them.
NAME = re.compile(r"^[A-Za-z0-9_]+$")
DETECTORS = ("openvino", "cpu")
CLEAN_SIZE = (1920, 1080)
RESTREAM = "rtsp://127.0.0.1:8554/"
# Shared memory: Frigate's own formula (docs.frigate.video, installation,
# "Calculating required shm-size"): per camera, (width x height x 1.5 +
# 270480) / 1048576 x 25 frames MB at the detect size, plus 50 MB for logs
# and the nginx cache. The compose default is 256 MB; it is never lowered.
SHM_MIN_MB = 256
SHM_STEP_MB = 64
SHM_EXTRA_MB = 50

_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.width = 4096  # the clean template is one long line; never fold it
_yaml.indent(mapping=2, sequence=4, offset=2)


def load(text):
    return _yaml.load(text)


def dump(doc):
    out = io.StringIO()
    _yaml.dump(doc, out)
    return out.getvalue()


def made_by_sync(text):
    """True when the config text starts with MARKER (comments may follow)."""
    return (text or "").lstrip().startswith(MARKER)


def is_frigate_default(text):
    """True for the empty config that Frigate writes when it starts with
    none (config.yaml, "cameras: {}" with no camera)."""
    if not text or made_by_sync(text):
        return False
    try:
        doc = load(text)
    except Exception:
        return False
    return isinstance(doc, dict) and not doc.get("cameras")


def detector_for(machine):
    """The default detector for a processor type (platform.machine())."""
    return "openvino" if machine.lower() in ("x86_64", "amd64") else "cpu"


def safe_name(raw):
    """A bridge camera name made fit for Frigate and the app."""
    return re.sub(r"[^A-Za-z0-9_]", "_", raw)


def _detector_blocks(kind):
    if kind not in DETECTORS:
        raise ValueError(f"FRIGATE_DETECTOR must be one of {', '.join(DETECTORS)}")
    if kind == "openvino":
        # The OpenVINO model that the Frigate image holds at /openvino-model.
        return ({"ov": {"type": "openvino", "device": "CPU"}},
                {"width": 300, "height": 300, "input_tensor": "nhwc",
                 "input_pixel_format": "bgr",
                 "path": "/openvino-model/ssdlite_mobilenet_v2.xml",
                 "labelmap_path": "/openvino-model/coco_91cl_bkgr.txt"})
    # The CPU detector with the image's own TensorFlow Lite model
    # (/cpu_model.tflite), which needs no model section.
    return {"cpu1": {"type": "cpu", "num_threads": 3}}, None


def detector_of(doc):
    """openvino, cpu, or None for any other detector."""
    types = {(d or {}).get("type") for d in (doc.get("detectors") or {}).values()}
    return types.pop() if len(types) == 1 and types <= set(DETECTORS) else None


def _same(a, b):
    """Compare a ruamel value with a plain one."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


def apply_settings(doc, settings):
    """Set the keys that the tool owns from .env. Returns the changes, as
    short sentences with no secret in them."""
    changes = []
    kind = settings.get("FRIGATE_DETECTOR") or "openvino"
    detectors, model = _detector_blocks(kind)
    if not _same(doc.get("detectors"), detectors) or (
            model is not None and not _same(doc.get("model"), model)) or (
            model is None and "model" in doc):
        changes.append(f"detector: {detector_of(doc) or 'other'} -> {kind}")
        doc["detectors"] = detectors
        if model is None:
            doc.pop("model", None)
        else:
            doc["model"] = model

    days = int(settings.get("RECORD_DAYS") or 7)
    if days < 1:
        raise ValueError("RECORD_DAYS must be 1 or more")
    record = doc.setdefault("record", {})
    for path in (("continuous", "days"), ("alerts", "retain", "days"),
                 ("detections", "retain", "days")):
        node = record
        for key in path[:-1]:
            node = node.setdefault(key, {})
        if node.get(path[-1]) != days:
            changes.append(f"record {'.'.join(path)}: {node.get(path[-1])} -> {days}")
            node[path[-1]] = days

    extra = [c.strip() for c in (settings.get("WEBRTC_CANDIDATES") or "").split(",") if c.strip()]
    port = settings.get("WEBRTC_PORT") or "8555"
    candidates = extra + [f"stun:{port}"]
    webrtc = doc.setdefault("go2rtc", {}).setdefault("webrtc", {})
    if not _same(webrtc.get("candidates"), candidates):
        changes.append("WebRTC addresses: " + ", ".join(candidates))
        webrtc["candidates"] = candidates
    return changes


def new_config(template_text, settings):
    """The first config, from the template and the .env settings."""
    doc = load(template_text)
    apply_settings(doc, settings)
    return doc


def wyze_cameras(metrics):
    """[{name, source, audio}] from the bridge's /api/metrics answer."""
    out = []
    for cam in (metrics or {}).get("cameras") or []:
        raw = (cam or {}).get("name")
        if raw:
            out.append({"name": safe_name(raw), "source": f"rtsp://wyze-bridge:8554/{raw}",
                        "sub": None, "audio": True,
                        "label": f"{cam.get('nickname') or raw} ({cam.get('model_name') or 'Wyze'})"})
    return out


def rtsp_cameras(doc):
    """[{name, source, sub, audio}] from cameras.yml, or ValueError with the
    fault in plain words."""
    if not doc:
        return []
    entries = doc.get("cameras") if isinstance(doc, dict) else None
    if not isinstance(entries, list):
        raise ValueError('cameras.yml must have a list under "cameras:" (see cameras.example.yml)')
    out, seen = [], set()
    for n, entry in enumerate(entries, 1):
        if not isinstance(entry, dict):
            raise ValueError(f"cameras.yml, entry {n}: each entry needs name and rtsp")
        name, rtsp, sub = entry.get("name"), entry.get("rtsp"), entry.get("sub")
        if not isinstance(name, str) or not NAME.match(name):
            raise ValueError(f"cameras.yml, entry {n}: the name must be letters, digits and _ only")
        if name in seen:
            raise ValueError(f"cameras.yml: the name {name} is there two times")
        seen.add(name)
        for key, value in (("rtsp", rtsp), ("sub", sub)):
            if value is None and key == "sub":
                continue
            if not isinstance(value, str) or not re.match(r"^rtsps?://\S+$", value):
                raise ValueError(f"cameras.yml, {name}: {key} must be an rtsp:// address")
        audio = entry.get("audio", False)
        if not isinstance(audio, bool):
            raise ValueError(f"cameras.yml, {name}: audio must be true or false")
        out.append({"name": name, "source": rtsp, "sub": sub, "audio": audio, "label": name})
    return out


def clean_stream(name):
    """The go2rtc source of the clean stream of a camera."""
    width, height = CLEAN_SIZE
    return f"ffmpeg:{name}#video=clean#width={width}#height={height}"


def camera_section(cam):
    """The Frigate camera section of a new camera."""
    main_roles = ["record"] + ([] if cam["sub"] else ["detect"]) + (["audio"] if cam["audio"] else [])
    inputs = [{"path": RESTREAM + cam["name"], "input_args": "preset-rtsp-restream",
               "roles": main_roles}]
    if cam["sub"]:
        inputs.append({"path": cam["sub"], "input_args": "preset-rtsp-generic",
                       "roles": ["detect"]})
    section = {"ffmpeg": {"inputs": inputs}, "live": {"streams": {"Main": cam["name"]}}}
    if cam["audio"]:
        section["audio"] = {"enabled": True}
    return section


def _streams(doc):
    go2rtc = doc.setdefault("go2rtc", {})
    if not isinstance(go2rtc.get("streams"), dict):
        go2rtc["streams"] = {}
    return go2rtc["streams"]


def _sub_input(section):
    """The camera's direct (not restream) detect input, or None."""
    for inp in ((section or {}).get("ffmpeg") or {}).get("inputs") or []:
        path = str(inp.get("path", ""))
        if not path.startswith(RESTREAM) and "detect" in (inp.get("roles") or []):
            return inp
    return None


def sync_cameras(doc, cameras):
    """Add each new camera and set the address of each known one.
    Returns (added, updated, kept) camera names."""
    if not isinstance(doc.get("cameras"), dict):
        doc["cameras"] = {}
    streams = _streams(doc)
    added, updated, kept = [], [], []
    for cam in cameras:
        name = cam["name"]
        if name not in doc["cameras"]:
            streams[name] = [cam["source"]]
            streams[name + "_clean"] = [clean_stream(name)]
            doc["cameras"][name] = camera_section(cam)
            added.append(name)
            continue
        changed = False
        if not _same(streams.get(name), [cam["source"]]):
            streams[name] = [cam["source"]]
            changed = True
        sub = _sub_input(doc["cameras"][name])
        if cam["sub"] and sub is not None and sub.get("path") != cam["sub"]:
            sub["path"] = cam["sub"]
            changed = True
        (updated if changed else kept).append(name)
    return added, updated, kept


def remove_camera(doc, name):
    """Take out a camera, its streams, and its name in the camera groups.
    False when the config does not have the camera."""
    cameras = doc.get("cameras") or {}
    if name not in cameras:
        return False
    del cameras[name]
    streams = _streams(doc)
    for key in (name, name + "_clean"):
        streams.pop(key, None)
    for group in (doc.get("camera_groups") or {}).values():
        members = (group or {}).get("cameras")
        if isinstance(members, list) and name in members:
            members.remove(name)
    return True


def shm_mb(doc):
    """The shared memory, in MB, that Frigate needs for the cameras of doc."""
    detect = doc.get("detect") or {}
    total = SHM_EXTRA_MB
    for section in (doc.get("cameras") or {}).values():
        own = (section or {}).get("detect") or {}
        width = own.get("width") or detect.get("width") or 1280
        height = own.get("height") or detect.get("height") or 720
        total += (width * height * 1.5 + 270480) / 1048576 * 25
    return max(SHM_MIN_MB, int(math.ceil(total / SHM_STEP_MB) * SHM_STEP_MB))


def record_days(doc):
    """record.continuous.days of a config, or None."""
    try:
        return int(doc["record"]["continuous"]["days"])
    except (KeyError, TypeError, ValueError):
        return None
