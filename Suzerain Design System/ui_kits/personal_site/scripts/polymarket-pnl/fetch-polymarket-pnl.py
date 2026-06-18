#!/usr/bin/env python3
"""
fetch-polymarket-pnl.py
Snapshots the Polymarket cumulative user-pnl series across all tracked wallets
(summed) so the Total view has a durable fallback when the live data-api is
unreachable.

Outputs JSON to stdout → pipe to data/polymarket-pnl.json.

Env:
  PM_WALLET  - comma-separated wallet addresses (defaults to hardcoded list)
"""
import json, os, sys
from datetime import datetime, timezone
from curl_cffi import requests

DEFAULT_WALLETS = [
    "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a",
    "0xfaf680c17a9cca24ff0773ae2d9f7db49c02cc47",
]
WALLETS = [w.strip() for w in os.environ.get("PM_WALLET", ",".join(DEFAULT_WALLETS)).split(",") if w.strip()]
INTERVAL = "all"
FIDELITY = "1d"

def url(w):
    return (
        "https://user-pnl-api.polymarket.com/user-pnl"
        f"?user_address={w}&interval={INTERVAL}&fidelity={FIDELITY}"
    )

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def fetch_series(sess, wallet):
    r = sess.get(url(wallet), timeout=20)
    r.raise_for_status()
    raw = r.json()
    rows = raw if isinstance(raw, list) else []
    return sorted(
        (int(x["t"]), float(x["p"])) for x in rows if "t" in x and "p" in x
    )

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

def main():
    sess = requests.Session(impersonate="chrome124")
    all_series = []
    for w in WALLETS:
        s = fetch_series(sess, w)
        log(f"fetched {len(s)} pnl points for {w}")
        all_series.append(s)
    clean = sum_series(all_series)
    log(f"summed series has {len(clean)} points across {len(WALLETS)} wallets")

    print(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "wallets": WALLETS,
        "interval": INTERVAL,
        "fidelity": FIDELITY,
        "rows": clean,
    }, indent=2))

main()
