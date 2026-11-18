"""Web push: VAPID keys, the subscription list, and sending.

pywebpush signs the VAPID token and encrypts each message (RFC 8291,
aes128gcm). The VAPID key pair is made at first start into /data/vapid.json
and never leaves that file: it is never logged, and helper/state is gitignored
and kept out of the image by .dockerignore.

Subscriptions are kept in /data/subscriptions.json, keyed by endpoint. The
file is read on every call, so a second process sees the same list.

What this does not do:
- It does not check that an endpoint belongs to a known push service; it
  only requires https. Anyone who can reach the app can register an
  endpoint, and the helper then POSTs encrypted messages to it.
- It does not retry a failed send. A 404 or 410 from the push service means
  the subscription is gone, and it is removed; any other failure is logged.
"""

import base64
import binascii
import json
import logging
import os
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import WebPushException, webpush as _webpush

ENDPOINT_MAX = 2048
TTL_S = 3600
TIMEOUT_S = 10
# A few people with a few devices each. A cap stops anything from filling the
# file with endpoints; the oldest is dropped first.
MAX_SUBS = 10

TEST_PAYLOAD = {"title": "Test alert",
                "body": "Alerts work on this phone.",
                "url": "/"}

log = logging.getLogger("cam-helper.push")


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text):
    if not isinstance(text, str):
        raise ValueError("not a string")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise ValueError("not base64url") from None


def _write_private(path, text):
    """Write text to path with mode 0600, atomically."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


@dataclass(frozen=True)
class Keys:
    private_raw: str  # base64url of the 32-byte private scalar
    public_key: str  # base64url of the 65-byte uncompressed P-256 point

    def __repr__(self):  # keep the private key out of any accidental log line
        return f"Keys(public_key={self.public_key!r})"

    def vapid(self):
        return Vapid.from_raw(self.private_raw.encode())


def load_or_create_keys(path):
    """The VAPID key pair at path; made on the first call."""
    if os.path.exists(path):
        with open(path) as f:
            stored = json.load(f)
        log.info("VAPID key pair loaded from %s", path)
        return Keys(stored["privateKey"], stored["publicKey"])
    private = ec.generate_private_key(ec.SECP256R1())
    raw = private.private_numbers().private_value.to_bytes(32, "big")
    point = private.public_key().public_bytes(serialization.Encoding.X962,
                                              serialization.PublicFormat.UncompressedPoint)
    keys = Keys(_b64(raw), _b64(point))
    _write_private(path, json.dumps({"privateKey": keys.private_raw,
                                     "publicKey": keys.public_key}))
    log.info("VAPID key pair created in %s", path)
    return keys


def valid_subscription(sub):
    """The subscription with only endpoint and keys, or ValueError."""
    if not isinstance(sub, dict):
        raise ValueError("a subscription is a JSON object")
    endpoint, keys = sub.get("endpoint"), sub.get("keys")
    if not isinstance(endpoint, str) or len(endpoint) > ENDPOINT_MAX:
        raise ValueError("endpoint missing or too long")
    if urllib.parse.urlsplit(endpoint).scheme != "https" or not urllib.parse.urlsplit(endpoint).hostname:
        raise ValueError("endpoint must be an https URL")
    if not isinstance(keys, dict):
        raise ValueError("keys missing")
    p256dh, auth = _unb64(keys.get("p256dh")), _unb64(keys.get("auth"))
    if len(p256dh) != 65 or p256dh[0] != 4:
        raise ValueError("keys.p256dh is not an uncompressed P-256 point")
    if len(auth) != 16:
        raise ValueError("keys.auth is not 16 bytes")
    return {"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}


def endpoint_host(endpoint):
    """For logs: the host only. The full endpoint works as a capability URL."""
    return urllib.parse.urlsplit(endpoint).hostname or "?"


class Subscriptions:
    """Subscriptions keyed by endpoint, in one JSON file."""

    _lock = threading.Lock()

    def __init__(self, path):
        self.path = path

    def _load(self):
        try:
            with open(self.path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def _save(self, data):
        _write_private(self.path, json.dumps(data, indent=1))

    def add(self, sub):
        with self._lock:
            data = self._load()
            if sub["endpoint"] not in data:
                while len(data) >= MAX_SUBS:
                    data.pop(next(iter(data)))  # dicts keep insertion order: oldest first
            data[sub["endpoint"]] = sub
            self._save(data)

    def remove(self, endpoint):
        with self._lock:
            data = self._load()
            if data.pop(endpoint, None) is not None:
                self._save(data)

    def get(self, endpoint):
        return self._load().get(endpoint)

    def all(self):
        return list(self._load().values())


class Pusher:
    def __init__(self, keys, subject, subs, webpush=_webpush):
        self.keys = keys
        self.subject = subject
        self.subs = subs
        self.webpush = webpush

    def send(self, sub, payload):
        """Send payload (a dict) to one subscription: "sent", "gone" or "failed"."""
        host = endpoint_host(sub["endpoint"])
        try:
            # A fresh claims dict each time: pywebpush writes "aud" into it.
            self.webpush(subscription_info=sub, data=json.dumps(payload),
                         vapid_private_key=self.keys.vapid(),
                         vapid_claims={"sub": self.subject},
                         ttl=TTL_S, timeout=TIMEOUT_S, headers={"Urgency": "high"})
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                self.subs.remove(sub["endpoint"])
                log.info("push to %s: %s, subscription removed", host, status)
                return "gone"
            log.warning("push to %s failed: HTTP %s", host, status)
            return "failed"
        except Exception as exc:  # network errors from requests, bad keys
            log.warning("push to %s failed: %s", host, type(exc).__name__)
            return "failed"
        log.info("push to %s sent", host)
        return "sent"

    def send_all(self, payload):
        """Send to every subscription. Returns a count per outcome."""
        # In parallel: a dead endpoint waits TIMEOUT_S, and one slow phone must
        # not hold the alert loop.
        subs = self.subs.all()
        counts = {}
        if not subs:
            return counts
        with ThreadPoolExecutor(max_workers=len(subs)) as pool:
            for result in pool.map(lambda sub: self.send(sub, payload), subs):
                counts[result] = counts.get(result, 0) + 1
        return counts

    def test(self, endpoint):
        sub = self.subs.get(endpoint)
        if sub is None:
            return "unknown"
        result = self.send(sub, TEST_PAYLOAD)
        return "unknown" if result == "gone" else result
