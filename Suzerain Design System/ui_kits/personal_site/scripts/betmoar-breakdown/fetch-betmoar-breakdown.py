#!/usr/bin/env python3
"""
fetch-betmoar-breakdown.py
Calls the Betmoar Next.js server action to get the profit breakdown
(Trading, LP, Yield, Maker, Sponsored, UMA). Outputs JSON to stdout.

Usage:
  python3 fetch-betmoar-breakdown.py > data/polymarket-breakdown.json
"""
import json, re, sys
from datetime import date
from curl_cffi import requests

WALLET = "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a"
BM_URL = f"https://www.betmoar.fun/profile/{WALLET}"

# Fallback hash — used if dynamic discovery fails
_FALLBACK_HASH = "85d5ff77f7cca6369bc174dc6a4c1d46509ca4ab"

def discover_action_hash():
    """Scrape the profile page JS bundles to find the current Next-Action hash."""
    r = requests.get(BM_URL, impersonate="chrome")
    r.raise_for_status()
    html = r.text

    # Collect all /_next/static JS chunk URLs
    chunk_urls = re.findall(r'"(/_next/static/chunks/[^"]+\.js)"', html)
    base = "https://www.betmoar.fun"

    for path in chunk_urls:
        try:
            cr = requests.get(base + path, impersonate="chrome", timeout=10)
            # Next.js server action hashes appear as 40-char hex strings bound to action exports
            matches = re.findall(r'["\'`]([0-9a-f]{40})["\' `]', cr.text)
            for m in matches:
                # Quick sanity-check: try the hash and see if the response contains tradingProfit
                if _try_hash(m):
                    return m
        except Exception:
            continue

    return None

def _try_hash(action_hash):
    try:
        body = json.dumps([WALLET]).encode()
        r = requests.post(
            BM_URL,
            content=body,
            headers={
                "Content-Type":           "text/plain;charset=UTF-8",
                "Next-Action":            action_hash,
                "Next-Router-State-Tree": "%5B%22%22%2C%7B%7D%5D",
            },
            impersonate="chrome",
            timeout=15,
        )
        return "tradingProfit" in r.text
    except Exception:
        return False

def fetch_stats(action_hash):
    body = json.dumps([WALLET]).encode()
    r = requests.post(
        BM_URL,
        content=body,
        headers={
            "Content-Type":           "text/plain;charset=UTF-8",
            "Next-Action":            action_hash,
            "Next-Router-State-Tree": "%5B%22%22%2C%7B%7D%5D",
        },
        impersonate="chrome",
        timeout=15,
    )
    raw = r.text

    for line in raw.splitlines():
        m = re.search(r'\{.+tradingProfit.+\}', line)
        if m:
            return json.loads(m.group())
    raise ValueError(f"stats object not found in response: {raw[:200]}")

def main():
    try:
        action_hash = discover_action_hash() or _FALLBACK_HASH
        print(f"using action hash: {action_hash}", file=sys.stderr)
        stats = fetch_stats(action_hash)
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
