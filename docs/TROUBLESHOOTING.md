# Troubleshooting

Run `docker compose run --rm setup doctor` first. It prints one line for each check. A line starts with `OK`, `NOTE`, or `FIX`. `NOTE` does not stop the cameras. Find the text of each `FIX` or `NOTE` line below.

Never print `.env`, `cameras.yml`, or `frigate/config/config.yml`. When you quote a log, remove any text of the form `://name:password@`.

## The checks of `doctor`

### `FIX  There is no .env yet. Run: docker compose run --rm setup init --tz <Area/City>`

The project has no `.env`. Run `init` with the time zone of the person (INSTALL.md, Step 4).

### `FIX  The setup tool cannot reach Docker. Start Docker Desktop (or the Docker service), wait until it says it is running, and run doctor again.`

The setup container cannot use the Docker socket `/var/run/docker.sock`.

1. Start Docker Desktop and wait until it says it is running.
2. On Linux run `sudo systemctl status docker`. Start it with `sudo systemctl start docker`.
3. If Docker runs, the socket may be at another path (Docker in rootless mode, or Podman). `docker-compose.yml` mounts `/var/run/docker.sock` only. This is a known gap.

### `FIX  The container <service> does not exist. Run: docker compose up -d`

The service is `frigate`, `clip-exporter`, `cam-helper`, `ui`, or `wyze-bridge`. Run `docker compose up -d`. For `wyze-bridge`, check that `.env` has `COMPOSE_PROFILES=wyze`. If it does not, run `docker compose run --rm setup init` with no options.

### `FIX  The container <service> is <state> (<status>). Read its log: docker compose logs --tail 50 <service>`

The container stopped or restarts in a loop. Read the log. For `cam-helper`, a message that starts with `PET_` names a bad pet setting in `.env`.

### `FIX  The container <service> runs but is unhealthy. Read its log: docker compose logs --tail 50 <service>`

The image of `cam-helper` has a health check. Read its log. After the fix run `docker compose up -d`.

### `NOTE The time zone is <name>. The time there is <time> on <date>. If you do not live in UTC, set your own time zone with init --tz, or the times in the app are wrong.`

Run `docker compose run --rm setup init --tz <Area/City>`. Then run `docker compose up -d`.

### `FIX  No time zone is set. Run: docker compose run --rm setup init --tz <Area/City>, for example --tz Europe/Berlin.`

`TZ` is empty in `.env`. Run the command in the message.

### `FIX  The time zone "<name>" is not a known name. Use a name such as Europe/Berlin or America/New_York (init --tz).`

Use a name of the form `Area/City`. Run `init --tz` again.

### `OK   The time zone is <name>. The time there is <time> on <date>. Compare it with your own clock.`

Compare the time with the clock of the person. If it is wrong, set another `--tz`.

### `OK   The values in .env are written so that Docker reads them as typed.`

Nothing to do.

### `FIX  .env, <KEY>: <what is wrong>`

Docker would read the value of `<KEY>` in another way than it was typed. The line says how to fix it, for example: put the whole value in single quotes. A value with a single quote `'` cannot be used; change it. `init` and `sync` print the same line and stop. The line never shows the value.

### `FIX  There is no Frigate config yet. Run: docker compose run --rm setup sync`

Run `sync` (INSTALL.md, Step 8).

### `FIX  Frigate started before sync and made its own empty config. Run: docker compose run --rm setup sync`

Run `sync`. It moves Frigate's empty `config.yaml` aside and makes the config from the template.

### `OK   The Frigate config was made by sync from the template (<N> days of recordings).`

Nothing to do.

### `FIX  The Frigate config keeps <N> days of recordings, and .env says RECORD_DAYS=<M>. Run: docker compose run --rm setup sync`

`RECORD_DAYS` changed after the last `sync`. Run `sync`; it sets the days and restarts Frigate.

### `NOTE The Frigate config was not made from the template by sync. ...`

The Frigate config was written by hand or by Frigate. `sync` adds and updates cameras in it, but does not set the detector, the days of recording, or the WebRTC addresses. Edit those in `frigate/config/config.yml`, or move the file aside (keep a copy) and run `sync` to make a new one from the template.

### The Wyze lines

`doctor` and `sync` check the Wyze login when `COMPOSE_PROFILES` has `wyze`. Each line is one of these:

