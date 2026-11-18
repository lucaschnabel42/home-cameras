# Install runbook

This file is for the Claude that installs the recorder on the computer of a person who does not write code.

## Rules for Claude

- Never ask the person for a secret in the chat. Secrets are: the Wyze password, the Wyze API key, and any RTSP address that holds a camera password.
- The person types each secret into a file with a text editor. Claude opens the file for the person.
- Never print `.env`, `cameras.yml`, or `frigate/config/config.yml`. All three can hold a password.
- Never pass a secret as a command argument. Do not use `--wyze-password`, `--wyze-api-key`, `--wyze-api-id`, or `--wyze-email`.
- Never run `docker compose config` or `docker inspect` on this install. Both print the values of `.env`.
- When you read a log, do not repeat any text that has the form `://name:password@`.
- A step marked **You do this:** belongs to the person. Say it in plain words. Wait for the person to say it is done.
- Run each check. Do not go to the next step until the check passes.
- All commands run in the project folder, in the same terminal type that the person has (PowerShell on Windows, a shell on macOS and Linux).
- Do not edit code. If a step fails in a way that this file does not cover, stop and tell the person. Name the step.

## Step 1. Check Docker

**Who:** Claude. If Docker is missing, the person.

Command:

```text
docker --version
docker compose version
docker info
```

Check: the first two commands print a version. `docker info` prints a `Server:` section with no error.

If `docker info` says it cannot connect, Docker Desktop is not running. Start it (see below), wait until it says it is running, and run the check again.

If a command is missing, Docker is not installed.

**You do this:** install Docker. Pick your computer.

- **Mac:**
  1. Open https://docs.docker.com/desktop/setup/install/mac-install/ and download the installer for Apple silicon (or Intel).
  2. Open `Docker.dmg`. Drag the Docker icon to the Applications folder.
  3. Open Docker in the Applications folder. Click **Accept** on the agreement.
  4. Wait until Docker Desktop says it is running.
- **Windows:**
  1. Open https://docs.docker.com/desktop/setup/install/windows-install/ and download the installer.
  2. Open `Docker Desktop Installer.exe`. On the Configuration page, choose **Use WSL 2 instead of Hyper-V**.
  3. Finish the wizard and click **Close**.
  4. Search for **Docker Desktop** in the Start menu, open it, and click **Accept**.
  5. Docker Desktop does not start by itself after the install. The page says so.
  6. Windows may ask you to restart. Restart, then open Docker Desktop again.
- **Linux:** follow https://docs.docker.com/engine/install/ for your Linux type. Claude can run the commands. They need `sudo`, so you type your password in the terminal when it asks.
  For Ubuntu the page gives the apt repository steps and the packages `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`.
  To run Docker without `sudo`, follow https://docs.docker.com/engine/install/linux-postinstall/ (`sudo groupadd docker`, `sudo usermod -aG docker $USER`, then log out and in). That page warns that the `docker` group gives root-level rights.

Sources: the three Docker pages named above, read on 2026-11-18.

## Step 2. Get the code

**Who:** Claude.

Ask the person for the link to the repository, if you do not have it. Put the folder in the home folder of the person. Do not use a folder that a cloud service syncs (iCloud Drive, OneDrive).

Command:

```text
git clone <the link> home-cameras
cd home-cameras
```

Check: `docker-compose.yml` is in the folder. On macOS and Linux run `ls docker-compose.yml`. On Windows run `Get-ChildItem docker-compose.yml`.

If `git` is missing: on a Mac, the system offers to install the command line tools. Accept. On Windows install Git for Windows. As an alternative, the person downloads the ZIP of the repository from the GitHub page (the green **Code** button, then **Download ZIP**) and unpacks it. A ZIP install cannot use `git pull` for updates.

## Step 3. Ask the questions

**Who:** Claude asks, the person answers. Ask all of these at one time.

1. In which city are you? Claude turns the answer into a name of the form `Area/City`, for example `America/New_York` or `Europe/Berlin`. Never guess it from the computer: the Windows command `tzutil /g` gives a Windows name, not this form.
2. Do you have Wyze cameras? (yes or no)
3. Do you have other cameras with an RTSP stream? (yes or no)
4. Does your Wyze account use two-step login (a code from an authenticator app)? If yes, the person also needs the two-step key in Step 5.

## Step 4. Write the settings (`init`)

**Who:** Claude.

Command (replace the time zone):

```text
docker compose run --rm setup init --tz America/New_York
```

The first run builds the tool image. This needs the internet and takes a few minutes.

