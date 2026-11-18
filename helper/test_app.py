"""Tests for the HTTP routes in app.py. Run: python -m pytest -q helper"""

import json
import threading
import urllib.error
import urllib.request

import pytest

import pet

from app import BODY_MAX, make_server, route


class FakeServices:
    """Stands in for push, summaries, and the pet day."""

    def __init__(self):
        self.subs = {}
        self.tested = []

    def config(self):
        return pet.client_config(pet.Pet("Rex", "living_room_cam"), True)

    def public_key(self):
        return "BPUBLIC"

    def subscribe(self, sub):
        if not isinstance(sub, dict) or "endpoint" not in sub:
            raise ValueError("not a subscription")
        self.subs[sub["endpoint"]] = sub

    def unsubscribe(self, endpoint):
        self.subs.pop(endpoint, None)

    def test_push(self, endpoint):
        if endpoint not in self.subs:
            return "unknown"
        self.tested.append(endpoint)
        return "sent"

    def summaries(self, after):
        all_ = {"a": (100, {"title": "A", "summary": "a"}),
                "b": (200, {"title": "B", "summary": "b"})}
        return {k: v for k, (t, v) in all_.items() if t >= after}

    def pet_days(self):
        return [{"date": "2026-10-16", "updated": 1792200000}]

    def pet_day(self, date):
        return {"date": date, "story": None} if date == "2026-10-16" else None

    def cameras(self):
        return {"front_porch_cam": {"last_live": 1792112460, "source": "camera-service"}}

    def pet_image(self, date, name):
        files = {("2026-10-16", "rest.jpg"): b"\xff\xd8rest",
                 ("2026-10-16", "1792150123.jpg"): b"\xff\xd8moment"}
        return files.get((date, name))


def call(svc, method, path, body=None):
    raw = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    return route(svc, method, path, raw)


def test_healthz():
    status, headers, body = call(FakeServices(), "GET", "/healthz")
    assert status == 200 and json.loads(body) == {"ok": True}


def test_push_key():
    status, headers, body = call(FakeServices(), "GET", "/push/key")
    assert status == 200 and json.loads(body) == {"publicKey": "BPUBLIC"}
    assert headers["Content-Type"] == "application/json"


def test_subscribe_unsubscribe():
    svc = FakeServices()
    sub = {"endpoint": "https://push.example/1", "keys": {"p256dh": "x", "auth": "y"}}
    assert call(svc, "POST", "/push/subscribe", sub)[0] == 204
    assert "https://push.example/1" in svc.subs
    assert call(svc, "POST", "/push/unsubscribe", {"endpoint": "https://push.example/1"})[0] == 204
    assert svc.subs == {}


def test_subscribe_rejects_bad_body():
    svc = FakeServices()
    assert call(svc, "POST", "/push/subscribe", b"not json")[0] == 400
    assert call(svc, "POST", "/push/subscribe", {"nope": 1})[0] == 400


def test_push_test_known_and_unknown():
    svc = FakeServices()
    assert call(svc, "POST", "/push/test", {"endpoint": "https://push.example/1"})[0] == 404
    svc.subs["https://push.example/1"] = {}
    assert call(svc, "POST", "/push/test", {"endpoint": "https://push.example/1"})[0] == 204
    assert svc.tested == ["https://push.example/1"]


def test_push_test_send_failure_is_502():
    svc = FakeServices()
    svc.test_push = lambda endpoint: "failed"
    assert call(svc, "POST", "/push/test", {"endpoint": "e"})[0] == 502


def test_summaries_after_filter():
    svc = FakeServices()
    status, _, body = call(svc, "GET", "/summaries?after=150")
    assert status == 200 and json.loads(body) == {"b": {"title": "B", "summary": "b"}}
    assert set(json.loads(call(svc, "GET", "/summaries")[2])) == {"a", "b"}
    assert call(svc, "GET", "/summaries?after=abc")[0] == 400


