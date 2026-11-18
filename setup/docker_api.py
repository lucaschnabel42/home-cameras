"""A small read-only client for the Docker Engine API on its Unix socket.

The doctor command uses it to see the containers of this install. It sends
GET requests only.
"""

import http.client
import json
import socket
from urllib.parse import quote

SOCKET = "/var/run/docker.sock"


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("docker", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Docker:
    def __init__(self, path=SOCKET, timeout=10):
        self.path = path
        self.timeout = timeout

    def get(self, url):
        """The decoded JSON body of GET url; OSError when Docker is not there."""
        conn = _UnixConnection(self.path, self.timeout)
        try:
            conn.request("GET", url)
            response = conn.getresponse()
            body = response.read()
        finally:
            conn.close()
        if response.status >= 400:
            raise OSError(f"Docker answered {response.status} for {url}")
        return json.loads(body) if body.strip().startswith((b"{", b"[")) else body.decode()

    def ping(self):
        return self.get("/_ping") == "OK"

    def container(self, ref):
        return self.get(f"/containers/{ref}/json")

    def project_containers(self, project):
        """The containers of a compose project, stopped ones too."""
        flt = json.dumps({"label": [f"com.docker.compose.project={project}"]})
        return self.get("/containers/json?all=1&filters=" + quote(flt, safe=""))