If the person has no Wyze camera, add `--no-wyze` to the command.

If another program on the computer uses port 5010, 5011, 8971, or 8555, give other numbers: add `--app-port N`, `--admin-port N`, `--frigate-https-port N`, or `--webrtc-port N` to the command. Step 9 names the fault that shows a port in use.

Do not copy `.env.example` to `.env` by hand. `init` picks the detector from the processor (`cpu` for Apple silicon and other arm64, `openvino` for x86-64) only when there is no `.env` yet.

Check: the output starts with `Wrote .env. The settings are:` and shows `TZ = America/New_York` and a line `FRIGATE_DETECTOR = cpu` or `FRIGATE_DETECTOR = openvino`. On the first run it also shows `Made the push keys (helper/state/vapid.json). Keep this file: without it every phone must turn alerts on again.` The last line starts with `Next:` and names the next step.

The first `init` needs `--tz`. Without it, `init` prints `FIX  Give the time zone: --tz <Area/City>` and writes nothing. Use `--tz UTC` only if the person lives in UTC; `doctor` then shows a `NOTE`.

If it prints `FIX  --tz "..." is not a time zone name.`, use a name of the form `Area/City`.

If it fails with a Docker error, go back to Step 1.

On Linux the tool gives each file that it writes to the owner of the project folder, so the person can edit `.env`.

Keep the push key file `helper/state/vapid.json`. Do not print it.

## Step 5. Wyze account and keys

Skip this step if the person has no Wyze camera.

**Who:** the person.

**You do this:** get a Wyze API key. It is free.

1. Open https://developer-api-console.wyze.com/#/apikey/view in your browser.
2. Sign in with your Wyze account.
3. Create an API key. The page shows a **Key ID** and an **API Key**. Keep the page open.

**You do this:** type your Wyze details into the file `.env`. Claude opens the file for you.

1. Claude runs the open command: on a Mac `open -e .env`, on Windows `notepad .env`, on Linux `nano .env`.
2. Find these four lines. Each ends with `=` and nothing after it.
3. Type each value directly after the `=` sign, with no space:
   - `WYZE_EMAIL=` your Wyze email
   - `WYZE_PASSWORD=` your Wyze password
   - `API_ID=` the Key ID from the Wyze page
   - `API_KEY=` the API Key from the Wyze page
4. If a value has a space, `$`, `#`, or a double quote in it, put the whole value in single quotes, for example `WYZE_PASSWORD='pass word$1'`. Without the quotes Docker reads it wrong. A password with a single quote `'` cannot be used; change it in the Wyze app first. On a Mac, TextEdit may change straight quotes to curly quotes. Turn off Edit, Substitutions, Smart Quotes first.
5. Only if your Wyze account has two-step login: put the two-step key after `WYZE_TOTP_KEY=`. This is the secret (a long code of letters and digits) that your authenticator app was set up with, not the six-digit code. Wyze shows this key only when two-step login is set up. If the person did not keep it, two-step login must be set up again in the Wyze app to see a new key. That path in the Wyze app is not verified.
6. Save the file and close it. Tell Claude it is done. Do not type the values in the chat.

**Who:** Claude. Run `init` again with no secret:

```text
docker compose run --rm setup init
```

Check: the output shows `WYZE_EMAIL = (set)`, `WYZE_PASSWORD = (set)`, `API_ID = (set)`, `API_KEY = (set)` and `COMPOSE_PROFILES = wyze`. Never `(empty)` for these four.

If a value shows `(empty)`: the person typed it on the wrong line or left it out. Ask the person to open the file again.

If `COMPOSE_PROFILES` does not show `wyze`, `WYZE_EMAIL` is empty. Fix that first.

If the output has a line `FIX  .env, <KEY>: <what>`, Docker would read that value in another way. The line says what to change, and never shows the value. Ask the person to open the file again and fix that line, then run `init` again.

## Step 6. Other cameras (`cameras.yml`)

Skip this step if the person has only Wyze cameras.

**Who:** Claude makes the file. The person fills it in.

Command: on macOS and Linux `cp cameras.example.yml cameras.yml`. On Windows `Copy-Item cameras.example.yml cameras.yml`.

**You do this:** write the address of each camera into `cameras.yml`.

