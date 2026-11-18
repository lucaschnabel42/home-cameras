# home-cameras

A recorder for home cameras that runs on one computer in your home.

- It records every camera all day and keeps the recordings for a set number of days.
- It finds people, dogs, and cats, and cuts a clip of each event.
- It shows live view, clips, and a timeline in an app for your phone.
- It sends phone alerts for a dog that barks, a smoke alarm, and breaking glass.
- You see the app away from home through Tailscale. The recorder sends no camera picture to a public server. A Wyze camera still talks to Wyze through the bridge.

This project has no link to Wyze, Frigate, or Tailscale. It is not made, approved, or supported by them.
It only uses their software and services.

## What you need

- A computer that stays on, with at least 8 GB of memory and room for recordings (see "Disk space" in `INSTALL.md`).
  It can run macOS (Apple silicon or Intel), Windows 10 or 11, or Linux.
- Docker. On macOS and Windows this is Docker Desktop. On Linux this is Docker Engine with the Compose plugin.
- Cameras: Wyze cameras, or any camera that gives an RTSP stream.
- A free Tailscale account, to see the app away from home.
- A phone. Alerts on an iPhone need iOS 16.4 or later.

## Give this to Claude

Open Claude Code on the computer that will run the recorder. Then send these three lines:

```text
Install this for me: <the link to this repository>
Follow INSTALL.md in the repository, step by step.
Tell me when a step needs me. Do not ask me for a password or a key in the chat.
```

Claude does the commands. Claude tells you when a step is yours, for example typing a password into a file.

## The parts

| Part | What it does |
|------|--------------|
| `frigate` | Reads each camera, records, finds objects, and gives live view. |
| `go2rtc` | Lives inside the Frigate image. It shares one camera connection between recording and live view. |
| `wyze-bridge` | Optional. It turns a Wyze camera into an RTSP stream. It runs only for Wyze cameras. |
| `clip-exporter` | Cuts a padded clip of each event from the recordings. |
| `cam-helper` | Sends the phone alerts. Optional: summaries and the pet day. |
| `ui` | Caddy web server. It serves the app and passes only the Frigate paths that the app needs. |
| `setup` | A tool that you run on demand. Commands: `init`, `sync`, `remove`, `doctor`. |

## What the app does

The app runs in a browser, on a phone and on a desktop. On an iPhone, add it
to the Home Screen and it opens like an app.

- **Home.** Each camera plays live. With many cameras the app shows a grid,
  and only some tiles play video at one time; the others show a still that
  refreshes. A camera that is offline shows since when.
- **Activity.** One list of what the cameras saw: people, animals, vehicles,
  and sounds. Events that are close together fold into one row. Tap a row to
  play its clip.
- **Camera view.** Live video with pinch to zoom, a dial to go back in the
  recording, and a button to save the last minutes as a clip.
- **Security mode.** A wall of all cameras with no other content. A camera
  gets a mark while the recorder sees a person, an animal, or a vehicle
  there. A spotlight layout shows one camera large. "Follow activity" moves
  the spotlight to the camera with the newest detection. The screen stays on.
  You can hide a camera, change the order, and save a still.
- **Phone alerts.** For a smoke alarm or breaking glass, and for a dog that
  barks while no person is home. They need the Tailscale address (see
  `INSTALL.md`).
- **A clean live stream.** Some cameras send damaged video frames over
  Wi-Fi, and a browser then drops the picture. The recorder can encode the
  video again, which hides the damage. The app uses this stream when it
  shows one or two cameras.
- **Themes.** Light and dark, in several colours.
- **Optional.** Short text summaries of events from a vision model on your
  own computer (Ollama), and a "day of your pet" page for one camera. Both
  are off until you set them up.

## Update

Run these commands in the project folder:

```text
git pull
docker compose build
docker compose run --rm setup sync
docker compose up -d
docker compose run --rm setup doctor --wait 180
```

`.env`, `cameras.yml`, and `frigate/config/config.yml` stay as they are.
A new setting in `.env.example` does not appear in your `.env` by itself.
Read `.env.example` after an update and add each new setting you want.

## Stop and remove

- Stop the recorder and keep the recordings: `docker compose stop`
- Start it again: `docker compose up -d`
- Remove the containers: `docker compose down`
- Remove the containers and the Frigate database volume: `docker compose down --volumes`
- Recordings and clips are in the folder `MEDIA_DIR` of your `.env` (default `./media`).
  Docker never deletes this folder. Delete it yourself when you want the disk space back.
- To stop the Tailscale link: `tailscale serve reset`

## Development

All the Python tests (helper, exporter, setup) run in Docker, with no Python on the host:

```text
docker compose run --rm test
```

The app (`ui/app`) needs Node.js on the host:

```text
cd ui/app
npm ci
npm test
npx tsc -b
npm run build
```

## Licence and third-party notices

This project uses the MIT licence. See `LICENSE`. Copyright the home-cameras authors, 2026.

The recorder runs the software below. It is not part of this repository, except where the table says so.

| Software | How this project uses it | Licence |
|----------|--------------------------|---------|
| Frigate (ghcr.io/blakeblackshear/frigate) | Container image, not changed | MIT, Copyright (c) 2026 Frigate, Inc. |
| go2rtc (inside the Frigate image) | Restream of each camera | MIT, Copyright (c) 2022 Alexey Khit |
| go2rtc `video-rtc.js` | Copied into `ui/app/src/vendor/video-rtc.js`, with its header kept | MIT, Copyright (c) 2022 Alexey Khit |
| Wyze bridge (idisposablegithub365/wyze-bridge, a fork of docker-wyze-bridge) | Container image, not changed. Optional. | GNU AGPL v3 |
| Caddy (caddy:2-alpine) | Web server in the `ui` image | Apache License 2.0 |
| React, React DOM, Motion, Phosphor Icons, Tailwind CSS | Built into the app | MIT |
| hls.js | Built into the app | Apache License 2.0 |
| Geist font (`@fontsource-variable/geist`) | Built into the app | SIL Open Font License 1.1 |

The Python tools use pywebpush, opencv-python-headless, numpy, ruamel.yaml, and cryptography.
Each has its own licence. See `helper/requirements.txt` and `setup/requirements.txt`.
The npm licence fields come from `ui/app/package-lock.json`.
The licence of each other package is the one in its own release.
