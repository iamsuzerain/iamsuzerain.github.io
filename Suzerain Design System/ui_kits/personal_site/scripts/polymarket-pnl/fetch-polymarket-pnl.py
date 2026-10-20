#!/usr/bin/env python3
"""
fetch-polymarket-pnl.py
Snapshots the Polymarket cumulative user-pnl series across all tracked wallets
(summed) so the Total view has a durable fallback when the live data-api is
unreachable.

Outputs JSON to stdout → pipe to data/polymarket-pnl.json.

NO WORKFLOW RUNS THIS (retired 2026-10-19). Every reader drops the series past
SZ_PM_BOOK_SEAM (2026-08-25) and build-pm-nav-history.py only reads it before
2026-07-15, so a daily refresh changed nothing on the site; the rows after the
seam fed only the szPmBookDivergence console warning. The committed snapshot is
frozen at 2026-10-20. Run this by hand if that warning is ever wanted again.

Env:
  PM_WALLET  - comma-separated wallet addresses (defaults to hardcoded list)

WHY THIS NO LONGER READS user-pnl-api (2026-10-19)
user-pnl-api.polymarket.com answers every request with HTTP 410 since 2026-10-16:
"user-pnl-api.polymarket.com has been retired. Use
https://data-api.polymarket.com/v2/user-pnl?user=<address> instead." The series now
comes from v2/user-pnl's `trade_pnl`, the same field fetch-polymarket-breakdown.py
reads for `trading`.

WHY THE COMMITTED HISTORY IS KEPT AND ONLY v2's DELTAS ARE APPENDED
v2 is a recomputation, not a copy. Against the 688 committed rows, summed trade_pnl
matches to the dollar on 296 days (the days with nothing open), at a 0h alignment -
no other shift does better, and the hourly series is daily underneath. Elsewhere it
marks open positions differently: a median $17 apart, but $20k on 2026-06-17 and $40k
on 2026-09-12, which are the old feed's neg-risk spikes (see SZ_PM_BOOK_SEAM in
Chrome.jsx). Taking v2 wholesale would restate every published pre-seam chart.

So the committed rows stand up to the newest day-boundary row v2 also covers (the
anchor), and every later point is v2's move since the anchor added to the committed
anchor value. The anchor moves forward each run, so a revision v2 makes to a day
already committed never reaches the file. On the first v2 run the anchor was
2026-10-14 00:00 (10-15 repeated it, stale) and v2 sat $492 below the committed
level there.

A raw v2 series is therefore NOT interchangeable with this file. Anything that needs
a live fallback for it has to rebase the same way, or read this file.
"""
import json, os, subprocess, sys, time
from datetime import datetime, timezone
from curl_cffi import requests

DEFAULT_WALLETS = [
    "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a",
    "0xfaf680c17a9cca24ff0773ae2d9f7db49c02cc47",
]
WALLETS = [w.strip() for w in os.environ.get("PM_WALLET", ",".join(DEFAULT_WALLETS)).split(",") if w.strip()]
INTERVAL = "all"
FIDELITY = "1d"
DAY_S = 86400

PNL = "https://data-api.polymarket.com/v2/user-pnl"
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data")
PREV_FILE = os.path.join(DATA, "polymarket-pnl.json")

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def get(sess, params, timeout=60, tries=5):
    """GET v2/user-pnl with backoff on 429 and 5xx (a shared runner IP, as in the
    breakdown fetch)."""
    delay = 2.0
    for attempt in range(tries):
        r = sess.get(PNL, params=params, timeout=timeout)
        if r.status_code < 400:
            return r
        if (r.status_code != 429 and r.status_code < 500) or attempt == tries - 1:
            r.raise_for_status()
        wait = float(r.headers.get("retry-after") or delay)
        log(f"  {r.status_code} on v2/user-pnl, retrying in {wait:.0f}s ({attempt + 1}/{tries})")
        time.sleep(wait)
        delay = min(delay * 2, 30)
    raise RuntimeError("unreachable")

def points(sess, wallet, **params):
    r = get(sess, {"user": wallet, **params})
    pts = (r.json().get("data") or {}).get("points") or []
    return sorted(
        (int(x["timestamp"]), float(x["trade_pnl"]))
        for x in pts if x.get("timestamp") is not None and x.get("trade_pnl") is not None
    )

