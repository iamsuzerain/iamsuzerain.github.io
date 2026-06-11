#!/usr/bin/env python3
"""Fetch daily closes for benchmark tickers (S&P 500 + VT) from Yahoo Finance
and emit data/benchmarks.json for the portfolio chart overlay.

Usage: python3 fetch-benchmarks.py > ../../data/benchmarks.json
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone

TICKERS = [
    ('spx', '^GSPC', 'SPX'),
    ('vt', 'VT', 'VT'),
]
UA = 'Mozilla/5.0 (compatible; suzerain-site-benchmarks)'


def fetch_series(symbol):
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/'
           f'{urllib.request.quote(symbol)}?range=1y&interval=1d')
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


def main():
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'benchmarks': {},
    }
    for key, symbol, label in TICKERS:
        out['benchmarks'][key] = {'label': label, 'series': fetch_series(symbol)}
    json.dump(out, sys.stdout, separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