1. Turn on RTSP in the app of your camera. Many cameras need this first. The camera maker's manual shows how.
2. Find the RTSP address of the camera in the app or the manual. It starts with `rtsp://`. It often holds the camera user name and password.
3. Claude opens the file (`open -e cameras.yml`, `notepad cameras.yml`, or `nano cameras.yml`).
4. Delete the two example entries. For each of your cameras, write an entry in the same form:

   ```text
   - name: front_door
     rtsp: rtsp://user:password@192.168.1.50:554/stream1
   ```

   The `name` has letters, digits, and `_` only. The optional `sub:` line is a smaller stream of the same camera. Detection uses it. `audio: true` turns on sound detection for a camera whose stream has sound.
5. Save the file and close it. Do not type the address in the chat.

Check: Claude runs Step 8 (`sync`). A wrong file gives a line that starts with `FIX  cameras.yml`. Quote that line to the person and ask the person to fix the file.

## Step 7. Start the Wyze bridge

Skip this step if the person has no Wyze camera.

**Who:** Claude.

Command:

```text
docker compose up -d wyze-bridge
```

Check: `docker compose ps` lists `wyze-bridge` with the state `running`.

If the state is `exited`, run `docker compose logs --tail 50 wyze-bridge`. See `docs/TROUBLESHOOTING.md`, "The Wyze login fails".

## Step 8. Add the cameras to Frigate (`sync`)

**Who:** Claude. The order does not matter: if Frigate started first and wrote its own empty config, `sync` moves it aside and says so.

Command:

```text
docker compose run --rm setup sync
```

With Wyze cameras this waits up to two minutes while the bridge reads the Wyze account. If the login fails, the `FIX` line says why in plain words: Wyze values not set, login refused, a two-step key needed, a wrong two-step key, or no camera on the account. See `docs/TROUBLESHOOTING.md`, "The Wyze login fails".

Check: for each camera the output has a line `add  <name>`. The first run also has `Made frigate/config/config.yml from the template (detector <detector>).` The detector is `cpu` or `openvino`. Because Frigate is not running yet, the last line is `Frigate is not running yet. Start everything: docker compose up -d`. That line is correct here.

If the output is `FIX  No camera found.`: the person has not written `cameras.yml`, or `.env` has no Wyze values. Go back to Step 5 or 6.

Run `sync` again after any change: a new camera, a changed address in `cameras.yml`, or a changed setting (`RECORD_DAYS`, `FRIGATE_DETECTOR`, `WEBRTC_PORT`, `WEBRTC_CANDIDATES`). A camera that is already there shows as `keep <name>`, or as `update <name> (the address from the bridge or cameras.yml)` when its address changed. A changed setting shows as a line that starts with `set`. Every other edit in `frigate/config/config.yml` stays.

To take a camera out, run `docker compose run --rm setup remove <name>`. It removes the camera and its streams, and puts the name in `SKIP_CAMERAS` in `.env` so that `sync` does not add it again.

With many cameras `sync` raises the shared memory of Frigate and prints `Restart needed: run docker compose up -d`. Then run that command.

## Step 9. Start everything

**Who:** Claude.

Command:

```text
docker compose up -d
```

The first run builds the app and the helper. This takes several minutes. Run it in the foreground. Do not poll.

Check: `docker compose ps` lists `frigate`, `clip-exporter`, `cam-helper`, and `ui` as `running` (and `wyze-bridge` for Wyze). Wait two minutes. Frigate needs about one minute after a start.

If a port is in use, the error names it, for example `Bind for 127.0.0.1:5010 failed: port is already allocated`. See `docs/TROUBLESHOOTING.md`, "A port is already in use".

## Step 10. Check the install (`doctor`)

**Who:** Claude.

Command:

```text
docker compose run --rm setup doctor --wait 180
```

`--wait 180` checks again every 15 seconds for up to three minutes while Frigate and the cameras start, and then prints the result once.

Check: every line starts with `OK` or `NOTE`, the last line is `Everything works.`, and the exit code is 0.

For each line that starts with `FIX`, find its text in `docs/TROUBLESHOOTING.md`.

`doctor` checks the Wyze login and the name in `APP_HOST`. It does not check Tailscale itself or phone alerts. Steps 12 to 15 check those.

## Step 11. Open the app on this computer

**Who:** the person.

**You do this:** open http://127.0.0.1:5010 in your browser. If you set `APP_PORT` to another number, use that number.

Check: you see your cameras with live pictures. Wyze cameras can take about a minute to show a picture.

If the page is blank or says "Misdirected request", the address has a name instead of `127.0.0.1`. Use exactly `http://127.0.0.1:5010`.

