# Relayo Sim action

Runs your tests against [Relayo Sim](https://github.com/Alimzen/relayo/tree/main/packages/simulator), the email delivery simulator, and adds a summary of every email the job sent to the run page.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22

      # Exports RELAYO_SIM_URL, RELAYO_SIM_API_KEY and RELAYO_SIM_SINCE, and checks the key works.
      - uses: Alimzen/relayo/actions/sim@main
        with:
          url: ${{ vars.RELAYO_SIM_URL }}
          api-key: ${{ secrets.RELAYO_SIM_API_KEY }}

      # Your tests send email through the simulator driver, which reads the same variables.
      - run: npm test

      # Assert outcomes from the shell too, if you like.
      - run: npx @alimzen/relayo-cli wait --search "Welcome" --for delivered

      # Summary of what happened to every email sent since "start", even when tests fail.
      - uses: Alimzen/relayo/actions/sim@main
        if: always()
        with:
          step: report
```

## Inputs

| Input | | |
| --- | --- | --- |
| `step` | `start` (default) or `report` | |
| `url` | Base URL of Relayo Sim | Needed for `start` |
| `api-key` | API key of the project | Needed for `start`; keep it in a secret. It is masked in logs. |
| `cli-version` | Version of [`@alimzen/relayo-cli`](https://www.npmjs.com/package/@alimzen/relayo-cli) (the `relayo` command) to run | Default `0` (latest 0.x) |

`start` fails the job with a clear message when the simulator cannot be reached or the key is wrong, before your tests waste time on it.

Pin the action to a commit (`Alimzen/relayo/actions/sim@<sha>`) for reproducible builds.
