#!/usr/bin/env python3
"""
fetch-polymarket-pnl.py
Snapshots the Polymarket cumulative user-pnl series for a wallet so the Total
view has a durable fallback when the live data-api is unreachable.

Outputs JSON to stdout → pipe to data/polymarket-pnl.json.

Env:
  PM_WALLET  - wallet address (defaults to hardcoded wallet)
"""
import json, os, sys
from datetime import datetime, timezone
from curl_cffi import requests

WALLET = os.environ.get("PM_WALLET", "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a")
INTERVAL = "all"
FIDELITY = "1d"
URL = (
    "https://user-pnl-api.polymarket.com/user-pnl"
    f"?user_address={WALLET}&interval={INTERVAL}&fidelity={FIDELITY}"
)

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def main():
    sess = requests.Session(impersonate="chrome124")
    r = sess.get(URL, timeout=20)
    r.raise_for_status()
    raw = r.json()
    rows = raw if isinstance(raw, list) else []
    # Keep only the fields the front end reads: t (unix seconds), p (USD).
    clean = [{"t": int(x["t"]), "p": float(x["p"])} for x in rows if "t" in x and "p" in x]
    log(f"fetched {len(clean)} pnl points for {WALLET}")

    print(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "userAddress": WALLET,
        "interval": INTERVAL,
        "fidelity": FIDELITY,
        "rows": clean,
    }, indent=2))

main()
