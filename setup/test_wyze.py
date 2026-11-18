import wyze

ENV = {"WYZE_EMAIL": "a@b.c", "WYZE_PASSWORD": "x", "API_ID": "i", "API_KEY": "k"}
SECRET_DETAIL = "login: HTTP 400: {\"msg\": \"bad\", \"email\": \"a@b.c\"}"


def bridge(health, metrics):
    def get(url):
        return health if url == wyze.HEALTH else metrics
    return get


def auth_issue(detail):
    return {"issues": [{"ID": "wyzeapi/auth", "Scope": "auth", "Message": "failed",
                        "Detail": detail}]}


def test_values_not_set_name_the_empty_keys():
    state, _ = wyze.status({"WYZE_EMAIL": "a@b.c"}, bridge({}, {}))
    assert state == "not_set"
    text = wyze.message(state, {"WYZE_EMAIL": "a@b.c"})
    assert "WYZE_PASSWORD, API_ID, API_KEY" in text and "a@b.c" not in text


def test_no_answer():
    def down(url):
        raise OSError("refused")
    assert wyze.status(ENV, down) == ("no_answer", [])


def test_two_step_code_needed():
    detail = "initial login: MFA required but no TOTP key configured — set WYZE_TOTP_KEY env var"
    assert wyze.status(ENV, bridge(auth_issue(detail), {}))[0] == "mfa_needed"
    assert "WYZE_TOTP_KEY" in wyze.message("mfa_needed")


def test_two_step_code_wrong():
    assert wyze.status(ENV, bridge(auth_issue("initial login: mfa login: HTTP 400"), {}))[0] \
        == "mfa_failed"


def test_login_refused_never_shows_the_detail():
    state, _ = wyze.status(ENV, bridge(auth_issue(SECRET_DETAIL), {}))
    assert state == "refused"
    assert "a@b.c" not in wyze.message(state, ENV) and "HTTP 400" not in wyze.message(state, ENV)


def test_lower_case_field_names_also_work():
    health = {"issues": [{"id": "wyzeapi/auth", "scope": "auth", "detail": "MFA required"}]}
    assert wyze.status(ENV, bridge(health, {}))[0] == "mfa_needed"


def test_logged_in_with_no_camera():
    metrics = {"cameras": [], "wyzeapi": [
        {"Path": "/app/v2/home_page/get_object_list", "LastStatus": 200, "Errors": 0}]}
    assert wyze.status(ENV, bridge({"status": "ok"}, metrics))[0] == "no_cameras"


def test_still_starting():
    assert wyze.status(ENV, bridge({"status": "ok"}, {"cameras": [], "wyzeapi": []}))[0] \
        == "starting"


def test_ok_with_cameras():
    state, cams = wyze.status(ENV, bridge({}, {"cameras": [{"name": "den"}]}))
    assert state == "ok" and cams[0]["name"] == "den"
    assert wyze.message(state, ENV, cams) == "The Wyze login works. The bridge lists 1 camera(s)."
