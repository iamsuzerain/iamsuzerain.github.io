# Canaries

Four checks across the data pipeline. None of them knows what the right number
is; each one watches a relationship that should hold whatever the right number
turns out to be, and says so when it stops holding.

That distinction is the whole design. A snapshot test over these fetchers would
freeze whatever they emit today, bug included — snapshot `polymarket-breakdown.json`
the day before redemptions were priced from their payout and the test locks
`price: 0` on every winning redemption into a permanent pass. What catches a bug
blind is redundancy the sources already contain: two readings of the same
quantity, an accounting identity, or yesterday's copy of the same file.

| check | lives in | watches | on failure |
|---|---|---|---|
| `flow-sources:` | `ibkr-flex/fetch-ibkr.py` | CT, ES and CIN agree on the window's deposits | reports |
| `flow-coverage:` | `ibkr-flex/fetch-ibkr.py` | the TWR has flows to adjust by | **stops the run** |
| `positions-sources:` | `betmoar-breakdown/fetch-betmoar-breakdown.py` | polymarket `/positions` and betmoar `portfolioValue` describe the same book | reports |
| `continuity` | `canary/continuity.py` | today's file against the copy in git HEAD | reports; stops on dates duplicated or out of order |

All four print one line to stderr, so the Actions log picks them up and stdout
stays clean JSON. All four are written to be safe in a world-readable log:
equality flags, counts and percentages, never amounts or per-date values. That
is the constraint that keeps `--reconcile-flows` local-only, and it applies here
for the same reason.

## Why three of them only report

A stated disagreement is better than a missing day. If `/positions` and betmoar
diverge, `/positions` is still the better source and is still the one used — the
run should publish and say what it saw. The reader's job is to notice a line
that changed, which is why these stay quiet on an ordinary day: a canary that
cries every morning is one you stop hearing by the end of the first week.

Tuning them to stay quiet was most of the work, and the module docstring in
`continuity.py` records what had to be absorbed — a TWR chain whose last stored
digit moves on half the file every rebuild, and rolling windows that shed their
oldest row by design.

## Why one of them stops the run

`flow_coverage` guards a failure that publishes as a clean number. Both
`build_perf_series` and `build_pnl_series` fall back to EquitySummary's
`depositsWithdrawals` when `build_cash_flows` returns nothing, and on this
site's Flex query that column reads 0.00 on every row — so the fallback does not
supply the flows, it supplies zero, and every deposit is chained into the curve
as performance. A $100k transfer into a $700k book prints as +14.3% for the day,
permanently, with no error.

Nothing else in the pipeline can see that afterwards. The number is plausible,
the JSON is valid, the chart renders. So this one refuses rather than reports,
and it separates a statement with no transfers (ordinary) from a statement whose
CashTransaction section is missing (not) — see its docstring.

## Running them

The three in the fetchers are always on, including in CI. Continuity runs as its
own workflow step before each `commit + push if changed`, so a file that fails it
is not published:

```bash
cd "Suzerain Design System/ui_kits/personal_site"
python3 scripts/canary/continuity.py data/portfolio.json data/nav-history.json
python3 scripts/canary/continuity.py --warn-only data/*.json   # never exits nonzero
```

It compares against `HEAD`, so run it before staging — once a file is committed
it is its own baseline and every check reads clean.
