#!/usr/bin/env python3
"""Fetch daily closes for the benchmark menu's tickers from Yahoo Finance and
emit data/benchmarks.json for the chart overlays.

The site draws SPX by default and lets the reader switch the comparison to any
of the others (see SZ_BENCHES in Chrome.jsx, which owns the labels and colors;
this file owns only the closes). Keys here and there must match.

Accumulates: each run unions the fresh fetch into the closes already stored on
disk (fresh values win on overlap), so dates that age out of Yahoo's rolling
window are preserved. Without this the file would only ever hold a trailing
window, and once the chart's MAX range (backed by the growing NAV history, which
starts ~2025 and never loses its origin) outran that window, the oldest slice
would have no benchmark to regress against — beta/r² would silently degrade.
Accumulating keeps the benchmark span >= the NAV-history span forever.

Floored at HISTORY_FLOOR at the other end. The fetch asks for a decade so a run
missed for weeks still can't open a gap, but a decade × ten tickers is 830KB the
browser downloads before it can draw a chart whose oldest reachable point is the
NAV history's 2025 origin. The floor keeps a couple of years of slack under that
origin and drops the rest.

Emits the merged JSON to stdout (the workflow redirects it back over
data/benchmarks.json). A ticker whose fetch fails falls back to the closes
already on disk; if nothing fetched at all, or the default benchmark has no
series, this raises before any write so the caller keeps the previously
committed file intact.

Usage: python3 fetch-benchmarks.py > ../../data/benchmarks.json
Stdlib only.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

# Order here is the order the site's dropdown lists them in. `spx` is the
# default and the anchor for every "vs" statistic, so it is the one ticker
# whose absence is fatal (see main).
TICKERS = [
    ('spx', '^GSPC',   'SPX'),
    ('qqq', 'QQQ',     'QQQ'),
    ('vti', 'VTI',     'VTI'),
    ('iwm', 'IWM',     'IWM'),
    ('vt',  'VT',      'VT'),
    ('aor', 'AOR',     'AOR'),
    ('bnd', 'BND',     'BND'),
    ('tlt', 'TLT',     'TLT'),
    ('gld', 'GLD',     'GLD'),
    ('btc', 'BTC-USD', 'BTC'),
]
DEFAULT_KEY = 'spx'
# Earliest close worth storing. Must stay comfortably before the oldest date any
# chart can reach — that is nav-history.json's first row (~2025), not this file —
# so moving the site's history origin earlier means moving this too.
HISTORY_FLOOR = '2023-01-01'
UA = 'Mozilla/5.0 (compatible; suzerain-site-benchmarks)'

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'benchmarks.json'))


def pick_closes(result):
    """Adjusted closes where Yahoo offers them, raw closes otherwise.

    The menu now includes benchmarks whose return is mostly income rather than
    price — BND and TLT pay it as coupons, AOR holds those funds, VT/VTI/GLD's
    ETFs distribute — and a price-only line understates every one of them
    against a portfolio whose TWR already banks its dividends. Indices (^GSPC)
    have no adjclose to offer and are unaffected.
    """
    quote = result['indicators']['quote'][0]
    closes = list(quote['close'])
    adj = (result['indicators'].get('adjclose') or [{}])[0].get('adjclose')
    if adj and len(adj) == len(closes):
        return list(adj)
    return closes


def patch_last_close(result, stamps, closes):
    """Backfill a null close on the newest bar from meta.regularMarketPrice.

    Yahoo can serve the most recent *completed* daily bar with close (and
    adjclose) null while open/high/low/volume are populated and meta already
    carries that session's official close. Skipped as missing, the series stalls
    a day behind and every run rewrites only generatedAt — the failure looks like
    a healthy refresh, so it goes unnoticed.

    Only fires when the quote is not mid-session, so a live intraday tick is
    never written as a close. Next run's fetch wins on overlap anyway (see
    merge_series), so a value taken here is replaced once Yahoo fills the bar.

    meta carries an unadjusted price, but no distribution has gone ex since the
    newest bar by definition, so on that bar it equals the adjusted close
    pick_closes would have taken.
    """
    if not stamps or not closes or closes[-1] is not None:
        return
    meta = result.get('meta') or {}
    price, quoted_at = meta.get('regularMarketPrice'), meta.get('regularMarketTime')
    if price is None or quoted_at is None:
        return
    regular = ((meta.get('currentTradingPeriod') or {}).get('regular')) or {}
    start, end = regular.get('start'), regular.get('end')
    if start is not None and end is not None and start <= quoted_at < end:
        return                                   # session still open: live tick
    if (datetime.fromtimestamp(quoted_at, tz=timezone.utc).date()
            != datetime.fromtimestamp(stamps[-1], tz=timezone.utc).date()):
        return                                   # quote belongs to another day
    closes[-1] = price


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
    closes = pick_closes(result)
    patch_last_close(result, stamps, closes)
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
    return [{'d': d, 'v': merged[d]} for d in sorted(merged) if d >= HISTORY_FLOOR]


def main():
    stored = load_stored()
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'benchmarks': {},
    }
    # One ticker failing (a delisting, a symbol Yahoo starts refusing) must not
    # cost the other nine their refresh, so a failure falls back to whatever is
    # already on disk and only a key with neither fresh nor stored closes is
    # dropped — the site skips benchmarks the file doesn't carry.
    fetched = 0
    for key, symbol, label in TICKERS:
        try:
            fresh = fetch_series(symbol)
            fetched += 1
        except Exception as e:                   # noqa: BLE001 — any failure, same fallback
            print(f'{symbol}: fetch failed ({e}) — falling back to stored', file=sys.stderr)
            fresh = []
        series = merge_series(stored.get(key, {}), fresh)
        if not series:
            print(f'{symbol}: no closes, dropping', file=sys.stderr)
            continue
        out['benchmarks'][key] = {'label': label, 'series': series}
    # A total outage would otherwise rewrite the file with nothing but a newer
    # generatedAt, and losing the default benchmark takes every "vs" statistic
    # on the site with it. Either way: raise, keep the committed file.
    if not fetched:
        raise RuntimeError('no ticker fetched successfully')
    if DEFAULT_KEY not in out['benchmarks']:
        raise RuntimeError(f'default benchmark {DEFAULT_KEY!r} missing')
    json.dump(out, sys.stdout, separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
