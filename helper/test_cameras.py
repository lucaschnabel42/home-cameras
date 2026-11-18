"""Tests for the last-live time of each camera. Run: python -m pytest -q helper"""

import json

import cameras
from cameras import SOURCE_FRIGATE, LastLive

# A value from another source, kept until Frigate sees frames.
OTHER = {"last_live": 1792108860.0, "source": "camera-service"}


class FakeFrigate:
    def __init__(self, fps):
        self.fps = fps
        self.calls = 0

    def stats(self):
        self.calls += 1
        if isinstance(self.fps, Exception):
            raise self.fps
        return {"cameras": {name: {"camera_fps": v, "process_fps": v} for name, v in self.fps.items()},
                "detectors": {}}


def test_a_new_state_is_empty(tmp_path):
    live = LastLive(FakeFrigate({}), str(tmp_path / "cameras.json"), clock=lambda: 1795000000)
    assert live.cameras() == {}


def test_a_camera_with_frames_is_live_now(tmp_path):
    path = tmp_path / "cameras.json"
    path.write_text(json.dumps({"front_porch_cam": OTHER}))
    live = LastLive(FakeFrigate({"living_room_cam": 5.1, "front_porch_cam": 0.0}), str(path),
                    clock=lambda: 1795000000.4)
    live.step()
    got = live.cameras()
    assert got["living_room_cam"] == {"last_live": 1795000000, "source": SOURCE_FRIGATE}
    # No frames: the porch keeps its stored time and its mark.
    assert got["front_porch_cam"] == OTHER
    assert json.loads(path.read_text()) == got


def test_a_camera_that_stops_keeps_its_last_live_time(tmp_path):
    path = str(tmp_path / "cameras.json")
    now = [1795000000]
    frig = FakeFrigate({"living_room_cam": 5.0})
    live = LastLive(frig, path, clock=lambda: now[0])
    live.step()
    frig.fps = {"living_room_cam": 0.0}
    now[0] += 600
    live.step()
    assert live.cameras()["living_room_cam"]["last_live"] == 1795000000
    # The value survives a restart of the helper.
    assert LastLive(frig, path, clock=lambda: now[0]).cameras()["living_room_cam"]["last_live"] == 1795000000


def test_frames_from_frigate_replace_a_value_from_another_source(tmp_path):
    (tmp_path / "cameras.json").write_text(json.dumps({"front_porch_cam": OTHER}))
    live = LastLive(FakeFrigate({"front_porch_cam": 4.9}), str(tmp_path / "cameras.json"),
                    clock=lambda: 1795000000)
    live.step()
    assert live.cameras()["front_porch_cam"] == {"last_live": 1795000000, "source": SOURCE_FRIGATE}


def test_a_broken_state_file_starts_empty(tmp_path):
    path = tmp_path / "cameras.json"
    path.write_text("{not json")
    assert LastLive(FakeFrigate({}), str(path), clock=lambda: 0).cameras() == {}
    path.write_text(json.dumps({"x": "not an entry", "y": {"last_live": "noon"}}))
    assert LastLive(FakeFrigate({}), str(path), clock=lambda: 0).cameras() == {}


def test_stats_with_no_cameras_or_odd_values_change_nothing(tmp_path):
    live = LastLive(FakeFrigate({"a": None, "b": "fast"}), str(tmp_path / "c.json"), clock=lambda: 9)
    live.step()
    assert live.cameras() == {}


def test_a_failed_stats_call_raises_and_keeps_the_state(tmp_path):
    live = LastLive(FakeFrigate(OSError("frigate down")), str(tmp_path / "c.json"), clock=lambda: 9)
    try:
        live.step()
    except OSError:
        pass
    assert live.cameras() == {}


def test_the_poll_interval_is_short_enough_for_the_minute_shown():
    assert cameras.EVERY_S <= 60
