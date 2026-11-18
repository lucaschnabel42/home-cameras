"""What the Wyze bridge says about its Wyze login, in plain words.

The bridge (the IDisposable fork, docker-compose.yml) answers on the compose
network at port 5080:
- GET /api/health has an "issues" list only when something is wrong. A
  failed Wyze login is the issue with ID "wyzeapi/auth" and Scope "auth".
  Its Detail is the error text: "MFA required but no TOTP key configured"
  when the account has two-step login and WYZE_TOTP_KEY is empty, "mfa
  login: ..." or "generate TOTP: ..." when the two-step key is wrong, and
  another text when the email, password, API ID or API key is refused.
- GET /api/metrics lists the cameras, and in "wyzeapi" each Wyze API call
  with its last HTTP status. A get_object_list call with status 200 and no
  camera means: logged in, but the account has no camera that the bridge
  can use.

The Detail text can hold a part of a Wyze answer. This module only looks
for the fixed words above in it; it never prints it.
"""

import frigate_config

HEALTH = "http://wyze-bridge:5080/api/health"
METRICS = "http://wyze-bridge:5080/api/metrics"
NEEDED = ("WYZE_EMAIL", "WYZE_PASSWORD", "API_ID", "API_KEY")
# States after which waiting longer does not help.
FINAL = ("not_set", "mfa_needed", "mfa_failed", "refused", "no_cameras", "ok")

MESSAGES = {
    "not_set": "These Wyze values are empty in .env: {missing}. Type them into .env "
               "(INSTALL.md, Step 5), then run init again.",
    "no_answer": "The Wyze bridge does not answer. Start it: docker compose up -d wyze-bridge. "
                 "Then wait one minute and try again.",
    "starting": "The Wyze bridge runs but has not read the Wyze account yet. Wait one minute "
                "and try again.",
    "mfa_needed": "Your Wyze account uses two-step login. Put the two-step key (the TOTP "
                  "secret of your authenticator app) on the line WYZE_TOTP_KEY= in .env, "
                  "then run: docker compose up -d wyze-bridge",
    "mfa_failed": "Wyze refused the two-step code. The value of WYZE_TOTP_KEY in .env is "
                  "not the right secret. Copy it again from the Wyze app, then run: "
                  "docker compose up -d wyze-bridge",
    "refused": "Wyze refused the login. Check WYZE_EMAIL, WYZE_PASSWORD, API_ID and API_KEY "
               "in .env (no space before or after a value), then run: "
               "docker compose up -d wyze-bridge",
    "no_cameras": "The Wyze login works, but the account has no camera that the bridge can "
                  "use. Add the camera in the Wyze app, then run: docker compose restart "
                  "wyze-bridge",
    "ok": "The Wyze login works. The bridge lists {count} camera(s).",
}


def _field(d, name):
    """A Go struct field in JSON: the bridge's issue fields have no JSON tags,
    so the name is "Detail"; a later version can write "detail"."""
    return d.get(name, d.get(name.lower())) if isinstance(d, dict) else None


def status(settings, get):
    """(state, cameras): state is a key of MESSAGES; cameras is the list of
    frigate_config.wyze_cameras when the state is "ok", else []."""
    missing = [k for k in NEEDED if not (settings.get(k) or "").strip()]
    if missing:
        return "not_set", []
    try:
        health = get(HEALTH) or {}
        metrics = get(METRICS) or {}
    except (OSError, ValueError):
        return "no_answer", []
    for issue in _field(health, "issues") or []:
        if _field(issue, "Scope") == "auth" or _field(issue, "ID") == "wyzeapi/auth":
            detail = str(_field(issue, "Detail") or "")
            if "MFA required" in detail:
                return "mfa_needed", []
            if "mfa login" in detail or "generate TOTP" in detail:
                return "mfa_failed", []
            return "refused", []
    cameras = frigate_config.wyze_cameras(metrics)
    if cameras:
        return "ok", cameras
    for call in metrics.get("wyzeapi") or []:
        if (isinstance(call, dict) and str(call.get("Path", "")).endswith("get_object_list")
                and call.get("LastStatus") == 200):
            return "no_cameras", []
    return "starting", []


def message(state, settings=None, cameras=()):
    missing = [k for k in NEEDED if not ((settings or {}).get(k) or "").strip()]
    return MESSAGES[state].format(missing=", ".join(missing), count=len(cameras))
