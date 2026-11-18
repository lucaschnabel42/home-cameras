import json
import os
import shutil

import pytest

import envfile
import setup

ROOT = os.path.join(os.path.dirname(__file__), "..")


@pytest.fixture
def work(tmp_path, monkeypatch):
    shutil.copy(os.path.join(ROOT, ".env.example"), tmp_path / ".env.example")
    (tmp_path / "frigate").mkdir()
    shutil.copy(os.path.join(ROOT, "frigate", "config.template.yml"),
                tmp_path / "frigate" / "config.template.yml")
    monkeypatch.setattr(setup, "WORK", str(tmp_path))
    return tmp_path


def run(*argv):
    return setup.main(list(argv))


def test_init_writes_env_and_push_keys_and_hides_secrets(work, capsys, monkeypatch):
    monkeypatch.setattr(setup.platform, "machine", lambda: "aarch64")
    assert run("init", "--tz", "Europe/Berlin", "--pet-name", "Rex", "--pet-camera", "den",
               "--wyze-email", "a@b.c", "--wyze-password", "s3cret pass#1",
               "--wyze-api-key", "KEY123", "--app-host", "box.tail1.ts.net") == 0
    out = capsys.readouterr().out
    assert "s3cret" not in out and "KEY123" not in out
    assert "WYZE_PASSWORD = (set)" in out and "API_ID = (empty)" in out
    env = envfile.parse((work / ".env").read_text())
    assert env["TZ"] == "Europe/Berlin" and env["PET_NAME"] == "Rex"
    assert env["WYZE_PASSWORD"] == "s3cret pass#1"
    assert env["COMPOSE_PROFILES"] == "wyze"
    assert env["FRIGATE_DETECTOR"] == "cpu"
    assert env["APP_HOST"] == "box.tail1.ts.net"
    keys = json.loads((work / "helper" / "state" / "vapid.json").read_text())
    assert set(keys) == {"privateKey", "publicKey"} and len(keys["publicKey"]) == 87
    assert (work / "media").is_dir()
    assert "# Time zone" in (work / ".env").read_text()  # the comments of the example stay


def test_a_second_init_keeps_the_rest_and_the_keys(work, monkeypatch):
    monkeypatch.setattr(setup.platform, "machine", lambda: "x86_64")
    run("init", "--tz", "Europe/Berlin", "--pet-name", "Rex")
    first = (work / "helper" / "state" / "vapid.json").read_text()
    run("init", "--record-days", "14")
    env = envfile.parse((work / ".env").read_text())
    assert env["PET_NAME"] == "Rex" and env["RECORD_DAYS"] == "14"
    assert env["FRIGATE_DETECTOR"] == "openvino"
    assert (work / "helper" / "state" / "vapid.json").read_text() == first


@pytest.mark.parametrize("argv", [
    ("--tz", "Mars/Base"), ("--app-port", "http"), ("--pet-label", "bird"),
    ("--app-host", "https://box.ts.net"), ("--pet-camera", "living room"), ("--detector", "tpu")])
def test_init_refuses_bad_values_and_writes_nothing(work, argv, capsys):
    assert run("init", *argv) == 2
    assert "FIX" in capsys.readouterr().out
    assert not (work / ".env").exists()


def test_sync_with_no_camera_says_what_to_do(work, capsys):
    run("init", "--tz", "UTC")
    assert run("sync") == 1
    assert "No camera found" in capsys.readouterr().out


def test_sync_makes_the_config_from_cameras_yml_and_keeps_it(work, capsys, monkeypatch):
    run("init", "--tz", "UTC", "--detector", "cpu", "--record-days", "3")
    (work / "cameras.yml").write_text("cameras:\n  - name: test_cam\n    rtsp: rtsp://src:8554/test\n")
    no_frigate(monkeypatch)
    assert run("sync") == 0
    out = capsys.readouterr().out
    assert "add  test_cam" in out and "docker compose up -d" in out
    config = (work / "frigate" / "config" / "config.yml").read_text()
    assert "type: cpu" in config and "days: 3" in config and "test_cam_clean" in config
    assert run("sync") == 0
    assert "keep test_cam" in capsys.readouterr().out


WYZE_ENV = {"WYZE_EMAIL": "a@b.c", "WYZE_PASSWORD": "x", "API_ID": "i", "API_KEY": "k"}


def test_wyze_wait_waits_for_the_bridge_and_its_list():
    # Each look asks for the health, then the metrics: no answer, then
    # running with no camera yet, then the camera.
    answers = iter([OSError("starting"), {}, {}, {}, {"cameras": [{"name": "cam1"}]}])

    def get(url):
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    state, cams = setup.wyze_wait(WYZE_ENV, get=get, wait_s=60, sleep=lambda s: None)
    assert state == "ok" and [c["name"] for c in cams] == ["cam1"]
    assert setup.wyze_wait(WYZE_ENV, get=lambda url: {}, wait_s=0,
                           sleep=lambda s: None) == ("starting", [])


