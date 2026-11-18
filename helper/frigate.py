"""A small GET-only client for Frigate's API (http://frigate:5000, no login).

The helper never writes to Frigate: no POST, PATCH or DELETE.
"""

import json
import urllib.parse
import urllib.request

TIMEOUT_S = 15


def http_get(url, timeout):
    """GET url and return the body. Raises urllib.error.URLError/HTTPError."""
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


class Frigate:
    def __init__(self, base, get=http_get):
        self.base = base.rstrip("/")
        self.get = get

    def _get(self, path, params, timeout=TIMEOUT_S):
        url = self.base + path
        clean = {k: v for k, v in params.items() if v is not None}
        if clean:
            url += "?" + urllib.parse.urlencode(clean, safe=",")
        return self.get(url, timeout)

    def events(self, after=None, before=None, labels=None, cameras=None,
               in_progress=None, limit=1000):
        """Events (tracked objects and sounds), newest first."""
        params = {"after": after, "before": before,
                  "labels": ",".join(labels) if labels else None,
                  "cameras": ",".join(cameras) if cameras else None,
                  "in_progress": None if in_progress is None else int(bool(in_progress)),
                  "limit": limit}
        return json.loads(self._get("/api/events", params))

    def reviews(self, after=None, before=None, limit=1000):
        """Review items, newest first."""
        return json.loads(self._get("/api/review",
                                    {"after": after, "before": before, "limit": limit}))

    def stats(self):
        """Frigate's /api/stats: per camera, camera_fps is 0 when no frames arrive."""
        return json.loads(self._get("/api/stats", {}))

    def snapshot(self, camera, t, height):
        """A JPEG frame from the continuous recordings at unix time t."""
        path = "/api/{}/recordings/{}/snapshot.jpg".format(urllib.parse.quote(camera), t)
        return self._get(path, {"height": height}, timeout=30)