- `These Wyze values are empty in .env: <keys>. ...`: the person types them into `.env` (INSTALL.md, Step 5).
- `The Wyze bridge does not answer. ...`: run `docker compose up -d wyze-bridge`, wait one minute, try again.
- `The Wyze bridge runs but has not read the Wyze account yet. ...`: wait one minute.
- `Your Wyze account uses two-step login. ...`: the person puts the two-step key on the line `WYZE_TOTP_KEY=` in `.env`. Then `docker compose up -d wyze-bridge`.
- `Wyze refused the two-step code. ...`: the two-step key is wrong. The person copies it again.
- `Wyze refused the login. ...`: the email, the password, `API_ID`, or `API_KEY` is wrong. See "The Wyze login fails".
- `The Wyze login works, but the account has no camera that the bridge can use. ...`: add the camera in the Wyze app, then `docker compose restart wyze-bridge` and `sync`.
- `OK   The Wyze login works. The bridge lists <N> camera(s).`: nothing to do.

### `FIX  Frigate does not answer. It needs about one minute after a start. If this stays, read its log: docker compose logs --tail 50 frigate`

Wait one minute and run `doctor` again. If it stays, read the log. A common cause is a wrong `frigate/config/config.yml`. The log names the line.

### `FIX  Frigate gives no camera numbers. Fix the Frigate line above first.`

The Frigate check failed. Fix that first.

### `FIX  Frigate has no camera. Add a camera (cameras.yml, or the Wyze settings in .env), then run: docker compose run --rm setup sync`

Do INSTALL.md Steps 5 to 8. Then run `docker compose restart frigate`.

### `NOTE The camera <name> sends no pictures yet: Frigate started <N> s ago. Run doctor again in one minute.`

Wait. A camera sends its first pictures up to about one minute after a start.

### `FIX  The camera <name> sends no pictures. Check that it has power and network, and that its RTSP address in cameras.yml is right (or, for a Wyze camera, that it shows live in the Wyze app). Then: docker compose logs --tail 50 frigate`

See "A camera is offline" below.

### `OK   The camera <name> sends pictures (<N> per second).`

The camera works.

### `FIX  No recording is in the media folder yet. Frigate writes its first segment a minute after a camera sends pictures. If the cameras are fine and this stays, check MEDIA_DIR in .env.`

Wait two minutes after the cameras send pictures. If it stays, check that `MEDIA_DIR` in `.env` is a folder that exists and that Docker may use it. On a Mac or Windows, Docker Desktop must be allowed to use that folder. The setting is in Docker Desktop, Settings, Resources, File sharing. I did not verify this in a Docker document.

### `FIX  The newest recording is <N> minutes old: Frigate does not record now. Read: docker compose logs --tail 50 frigate`

Frigate runs but writes no new file. Read the log. Check the disk (see "The disk is full"). Check the cameras.

### `OK   Frigate records (the newest segment is <N> s old).`

Recording works.

### `FIX  The media folder cannot be read. Check MEDIA_DIR in .env.`

The folder in `MEDIA_DIR` is missing or Docker cannot use it. Make the folder, or set another with `init --media-dir`. Then run `docker compose up -d`.

### `OK   The recordings of <camera> take <N> GB a day (<how>).`

The size of one day of recordings of that camera. `<how>` is `measured on yesterday`, or `estimated from <N> min of recording today` in the first day. Under 10 minutes of recording gives no line yet.

### `FIX  The disk of the media folder has <N> GB free. ... The recordings need <N> GB more to reach <D> days. ...`

The recordings of `RECORD_DAYS` days do not fit, or under 5 GB is free. See "The disk is full".

### `NOTE The disk of the media folder has <N> GB free. ... At this rate the disk is full in about <N> days. ...`

The event clips fill the disk within 30 days. Free space, or set `CLIP_KEEP_DAYS` (see "The disk is full").

### `OK   The disk of the media folder has <N> GB free. ...`

The line gives the size of the event clips and how many days remain at this rate. Nothing to do.

### `FIX  The helper does not answer. Read its log: docker compose logs --tail 50 cam-helper`

Read the log. A traceback that ends in a `ValueError` about `PET_NAME`, `PET_CAMERA`, `PET_LABEL`, or `PET_SEX` is a bad pet setting. Correct it with `init`. A bad `GPU_GATE` shows `GPU_GATE must be empty or "nvidia"`.

### `OK   The helper (alerts, summaries, pet day) answers.`

The helper works.

### `FIX  The app does not answer. Read: docker compose logs --tail 50 ui`

The `ui` container is not serving. Read the log. A failed first build shows in `docker compose up -d`. Run `docker compose build ui` and read the error.

### `FIX  The app answers, but not on port <N> of this computer. Run: docker compose up -d`

The `ui` container has another port than `APP_PORT`. After a change of `APP_PORT`, run `docker compose up -d` so Docker recreates the container.

