# Adds every new camera to Frigate: each Wyze camera that the bridge lists,
# and each camera in cameras.yml. A camera that Frigate already has is left
# as it is. Run it again after you add a camera.
#
# This is a short form of "docker compose run --rm setup sync" for Windows.
# The setup tool does the work (setup/setup.py); this script needs only
# Docker.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
docker compose run --rm setup sync
exit $LASTEXITCODE