def test_cameras_last_live():
    status, headers, body = call(FakeServices(), "GET", "/cameras")
    assert status == 200 and headers["Cache-Control"] == "no-store"
    assert json.loads(body) == {"cameras": {"front_porch_cam": {"last_live": 1792112460,
                                                                "source": "camera-service"}}}
    assert call(FakeServices(), "POST", "/cameras")[0] == 405


def test_real_services_without_cameras_answer_empty():
    import app

    assert app.Services(pusher=None).cameras() == {}


def test_pet_days_day_and_images():
    svc = FakeServices()
    status, _, body = call(svc, "GET", "/pet/days")
    assert status == 200 and json.loads(body) == [{"date": "2026-10-16", "updated": 1792200000}]
    status, headers, body = call(svc, "GET", "/pet/2026-10-16.json")
    assert status == 200 and headers["Content-Type"] == "application/json"
    assert json.loads(body) == {"date": "2026-10-16", "story": None}
    assert call(svc, "GET", "/pet/2026-10-15.json")[0] == 404
    status, headers, body = call(svc, "GET", "/pet/2026-10-16/rest.jpg")
    assert status == 200 and headers["Content-Type"] == "image/jpeg" and body == b"\xff\xd8rest"
    assert headers["Cache-Control"] == "no-cache"
    status, headers, body = call(svc, "GET", "/pet/2026-10-16/1792150123.jpg")
    assert status == 200 and body == b"\xff\xd8moment"
    assert "immutable" in headers["Cache-Control"]
    assert call(svc, "GET", "/pet/2026-10-16/1792150124.jpg")[0] == 404
    assert call(svc, "POST", "/pet/2026-10-16.json")[0] == 405


@pytest.mark.parametrize("path", [
    "/pet/../vapid.json", "/pet/..%2Fvapid.json", "/pet/vapid.json",
    "/pet/2026-10-16.jpg", "/pet/2026-10-16-night.jpg", "/pet/2026-10-16.json.bak",
    "/pet/2026-1-16.json", "/pet/2026-10-16/../state.json", "/pet/2026-10-16/..%2Frest.jpg",
    "/pet/2026-10-16/rest.png", "/pet/2026-10-16/12.jpg", "/pet/2026-10-16/rest.jpg/x",
    "/pet/2026-10-16//rest.jpg", "/pet/cache/2026-10-16/rest.jpg",
    "/pet/2026-10-16/%2e%2e.jpg", "/pet/2026-10-16/rest.jpg%00",
    "/pet/2026-10-16\\rest.jpg", "/pet/2026-10-16/rest.jpg?x=../y"])
def test_pet_rejects_other_names(path):
    svc = FakeServices()
    svc.pet_day = lambda date: pytest.fail(f"asked for {date!r}")
    svc.pet_image = lambda date, name: pytest.fail(f"asked for {date!r} {name!r}")
    if path.endswith("?x=../y"):  # the query is ignored; the path itself is good
        assert call(FakeServices(), "GET", path)[0] == 200
        return
    assert call(svc, "GET", path)[0] == 404


def test_real_services_add_the_story_to_the_day():
    import app

    class PetDays:
        def days(self):
            return [{"date": "2026-10-16", "updated": 100}, {"date": "2026-10-15", "updated": 50}]

        def day(self, date):
            return {"date": date, "updated": 100} if date == "2026-10-16" else None

        def image(self, date, name):
            return b"jpg"

    class Stories:
        def story(self, date):
            return ({"title": "A nap", "written": 300, "chapters": []} if date == "2026-10-16"
                    else None)

    svc = app.Services(pusher=None, pet_days=PetDays(), stories=Stories())
    assert svc.pet_days() == [{"date": "2026-10-16", "updated": 300},
                                {"date": "2026-10-15", "updated": 50}]
    assert svc.pet_day("2026-10-16") == {"date": "2026-10-16", "updated": 300,
                                           "story": {"title": "A nap", "written": 300,
                                                     "chapters": []}}
    assert svc.pet_day("2026-10-14") is None
    assert app.Services(pusher=None).pet_days() == []


