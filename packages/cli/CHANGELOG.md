# @alimzen/relayo-cli

## 0.2.0

### Minor Changes

- 770a3b2: Live keys and templates: `relayo tail` follows events as they happen (`--requests`: the API request log), `send` takes `--template` and `--var` and asks for `--from` with live keys, and `relayo templates list|show|pull|push` keeps templates as files in your repository. `RELAYO_URL` and `RELAYO_API_KEY` work besides `RELAYO_SIM_*`.

## 0.1.0

### Minor Changes

- 2322924: New `@alimzen/relayo-cli` package with the `relayo` command for Relayo Sim: `scenarios`, `send`, `messages`, `show`, `wait` (wait for an event in CI, exit 1 on timeout) and `report` (text or markdown for GitHub job summaries).
