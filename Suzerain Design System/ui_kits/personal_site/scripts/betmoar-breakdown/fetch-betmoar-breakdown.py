#!/usr/bin/env python3
"""
fetch-betmoar-breakdown.py
Scrapes the Betmoar profile page and extracts the profit breakdown
(Trading, LP, Yield, Maker, Sponsored, UMA). Outputs JSON to stdout.

Usage:
  python3 fetch-betmoar-breakdown.py > data/polymarket-breakdown.json

No credentials required — data is public on the Betmoar profile page.
"""
import json, re, sys
from datetime import date
try:
    from curl_cffi import requests
    SESSION = requests.Session(impersonate="chrome124")
    def get(url):
        r = SESSION.get(url, timeout=15)
        r.raise_for_status()
        return r.text
except ImportError:
    import urllib.request
    def get(url):
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode()

WALLET  = "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a"
BM_URL  = f"https://www.betmoar.fun/profile/{WALLET}"

def extract(html, label):
    m = re.search(label + r'[^<$]{0,80}\$([0-9,]+)', html, re.IGNORECASE)
    if m:
        return int(m.group(1).replace(',', ''))
    return None

def main():
    try:
        html = get(BM_URL)
    except Exception as e:
        print(f"error fetching {BM_URL}: {e}", file=sys.stderr)
        sys.exit(1)

    breakdown = {
        "generatedAt": date.today().isoformat(),
        "wallet":      WALLET,
        "source":      BM_URL,
        "totals": {
            "trading":   extract(html, r'Trading'),
            "lp":        extract(html, r'\bLP\b'),
            "yield":     extract(html, r'Yield'),
            "maker":     extract(html, r'Maker'),
            "sponsored": extract(html, r'Sponsored'),
            "uma":       extract(html, r'\bUMA\b'),
        },
    }

    missing = [k for k, v in breakdown["totals"].items() if v is None]
    if missing:
        print(f"warning: could not parse {missing} from page", file=sys.stderr)

    print(json.dumps(breakdown, indent=2))

main()