def test_a_story_lists_only_moments_the_day_still_has():
    """A final story is never rewritten, but the day data is made again (a
    moment can be dropped later, for example by a stricter person rule)."""
    import app

    class PetDays:
        def day(self, date):
            return {"date": date, "updated": 100, "moments": [{"t": 1.5}, {"t": 3.0}]}

    class Stories:
        def story(self, date):
            return {"title": "A nap", "written": 50, "chapters": [
                {"start": 0, "end": 4, "text": "x", "moments": [1.5, 2.0, 3.0], "code": False}]}

    doc = app.Services(pusher=None, pet_days=PetDays(), stories=Stories()).pet_day("2026-10-16")
    assert doc["story"]["chapters"][0]["moments"] == [1.5, 3.0]
    assert Stories().story("x")["chapters"][0]["moments"] == [1.5, 2.0, 3.0]  # store unchanged
    assert app.Services(pusher=None).pet_day("2026-10-16") is None


def test_unknown_path_and_wrong_method():
    svc = FakeServices()
    assert call(svc, "GET", "/nope")[0] == 404
    assert call(svc, "GET", "/push/subscribe")[0] == 405
    assert call(svc, "POST", "/push/key")[0] == 405
    assert call(svc, "DELETE", "/push/key")[0] == 405


def test_real_services_validate_subscriptions(tmp_path):
    """The real Services: an http endpoint is a 400, a good one is stored."""
    import push
    from app import Services
    from test_push import client_sub

    keys = push.load_or_create_keys(str(tmp_path / "vapid.json"))
    subs = push.Subscriptions(str(tmp_path / "subscriptions.json"))
    svc = Services(push.Pusher(keys, "https://x", subs, webpush=None))
    assert call(svc, "POST", "/push/subscribe", client_sub("http://127.0.0.1:9/x"))[0] == 400
    assert subs.all() == []
    good = client_sub("https://push.example/1")
    assert call(svc, "POST", "/push/subscribe", dict(good, expirationTime=None))[0] == 204
    assert subs.all() == [good]
    assert json.loads(call(svc, "GET", "/push/key")[2]) == {"publicKey": keys.public_key}


class FakeFrigate:
    def __init__(self, events=(), reviews=()):
        self.ev, self.rv = list(events), list(reviews)
        self.calls = []

    def events(self, **kw):
        self.calls.append(kw)
        if kw.get("in_progress"):
            return [e for e in self.ev if e["end_time"] is None]
        return [e for e in self.ev if e["start_time"] > kw.get("after", 0)]

    def reviews(self, **kw):
        return self.rv


class FakePusher:
    def __init__(self):
        self.sent = []

    def send_all(self, payload):
        self.sent.append(payload)
        return {"sent": 1}


def test_alert_loop_pushes_once_and_keeps_state(tmp_path):
    from app import AlertLoop

    now = 1_800_000_000.0
    smoke = {"id": "s1", "label": "smoke_detector", "camera": "living_room_cam",
             "start_time": now - 3, "end_time": None}
    # A person who arrived 5 h ago and is still on the couch: only the
    # in-progress query returns him, and he must block the bark alert.
    person = {"id": "p1", "label": "person", "camera": "living_room_cam",
              "start_time": now - 5 * 3600, "end_time": None}
    barks = {"id": "b1", "label": "bark", "camera": "living_room_cam",
             "start_time": now - 300, "end_time": now - 10}
    review = {"id": "r1", "camera": "living_room_cam", "start_time": now - 5,
              "end_time": None, "data": {"detections": ["s1"]}}
    frigate = FakeFrigate([smoke, person, barks], [review])
    pusher = FakePusher()
    path = str(tmp_path / "alerts.json")
    rex = pet.Pet("Rex", "living_room_cam")
    loop = AlertLoop(frigate, pusher, path, ["living_room_cam"], clock=lambda: now, pet=rex)
    loop.step()
    assert pusher.sent == [{"title": "Smoke alarm",
                            "body": "A smoke alarm is sounding in the living room. Check on Rex.",
                            "url": "/#review=r1", "tag": "smoke:s1"}]
    loop.step()
    AlertLoop(frigate, pusher, path, ["living_room_cam"], clock=lambda: now + 400).step()
    assert len(pusher.sent) == 1