### `OK   The app answers. Open http://127.0.0.1:<N> on this computer.`

Open that address.

### `NOTE APP_HOST is empty: only this computer can open the app. ...`

Remote view is not set up yet. See INSTALL.md, Step 12.

### `OK   The app accepts https://<name>, the page and the live view. ...`

The app takes requests for that name. Compare the name with the one that `tailscale serve status` shows.

### `FIX  The app runs with APP_HOST=<old>, but .env says <new>. Run: docker compose up -d`

`APP_HOST` changed and the `ui` container still has the old value. Run `docker compose up -d`.

### `FIX  The app refuses the name <name> (answer <N>). ...` or `FIX  The app page opens as https://<name>, but its live view refuses it (answer <N>). ...`

The `ui` container does not take that name. Check `APP_HOST` in `.env` (a name only: no `https://`, no port), then run `docker compose up -d` and `doctor` again.

### `OK   Docker answers.` and `OK   The container <service> is running.`

Nothing to do.

### The last line

`Everything works.` means no `FIX`. `<N> thing(s) to fix: see the FIX lines above.` means at least one.

## The messages of `sync`, `remove` and `init`

### `FIX  Give the time zone: --tz <Area/City>, ...`

The first `init` needs the time zone. Ask the person for the city (INSTALL.md, Step 3).

### `NOTE The time zone is UTC. The times in the app are UTC times.`

Only right if the person lives in UTC. Else run `init --tz <Area/City>`.

### `Next: ...`

The last line of `init` names the next step: type the Wyze values, make `cameras.yml`, start the bridge, or run `sync`.

### `FIX  No camera found. Add your cameras to cameras.yml (see cameras.example.yml), or set the Wyze values with init, then run sync again.`

Do INSTALL.md Step 5 or 6.

### `FIX  cameras.yml ...`

The message names the entry and the fault: `the name must be letters, digits and _ only`, `the name <x> is there two times`, `rtsp must be an rtsp:// address`, `audio must be true or false`, or `must have a list under "cameras:"`. Ask the person to fix the file. Do not print the file.

### `FIX  <KEY> must be a whole number`, `--app-host ...`, `--detector must be one of openvino, cpu.`

`init` refuses a bad value. Use the form that the message shows. `APP_HOST` is a name only: no `https://` and no port.

### `keep <name>`, `update <name> (the address from the bridge or cameras.yml)`, `add  <name>`, `skip <name> (in SKIP_CAMERAS in .env)`

What `sync` did with each camera. `update` means its address changed. Every other edit of the camera in `frigate/config/config.yml` stays.

### `set  <setting>: <old> -> <new>`

A setting of `.env` (detector, days of recording, WebRTC addresses) changed, and `sync` wrote it into the Frigate config. Only a config that `sync` made gets these lines.

### `Frigate had started before sync and wrote an empty config.yaml. Moved it to frigate/config/config.yaml.frigate-default.`

Nothing to do. The moved file is Frigate's empty default; it can be deleted.

### `FIX  frigate/config/config.yaml holds cameras that Frigate wrote. ...`

Someone added cameras in Frigate's own pages before `sync` ran. Move that file out of `frigate/config` (keep a copy), then run `sync`.

### `set  FRIGATE_SHM_SIZE <old>mb -> <new>mb in .env ...` and `Restart needed: run docker compose up -d ...`

More cameras need more shared memory. Run `docker compose up -d`.

### `Nothing to change.`

The Frigate config already has every camera and setting.

### `Removed <name> and its streams from the Frigate config. ...`

`remove` took the camera out and put its name in `SKIP_CAMERAS` in `.env`. To get it back, take the name out of `SKIP_CAMERAS` and run `sync`.

### `FIX  The Frigate config has no camera <name>. The cameras are: ...`

Use one of the names in the line.

## Common failures

### A camera is offline

1. Run `doctor`. Find the `FIX  The camera <name> sends no pictures.` line.
2. Check that the camera has power and a network. For a Wyze camera, open the Wyze app and look at the live picture.
3. For an RTSP camera, check that RTSP is on in the camera app, and that the address in `cameras.yml` is right. Ask the person to check the file. Do not read it aloud.
4. Run `docker compose logs --tail 50 frigate`. Look for lines with the camera name.
5. If you fixed the address in `cameras.yml`, run `docker compose run --rm setup sync`. It shows `update <name>` and restarts Frigate.
6. The app shows how long a camera has been down.

### No picture on the phone

