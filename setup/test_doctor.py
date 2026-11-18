import datetime
import json
import os
import time
from collections import namedtuple

import doctor
import frigate_config

NOW = time.time()


def frigate(stats=None, version=b"0.18.1-abc", down=False, uptime=3600):
    def get(url, host=None, timeout=5):
        if down:
            raise OSError("no route")
        if url.endswith("/api/version"):
            return 200, version
        if url.endswith("/api/stats"):
            return 200, json.dumps({"cameras": stats or {}, "service": {"uptime": uptime}}).encode()
        if url.endswith("/healthz"):
            return 200, b'{"ok": true}'
        if url == "http://ui:80/" and host:
            return 200, b"<!doctype html><html></html>"
        return 404, b""
    return get


def container(service, state="running", status="Up 5 minutes", ports=()):
    return {"Labels": {"com.docker.compose.service": service}, "State": state,
            "Status": status, "Ports": list(ports)}


class FakeDocker:
    def __init__(self, containers=(), up=True):
        self.containers, self.up = list(containers), up

    def ping(self):
        if not self.up:
            raise OSError("no socket")
        return True

    def project_containers(self, project):
        return self.containers

    def container(self, ref):
        return {"Config": {"Env": []}}


def test_docker_down_says_to_start_it():
    r = doctor.check_docker(FakeDocker(up=False))
    assert r.level == "FIX" and "Start Docker" in r.text


def test_containers_each_get_a_line():
    cs = [container("frigate"), container("ui"), container("cam-helper", "restarting", "Restarting (1)"),
          container("setup")]
    results = doctor.check_containers(cs, {"COMPOSE_PROFILES": "wyze"})
    text = [r.line() for r in results]
    assert text[0].startswith("OK") and "frigate" in text[0]
    assert any(t.startswith("FIX") and "clip-exporter does not exist" in t for t in text)
    assert any(t.startswith("FIX") and "cam-helper is restarting" in t for t in text)
    assert any("wyze-bridge does not exist" in t for t in text)
    assert not any("setup" in t for t in text)


def test_no_bridge_is_wanted_without_the_profile():
    assert "wyze-bridge" not in doctor.wanted_services({})


def test_time_zone():
    utc = datetime.datetime(2027, 1, 15, 12, 0, tzinfo=datetime.timezone.utc)
    assert doctor.check_time_zone({}).level == "FIX"
    assert doctor.check_time_zone({"TZ": "Mars/Base"}).level == "FIX"
    assert doctor.check_time_zone({"TZ": "UTC"}, utc).level == "NOTE"
    r = doctor.check_time_zone({"TZ": "Europe/Berlin"}, utc)
    assert r.level == "OK" and "13:00" in r.text


def test_cameras_with_and_without_frames():
    results, names = doctor.check_cameras(frigate({"a": {"camera_fps": 5.0}, "b": {"camera_fps": 0}}))
    assert [r.level for r in results] == ["OK", "FIX"] and names == ["a", "b"]
    assert "b sends no pictures" in results[1].text
    assert doctor.check_cameras(frigate({}))[0][0].level == "FIX"
    assert doctor.check_cameras(frigate(down=True))[0][0].level == "FIX"


def test_a_camera_with_no_pictures_just_after_a_start_is_a_note():
    (r,), _ = doctor.check_cameras(frigate({"b": {"camera_fps": 0}}, uptime=40))
    assert r.level == "NOTE" and "40 s ago" in r.text and r.pending


def test_frigate_and_helper():
    assert doctor.check_frigate(frigate()).text == "Frigate answers (version 0.18.1-abc)."
    assert doctor.check_frigate(frigate(down=True)).level == "FIX"
    assert doctor.check_helper(frigate()).level == "OK"


def test_recording_age(tmp_path):
    assert doctor.check_recording(str(tmp_path), NOW).level == "FIX"
    day = time.strftime("%Y-%m-%d", time.gmtime(NOW))  # Frigate's folders are in UTC
    seg = tmp_path / "recordings" / day / "10" / "cam"
    seg.mkdir(parents=True)
    f = seg / "00.00.mp4"
    f.write_bytes(b"x")
    os.utime(f, (NOW - 30, NOW - 30))
    assert doctor.check_recording(str(tmp_path), NOW).level == "OK"
    os.utime(f, (NOW - 3600, NOW - 3600))
    r = doctor.check_recording(str(tmp_path), NOW)
    assert r.level == "FIX" and "60 minutes" in r.text