def test_alert_loop_survives_a_broken_state_file(tmp_path):
    from app import AlertLoop

    path = tmp_path / "alerts.json"
    path.write_text("{not json")
    loop = AlertLoop(FakeFrigate(), FakePusher(), str(path), [], clock=lambda: 1.0)
    loop.step()
    assert json.loads(path.read_text())["done"] == {}


def test_real_server_round_trip():
    """The socket layer: a real request, a JSON answer, a body cap."""
    svc = FakeServices()
    server = make_server(svc, "127.0.0.1", 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(base + "/push/key", timeout=5) as r:
            assert json.loads(r.read()) == {"publicKey": "BPUBLIC"}
        req = urllib.request.Request(
            base + "/push/subscribe", method="POST",
            data=json.dumps({"endpoint": "https://p/1", "keys": {}}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            assert r.status == 204
        big = urllib.request.Request(base + "/push/subscribe", method="POST",
                                     data=b"x" * (BODY_MAX + 1))
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(big, timeout=5)
        assert e.value.code == 413
    finally:
        server.shutdown()
        server.server_close()


def test_config_names_the_pet_and_the_features():
    status, headers, body = call(FakeServices(), "GET", "/config")
    assert status == 200 and headers["Cache-Control"] == "no-store"
    assert json.loads(body) == {"pet": {"name": "Rex", "camera": "living_room_cam", "label": "dog"},
                                "features": {"summaries": True, "petDay": True}}
    assert call(FakeServices(), "POST", "/config")[0] == 405


def test_real_services_with_no_pet():
    import app
    svc = app.Services(pusher=None)
    assert svc.config() == {"pet": None, "features": {"summaries": False, "petDay": False}}
    assert svc.pet_days() == [] and svc.pet_day("2026-10-16") is None


def test_the_old_pet_state_folder_moves_to_pet_once(tmp_path):
    import app
    old = tmp_path / "rex"
    (old / "2026-10-16").mkdir(parents=True)
    (old / "state.json").write_text("{}")
    rex = pet.Pet("Rex", "living_room_cam")
    folder = app.move_old_pet_state(str(tmp_path), rex)
    assert folder == str(tmp_path / "pet")
    assert (tmp_path / "pet" / "state.json").exists() and not old.exists()
    # A second start, or an old folder that comes back, changes nothing.
    old.mkdir()
    assert app.move_old_pet_state(str(tmp_path), rex) == folder and old.exists()


def test_no_pet_moves_nothing(tmp_path):
    import app
    (tmp_path / "rex").mkdir()
    app.move_old_pet_state(str(tmp_path), None)
    assert (tmp_path / "rex").exists() and not (tmp_path / "pet").exists()


def test_the_gpu_gate():
    import app
    assert app.gpu_check("", "http://ollama:11434")() is True
    with pytest.raises(ValueError):
        app.gpu_check("amd", "http://ollama:11434")


def test_the_push_contact_comes_from_the_app_host():
    import app
    assert app.vapid_subject({"VAPID_SUBJECT": "mailto:me@example.org", "APP_HOST": "a.ts.net"})         == "mailto:me@example.org"
    assert app.vapid_subject({"APP_HOST": "box.tail1.ts.net"}) == "https://box.tail1.ts.net"
    assert app.vapid_subject({"APP_HOST": "home-cameras.invalid"}) == app.DEFAULT_VAPID_SUBJECT
    assert app.vapid_subject({}) == app.DEFAULT_VAPID_SUBJECT
