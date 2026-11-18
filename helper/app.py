"""cam-helper: web push, summaries, and the pet day for the camera app.

The app reaches this service at /helper/* on its own origin; Caddy strips
/helper and passes the rest here (port 8000). JSON in and out.

Routes:
- GET /healthz: {"ok": true}.
- GET /config: the pet and the features that are on (pet.client_config).
- GET /push/key; POST /push/subscribe, /push/unsubscribe, /push/test.
- GET /summaries?after=<unix seconds>: {review id: {"title", "summary"}}.
- GET /cameras: the last-live time of each camera (cameras.py).
- GET /pet/days, /pet/<date>.json (the day with its story), and
  /pet/<date>/<rest or unix seconds>.jpg: the pet day (pet_day.py,
  story.py). With no pet in the settings, /pet/days is an empty list.

State lives in /data (the compose volume ./helper/state, gitignored).

Settings (environment): FRIGATE_URL, VAPID_SUBJECT or APP_HOST (the contact
in each push message, vapid_subject), OLLAMA_URL (empty: no
summaries and no model story), GPU_GATE ("nvidia": summaries wait for a free
GPU), INDOOR_CAMERAS, and the PET_* values of pet.py.

What this does not do:
- It has no login of its own. The app's remote access (a tailnet, or a login
  proxy in front of it) is the login, the same as for Frigate's API.
- It accepts only GET and POST, and a body of at most BODY_MAX bytes.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import alerts
import cameras
import frigate
import jsonstore
import pet
import pet_day
import push
import story
import summaries

BODY_MAX = 16 * 1024
PET_DAY = re.compile(r"^/pet/(\d{4}-\d{2}-\d{2})\.json$")
PET_IMAGE = re.compile(r"^/pet/(\d{4}-\d{2}-\d{2})/(rest|\d{9,11})\.jpg$")
ALERT_EVERY_S = 10
ALERT_LOOKBACK_S = 3600
PET_EVERY_S = 60
DEFAULT_VAPID_SUBJECT = "mailto:home-cameras@example.com"

log = logging.getLogger("cam-helper")


def _json(status, value):
    return status, {"Content-Type": "application/json", "Cache-Control": "no-store"}, \
        json.dumps(value).encode()


def _empty(status):
    return status, {}, b""


def _error(status, message):
    return _json(status, {"error": message})


def _endpoint(body):
    """The "endpoint" string of a JSON body, or ValueError."""
    value = json.loads(body or b"null")
    if not isinstance(value, dict) or not isinstance(value.get("endpoint"), str):
        raise ValueError("body must be {\"endpoint\": \"...\"}")
    return value["endpoint"]


def route(svc, method, target, body):
    """Answer one request. Returns (status, headers, body bytes).

    svc provides config, public_key, subscribe, unsubscribe, test_push,
    summaries, cameras, pet_days, pet_day and pet_image. A ValueError from svc
    or from parsing is a 400. Pet paths must match PET_DAY or PET_IMAGE whole;
    a percent-encoded path is not decoded, so it never matches.
    """
    parts = urllib.parse.urlsplit(target)
    path, query = parts.path, urllib.parse.parse_qs(parts.query)
    get_routes = {"/healthz", "/config", "/push/key", "/summaries", "/cameras", "/pet/days"}
    post_routes = {"/push/subscribe", "/push/unsubscribe", "/push/test"}
    is_pet_file = path.startswith("/pet/") and path != "/pet/days"

    if path in get_routes or is_pet_file:
        if method != "GET":
            return _error(405, "GET only")
    elif path in post_routes:
        if method != "POST":
            return _error(405, "POST only")
    else:
        return _error(404, "no such route")

    try:
        if path == "/healthz":
            return _json(200, {"ok": True})
        if path == "/config":
            return _json(200, svc.config())
        if path == "/push/key":
            return _json(200, {"publicKey": svc.public_key()})
        if path == "/push/subscribe":
            svc.subscribe(json.loads(body or b"null"))
            return _empty(204)
        if path == "/push/unsubscribe":
            svc.unsubscribe(_endpoint(body))
            return _empty(204)
        if path == "/push/test":
            result = svc.test_push(_endpoint(body))
            if result == "unknown":
                return _error(404, "unknown subscription")
            if result != "sent":
                return _error(502, "the push service refused the message")
            return _empty(204)
        if path == "/summaries":
            after = float(query.get("after", ["0"])[0])
            return _json(200, svc.summaries(after))
        if path == "/cameras":
            return _json(200, {"cameras": svc.cameras()})
        if path == "/pet/days":
            return _json(200, svc.pet_days())
        day = PET_DAY.match(path)
        if day:
            doc = svc.pet_day(day.group(1))
            return _json(200, doc) if doc is not None else _error(404, "no such day")
        image = PET_IMAGE.match(path)
        if not image:
            return _error(404, "no such picture")
        data = svc.pet_image(image.group(1), image.group(2) + ".jpg")
        if data is None:
            return _error(404, "no such picture")
        # A moment image never changes (its name is its time); rest.jpg is
        # made again every hour.
        cache = "no-cache" if image.group(2) == "rest" else "private, max-age=604800, immutable"
        return 200, {"Content-Type": "image/jpeg", "Cache-Control": cache}, data
    except ValueError as exc:  # json.JSONDecodeError is a ValueError
        return _error(400, str(exc))


def make_server(svc, host, port):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _handle(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            if length > BODY_MAX:
                status, headers, body = _error(413, "body too large")
                self.close_connection = True
            else:
                raw = self.rfile.read(length) if length else b""
                try:
                    status, headers, body = route(svc, method, self.path, raw)
                except Exception:
                    log.exception("%s %s failed", method, self.path.split("?")[0])
                    status, headers, body = _error(500, "internal error")
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PUT(self):
            self._handle("PUT")

        def do_DELETE(self):
            self._handle("DELETE")

        def do_PATCH(self):
            self._handle("PATCH")

        def log_message(self, fmt, *args):
            # Paths only; query strings and bodies stay out of the log.
            log.debug("%s %s", self.command, self.path.split("?")[0])

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def start_loop(name, step, every_s):
    """Run step() every every_s seconds in a daemon thread; log, never die."""

    def run():
        while True:
            started = time.monotonic()
            try:
                step()
            except Exception:
                log.exception("%s loop failed", name)
            time.sleep(max(1.0, every_s - (time.monotonic() - started)))

    threading.Thread(target=run, name=name, daemon=True).start()


class AlertLoop:
    """Every ALERT_EVERY_S: read events, apply alerts.decide, push.

    The state is saved before any push is sent, so a crash between the two
    loses a push rather than sending it twice.
    """

    def __init__(self, frigate, pusher, state_path, indoor, clock=time.time, pet=None):
        self.frigate = frigate
        self.pusher = pusher
        self.path = state_path
        self.indoor = list(indoor)
        self.clock = clock
        self.pet = pet
        self.state = jsonstore.load(state_path, {})
        if not isinstance(self.state, dict):
            self.state = {}

    def step(self):
        now = self.clock()
        events = {e["id"]: e for e in self.frigate.events(after=now - ALERT_LOOKBACK_S)}
        # A person on the couch for hours started before the lookback.
        events.update({e["id"]: e for e in self.frigate.events(in_progress=True)})
        pushes, self.state = alerts.decide(list(events.values()), now, self.state, self.indoor,
                                           self.pet)
        jsonstore.save(self.path, self.state)
        if not pushes:
            return
        reviews = self.frigate.reviews(after=now - 2 * ALERT_LOOKBACK_S)
        for p in pushes:
            url = alerts.review_url(reviews, p["camera"], p["event_id"], p["time"])
            # A tag of its own per alert: with a shared tag (the review link),
            # a bark alert can replace a smoke alarm's notification.
            counts = self.pusher.send_all({"title": p["title"], "body": p["body"], "url": url,
                                           "tag": f"{p['kind']}:{p['event_id']}"})
            log.info("%s alert on %s: %s", p["kind"], p["camera"], counts)


class Services:
    """The real services behind the routes. client_config is the body of
    GET /config (pet.client_config)."""

    def __init__(self, pusher, summarizer=None, pet_days=None, stories=None, last_live=None,
                 client_config=None):
        self.pusher = pusher
        self.summarizer = summarizer
        self.pet_days_maker = pet_days
        self.stories = stories
        self.last_live = last_live
        self.client_config = client_config or pet.client_config(None, False)

    def config(self):
        return self.client_config

    def public_key(self):
        return self.pusher.keys.public_key

    def subscribe(self, sub):
        clean = push.valid_subscription(sub)
        self.pusher.subs.add(clean)
        log.info("subscribed %s", push.endpoint_host(clean["endpoint"]))

    def unsubscribe(self, endpoint):
        self.pusher.subs.remove(endpoint)

    def test_push(self, endpoint):
        return self.pusher.test(endpoint)

    def summaries(self, after):
        return self.summarizer.summaries(after) if self.summarizer else {}

    def cameras(self):
        return self.last_live.cameras() if self.last_live else {}

    def _story(self, date):
        return self.stories.story(date) if self.stories else None

    def pet_days(self):
        """The days, each "updated" by its data or its story, newest first."""
        days = self.pet_days_maker.days() if self.pet_days_maker else []
        for d in days:
            s = self._story(d["date"])
            if s:
                d["updated"] = max(d["updated"], s["written"])
        return days

    def pet_day(self, date):
        """The day document with its story (null until one exists). A
        chapter lists only moments the day still has: the day data is made
        again after a final story, and can drop a moment."""
        doc = self.pet_days_maker.day(date) if self.pet_days_maker else None
        if doc is None:
            return None
        s = self._story(date)
        if s:
            have = {m["t"] for m in doc.get("moments", [])}
            s = dict(s, chapters=[dict(c, moments=[t for t in c["moments"] if t in have])
                                  for c in s["chapters"]])
        out = dict(doc, story=s)
        if s:
            out["updated"] = max(doc["updated"], s["written"])
        return out

    def pet_image(self, date, name):
        return self.pet_days_maker.image(date, name) if self.pet_days_maker else None


def move_old_pet_state(data, the_pet):
    """Rename the pet day folder of an earlier version to "pet".

    Earlier versions kept the pet day in a folder named after the pet, in
    lower case. The folder moves once, when "pet" does not exist yet.
    Returns the path of the pet day folder.
    """
    folder = os.path.join(data, "pet")
    if the_pet and not os.path.exists(folder):
        old = os.path.join(data, the_pet.name.lower())
        if os.path.isdir(old):
            os.rename(old, folder)
            log.info("moved the pet day state to %s", folder)
    return folder


def vapid_subject(env):
    """The contact in each push message: VAPID_SUBJECT when it is set, else
    the app's own address (https://APP_HOST), else a placeholder address."""
    given = (env.get("VAPID_SUBJECT") or "").strip()
    if given:
        return given
    host = (env.get("APP_HOST") or "").strip()
    if host and not host.endswith(".invalid"):
        return f"https://{host}"
    return DEFAULT_VAPID_SUBJECT


