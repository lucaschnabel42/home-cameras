import os

import pytest

import frigate_config as fc

TEMPLATE = os.path.join(os.path.dirname(__file__), "..", "frigate", "config.template.yml")


def template():
    with open(TEMPLATE, encoding="utf-8") as f:
        return f.read()


def test_detector_follows_the_processor():
    assert fc.detector_for("x86_64") == "openvino"
    assert fc.detector_for("AMD64") == "openvino"
    assert fc.detector_for("aarch64") == "cpu"
    assert fc.detector_for("arm64") == "cpu"


def test_new_config_takes_the_settings():
    doc = fc.new_config(template(), {"FRIGATE_DETECTOR": "cpu", "RECORD_DAYS": "14",
                                     "WEBRTC_CANDIDATES": "192.168.1.20:8555, 100.64.0.2:8555",
                                     "WEBRTC_PORT": "8555"})
    assert doc["detectors"] == {"cpu1": {"type": "cpu", "num_threads": 3}}
    assert "model" not in doc
    assert fc.record_days(doc) == 14
    assert doc["record"]["alerts"]["retain"]["days"] == 14
    assert list(doc["go2rtc"]["webrtc"]["candidates"]) == ["192.168.1.20:8555", "100.64.0.2:8555",
                                                           "stun:8555"]


def test_openvino_is_the_default_and_the_clean_template_stays_one_line():
    doc = fc.new_config(template(), {})
    assert doc["detectors"]["ov"]["type"] == "openvino"
    assert doc["model"]["path"] == "/openvino-model/ssdlite_mobilenet_v2.xml"
    text = fc.dump(doc)
    clean = [line for line in text.splitlines() if line.strip().startswith("clean:")]
    assert len(clean) == 1 and "-bufsize 2500k" in clean[0]
    assert "# The clean streams." in text  # the comments stay


def test_bad_detector_and_days_are_refused():
    with pytest.raises(ValueError):
        fc.new_config(template(), {"FRIGATE_DETECTOR": "tpu"})
    with pytest.raises(ValueError):
        fc.new_config(template(), {"RECORD_DAYS": "0"})


def test_wyze_cameras_from_the_bridge_metrics():
    cams = fc.wyze_cameras({"cameras": [
        {"name": "living_room_cam", "nickname": "Living Room Cam", "model_name": "Wyze Cam v4"},
        {"name": "back-yard", "nickname": "Back Yard"}, {"nickname": "no name"}]})
    assert [c["name"] for c in cams] == ["living_room_cam", "back_yard"]
    assert cams[1]["source"] == "rtsp://wyze-bridge:8554/back-yard"
    assert cams[0]["audio"] is True and cams[0]["sub"] is None


def test_rtsp_cameras_from_cameras_yml():
    doc = fc.load("cameras:\n  - name: front_door\n    rtsp: rtsp://u:p@10.0.0.5/main\n"
                  "    sub: rtsp://u:p@10.0.0.5/sub\n    audio: true\n"
                  "  - name: garage\n    rtsp: rtsp://10.0.0.6/live\n")
    cams = fc.rtsp_cameras(doc)
    assert [(c["name"], c["sub"], c["audio"]) for c in cams] == [
        ("front_door", "rtsp://u:p@10.0.0.5/sub", True), ("garage", None, False)]


@pytest.mark.parametrize("text, words", [
    ("cameras: {}", "a list"),
    ("cameras:\n  - name: front door\n    rtsp: rtsp://x/y\n", "letters, digits"),
    ("cameras:\n  - name: a\n    rtsp: http://x/y\n", "rtsp://"),
    ("cameras:\n  - name: a\n    rtsp: rtsp://x/y\n  - name: a\n    rtsp: rtsp://x/z\n", "two times"),
    ("cameras:\n  - name: a\n    rtsp: rtsp://x/y\n    audio: yes please\n", "true or false"),
])
def test_bad_cameras_yml_says_what_is_wrong(text, words):
    with pytest.raises(ValueError, match=words):
        fc.rtsp_cameras(fc.load(text))


def test_add_cameras_adds_streams_and_sections():
    doc = fc.new_config(template(), {})
    cams = [{"name": "garage", "source": "rtsp://10.0.0.6/live", "sub": "rtsp://10.0.0.6/sub",
             "audio": False}]
    assert fc.sync_cameras(doc, cams) == (["garage"], [], [])
    streams = doc["go2rtc"]["streams"]
    assert list(streams["garage"]) == ["rtsp://10.0.0.6/live"]
    assert list(streams["garage_clean"]) == ["ffmpeg:garage#video=clean#width=1920#height=1080"]
    assert "garage_sub" not in streams  # a sub-stream is not a go2rtc stream
    section = doc["cameras"]["garage"]
    inputs = section["ffmpeg"]["inputs"]
    assert inputs[0]["path"] == "rtsp://127.0.0.1:8554/garage" and list(inputs[0]["roles"]) == ["record"]
    assert inputs[1]["path"] == "rtsp://10.0.0.6/sub" and list(inputs[1]["roles"]) == ["detect"]
    assert "audio" not in section
    for line in streams.values():
        assert " " not in line[0] and "{" not in line[0] and "}" not in line[0]


def test_a_camera_with_sound_gets_the_audio_role():
    doc = fc.new_config(template(), {})
    fc.sync_cameras(doc, [{"name": "den", "source": "rtsp://x/y", "sub": None, "audio": True}])
    section = doc["cameras"]["den"]
    assert list(section["ffmpeg"]["inputs"][0]["roles"]) == ["record", "detect", "audio"]
    assert section["audio"] == {"enabled": True}


