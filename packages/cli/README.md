# @alimzen/relayo-cli

The `relayo` command, for [Relayo](https://relayo.alimzen.com) (hosted or [your own](https://github.com/Alimzen/relayo-sim)): with a test key (`rly_test_…`) it drives the delivery simulator — send test emails, read their timelines, and **wait in CI for the bounce, complaint or delivery your code must handle** —; with a live key (`rly_live_…`) it sends for real, follows events as they arrive and keeps your templates in your repository.

```sh
npm install --save-dev @alimzen/relayo-cli   # then: npx relayo --help
npx @alimzen/relayo-cli --help                # or run it without installing
```

Node 20+. No dependencies.

## Configuration

| Flag | Environment | |
| --- | --- | --- |
| `--url` | `RELAYO_URL` (or `RELAYO_SIM_URL`) | Base URL: `https://relayo.alimzen.com`, or your installation |
| `--api-key` | `RELAYO_API_KEY` (or `RELAYO_SIM_API_KEY`) | API key of a project: `rly_test_…` or `rly_live_…` |

There is no default URL: the key only goes where you say. `RELAYO_SIM_*` are the variables the [`@alimzen/relayo-simulator`](https://www.npmjs.com/package/@alimzen/relayo-simulator) driver documents, so one set serves your app and the CLI.

## Commands

```sh
relayo scenarios                                   # scenarios and an example address for each
relayo send --to hard-bounce@sim.relayo.dev        # prints the message id
relayo messages --status bounced --since 1h        # latest messages with their status
relayo show sim_8c1…                               # one message, with its timeline per recipient
relayo wait sim_8c1… --for bounced:hard            # waits for the event; exit 1 on timeout
relayo wait --search "Your invoice" --for delivered --timeout 2m
relayo report --since 1h --format markdown         # summary for a CI job

relayo tail                                        # each event as it happens (Ctrl+C to stop)
relayo tail --requests                             # each request made with the project's keys
relayo send --to ana@cliente.com --from hola@tuempresa.com --template bienvenida --var nombre=Ana
relayo templates list
relayo templates pull bienvenida --dir emails/     # emails/bienvenida.json + .html
relayo templates push emails/bienvenida.json       # creates or updates it from the files
```

With a live key, `send` delivers for real, so `--from` is required. `--var name=value` fills the template's variables (numbers, `true` and JSON are parsed). `templates push` takes the HTML from the `.html` next to the `.json` (or `--html-file`): keep your templates in the repository and push them in CI, and their content changes without deploying your app.

Every command takes `--json`. `wait` checks every second (`--interval`) for 60 seconds (`--timeout`); `--for` takes an event type (`accepted`, `delivered`, `deferred`, `bounced`, `complained`, `rejected`, `opened`, `clicked`, `unsubscribed`) and, for bounces, a type: `bounced:hard`, `bounced:soft`, `bounced:block`. `--since` takes an ISO date or a duration back from now (`30s`, `15m`, `2h`, `1d`).

Exit codes: `0` ok, `1` an expectation was not met (`wait` timed out), `2` wrong usage or missing configuration, `3` the API answered with an error.

## In CI

Your test suite sends email to the simulator (through `@alimzen/relayo-simulator` or SMTP) and then asserts the outcome:

```sh
id=$(relayo send --to hard-bounce@sim.relayo.dev --subject "Welcome")
relayo wait "$id" --for bounced:hard
```

On GitHub, the [Relayo Sim action](https://github.com/Alimzen/relayo/tree/main/actions/sim) exports the configuration and writes a job summary of every email the job sent.

## Programmatic use

```ts
import { run, SimClient } from '@alimzen/relayo-cli';

const sim = new SimClient(process.env.RELAYO_SIM_URL!, process.env.RELAYO_SIM_API_KEY!);
const message = await sim.message('sim_8c1…');
```

## License

MIT
