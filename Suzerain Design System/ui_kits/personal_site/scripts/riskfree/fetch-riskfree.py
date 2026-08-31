#!/usr/bin/env python3
"""Fetch the effective federal funds rate from the New York Fed and emit
data/riskfree.json — the risk-free leg of every Sharpe and Sortino on the site.

Those figures used to assume rf = 0. That was defensible while the numerator was
a ~50% annual return, and indefensible as a permanent stance: cash paid 5.33% for
most of 2023-24 and still pays over 3.5%, so a zero-rf Sharpe credits the book
with a few tenths it did not earn — and, worse, moves when the Fed moves without
the ratio noticing. A rate the reader can look up beats a convenient constant.

Source is the NY Fed's own reference-rate API rather than FRED's DFF mirror:
same numbers, one hop closer, no key, and it publishes the target band alongside
the realized rate. EFFR lands the business day after the day it describes, so the
newest row here is typically T-1 — which is also the vintage of the Flex
statement the Sharpe is computed over, so the two line up.

Rows are business days only. Consumers forward-fill: the rate that was in force
on the Friday is the rate cash earned across the weekend, which is why the
accrual is done over calendar days at the last published rate (see szRfSteps in
Chrome.jsx and rf_steps in scripts/ibkr-flex/fetch-ibkr.py — the two must agree).

Accumulates into whatever is already on disk (fresh values win on overlap), for
the same reason fetch-benchmarks.py does: the file has to keep covering the whole
span the MAX range can reach, however the upstream window moves.

Emits the merged JSON to stdout (the workflow redirects it back over
data/riskfree.json). Raises before printing anything if the fetch produced no
usable rows and nothing is on disk, so a bad run leaves the committed file alone.

Usage: python3 fetch-riskfree.py > ../../data/riskfree.json
Stdlib only.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

API = ("https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json"
       "?startDate={start}&endDate={end}&type=rate")
# Same floor as the benchmark closes, and for the same reason: comfortably before
# nav-history.json's ~2025 origin, with no interest in the decades before it.
HISTORY_FLOOR = '2023-01-01'
UA = 'Mozilla/5.0 (compatible; suzerain-site-riskfree)'

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'riskfree.json'))


def load_store():
    """Rows already committed, as {date: percent}. Missing/corrupt file → {}."""
    try:
        with open(STORE, 'r', encoding='utf-8') as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return {}
    return {r['d']: r['v'] for r in (doc.get('series') or [])
            if r.get('d') and isinstance(r.get('v'), (int, float))}


def fetch_effr():
    """{date: percent} for every EFFR publication from the floor to today."""
    # A day of slack on the end: the API is fine with a future end date, and this
    # way a run near a UTC boundary can't ask for a window that excludes the row
    # it is running to collect.
    end = (datetime.now(timezone.utc) + timedelta(days=1)).strftime('%Y-%m-%d')
    url = API.format(start=HISTORY_FLOOR, end=end)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        doc = json.load(r)

    out = {}
    for row in doc.get('refRates') or []:
        if row.get('type') != 'EFFR':
            continue
        d, v = row.get('effectiveDate'), row.get('percentRate')
        # percentRate is null on days the Fed publishes the row but not the rate
        # (it has happened around holidays); those dates simply stay unpublished
        # and the forward-fill on the reading side covers them.
        if d and isinstance(v, (int, float)):
            out[d] = float(v)
    return out


def main():
    stored = load_store()
    try:
        fresh = fetch_effr()
    except Exception as e:                      # noqa: BLE001 — best effort
        print(f'EFFR fetch failed: {e}', file=sys.stderr)
        fresh = {}

    merged = dict(stored)
    merged.update(fresh)                        # fresh wins on overlap (revisions)
    merged = {d: v for d, v in merged.items() if d >= HISTORY_FLOOR}
    if not merged:
        raise SystemExit('no EFFR rows fetched and none on disk — refusing to write')

    series = [{'d': d, 'v': round(v, 4)} for d, v in sorted(merged.items())]
    print(f'EFFR: {len(series)} rows, {series[0]["d"]} to {series[-1]["d"]}, '
          f'last {series[-1]["v"]}%', file=sys.stderr)

    json.dump({
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'newyorkfed.org EFFR (effective federal funds rate)',
        'unit': 'percent-annual',
        'series': series,
    }, sys.stdout, separators=(',', ':'))
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