def test_an_edited_camera_stays_as_it_is():
    text = ("go2rtc:\n  streams:\n    den:\n      - rtsp://edited/by/hand # mine\n"
            "cameras:\n  den:\n    detect:\n      fps: 2 # slower\n")
    doc = fc.load(text)
    added, updated, kept = fc.sync_cameras(doc, [
        {"name": "den", "source": "rtsp://edited/by/hand", "sub": None, "audio": True},
        {"name": "hall", "source": "rtsp://x/h", "sub": None, "audio": False}])
    assert (added, updated, kept) == (["hall"], [], ["den"])
    out = fc.dump(doc)
    assert "rtsp://edited/by/hand # mine" in out and "fps: 2 # slower" in out
    assert "den_clean" not in out and "hall_clean" in out


# --- the marker, the owned keys, updates, removal, shared memory -------------------------

def test_the_template_carries_the_marker_through_a_dump():
    doc = fc.new_config(template(), {})
    text = fc.dump(doc)
    assert fc.made_by_sync(text) and not fc.made_by_sync("mqtt:\n  enabled: false\n")


def test_frigate_default_is_recognised():
    default = "mqtt:\n  enabled: False\n\ncameras: {}  # No cameras defined, UI wizard should be used\n"
    assert fc.is_frigate_default(default)
    assert not fc.is_frigate_default("cameras:\n  den:\n    ffmpeg: {}\n")
    assert not fc.is_frigate_default(fc.MARKER + "\ncameras: {}\n")


def test_changed_settings_reach_the_owned_keys_only():
    doc = fc.new_config(template(), {"FRIGATE_DETECTOR": "openvino", "RECORD_DAYS": "7"})
    doc["snapshots"]["retain"]["default"] = 5  # a user edit
    changes = fc.apply_settings(doc, {"FRIGATE_DETECTOR": "cpu", "RECORD_DAYS": "14",
                                      "WEBRTC_PORT": "6555", "WEBRTC_CANDIDATES": "10.0.0.2:6555"})
    assert "detector: openvino -> cpu" in changes
    assert "record continuous.days: 7 -> 14" in changes
    assert fc.record_days(doc) == 14 and doc["record"]["detections"]["retain"]["days"] == 14
    assert list(doc["go2rtc"]["webrtc"]["candidates"]) == ["10.0.0.2:6555", "stun:6555"]
    assert "model" not in doc and doc["snapshots"]["retain"]["default"] == 5
    assert fc.apply_settings(doc, {"FRIGATE_DETECTOR": "cpu", "RECORD_DAYS": "14",
                                   "WEBRTC_PORT": "6555", "WEBRTC_CANDIDATES": "10.0.0.2:6555"}) == []


def cam(name, source, sub=None, audio=False):
    return {"name": name, "source": source, "sub": sub, "audio": audio}


def test_a_changed_address_is_updated_and_the_rest_of_the_camera_stays():
    doc = fc.new_config(template(), {})
    fc.sync_cameras(doc, [cam("den", "rtsp://old/main", sub="rtsp://old/sub")])
    doc["cameras"]["den"]["detect"] = {"fps": 2}  # a user edit
    added, updated, kept = fc.sync_cameras(doc, [cam("den", "rtsp://new/main", sub="rtsp://new/sub")])
    assert (added, updated, kept) == ([], ["den"], [])
    assert list(doc["go2rtc"]["streams"]["den"]) == ["rtsp://new/main"]
    assert doc["cameras"]["den"]["ffmpeg"]["inputs"][1]["path"] == "rtsp://new/sub"
    assert doc["cameras"]["den"]["detect"] == {"fps": 2}
    assert fc.sync_cameras(doc, [cam("den", "rtsp://new/main", sub="rtsp://new/sub")]) == ([], [], ["den"])


def test_remove_takes_the_camera_its_streams_and_its_group_place():
    doc = fc.new_config(template(), {})
    fc.sync_cameras(doc, [cam("den", "rtsp://a"), cam("hall", "rtsp://b")])
    doc["camera_groups"] = {"Home": {"cameras": ["den", "hall"], "order": 0}}
    assert fc.remove_camera(doc, "den") is True
    assert "den" not in doc["cameras"] and "den" not in doc["go2rtc"]["streams"]
    assert "den_clean" not in doc["go2rtc"]["streams"] and "hall_clean" in doc["go2rtc"]["streams"]
    assert list(doc["camera_groups"]["Home"]["cameras"]) == ["hall"]
    assert fc.remove_camera(doc, "den") is False


def test_shared_memory_follows_the_count_and_size_of_the_cameras():
    doc = fc.new_config(template(), {})
    fc.sync_cameras(doc, [cam(f"c{i}", "rtsp://x") for i in range(2)])
    assert fc.shm_mb(doc) == 256  # 2 x 39.4 + 50 MB is under the floor
    fc.sync_cameras(doc, [cam(f"c{i}", "rtsp://x") for i in range(8)])
    # 8 x 39.4 + 50 = 365 MB, up to the next 64 MB step.
    assert fc.shm_mb(doc) == 384
    doc["cameras"]["c0"]["detect"] = {"width": 2560, "height": 1440}
    assert fc.shm_mb(doc) == 512
