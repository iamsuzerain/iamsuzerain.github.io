# IBKR Flex Query → `portfolio.json` (daily cron)

This directory contains everything needed to automatically refresh the Portfolio
page with your real IBKR account data, once a day, with zero manual intervention.

The data flow:

```
  IBKR Flex Web Service           GitHub Actions cron         your site
  ────────────────────           ───────────────────         ─────────
   Flex Query XML       ───>      fetch-ibkr.py       ───>   portfolio.json
   (positions, NAV,               runs 1×/day, parses          (committed +
    PnL, allocation)              XML, writes JSON              served static)
```

Nothing in the browser touches your IBKR token. The token lives in GitHub
Secrets; only the Action can read it.

---

## 1 — Create the Flex Query

1. Log into **Client Portal** at interactivebrokers.com.
2. Head-left menu → **Performance & Reports** → **Flex Queries**.
3. Click **Create Activity Flex Query**.
4. Give it a name: `site-portfolio-daily`.
5. Under **Sections**, enable exactly these — the names below match the Flex
   query builder verbatim, and each one maps to an element `fetch-ibkr.py`
   actually parses. Omit one and the corresponding block of `portfolio.json`
   silently degrades to zeros rather than erroring:

   | Section | Element parsed | Feeds |
   |---|---|---|
   | `Open Positions` | `OpenPosition` | positions, allocation |
   | `Net Asset Value (NAV) in Base` | `EquitySummaryByReportDateInBase` | NAV, cash, NAV series |
   | `Mark-to-Market Performance Summary in Base` | `MTMPerformanceSummaryUnderlying` | contribution, byAssetClass |
   | `Change in NAV` | `ChangeInNAV` | 1-year P&L and TWR |
   | `Cash Transactions` | `CashTransaction` | deposit/withdrawal adjustment |
   | `Cash Report` | `CashReportCurrency` | MTD/YTD net deposits |

   There is no section called "Equity Summary in Base" — an earlier version of
   this document said there was. The `EquitySummary*` elements come from
   **Net Asset Value (NAV) in Base**.
6. **Delivery Configuration** — Format: `XML`. Period: `Last Business Day`
   (or `Month to Date` if you want a longer NAV series per call).
7. Save. Note the **Query ID** — a number like `123456`.

## 2 — Generate the Flex Web Service token

1. Same menu — **Settings** → **Account Settings** → scroll to **Reporting** →
   **FlexWeb Service**.
2. Click **Configure** and enable the service.
3. Generate a new **token**. It's a long string. Save it to a password manager —
   GitHub will not show a secret's value back to you once stored, so the copy you
   keep is the only readable one you control.

   An earlier version of this said IBKR shows the token exactly once. It does
   not: the Flex Queries page displays the current token, so a value that is
   only "lost" from your own notes can be read straight off that page. Worth
   knowing before regenerating, because generating a new token can invalidate
   the working one and silently break the daily refresh.
4. Keep it secret. This token allows anyone to download your full portfolio.

## 3 — Wire up GitHub Actions

Assuming your site is a repo on GitHub:

1. Copy `fetch-ibkr.py` to `scripts/fetch-ibkr.py` in the repo.
2. Copy `.github/workflows/portfolio-refresh.yml` into the repo.
3. Go to repo **Settings → Secrets and variables → Actions** and add:
   - `IBKR_FLEX_TOKEN` — the token from step 2
   - `IBKR_FLEX_QUERY_ID` — the number from step 1
4. Commit + push. The workflow runs daily at **22:00 UTC** (~6pm ET, after the
   US market close). You can also trigger it manually from the Actions tab.
5. On success, it commits `ui_kits/personal_site/data/portfolio.json` back
   to the repo. Your site picks up the new file on next page load.

---

## 4 — Running it locally (optional)

```bash
export IBKR_FLEX_TOKEN='...'
export IBKR_FLEX_QUERY_ID='123456'
python3 scripts/fetch-ibkr.py > ui_kits/personal_site/data/portfolio.json
```