1. The app opens but the pictures stay black. Wait 10 seconds. The app starts on a direct stream and changes after a few seconds.
2. The app does not open at all. Check that Tailscale is on in the phone (the app shows a connected state) and that the phone uses the same Tailscale account as the computer.
3. On the computer run `tailscale serve status`. It must show the `https://...ts.net` name and the proxy to `http://127.0.0.1:5010`. If it shows nothing, run the command of INSTALL.md Step 12 again.
4. A page that says `Misdirected request` means the name in `APP_HOST` is not the name in the address. Run `docker compose run --rm setup init --app-host <name>` with the exact name from `tailscale serve status`. Then run `docker compose up -d`.
5. A page that says `Not available here` means the path is not allowed. Open the base address `https://<name>/`.
6. Live view also needs the video to work in the browser. Try the browser of the computer first (Step 11). If it works there and not on the phone, the cause is the link (Tailscale, the name, HTTPS).
7. The computer sleeps. Check the sleep setting (INSTALL.md Step 16).

### Phone alerts do not arrive

1. On an iPhone the app must run from the Home Screen icon, and iOS must be 16.4 or later. The app tells you when it is not.
2. The **Alerts** page must say `Alerts are on for this device`. Tap **Send a test alert**.
3. The app says `The alert service is not answering`. Run `docker compose logs --tail 50 cam-helper`.
4. The app says `Alerts are turned off for this app`. On the phone open Settings, Notifications, Cameras, and allow notifications.
5. Alerts exist for only three things: a dog that barks, a smoke alarm, and breaking glass. A bark alert needs `INDOOR_CAMERAS` and a camera with sound.
6. If `helper/state/vapid.json` was deleted, every phone must turn alerts on again.

### The Wyze login fails or needs a code

1. Run `docker compose run --rm setup doctor`. The Wyze line says which of the faults it is (see "The Wyze lines" above).
2. Run `docker compose run --rm setup init` with no options. It must show `(set)` for `WYZE_EMAIL`, `WYZE_PASSWORD`, `API_ID`, and `API_KEY`, and no `FIX  .env` line.
3. A value with `$`, `#`, a space, or a double quote must be in single quotes in `.env`. A password with a single quote cannot be used.
4. `API_ID` is the Key ID and `API_KEY` is the API Key of https://developer-api-console.wyze.com/#/apikey/view. They are not the password.
5. A Wyze account with two-step login needs `WYZE_TOTP_KEY` in `.env`: the secret of the authenticator app, not the six-digit code. A code that the person receives by text cannot be used.
6. After a fix, run `docker compose up -d wyze-bridge` and then `docker compose run --rm setup sync`.
7. A Wyze camera that was added later does not appear by itself. Run `docker compose restart wyze-bridge`, then `sync`.

### A port is already in use

The error looks like `Bind for 127.0.0.1:5010 failed: port is already allocated` or `address already in use`. The ports are `APP_PORT` (5010), `ADMIN_PORT` (5011), `FRIGATE_HTTPS_PORT` (8971), and `WEBRTC_PORT` (8555).

1. Find out what uses the port. macOS and Linux: `lsof -i :5010`. Windows: `Get-NetTCPConnection -LocalPort 5010`.
2. If it is another copy of this recorder, stop it with `docker compose down` in its folder.
3. Or pick another port: `docker compose run --rm setup init --app-port 5020`. Then run `docker compose up -d`. If `tailscale serve` uses the old port, run `tailscale serve reset` and the command of INSTALL.md Step 12 with the new port.
4. After a change of `WEBRTC_PORT`, run `docker compose run --rm setup sync` too. It writes the new port into the Frigate config.

### The disk is full

1. Run `docker compose run --rm setup doctor`. The disk lines show the free space, the size of a day of recordings of each camera, and the size of the event clips.
2. Recording stops when the disk is full.
3. Lower `RECORD_DAYS`: `docker compose run --rm setup init --record-days 3`, then `docker compose run --rm setup sync`. `sync` writes the days into the Frigate config and restarts Frigate. Then run `docker compose up -d` so the clip exporter gets the new number.
4. Delete old event clips: `docker compose run --rm setup init --clip-keep-days 30`, then `docker compose up -d`. The clip exporter then deletes each clip that the recorder cut when its event is older than that, 20 clips each poll. A clip that the person saved stays. The least is 3 days.
5. Or move `MEDIA_DIR` to a larger disk: `init --media-dir <folder>`, then `docker compose up -d`. The old files do not move.

### The first build fails

`docker compose up -d` builds the app and the helper. This needs the internet. A message with `npm` or `pip` and `network` or `timeout` is a network fault. Run the command again.
