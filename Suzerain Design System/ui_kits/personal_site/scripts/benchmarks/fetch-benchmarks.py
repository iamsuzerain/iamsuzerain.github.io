#!/usr/bin/env python3
"""Fetch daily closes for benchmark tickers (S&P 500 + VT) from Yahoo Finance
and emit data/benchmarks.json for the portfolio chart overlay.

Accumulates: each run unions the fresh fetch into the closes already stored on
disk (fresh values win on overlap), so dates that age out of Yahoo's rolling
window are preserved. Without this the file would only ever hold a trailing
window, and once the chart's MAX range (backed by the growing NAV history, which
starts ~2025 and never loses its origin) outran that window, the oldest slice
would have no benchmark to regress against — beta/r² would silently degrade.
Accumulating keeps the benchmark span >= the NAV-history span forever.

Emits the merged JSON to stdout (the workflow redirects it back over
data/benchmarks.json). A failed/short fetch raises before any write, so the
caller keeps the previously committed file intact.

Usage: python3 fetch-benchmarks.py > ../../data/benchmarks.json
Stdlib only.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

TICKERS = [
    ('spx', '^GSPC', 'SPX'),
    ('vt', 'VT', 'VT'),
]
UA = 'Mozilla/5.0 (compatible; suzerain-site-benchmarks)'

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'benchmarks.json'))


def fetch_series(symbol):
    # 10y of daily closes: the largest Yahoo range that still returns daily
    # granularity (`max` downgrades to quarterly). A decade is a generous overlap
    # against the stored history, so a run missed for days/weeks never opens a gap
    # — and because we accumulate, coverage only ever grows past this window.
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/'
           f'{urllib.request.quote(symbol)}?range=10y&interval=1d')
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.load(r)
    result = payload['chart']['result'][0]
    stamps = result['timestamp']
    closes = result['indicators']['quote'][0]['close']
    series = []
    for t, c in zip(stamps, closes):
        if c is None:
            continue
        d = datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()
        series.append({'d': d, 'v': round(c, 4)})
    if len(series) < 50:
        raise ValueError(f'{symbol}: only {len(series)} usable points')
    return series


def load_stored():
    """Best-effort read of the committed benchmarks.json → {key: {d: v}}."""
    try:
        with open(STORE, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError):
        return {}
    out = {}
    for key, b in (data.get('benchmarks') or {}).items():
        out[key] = {row['d']: row['v'] for row in (b.get('series') or []) if row.get('d')}
    return out


def merge_series(stored_closes, fresh):
    """Union stored + fresh daily closes by date; fresh wins on overlap (picks up
    Yahoo revisions). Closes are absolute index levels, so no rebasing is needed —
    the chart samples/rebases by date at render time."""
    merged = dict(stored_closes)                 # dates that aged out of the fetch
    for row in fresh:                            # recent dates (authoritative)
        merged[row['d']] = row['v']
    return [{'d': d, 'v': merged[d]} for d in sorted(merged)]


def main():
    stored = load_stored()
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'benchmarks': {},
    }
    for key, symbol, label in TICKERS:
        fresh = fetch_series(symbol)             # raises on failure → nothing written
        series = merge_series(stored.get(key, {}), fresh)
        out['benchmarks'][key] = {'label': label, 'series': series}
    json.dump(out, sys.stdout, separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