The script has no dependencies beyond the Python stdlib.

`--from-file PATH` reads a statement off disk instead of calling the API — point
it at a decrypted, gunzipped copy out of the archive to re-run a past day without
burning a Flex request.

### Reconciling the flow sources

Three different deposit/withdrawal figures feed this page, and they do not agree:

| | source | drives |
|---|---|---|
| CT | `CashTransaction` rows, deduped | `perfSeries`, `pnlSeries` — the chart |
| ES | `EquitySummaryByReportDateInBase@depositsWithdrawals` | nothing today; fallback only |
| CIN | `ChangeInNAV@depositsWithdrawals` | the `1y` stat tile |

CT and CIN currently land **exactly $2,000.00 apart** on every snapshot in the
repo, back to 2026-07-24. `Portfolio.jsx` hides the endpoint gap with a ratio
(`pfAnchorDollars`), which spreads a fixed dollar error across all 262 points and
contaminates every shorter window along the way.

`--reconcile-flows` prints all three totals, the per-day CT-vs-ES comparison that
localizes the gap to a date, and a pre-dedup breakdown of the CT rows by currency:

```bash
python3 scripts/ibkr-flex/fetch-ibkr.py --reconcile-flows > /dev/null
```

Read it as a decision tree:

- **ES == CIN, CT differs** → the bug is ours, in `build_cash_flows`. The dedup key
  is `date|type|amount`, so the BASE and native copies of a *non-base-currency*
  movement carry different amounts, neither is suppressed, and the flow is counted
  twice. A currency other than USD in the breakdown is the tell.
- **ES == CT, CIN differs** → IBKR books the movement somewhere other than
  `depositsWithdrawals` (internal transfer, position transfer), and the `1y` tile
  is the odd one out.

**Do not wire this into the workflow.** It prints per-date cash movements, which is
exactly the metadata the archive was moved to a private repo to stop publishing —
and Actions logs on a public repo are world readable. The report goes to stderr and
stdout stays clean JSON, so the flag is safe to add to an existing pipe locally.

### The canary (always on, including CI)

Every run prints one line to stderr, which the Actions log picks up:

```
flow-sources: CT!=ES ES==CIN CT!=CIN -> suspect build_cash_flows (currency dedup)
```

Three equality flags and a verdict — **no amounts, no dates, no transaction
counts** — which is what makes it safe to publish where the full report is not.
`CT?CIN` means the statement carried no `ChangeInNAV` to compare against.

Its value is that it watches a constant. The CT/CIN gap has been a flat $2,000.00
on every snapshot since 2026-07-24, so the event worth catching is the day that
*changes* — the gap closing, or a second one opening on top of it. Nothing else in
the pipeline would notice.

No workflow change was needed: `run:` steps already send stderr to the log, and
stdout is redirected into `portfolio.json`.

---

## 5 — What the Flex API actually returns

IBKR returns XML. A skeleton looks like:

```xml
<FlexQueryResponse queryName="site-portfolio-daily" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U1234567" fromDate="2026-04-23" toDate="2026-04-23">
      <EquitySummaryInBase>
        <EquitySummaryByReportDateInBase
          total="184720.44" cash="12480.12" stock="172240.32" ... />
      </EquitySummaryInBase>
      <OpenPositions>
        <OpenPosition symbol="NVDA" position="120" markPrice="207.00"
          positionValue="24840.00" costBasisMoney="12600.00"
          fifoPnlUnrealized="12240.00" ... />
        ...
      </OpenPositions>
      <MTMPerformanceSummaryInBase>
        <MTMPerformanceSummaryUnderlying ... />
      </MTMPerformanceSummaryInBase>
      <ChangeInNAV>
        <ChangeInNAVByPeriod fromDate="..." toDate="..."
          startingValue="120000" endingValue="184720.44" ... />
      </ChangeInNAV>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>
```

`fetch-ibkr.py` walks that tree and emits the JSON shape the Portfolio view
expects — see `../data/portfolio.json` for the contract.