# --- round 2: any order, changed settings, changed cameras -------------------------------

def no_frigate(monkeypatch):
    monkeypatch.setattr(setup, "http_json", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    monkeypatch.setattr(setup.socket, "gethostbyname",
                        lambda name: (_ for _ in ()).throw(OSError("no such host")))


def test_the_first_init_needs_a_time_zone(work, capsys):
    assert run("init") == 2
    assert "Give the time zone" in capsys.readouterr().out
    assert run("init", "--tz", "UTC") == 0
    out = capsys.readouterr().out
    assert "NOTE The time zone is UTC" in out
    assert "for Wyze cameras, type the four Wyze values" in out and "cameras.yml" in out


def test_next_step_after_the_wyze_values_are_typed_in(work, capsys):
    run("init", "--tz", "UTC")
    env = (work / ".env").read_text()
    for key in ("WYZE_EMAIL", "WYZE_PASSWORD", "API_ID", "API_KEY"):
        env = env.replace(f"\n{key}=\n", f"\n{key}=value-of-{key.lower()}\n")
    (work / ".env").write_text(env)
    capsys.readouterr()
    assert run("init") == 0
    out = capsys.readouterr().out
    assert "COMPOSE_PROFILES = wyze" in out and "Next: docker compose up -d wyze-bridge" in out
    assert "value-of" not in out


def test_a_hand_typed_value_that_docker_misreads_stops_init_and_sync(work, capsys, monkeypatch):
    run("init", "--tz", "UTC")
    env = (work / ".env").read_text().replace("\nWYZE_PASSWORD=\n", "\nWYZE_PASSWORD=pa$word\n")
    (work / ".env").write_text(env)
    capsys.readouterr()
    assert run("init") == 1
    out = capsys.readouterr().out
    assert "FIX  .env, WYZE_PASSWORD: has a $ sign" in out and "pa$word" not in out
    no_frigate(monkeypatch)
    assert run("sync") == 1


def write_cameras(work, *entries):
    (work / "cameras.yml").write_text("cameras:\n" + "".join(
        f"  - name: {n}\n    rtsp: {u}\n" for n, u in entries))


def config_text(work):
    return (work / "frigate" / "config" / "config.yml").read_text()


def test_a_start_before_sync_does_no_harm(work, capsys, monkeypatch):
    run("init", "--tz", "UTC", "--detector", "cpu")
    write_cameras(work, ("den", "rtsp://cam/den"))
    folder = work / "frigate" / "config"
    folder.mkdir(parents=True)
    # What Frigate 0.18.1 writes when it starts with no config.
    (folder / "config.yaml").write_text(
        "mqtt:\n  enabled: False\n\ndetectors:\n  ov:\n    type: openvino\n    device: CPU\n"
        "cameras: {}  # No cameras defined, UI wizard should be used\nversion: 0.18-0\n")
    no_frigate(monkeypatch)
    capsys.readouterr()
    assert run("sync") == 0
    assert "Moved it to frigate/config/config.yaml.frigate-default" in capsys.readouterr().out
    text = config_text(work)
    assert text.startswith(setup.frigate_config.MARKER) and "type: cpu" in text
    assert "den_clean" in text and not (folder / "config.yaml").exists()


def test_a_config_yaml_with_cameras_is_left_alone(work, capsys, monkeypatch):
    run("init", "--tz", "UTC")
    write_cameras(work, ("den", "rtsp://cam/den"))
    folder = work / "frigate" / "config"
    folder.mkdir(parents=True)
    (folder / "config.yaml").write_text("cameras:\n  porch:\n    ffmpeg: {}\n")
    no_frigate(monkeypatch)
    assert run("sync") == 1
    assert "holds cameras that Frigate wrote" in capsys.readouterr().out
    assert (folder / "config.yaml").exists() and not (folder / "config.yml").exists()


def test_a_changed_setting_reaches_the_config_and_edits_stay(work, capsys, monkeypatch):
    run("init", "--tz", "UTC", "--detector", "openvino", "--record-days", "7")
    write_cameras(work, ("den", "rtsp://cam/den"))
    no_frigate(monkeypatch)
    run("sync")
    path = work / "frigate" / "config" / "config.yml"
    path.write_text(path.read_text().replace("default: 30", "default: 5  # mine"))
    run("init", "--record-days", "14", "--detector", "cpu")
    capsys.readouterr()
    assert run("sync") == 0
    out = capsys.readouterr().out
    assert "set  detector: openvino -> cpu" in out and "7 -> 14" in out
    text = config_text(work)
    assert "days: 14" in text and "type: cpu" in text and "default: 5  # mine" in text


def test_a_config_not_made_by_sync_keeps_its_settings(work, capsys, monkeypatch):
    run("init", "--tz", "UTC", "--record-days", "14")
    write_cameras(work, ("den", "rtsp://cam/den"))
    folder = work / "frigate" / "config"
    folder.mkdir(parents=True)
    (folder / "config.yml").write_text("record:\n  continuous:\n    days: 7\ncameras: {}\n")
    no_frigate(monkeypatch)
    assert run("sync") == 0
    assert "was not made by sync" in capsys.readouterr().out
    assert "days: 7" in config_text(work) and "den_clean" in config_text(work)


def test_an_address_change_and_a_removal(work, capsys, monkeypatch):
    run("init", "--tz", "UTC")
    write_cameras(work, ("den", "rtsp://cam/den"), ("hall", "rtsp://cam/hall"))
    no_frigate(monkeypatch)
    run("sync")
    write_cameras(work, ("den", "rtsp://cam/den-new"), ("hall", "rtsp://cam/hall"))
    capsys.readouterr()
    run("sync")
    assert "update den" in capsys.readouterr().out
    assert "rtsp://cam/den-new" in config_text(work)
    assert run("remove", "hall") == 0
    assert "hall" not in config_text(work)
    assert setup.settings()["SKIP_CAMERAS"] == "hall"
    capsys.readouterr()
    run("sync")
    out = capsys.readouterr().out
    assert "skip hall" in out and "add  hall" not in out
    assert run("remove", "nothere") == 1


def test_many_cameras_raise_the_shared_memory_in_env(work, capsys, monkeypatch):
    run("init", "--tz", "UTC")
    write_cameras(work, *[(f"c{i}", f"rtsp://cam/{i}") for i in range(8)])
    no_frigate(monkeypatch)
    capsys.readouterr()
    run("sync")
    out = capsys.readouterr().out
    assert "FRIGATE_SHM_SIZE 256mb -> 384mb" in out and "Restart needed" in out
    assert setup.settings()["FRIGATE_SHM_SIZE"] == "384mb"


class Args:
    wait = 40


def test_doctor_wait_repeats_until_all_is_well(work, capsys, monkeypatch):
    run("init", "--tz", "UTC")
    looks = iter([[setup.doctor.fix("not yet")], [setup.doctor.ok("fine")]])
    monkeypatch.setattr(setup.doctor, "run", lambda *a, **k: next(looks))
    monkeypatch.setattr(setup, "own_project", lambda docker: "p")
    slept = []
    capsys.readouterr()
    assert setup.cmd_doctor(Args(), sleep=slept.append) == 0
    out = capsys.readouterr().out
    assert slept == [15] and "OK   fine" in out and "Everything works." in out


def test_files_go_to_the_owner_of_the_folder(work, monkeypatch):
    owners = []
    monkeypatch.setattr(setup.os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(setup.os, "chown", lambda p, uid, gid: owners.append(p), raising=False)
    run("init", "--tz", "UTC")
    names = {os.path.basename(p.rstrip("/")) for p in owners}
    assert {".env.tmp", "vapid.json.tmp", "state", "media"} <= names


def test_restart_waits_for_a_frigate_that_is_still_starting(monkeypatch):
    answers = iter([OSError("starting"), OSError("starting"), {"success": True}])

    def http(*a, **k):
        x = next(answers)
        if isinstance(x, Exception):
            raise x
        return x

    monkeypatch.setattr(setup, "http_json", http)
    slept = []
    assert setup.restart_frigate(wait_s=60, sleep=slept.append, resolve=lambda n: "10.0.0.2")         == "restarted"
    assert slept == [5, 5]
    monkeypatch.setattr(setup, "http_json", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))
    assert setup.restart_frigate(wait_s=0, sleep=slept.append, resolve=lambda n: "10.0.0.2")         == "no_answer"
    assert setup.restart_frigate(resolve=lambda n: (_ for _ in ()).throw(OSError("x"))) == "absent"


def test_sync_restarts_a_frigate_that_runs_without_the_cameras(work, capsys, monkeypatch):
    run("init", "--tz", "UTC")
    write_cameras(work, ("den", "rtsp://cam/den"))
    no_frigate(monkeypatch)
    run("sync")
    calls = []

    def http(url, method="GET", timeout=10):
        calls.append((method, url))
        return {"cameras": {}} if url.endswith("/api/config") else {"success": True}

    monkeypatch.setattr(setup, "http_json", http)
    monkeypatch.setattr(setup.socket, "gethostbyname", lambda name: "10.0.0.2")
    capsys.readouterr()
    assert run("sync") == 0
    assert "runs without some of its cameras" in capsys.readouterr().out
    assert ("POST", setup.FRIGATE + "/api/restart") in calls
    monkeypatch.setattr(setup, "http_json", lambda url, **k: {"cameras": {"den": {}}})
    run("sync")
    assert "Nothing to change." in capsys.readouterr().out
