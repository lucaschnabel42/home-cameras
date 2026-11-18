# The camera app

The web app that shows the cameras, the activity list, the clips, and the
security wall. React, TypeScript, and Vite. It reads everything from the
recorder (Frigate) through the Caddy proxy in `../Caddyfile`, and it holds no
camera name of its own.

## Layout

| Path | Holds |
|------|-------|
| `src/App.tsx` | The home screen and the overlays. |
| `src/components/` | One file for each screen or large part. `security/` is the camera wall. |
| `src/lib/` | The logic, as pure functions. Each module has a test file beside it. |
| `src/styles.css`, `src/themes.css` | The styles and the colour themes. |
| `public/sw.js` | The service worker that shows a phone alert. |

## Commands

```
npm ci          # install the packages
npm test        # the unit tests (vitest)
npx tsc -b      # the type check
npm run build   # the production build, to dist/
npm run dev     # a dev server; it sends API calls to the recorder at 127.0.0.1:5010
```

A normal install does not need these commands. `docker compose` builds the app
inside Docker (`../Dockerfile`).
