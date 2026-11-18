"""Tests for push.py. Run: python -m pytest -q helper"""

import base64
import json
import logging
import os

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException

import push


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def client_sub(endpoint="https://web.push.apple.com/abc"):
    """A subscription as a browser makes it: a P-256 key and a 16-byte secret."""
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(
        encoding=push.serialization.Encoding.X962,
        format=push.serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": endpoint, "keys": {"p256dh": b64(point), "auth": b64(os.urandom(16))}}


# --- VAPID keys -------------------------------------------------------------

def test_keys_made_once_and_persist(tmp_path):
    path = tmp_path / "vapid.json"
    first = push.load_or_create_keys(str(path))
    assert path.exists()
    again = push.load_or_create_keys(str(path))
    assert again.public_key == first.public_key
    assert again.private_raw == first.private_raw


def test_public_key_is_uncompressed_p256_base64url(tmp_path):
    keys = push.load_or_create_keys(str(tmp_path / "vapid.json"))
    raw = unb64(keys.public_key)
    assert len(raw) == 65 and raw[0] == 4
    assert "=" not in keys.public_key and "+" not in keys.public_key and "/" not in keys.public_key
    # The public key belongs to the stored private key.
    private = ec.derive_private_key(int.from_bytes(unb64(keys.private_raw), "big"), ec.SECP256R1())
    assert b64(private.public_key().public_bytes(
        push.serialization.Encoding.X962, push.serialization.PublicFormat.UncompressedPoint)) \
        == keys.public_key


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_key_file_is_private(tmp_path):
    path = tmp_path / "vapid.json"
    push.load_or_create_keys(str(path))
    assert (path.stat().st_mode & 0o777) == 0o600


def test_private_key_never_logged(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    keys = push.load_or_create_keys(str(tmp_path / "vapid.json"))
    push.load_or_create_keys(str(tmp_path / "vapid.json"))
    assert keys.private_raw not in caplog.text
    assert "vapid" in caplog.text.lower()  # the positive control: it did log


# --- subscriptions ----------------------------------------------------------

def test_subscriptions_keyed_by_endpoint_and_persist(tmp_path):
    path = str(tmp_path / "subscriptions.json")
    subs = push.Subscriptions(path)
    a, b = client_sub("https://p/a"), client_sub("https://p/b")
    subs.add(a)
    subs.add(b)
    subs.add(dict(a, keys=b["keys"]))  # same endpoint again replaces
    again = push.Subscriptions(path)
    assert sorted(s["endpoint"] for s in again.all()) == ["https://p/a", "https://p/b"]
    assert again.get("https://p/a")["keys"] == b["keys"]
    again.remove("https://p/a")
    assert push.Subscriptions(path).get("https://p/a") is None
    again.remove("https://p/never")  # no error


def test_subscriptions_read_changes_from_another_writer(tmp_path):
    path = str(tmp_path / "subscriptions.json")
    one, two = push.Subscriptions(path), push.Subscriptions(path)
    one.add(client_sub("https://p/a"))
    assert two.get("https://p/a") is not None


def test_valid_subscription():
    good = client_sub()
    assert push.valid_subscription(good) == good
    bad = [
        None, [], {"endpoint": "https://p/a"},
        dict(good, endpoint="http://p/a"),
        dict(good, endpoint="https://" + "a" * 3000),
        dict(good, keys={"p256dh": good["keys"]["p256dh"]}),
        dict(good, keys={"p256dh": "short", "auth": good["keys"]["auth"]}),
        dict(good, keys={"p256dh": good["keys"]["p256dh"], "auth": b64(b"x" * 5)}),
        dict(good, keys={"p256dh": good["keys"]["p256dh"], "auth": "!!not base64!!"}),
    ]
    for sub in bad:
        with pytest.raises(ValueError):
            push.valid_subscription(sub)


def test_valid_subscription_keeps_only_known_fields():
    sub = dict(client_sub(), expirationTime=None, extra="x" * 100)
    assert set(push.valid_subscription(sub)) == {"endpoint", "keys"}


# --- send -------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status):
        self.status_code = status


class FakeWebpush:
    def __init__(self, status=201):
        self.status = status
        self.calls = []

    def __call__(self, subscription_info, data, vapid_private_key, vapid_claims, **kw):
        self.calls.append({"sub": subscription_info, "data": data, "claims": vapid_claims,
                           "key": vapid_private_key, **kw})
        # pywebpush mutates the claims dict it is given (adds aud and exp).
        vapid_claims.setdefault("aud", subscription_info["endpoint"])
        if isinstance(self.status, Exception):
            raise self.status
        if self.status > 202:
            raise WebPushException("Push failed", response=FakeResponse(self.status))
        return FakeResponse(self.status)


def make_pusher(tmp_path, status=201):
    keys = push.load_or_create_keys(str(tmp_path / "vapid.json"))
    subs = push.Subscriptions(str(tmp_path / "subscriptions.json"))
    fake = FakeWebpush(status)
    return push.Pusher(keys, "https://cameras.example", subs, webpush=fake), subs, fake


PAYLOAD = {"title": "Smoke alarm", "body": "Heard on Living room.", "url": "/#review=r1"}


def test_send_payload_is_json_with_fresh_claims(tmp_path):
    pusher, subs, fake = make_pusher(tmp_path)
    a, b = client_sub("https://p/a"), client_sub("https://q/b")
    subs.add(a)
    subs.add(b)
    assert pusher.send(a, PAYLOAD) == "sent"
    assert pusher.send(b, PAYLOAD) == "sent"
    assert json.loads(fake.calls[0]["data"]) == PAYLOAD
    assert fake.calls[0]["claims"] is not fake.calls[1]["claims"]
    assert fake.calls[1]["claims"] == {"sub": "https://cameras.example", "aud": "https://q/b"}
    assert fake.calls[0]["sub"] == a
    assert fake.calls[0]["ttl"] > 0 and fake.calls[0]["timeout"] > 0


@pytest.mark.parametrize("status", [404, 410])
def test_gone_subscription_is_removed(tmp_path, status):
    pusher, subs, fake = make_pusher(tmp_path, status)
    a = client_sub("https://p/a")
    subs.add(a)
    assert pusher.send(a, PAYLOAD) == "gone"
    assert subs.get("https://p/a") is None


def test_other_failure_keeps_subscription(tmp_path):
    pusher, subs, fake = make_pusher(tmp_path, 500)
    a = client_sub("https://p/a")
    subs.add(a)
    assert pusher.send(a, PAYLOAD) == "failed"
    assert subs.get("https://p/a") is not None


def test_network_error_keeps_subscription(tmp_path):
    pusher, subs, fake = make_pusher(tmp_path, OSError("no route"))
    a = client_sub("https://p/a")
    subs.add(a)
    assert pusher.send(a, PAYLOAD) == "failed"
    assert subs.get("https://p/a") is not None


def test_send_all_reaches_every_subscription(tmp_path):
    pusher, subs, fake = make_pusher(tmp_path)
    for name in "abc":
        subs.add(client_sub(f"https://p/{name}"))
    assert pusher.send_all(PAYLOAD) == {"sent": 3}
    assert sorted(c["sub"]["endpoint"] for c in fake.calls) == ["https://p/a", "https://p/b",
                                                                "https://p/c"]


def test_real_send_decrypts_at_the_endpoint(tmp_path):
    """Real pywebpush to a local server; the body decrypts to the payload."""
    import http_ece
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    got = {}

    class Endpoint(BaseHTTPRequestHandler):
        def do_POST(self):
            got["body"] = self.rfile.read(int(self.headers["Content-Length"]))
            got["headers"] = {k.lower(): v for k, v in self.headers.items()}
            self.send_response(201)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Endpoint)
    threading.Thread(target=server.handle_request, daemon=True).start()
    client_key = ec.generate_private_key(ec.SECP256R1())
    point = client_key.public_key().public_bytes(push.serialization.Encoding.X962,
                                                 push.serialization.PublicFormat.UncompressedPoint)
    auth = os.urandom(16)
    sub = {"endpoint": f"http://127.0.0.1:{server.server_address[1]}/push/x",
           "keys": {"p256dh": b64(point), "auth": b64(auth)}}
    keys = push.load_or_create_keys(str(tmp_path / "vapid.json"))
    pusher = push.Pusher(keys, "https://cameras.example",
                         push.Subscriptions(str(tmp_path / "subscriptions.json")))
    try:
        assert pusher.send(sub, PAYLOAD) == "sent"
    finally:
        server.server_close()
    plain = http_ece.decrypt(got["body"], private_key=client_key, auth_secret=auth,
                             version="aes128gcm")
    assert json.loads(plain) == PAYLOAD
    assert got["headers"]["content-encoding"] == "aes128gcm"
    assert f"k={keys.public_key}" in got["headers"]["authorization"]


def test_test_push(tmp_path):
    pusher, subs, fake = make_pusher(tmp_path)
    assert pusher.test("https://p/none") == "unknown"
    subs.add(client_sub("https://p/a"))
    assert pusher.test("https://p/a") == "sent"
    body = json.loads(fake.calls[0]["data"])
    assert set(body) == {"title", "body", "url"} and "Alerts work" in body["body"]


def test_subscriptions_are_capped_oldest_dropped(tmp_path):
    # another page could add endpoints without limit
    subs = push.Subscriptions(str(tmp_path / "s.json"))
    for i in range(push.MAX_SUBS + 3):
        subs.add({"endpoint": f"https://p/{i}", "keys": {"p256dh": "x", "auth": "y"}})
    ends = [s["endpoint"] for s in subs.all()]
    assert len(ends) == push.MAX_SUBS
    assert "https://p/0" not in ends and f"https://p/{push.MAX_SUBS + 2}" in ends
    subs.add({"endpoint": "https://p/5", "keys": {"p256dh": "x", "auth": "y"}})  # known: no drop
    assert len(subs.all()) == push.MAX_SUBS and "https://p/3" in [s["endpoint"] for s in subs.all()]
