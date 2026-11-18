# Security

## Report a problem in private

Report these problems in private:

- A way to reach the cameras or the recordings without permission.
- A secret that the tool prints.

Use the **Report a vulnerability** button on the **Security** tab of this repository. Do not open a public issue for these problems.

## How the project protects an install

- The app port is bound to the computer itself (`127.0.0.1`). Other devices at home cannot reach it. The Frigate login port is bound to `127.0.0.1` too, unless the person sets `FRIGATE_BIND_ADDRESS`.
- Remote access goes through the Tailscale devices of the person only. The app is not on the public internet. `INSTALL.md` Step 12 sets this up.
- Secrets stay in `.env` and `cameras.yml`. Git ignores both files.