Frigate's own pages (settings, all recordings) are at http://127.0.0.1:5011 on this computer (`ADMIN_PORT`). They need no login there. Frigate's login port (`FRIGATE_HTTPS_PORT`, 8971) listens on this computer only (`FRIGATE_BIND_ADDRESS=127.0.0.1`), so other devices at home cannot reach it.

## Step 12. Tailscale on the computer (away from home)

Tailscale is a private network between your own devices. The app is not on the public internet.

**Who:** the person installs and signs in. Claude runs the commands.

**You do this:**

1. Install Tailscale on this computer. The install pages are linked from https://tailscale.com/kb/1347/installation (Mac, Windows, Linux).
2. Open Tailscale and sign in. Use the account that you will also use on your phone.
3. Open https://login.tailscale.com/admin/dns in your browser. This is the DNS page of the admin console.
4. Turn on **MagicDNS**, if it is off.
5. Under **HTTPS Certificates**, click **Enable HTTPS**. Tailscale warns you: the names of your devices go into a public list of certificates. Do not turn it on if a device name holds private words. You can rename a device first.

**Who:** Claude. Command:

```text
tailscale serve --bg --https=443 http://127.0.0.1:5010
tailscale serve status
```

Use the port from `APP_PORT` in place of `5010`. On a Mac with the Tailscale app, the `tailscale` command may be missing from the path. Then use the command inside the app, for example `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (checked with Tailscale 1.98.9 on macOS 26).

Check: `tailscale serve status` shows a line that starts with `https://` and ends in `.ts.net`, and says it proxies to `http://127.0.0.1:5010`. That name is the app address. `--bg` keeps the setting across a restart of the computer (source below).

Then give Caddy that name. Take the name from the status line, with no `https://` and no trailing `/`:

```text
docker compose run --rm setup init --app-host <name>.<tailnet>.ts.net
docker compose up -d
```

`init` ends with a `Next:` line that also names `sync`. For this change `sync` is not necessary: `docker compose up -d` is enough.

Check: the `init` output shows `APP_HOST = <the name>`. Then run `docker compose run --rm setup doctor --wait 60`. It must show `OK   The app accepts https://<the name>, the page and the live view.` A `FIX` line there means the app refuses that name; it names the fault.

If `tailscale serve` says HTTPS is not enabled, finish the admin console step above and run it again.

Sources: https://tailscale.com/kb/1242/tailscale-serve (commands, `--bg`, `status`, `reset`, restart behavior). https://tailscale.com/kb/1153/enabling-https (admin console steps, public certificate list). Read on 2026-11-18.

The contact in each push message (`VAPID_SUBJECT`) is `https://<name>` unless the person sets another one.

## Step 13. Tailscale on the phone

**Who:** the person.

**You do this:**

1. Install the Tailscale app from the App Store (iPhone) or Google Play (Android).
2. Open it and sign in with the same account as on the computer.
3. Turn Tailscale on. Leave it on.
4. In the phone browser (Safari on iPhone, Chrome on Android) open `https://<the name from Step 12>`.

Check: the app opens with your cameras.

If it does not open: Tailscale on the phone is off, or the account is different. See `docs/TROUBLESHOOTING.md`, "No picture on the phone".

## Step 14. Add the app to the phone Home Screen

**Who:** the person.

**You do this:**

- iPhone: open the address in Safari. Tap **Share**, then **Add to Home Screen**, then **Add**.
- Android: open the address in Chrome. Open the menu and tap **Add to Home screen** (or **Install app**).

Alerts on an iPhone work only from the icon on the Home Screen, with iOS 16.4 or later (the app says so). They never work in a Safari tab.

## Step 15. Turn on phone alerts

**Who:** the person.

**You do this:**

1. Open the app from the Home Screen icon.
2. Tap the bell icon at the top. This is the **Alerts** page.
3. Tap **Turn on alerts on this phone**. Tap **Allow** when the phone asks.
4. Tap **Send a test alert**. A notification arrives in a few seconds.

Alerts are sent for only three things: a dog that barks for 2 minutes while nobody was seen inside for 20 minutes, a smoke alarm, and breaking glass. There is no alert for a person.
Bark alerts need `INDOOR_CAMERAS` in `.env` (comma-separated camera names) and a camera whose stream has sound.

If the test alert does not arrive, see `docs/TROUBLESHOOTING.md`, "Phone alerts do not arrive".

## Step 16. Start after a restart or a power cut

The containers use `restart: unless-stopped`. Docker starts them again when Docker starts. So the computer must start Docker by itself.

**Who:** Claude shows the person where. The person clicks. Status of each item:

