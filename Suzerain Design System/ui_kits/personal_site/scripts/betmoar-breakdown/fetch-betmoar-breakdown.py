#!/usr/bin/env python3
"""
fetch-betmoar-breakdown.py
Calls the Betmoar Next.js server action to get the profit breakdown
(Trading, LP, Yield, Maker, Sponsored, UMA). Outputs JSON to stdout.

Usage:
  python3 fetch-betmoar-breakdown.py > data/polymarket-breakdown.json
"""
import json, re, sys, urllib.request
from datetime import date

WALLET      = "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a"
BM_URL      = f"https://www.betmoar.fun/profile/{WALLET}"
ACTION_HASH = "85d5ff77f7cca6369bc174dc6a4c1d46509ca4ab"

def fetch_stats():
    body = json.dumps([WALLET]).encode()
    req = urllib.request.Request(
        BM_URL,
        data=body,
        headers={
            "User-Agent":             "Mozilla/5.0",
            "Content-Type":           "text/plain;charset=UTF-8",
            "Next-Action":            ACTION_HASH,
            "Next-Router-State-Tree": "%5B%22%22%2C%7B%7D%5D",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode()

    # response is newline-delimited lines; find the one with the stats object
    for line in raw.splitlines():
        m = re.search(r'\{.+tradingProfit.+\}', line)
        if m:
            return json.loads(m.group())
    raise ValueError(f"stats object not found in response: {raw[:200]}")

def main():
    try:
        stats = fetch_stats()
    except Exception as e:
        print(f"error fetching stats: {e}", file=sys.stderr)
        sys.exit(1)

    def dollars(val):
        return round(val) if val else 0

    breakdown = {
        "generatedAt": date.today().isoformat(),
        "wallet":      WALLET,
        "source":      BM_URL,
        "totals": {
            "trading":   dollars(stats.get("tradingProfit")),
            "lp":        dollars(stats.get("lpRewards")),
            "yield":     dollars(stats.get("yieldRewards")),
            "maker":     dollars(stats.get("makerRebates")),
            "sponsored": dollars(stats.get("sponsoredRewards")),
            "uma":       dollars(stats.get("umaPnl")),
        },
    }

    print(json.dumps(breakdown, indent=2))

main()
