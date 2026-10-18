# @alimzen/cli

The `relayo` command, for [Relayo Sim](https://github.com/Alimzen/relayo/tree/main/packages/simulator), the email delivery simulator: send test emails, read their timelines, and **wait in CI for the bounce, complaint or delivery your code must handle**.

```sh
npm install --save-dev @alimzen/cli   # then: npx relayo --help
npx @alimzen/cli --help                # or run it without installing
```

Node 20+. No dependencies.

## Configuration

| Flag | Environment | |
| --- | --- | --- |
| `--url` | `RELAYO_SIM_URL` | Base URL of Relayo Sim |
| `--api-key` | `RELAYO_SIM_API_KEY` | API key of a project |

These are the same variables the [`@alimzen/simulator`](https://www.npmjs.com/package/@alimzen/simulator) driver documents, so one set of variables serves your app and the CLI.

## Commands

```sh
relayo scenarios                                   # scenarios and an example address for each
relayo send --to hard-bounce@sim.relayo.dev        # prints the message id
relayo messages --status bounced --since 1h        # latest messages with their status
relayo show sim_8c1…                               # one message, with its timeline per recipient
relayo wait sim_8c1… --for bounced:hard            # waits for the event; exit 1 on timeout
relayo wait --search "Your invoice" --for delivered --timeout 2m
relayo report --since 1h --format markdown         # summary for a CI job
```

Every command takes `--json`. `wait` checks every second (`--interval`) for 60 seconds (`--timeout`); `--for` takes an event type (`accepted`, `delivered`, `deferred`, `bounced`, `complained`, `rejected`, `opened`, `clicked`, `unsubscribed`) and, for bounces, a type: `bounced:hard`, `bounced:soft`, `bounced:block`. `--since` takes an ISO date or a duration back from now (`30s`, `15m`, `2h`, `1d`).

Exit codes: `0` ok, `1` an expectation was not met (`wait` timed out), `2` wrong usage or missing configuration, `3` the API answered with an error.

## In CI

Your test suite sends email to the simulator (through `@alimzen/simulator` or SMTP) and then asserts the outcome:

```sh
id=$(relayo send --to hard-bounce@sim.relayo.dev --subject "Welcome")
relayo wait "$id" --for bounced:hard
```

On GitHub, the [Relayo Sim action](https://github.com/Alimzen/relayo/tree/main/actions/sim) exports the configuration and writes a job summary of every email the job sent.

## Programmatic use

```ts
import { run, SimClient } from '@alimzen/cli';

const sim = new SimClient(process.env.RELAYO_SIM_URL!, process.env.RELAYO_SIM_API_KEY!);
const message = await sim.message('sim_8c1…');
```

## License

MIT