def fetch_series(sess, wallet):
    """Daily closes, plus the latest hourly point as a live tail - the shape the old
    feed had, which szPmPointDay in Chrome.jsx reads as a partial day."""
    daily = points(sess, wallet, interval=INTERVAL, fidelity=FIDELITY)
    if not daily:
        raise ValueError(f"v2/user-pnl returned no points for {wallet}")
    hourly = points(sess, wallet, interval="1d")
    if hourly and hourly[-1][0] > daily[-1][0]:
        daily.append(hourly[-1])
    return daily

def sum_series(series_list):
    # Cumulative-PnL series can start at different times. Union timestamps and
    # carry forward each wallet's last known value (0 before its first point).
    all_ts = sorted({t for s in series_list for t, _ in s})
    cursors = [0] * len(series_list)
    last_vals = [0.0] * len(series_list)
    summed = []
    for t in all_ts:
        for i, s in enumerate(series_list):
            while cursors[i] < len(s) and s[cursors[i]][0] <= t:
                last_vals[i] = s[cursors[i]][1]
                cursors[i] += 1
        summed.append({"t": t, "p": round(sum(last_vals), 6)})
    return summed

def load_prev():
    """The committed snapshot, from the working tree or else from git HEAD.

    The workflow redirects stdout over polymarket-pnl.json, and `>` truncates it before
    this runs, so in CI the working copy is empty and HEAD is the one to read.
    """
    try:
        with open(PREV_FILE, encoding="utf-8") as fh:
            rows = json.load(fh).get("rows") or []
        if rows:
            return rows
    except Exception:
        pass
    try:
        out = subprocess.run(["git", "-C", DATA, "show", "HEAD:./polymarket-pnl.json"],
                             capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            rows = json.loads(out.stdout).get("rows") or []
            log(f"prev pnl read from git HEAD ({len(rows)} rows); the working file was empty")
            return rows
    except Exception as e:
        log(f"WARNING could not read prev pnl from git: {e}")
    return []

def stitch(prev, fresh):
    """Committed rows through the anchor, then v2's moves since the anchor."""
    if not prev:
        log("no committed history - writing the raw v2 series")
        return fresh
    last_daily = max(r["t"] for r in fresh if r["t"] % DAY_S == 0)
    # A row that repeats the one before it may be a stale tail rather than a close:
    # the old feed stopped updating on 2026-10-14 and wrote that value again for
    # 10-15. Anchoring there would carry the staleness forward as a fixed offset.
    # A genuinely flat day loses nothing by anchoring one day earlier.
    anchors = [r for i, r in enumerate(prev)
               if r["t"] % DAY_S == 0 and r["t"] <= last_daily
               and (i == 0 or r["p"] != prev[i - 1]["p"])]
    if not anchors:
        raise ValueError("committed history and v2 share no day boundary to anchor on")
    anchor = anchors[-1]
    base = max((r for r in fresh if r["t"] <= anchor["t"]), key=lambda r: r["t"], default=None)
    base_p = base["p"] if base else 0.0
    offset = anchor["p"] - base_p
    day = datetime.fromtimestamp(anchor["t"], timezone.utc).date().isoformat()
    log(f"anchored on {day}: v2 sits {-offset:+,.0f} from the committed level there")
    kept = [r for r in prev if r["t"] <= anchor["t"]]
    added = [{"t": r["t"], "p": round(r["p"] + offset, 6)} for r in fresh if r["t"] > anchor["t"]]
    return kept + added

def main():
    sess = requests.Session(impersonate="chrome124")
    all_series = []
    for w in WALLETS:
        s = fetch_series(sess, w)
        log(f"fetched {len(s)} pnl points for {w}")
        all_series.append(s)
    fresh = sum_series(all_series)
    log(f"summed series has {len(fresh)} points across {len(WALLETS)} wallets")
    clean = stitch(load_prev(), fresh)

    print(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "wallets": WALLETS,
        "interval": INTERVAL,
        "fidelity": FIDELITY,
        "rows": clean,
    }, indent=2))

main()
