"""Tests for the Frigate GET client. Run: python -m pytest -q helper"""

import json
import urllib.parse

from frigate import Frigate


class FakeGet:
    def __init__(self, answers):
        self.answers = answers
        self.urls = []

    def __call__(self, url, timeout):
        self.urls.append(url)
        parts = urllib.parse.urlsplit(url)
        return self.answers[parts.path], urllib.parse.parse_qs(parts.query)


def make(answers):
    fake = FakeGet(answers)
    return Frigate("http://frigate:5000/", get=lambda url, timeout: fake(url, timeout)[0]), fake


def query(url):
    return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).items()}


def test_events_query_and_parse():
    f, fake = make({"/api/events": json.dumps([{"id": "a"}]).encode()})
    assert f.events(after=100.5, labels=["bark", "howl"], cameras=["c1"]) == [{"id": "a"}]
    q = query(fake.urls[0])
    assert fake.urls[0].startswith("http://frigate:5000/api/events?")
    assert q == {"after": "100.5", "labels": "bark,howl", "cameras": "c1", "limit": "1000"}


def test_events_in_progress():
    f, fake = make({"/api/events": b"[]"})
    f.events(in_progress=True)
    assert query(fake.urls[0])["in_progress"] == "1"


def test_reviews():
    f, fake = make({"/api/review": json.dumps([{"id": "r"}]).encode()})
    assert f.reviews(after=5, before=9) == [{"id": "r"}]
    assert query(fake.urls[0]) == {"after": "5", "before": "9", "limit": "1000"}


def test_stats():
    f, fake = make({"/api/stats": json.dumps({"cameras": {"c1": {"camera_fps": 5.0}}}).encode()})
    assert f.stats() == {"cameras": {"c1": {"camera_fps": 5.0}}}
    assert fake.urls[0] == "http://frigate:5000/api/stats"


def test_snapshot_path():
    f, fake = make({"/api/living_room_cam/recordings/1700000000.5/snapshot.jpg": b"jpg"})
    assert f.snapshot("living_room_cam", 1700000000.5, height=480) == b"jpg"
    assert query(fake.urls[0]) == {"height": "480"}
