"""The last time each camera was live, kept past Frigate's retention.

Every EVERY_S seconds the helper reads Frigate's /api/stats. A camera with
camera_fps > 0 sends frames, so its last-live time is now. A camera with no
frames keeps the time it had. The times are in DATA_DIR/cameras.json and are
served at GET /cameras (/helper/cameras through Caddy).

The app needs this for a camera that has been down longer than the 7 days of
recordings: Frigate's /api/recordings/unavailable then gives one range that
starts where the question starts, so Frigate cannot say when the camera
stopped.

A value from another source (for example, a time read from the camera
maker's own service) can be put in the state file by hand with its own
"source" mark. The helper keeps it until Frigate sees frames from the camera.

What this does not do:
- It does not ask the camera maker's service.
- It is good to EVERY_S: a camera that stops just after a poll has a last-live
  time up to EVERY_S seconds early.
- It knows nothing from before the helper first ran.
"""

import logging
import jsonstore

log = logging.getLogger("cam-helper.cameras")

EVERY_S = 30
SOURCE_FRIGATE = "frigate-stats"


def _valid(entry):
    return (isinstance(entry, dict) and isinstance(entry.get("last_live"), (int, float))
            and not isinstance(entry.get("last_live"), bool) and isinstance(entry.get("source"), str))


class LastLive:
    def __init__(self, frigate, path, clock):
        self.frigate = frigate
        self.path = path
        self.clock = clock
        stored = jsonstore.load(path, {})
        if not isinstance(stored, dict):
            stored = {}
        self.state = {}
        self.state.update({k: v for k, v in stored.items() if _valid(v)})

    def step(self):
        """Read the stats once; save when a camera sent frames."""
        stats = self.frigate.stats()
        now = int(self.clock())
        changed = False
        for name, cam in (stats.get("cameras") or {}).items():
            fps = cam.get("camera_fps") if isinstance(cam, dict) else None
            if isinstance(fps, (int, float)) and not isinstance(fps, bool) and fps > 0:
                self.state[name] = {"last_live": now, "source": SOURCE_FRIGATE}
                changed = True
        if changed:
            jsonstore.save(self.path, self.state)

    def cameras(self):
        """camera -> {"last_live": unix seconds, "source": where the value came from}."""
        return {k: dict(v) for k, v in self.state.items()}
