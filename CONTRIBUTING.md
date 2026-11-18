# Contributing

Thank you for helping. This file says how to test a change and how to send it.

## Run the tests

The Python tests (helper, exporter, setup) run in Docker. The host needs no Python:

```text
docker compose run --rm test
```

The app in `ui/app` needs Node.js on the host:

```text
cd ui/app
npm ci
npm test
npx tsc -b
npm run build
```

## Rules for the content

- No source file may hold a camera name, a pet name, a host name, or any detail of a real home.
- Test data must be invented. Never capture test data from a real camera.
- Never commit a secret. `.env` and `cameras.yml` stay out of git.

## Send a change

1. Fork the repository and make a branch.
2. Make the change. Add or update a test.
3. Run all the tests above. They must pass.
4. Open a pull request. Say what the change does and why.