| Item | What to do | Checked in a document |
|------|------------|-----------------------|
| Docker Desktop at sign-in (Mac, Windows) | Docker Desktop, Settings, General, turn on **Start Docker Desktop when you sign in to your computer** | Yes. https://docs.docker.com/desktop/settings-and-maintenance/settings/ lists the setting. It is off by default. |
| Docker on Linux | Ubuntu and Debian start Docker on boot. On another system run `sudo systemctl enable docker.service containerd.service` | Yes. https://docs.docker.com/engine/install/linux-postinstall/ |
| Tailscale `serve` after a restart | Nothing to do with `--bg` | Yes. https://tailscale.com/kb/1242/tailscale-serve |
| Automatic sign-in on a Mac | System Settings, Users & Groups, **Automatically log in as**, choose the account, enter its password. It may be dimmed when FileVault is on. | Yes. https://support.apple.com/en-us/102316 |
| Mac starts after a power failure | System Settings, Energy, **Start up automatically after a power failure** | No. The Apple pages that I read do not name this setting for a current Mac mini. The name may differ on a new Mac. Look on the Energy page. Claude can read the setting with `pmset -g` and look for `autorestart`. This command is not verified. |
| Mac does not sleep | System Settings, Energy, keep the computer awake when the display is off | No. Same reason. |
| Automatic sign-in on Windows | Not covered here | No. |
| Windows or PC starts after a power failure | A setting in the BIOS of the computer. Its name differs by maker. | No. |
| Tailscale starts at sign-in | Not covered here | No. |

On a Mac, Docker Desktop starts only after someone signs in. A Mac with FileVault on waits at the sign-in screen after a power cut. The recorder is then down until a person signs in. Say this to the person.

Check (after the person agrees): restart the computer, wait five minutes, sign in if needed, and run `docker compose run --rm setup doctor`.

## Step 17. Disk space

Recordings go to the folder `MEDIA_DIR` in `.env` (default `./media`, in the project folder). Put it on a disk with room. To move it: `docker compose run --rm setup init --media-dir <folder>` and `docker compose up -d`. The old recordings do not move.

Frigate records the stream of each camera without a new encode, so the size depends on the camera. `doctor` measures it: one line for each camera with its GB a day (measured on yesterday, or estimated from today's recording once it is 10 minutes long), the size of the event clips, and how many days remain until the disk is full at this rate.

- A `FIX` line about the disk means the recordings of `RECORD_DAYS` days do not fit, or under 5 GB is free.
- A `NOTE` line means the disk is full within 30 days at this rate.

Before the first recordings exist, estimate from the data rate of the main stream (the camera app shows it in Mbit/s): one camera for one day is `rate in Mbit/s × 10.8` GB. Recordings need `cameras × RECORD_DAYS × one camera for one day`.

Event clips in `media/exports` stay for ever by default. To delete old clips, set the days: `docker compose run --rm setup init --clip-keep-days 30`, then `docker compose up -d`. The least is 3 days. Only the clips that the recorder cut go; a clip that the person saved in the app stays. Snapshots stay for 30 days (`snapshots.retain.default` in the Frigate config).

## Step 18. Optional: AI summaries

Skip unless the person asks. This needs Ollama, a separate program that runs a model on the computer. The person installs it. The model is `qwen2.5vl:7b`.

**Who:** the person installs Ollama from https://ollama.com. Claude runs:

```text
ollama pull qwen2.5vl:7b
docker compose run --rm setup init --ollama-url http://host.docker.internal:11434
docker compose up -d
```

Check: `docker compose logs --tail 20 cam-helper` shows `summaries on`.

Do not set `GPU_GATE` unless the computer has an NVIDIA GPU and the person knows the setting. It needs a GPU reservation in an override file that this repository does not give.

On Linux, Ollama listens only on the computer itself by default. A container may not reach it. This is not verified.

## Step 19. Optional: the pet day

Skip unless the person asks. The pet day shows a story of what a dog or a cat did all day.

**Who:** Claude asks for the name, the camera of the room, dog or cat, and male or female. The camera name is one of the names that `sync` printed.

```text
docker compose run --rm setup init --pet-name Rex --pet-camera living_room --pet-label dog --pet-sex male
docker compose up -d
```

Check: `docker compose logs --tail 20 cam-helper` shows `pet day on`.

The app shows the pet day only in a version that reads the pet routes of the helper. Check with the person that the app shows the pet card.

## Step 20. Report to the person

Tell the person in plain words: what works, what step is theirs and still open, the app address, and where the recordings are. Do not print any secret.