Usage = namedtuple("Usage", "total used free")


def write(path, size, mtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.truncate(size)  # a sparse file: its size counts, and it is quick to make
    os.utime(path, (mtime, mtime))


def test_storage_measures_each_camera_and_the_clips(tmp_path):
    yesterday = time.strftime("%Y-%m-%d", time.gmtime(NOW - 86400))
    for hour in range(24):
        write(tmp_path / "recordings" / yesterday / f"{hour:02d}" / "den" / "00.00.mp4", 1000, NOW)
    # 2 000 bytes of clips, the oldest 2 days old: 1 000 bytes a day.
    write(tmp_path / "exports" / "a.mp4", 1000, NOW - 2 * 86400)
    write(tmp_path / "exports" / "b.mp4", 1000, NOW - 3600)
    results = doctor.check_storage(str(tmp_path), {"RECORD_DAYS": "7"}, NOW,
                                   usage=lambda p: Usage(0, 0, 100e9))
    assert results[0].text.startswith("The recordings of den take 0.0 GB a day (measured on yesterday)")
    last = results[-1]
    # Recordings: 24 000 bytes a day, 6 more days to come; clips 1 000 bytes a day.
    full_in = (100e9 - 24000 * 6) / 1000
    assert last.level == "OK" and f"full in about {full_in:.0f} days" in last.text


def test_storage_is_a_fault_when_the_recordings_do_not_fit(tmp_path):
    today = time.strftime("%Y-%m-%d", time.gmtime(NOW))
    # 1 GB in 30 min of recording today: 48 GB a day.
    write(tmp_path / "recordings" / today / "10" / "den" / "00.00.mp4", 500_000_000, NOW - 1800)
    write(tmp_path / "recordings" / today / "10" / "den" / "30.00.mp4", 500_000_000, NOW)
    results = doctor.check_storage(str(tmp_path), {"RECORD_DAYS": "7"}, NOW,
                                   usage=lambda p: Usage(0, 0, 50e9))
    assert results[0].text == ("The recordings of den take 48.0 GB a day (estimated from 30 min "
                               "of recording today).")
    assert results[-1].level == "FIX" and "RECORD_DAYS" in results[-1].text


def test_storage_with_little_room_for_clips_is_a_note(tmp_path):
    write(tmp_path / "exports" / "a.mp4", 1_000_000_000, NOW - 86400)
    results = doctor.check_storage(str(tmp_path), {}, NOW, usage=lambda p: Usage(0, 0, 10e9))
    assert results[-1].level == "NOTE" and "CLIP_KEEP_DAYS" in results[-1].text
    kept = doctor.check_storage(str(tmp_path), {"CLIP_KEEP_DAYS": "7"}, NOW,
                                usage=lambda p: Usage(0, 0, 10e9))
    assert kept[-1].level == "OK" and "kept 7 days" in kept[-1].text
    low = doctor.check_storage(str(tmp_path), {}, NOW, usage=lambda p: Usage(0, 0, 2e9))
    assert low[-1].level == "FIX"


def test_app_answers_and_is_published_on_its_port():
    ui = container("ui", ports=[{"PrivatePort": 80, "PublicPort": 6010}])
    assert doctor.check_app(frigate(), {"APP_PORT": "6010"}, ui).level == "OK"
    r = doctor.check_app(frigate(), {"APP_PORT": "5010"}, ui)
    assert r.level == "FIX" and "port 5010" in r.text
    assert doctor.check_app(frigate(down=True), {}, ui).level == "FIX"


def test_run_gives_every_check(tmp_path):
    cs = [container(s) for s in doctor.SERVICES]
    results = doctor.run({"TZ": "Europe/Berlin"}, FakeDocker(cs),
                         frigate({"a": {"camera_fps": 5}}), str(tmp_path), "p", now=NOW,
                         work=str(tmp_path), env_text="TZ=Europe/Berlin\n",
                         ws=lambda *a: 101)
    texts = [r.text for r in results]
    # docker, the containers, env, time zone, config, Frigate, 1 camera,
    # recording, storage (1 line with no recording), helper, app, remote.
    assert len(results) == 1 + len(doctor.SERVICES) + 10
    assert any("no Frigate config yet" in t for t in texts)
    assert any("APP_HOST is empty" in t for t in texts)


# --- the env file, the config, Wyze and the remote name -------------------------------

def test_env_values_that_docker_reads_otherwise_are_faults():
    assert doctor.check_env("WYZE_PASSWORD='a $b'\n")[0].level == "OK"
    (r,) = doctor.check_env("WYZE_PASSWORD=a$b\n")
    assert r.level == "FIX" and "WYZE_PASSWORD" in r.text and "a$b" not in r.text


def test_config_origin_and_days(tmp_path):
    folder = tmp_path / "frigate" / "config"
    folder.mkdir(parents=True)
    (folder / "config.yaml").write_text("cameras: {}\n")
    assert "made its own empty config" in doctor.check_config(str(tmp_path), {}).text
    (folder / "config.yml").write_text(frigate_config.MARKER + "\nrecord:\n  continuous:\n    days: 7\n")
    assert doctor.check_config(str(tmp_path), {"RECORD_DAYS": "7"}).level == "OK"
    r = doctor.check_config(str(tmp_path), {"RECORD_DAYS": "14"})
    assert r.level == "FIX" and "RECORD_DAYS=14" in r.text
    (folder / "config.yml").write_text("record:\n  continuous:\n    days: 7\n")
    assert doctor.check_config(str(tmp_path), {"RECORD_DAYS": "14"}).level == "NOTE"


def test_wyze_is_checked_only_with_the_profile():
    assert doctor.check_wyze({}, None) == []
    (r,) = doctor.check_wyze({"COMPOSE_PROFILES": "wyze"}, None)
    assert r.level == "FIX" and "WYZE_EMAIL" in r.text


def ui_with(app_host):
    return {"Config": {"Env": [f"APP_HOST={app_host}", "APP_PORT=5010"]}}


def test_remote_name_passes_the_page_and_the_live_rule():
    env = {"APP_HOST": "box.tail1.ts.net"}
    seen = []

    def ws(host, origin, src):
        seen.append((host, origin, src))
        return 101

    r = doctor.check_remote(frigate(), env, ui_with("box.tail1.ts.net"), "den", ws)
    assert r.level == "OK" and seen == [("box.tail1.ts.net", "https://box.tail1.ts.net", "den")]


def test_remote_name_faults():
    env = {"APP_HOST": "box.tail1.ts.net"}
    assert "runs with APP_HOST=old.ts.net" in doctor.check_remote(
        frigate(), env, ui_with("old.ts.net"), "den", lambda *a: 101).text

    def refuse(url, host=None, timeout=5):
        return 421, b"Misdirected request"

    assert "refuses the name" in doctor.check_remote(refuse, env, ui_with("box.tail1.ts.net"),
                                                     "den", lambda *a: 101).text
    assert "live view refuses" in doctor.check_remote(frigate(), env, ui_with("box.tail1.ts.net"),
                                                      "den", lambda *a: 403).text
    assert doctor.check_remote(frigate(), {}, None, "den").level == "NOTE"


def test_recording_folders_are_read_by_the_utc_date(tmp_path, monkeypatch):
    # 03:30 UTC is still the day before in New York: Frigate's folder has the UTC date.
    now = datetime.datetime(2027, 1, 16, 3, 30, tzinfo=datetime.timezone.utc).timestamp()
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    try:
        seg = tmp_path / "recordings" / "2027-01-16" / "03" / "cam"
        seg.mkdir(parents=True)
        f = seg / "29.00.mp4"
        f.write_bytes(b"x")
        os.utime(f, (now - 20, now - 20))
        assert doctor.newest_recording(str(tmp_path), now) == 20
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


def test_a_few_minutes_of_recording_give_no_rate_yet(tmp_path):
    today = time.strftime("%Y-%m-%d", time.gmtime(NOW))
    write(tmp_path / "recordings" / today / "10" / "den" / "00.00.mp4", 1000, NOW - 120)
    write(tmp_path / "recordings" / today / "10" / "den" / "02.00.mp4", 1000, NOW)
    assert doctor.recording_rates(str(tmp_path), NOW) == {}
