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
3. Generate a new **token**. It's a long string. **Copy it now** — IBKR shows it
   exactly once.
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
