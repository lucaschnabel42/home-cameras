# home-cameras

This folder is a home camera recorder. Docker runs every part.

- To install it for a person, follow `INSTALL.md` step by step. Run each check.
- To fix a fault, use `docs/TROUBLESHOOTING.md`. Start with `docker compose run --rm setup doctor`.
- Never ask the person for a secret in the chat. The person types it into `.env` or `cameras.yml` with a text editor.
- Never print `.env`, `cameras.yml`, or `frigate/config/config.yml`. Never pass a secret as a command argument.
- Never run `docker compose config` or `docker inspect`. They print the values of `.env`.
- Remove any text of the form `://name:password@` before you quote a log.
- Use `docker compose run --rm setup init` with no secret option. The person's values stay in `.env`.
- Run `setup sync` after each change of `cameras.yml` or of a camera setting in `.env`. The order of `sync` and the first `docker compose up -d` does not matter.
- Mark each step that the person must do with **You do this:** and use plain words.
- Do not edit code. If a step fails in a way that the documents do not cover, stop and tell the person.
- Write in short, plain sentences.