def gpu_check(gate, ollama):
    """The summaries' GPU gate: nvidia-smi when gate is "nvidia", else open."""
    if gate == "nvidia":
        return lambda: summaries.gpu_free(get_ps=summaries.ollama_ps(ollama))
    if gate:
        raise ValueError('GPU_GATE must be empty or "nvidia"')
    return lambda: True


def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    data = os.environ.get("DATA_DIR", "/data")
    keys = push.load_or_create_keys(os.path.join(data, "vapid.json"))
    subs = push.Subscriptions(os.path.join(data, "subscriptions.json"))
    pusher = push.Pusher(keys, vapid_subject(os.environ), subs)
    frig = frigate.Frigate(os.environ.get("FRIGATE_URL", "http://frigate:5000"))
    the_pet = pet.from_env(os.environ)
    ollama = os.environ.get("OLLAMA_URL", "").strip()
    # With no Ollama the model is never asked: the summaries loop does not
    # run, and the story of each day is the code-written template.
    has_model = bool(ollama)
    model_free = gpu_check(os.environ.get("GPU_GATE", "").strip(), ollama) if has_model \
        else (lambda: False)
    summarizer = summaries.Summarizer(
        frig, summaries.ollama_chat(ollama), model_free,
        os.path.join(data, "summaries.json"), clock=time.time, pet=the_pet)
    pet_days = stories = None
    if the_pet:
        pet_days = pet_day.PetDay(frig, move_old_pet_state(data, the_pet), the_pet,
                                  clock=time.time, summaries=summarizer.summaries)
        stories = story.StoryWriter(
            frig, pet_days, summarizer, summaries.ollama_chat(ollama, timeout=600), model_free,
            os.path.join(data, "stories.json"), the_pet, clock=time.time)
    last_live = cameras.LastLive(frig, os.path.join(data, "cameras.json"), clock=time.time)
    svc = Services(pusher, summarizer, pet_days, stories, last_live,
                   pet.client_config(the_pet, has_model))
    indoor = [c.strip() for c in os.environ.get("INDOOR_CAMERAS", "").split(",") if c.strip()]
    alert_loop = AlertLoop(frig, pusher, os.path.join(data, "alerts.json"), indoor, pet=the_pet)
    start_loop("alerts", alert_loop.step, ALERT_EVERY_S)
    if has_model:
        start_loop("summaries", summarizer.step, summaries.MIN_GAP_S)
    start_loop("cameras", last_live.step, cameras.EVERY_S)

    if the_pet:
        def pet_step():
            # One thread: the story makes the day data fresh before it writes.
            pet_days.step()
            stories.step()

        start_loop("pet", pet_step, PET_EVERY_S)
    log.info("pet day %s; summaries %s", "on" if the_pet else "off", "on" if has_model else "off")
    server = make_server(svc, "0.0.0.0", int(os.environ.get("PORT", "8000")))
    log.info("listening on :%s", server.server_address[1])
    server.serve_forever()


if __name__ == "__main__":
    main()
