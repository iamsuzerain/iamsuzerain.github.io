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
summarized positions and a per-underlying contribution roll-up; it discards every
trade row, and every option leg's strike, expiry, right, and multiplier. IBKR's
Flex window is a rolling ~365 days, so a statement not captured on the day it is
served is gone for good.

That is why `merge-nav-history.py` exists — it stitches the one series that would
otherwise age out. The archive generalizes that: bank the untransformed XML
daily, and questions needing trade- or leg-level history (DTE drift,
delta-reduction cost per unit of exposure, vega by underlying over months) become
answerable later instead of never.

### Where it lives, and why not here

The archive goes to the **private** repo `iamsuzerain/warehouse`, not this one.

This repo is public and `deploy-pages` uploads the whole `personal_site`
directory. Raw Flex XML carries the unmasked account id, every position, and
every cash transaction — exactly what `mask_account()` strips before anything
reaches the site. Encryption alone would not have been enough:

- **Public commits are permanent and mirrored.** A key leak or crypto break
  later would expose every historical statement retroactively, and there is no
  un-publishing a forked or archived repo.
- **Metadata leaks through the encryption.** Filenames publish which trading days
  exist; blob sizes proxy position count and activity.
- **Ciphertext does not delta-compress.** Each day is a fresh full blob in a repo
  every Pages deploy checks out — hundreds of MB a year of data the site never
  reads.

GitHub Actions artifacts are not an alternative either: on a public repo, anyone
can download a run's artifacts.

It is still encrypted inside the private repo — AES-256, PBKDF2, 600k iterations.
That is defence in depth: an accidental visibility flip or a leaked read-only
token stops being a disclosure on its own.

### Two queries, on purpose

| Query | Period | Feeds | Secret |
|---|---|---|---|
| site | ~365 days | `portfolio.json`, NAV series | `IBKR_FLEX_QUERY_ID` |
| archive | **Last Business Day** | the warehouse | `IBKR_FLEX_ARCHIVE_QUERY_ID` |

Archiving the wide query daily would re-store a year of already-archived history
on every run, in blobs git cannot delta. The narrow query accumulates the same
information over time at a fraction of the bytes.

Build the archive query exactly like section 1, but set **Period: Last Business
Day**, and enable `Trades` and `Open Positions` with the full contract fields
(`underlyingSymbol`, `strike`, `expiry`, `putCall`, `multiplier`) — those are the
fields the whole exercise is for.

### Setup

1. Create the archive Flex Query (above). Note its id.
2. Generate a passphrase and **store it in a password manager**. If it is lost
   the archive is unreadable; there is no recovery path.
   ```
   openssl rand -base64 32
   ```
3. Create a **fine-grained personal access token** scoped to
   `iamsuzerain/warehouse` only, with `Contents: read and write`.
4. Add three repo secrets to *this* repo
   (**Settings → Secrets and variables → Actions**):

   | Secret | Value |
   |---|---|
   | `IBKR_FLEX_ARCHIVE_QUERY_ID` | id from step 1 |
   | `IBKR_FLEX_ARCHIVE_KEY` | passphrase from step 2 |
   | `WAREHOUSE_TOKEN` | token from step 3 |

Until all three exist the workflow still refreshes the site but archives nothing
and emits a red `::error::` annotation on every run. Deliberately not a hard
failure — breaking the daily refresh over missing archive plumbing would trade a
visible problem for a worse one.

The token expires (a year at most for fine-grained PATs). When it does, the
archive stops silently apart from that annotation — worth a calendar reminder.

### Reading the archive back

```
git clone git@github.com:iamsuzerain/warehouse.git
export IBKR_FLEX_ARCHIVE_KEY='...'
export WAREHOUSE_DIR="$PWD/warehouse/flex-raw"
./decrypt-raw.sh /tmp/flex                    # whole archive
./decrypt-raw.sh /tmp/flex path/to/one.enc    # one statement
zcat /tmp/flex/flex-<qid>-<date>.xml.gz
```

Decrypt to a path **outside both repos**. `decrypt-raw.sh` verifies gzip
integrity after decrypting, so a wrong key fails loudly rather than emitting
garbage.

### Local runs

`fetch-ibkr.py` archives only when `IBKR_FLEX_RAW_DIR` is set, and writes
plaintext. On a private machine that is fine:

```
IBKR_FLEX_RAW_DIR=~/flex-archive python3 fetch-ibkr.py --archive-only
```

`--archive-only` skips the transform, which the narrow archive statement would
fail anyway — it has no NAV series and no `ChangeInNAV`.

### Behavior worth knowing

- **First capture of a day wins.** `openssl` salts every invocation, so the same
  statement encrypted twice is two different blobs. The workflow skips a date
  already present rather than banking a duplicate.
- **Named by the statement's `toDate`**, not the wall clock, so a late or
  hand-dispatched run lands on the trading day it describes.
- **Push retries by re-cloning** up to 3 times. Two runs can overlap; re-cloning
  picks up whatever landed and dedupes against it.
