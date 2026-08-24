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
5. Under **Sections**, enable at minimum:
   - `Open Positions` (symbol, qty, markPrice, positionValue, costBasis, fifoPnlUnrealized)
   - `Net Asset Value in Base` (total, cash, stock, etc.)
   - `Equity Summary in Base` (for buying power + cash balances)
   - `MTM Performance Summary in Base` (for day/MTD/YTD PnL)
   - `Change in NAV` (for the NAV time-series)
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

## 7 — Raw statement archive (required for anything cross-statement)

`portfolio.json` is a **lossy projection** of the Flex statement. It keeps 17
summarized positions and a per-underlying contribution roll-up; it discards
every trade row, and every option leg's strike, expiry, right, and multiplier.
IBKR's Flex window is a rolling ~365 days, so a statement that is not captured
on the day it is served is gone for good.

That is why `merge-nav-history.py` exists — it stitches the one series that
would otherwise age out. The archive generalizes that: bank the untransformed
XML daily, and questions that need trade-level or leg-level history (DTE drift,
delta-reduction cost per unit of exposure, vega by underlying over months)
become answerable later instead of never.

### Why it is encrypted

**This repo is public**, and `deploy-pages` uploads the whole `personal_site`
directory. Raw Flex XML carries the unmasked account id, every position, and
every cash transaction — exactly what `mask_account()` strips before anything
reaches the site. Committing it in the clear would publish all of it, in git
history, permanently.

GitHub Actions artifacts are *not* an alternative: on a public repo, anyone can
download a run's artifacts.

So the workflow stages plaintext on the runner's temp disk, encrypts it with
AES-256 (PBKDF2, 600k iterations), and commits only ciphertext under
`warehouse/flex-raw/`. The root `.gitignore` refuses plaintext `*.xml.gz`
anywhere in the tree as a second line of defence.

### Setup — one secret, and the archive starts filling

1. Generate a strong passphrase and **store it in a password manager**. If it is
   lost the archive is unreadable; there is no recovery path.

   ```
   openssl rand -base64 32
   ```

2. Add it as a repo secret named `IBKR_FLEX_ARCHIVE_KEY`
   (**Settings → Secrets and variables → Actions**).

Until that secret exists the workflow still refreshes the site, but emits a red
`::error::` annotation on every run and archives nothing. It is deliberately not
a hard failure — breaking the daily refresh over a missing archive key would
trade a visible problem for a worse one.

### Reading the archive back

```
IBKR_FLEX_ARCHIVE_KEY='...' ./decrypt-raw.sh /tmp/flex        # whole archive
IBKR_FLEX_ARCHIVE_KEY='...' ./decrypt-raw.sh /tmp/flex F.enc  # one statement
zcat /tmp/flex/flex-<qid>-<date>.xml.gz
```

Decrypt to a path **outside the repo**. `decrypt-raw.sh` verifies gzip integrity
after decrypting, so a wrong key fails loudly rather than emitting garbage.

### Local runs

`fetch-ibkr.py` archives only when `IBKR_FLEX_RAW_DIR` is set, and writes
plaintext. On a private machine that is fine and convenient:

```
IBKR_FLEX_RAW_DIR=~/flex-archive python3 fetch-ibkr.py > /dev/null
```

### Still missing

The Flex query itself must be widened before the archive is worth much: it
needs the **Trades** section and the full option contract fields
(`underlyingSymbol`, `strike`, `expiry`, `putCall`, `multiplier`) on
`Open Positions`. Archiving today's narrower statement is still strictly better
than not archiving — the statement is unrecoverable either way, and a widened
query cannot backfill days already lost.