---

## 5a — What the stat tiles mean

Each of the four tiles carries a dollar/percent pair, and they are **not two
views of one number** — `abs / pct` will not reproduce the opening NAV.

| | quantity | built by |
|---|---|---|
| `abs` | deposit-adjusted dollar P&L over the period: `(end − start) − net flows` | `adjusted_pnl()` |
| `pct` | chained daily TWR over the same period | `period_twr()` |

They answer different questions — how much money the period made, and how each
dollar performed while it was in the account — and on a book whose size moves,
the answers diverge hard. With $228k withdrawn during 2026 the ytd tile read
**+37.98%** while the chart drew **+43.45%**; both were correct under their own
definition, which is exactly the problem.

Before 2026-08, `pct` was `abs / start_nav` — dollar P&L over the NAV the period
opened on. TWR is what the risk block, the alpha strip and every benchmark
overlay were already computed on; the tiles were the last thing on the page still
dividing by a fixed denominator, and the chart never agreed with them. `1y` had a
third definition on top of that: IBKR's own `ChangeInNAV@twr`, which runs ~40bp
off our daily chain because IBKR weights flows intraday and we chain on closes.
All four are now the same chained return the chart draws.

**Periods are named off the statement's last row, never the wall clock**
(`period_bounds()`). Chrome.jsx's `szRangeCutoff` makes the same demand for the
same reason: statements lag up to 24h, so on the first day of any month, quarter
or year the two would otherwise disagree about which period they are describing.
A run on 1 January against a 31 December statement would compute a ytd that has
not started yet.

---

## 6 — Gotchas

- **First request takes ~30–60s.** IBKR's Flex service renders the report on
  demand. The script calls `SendRequest` to kick it off, sleeps, then polls
  `GetStatement` up to 5 times.
- **Rate-limited to ~1 request per minute** per query. Don't cron more
  aggressively than that.
- **Tokens expire.** IBKR rotates them every ~1 year. If the workflow starts
  failing with `1003` or `1012` error codes, regenerate the token.
- **Market data fields may be blank** outside regular trading hours. Schedule
  the cron for after 16:30 ET to be safe.
- **NAV time series** needs a Flex period of at least `Month to Date`, ideally
  `Year to Date` or `Last 365 Calendar Days`. Shorter periods give a short
  sparkline.

---

## 7 — Raw statement archive (lives in the private warehouse repo)

`portfolio.json` is a **lossy projection** of the Flex statement: 17 summarized
positions and a per-underlying roll-up, discarding every trade row and every
option leg's strike, expiry, right, and multiplier. IBKR's Flex window is a
rolling ~365 days, so a statement not captured on the day it is served is gone.
That is why `merge-nav-history.py` exists — it stitches the one series that would
otherwise age out.

**The archive is not in this repo, and nothing here touches it.** It runs in the
private [`iamsuzerain/warehouse`](https://github.com/iamsuzerain/warehouse)
repo, which has its own daily workflow, its own narrow Flex query, and its own
setup instructions. See that repo's README.

### Why it is not here

Not because this repo is public in itself — the site publishes NAV and holdings
at `/data/portfolio.json` deliberately, so repo visibility was never the
boundary. What the raw statement adds over that is the part worth protecting:
the **unmasked account id**, every cash transaction, the full trade history, and
every position rather than the top 20.

The deciding factor was that a public repo has **public Actions logs**. While the
archive job ran here, every line it printed was a publishing decision, and a byte
count echoed to the log leaked a proxy for position count and activity before
anyone noticed. Censoring log lines treats the symptom. Moving the job to a
private repo fixes the cause, and removes the cross-repo access token as a bonus.

### What stays here

This script and its wide Flex query, feeding `portfolio.json` and the NAV series
— all of it published on purpose. The archive query is a **separate** Flex query
scoped to `Last Business Day`; the two do not share an id, and only the site one
belongs in this repo's secrets.
