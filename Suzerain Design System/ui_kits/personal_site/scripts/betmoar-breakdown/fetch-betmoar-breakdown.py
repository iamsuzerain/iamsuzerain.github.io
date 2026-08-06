#!/usr/bin/env python3
"""
fetch-betmoar-breakdown.py
Calls the Betmoar Next.js server action to get the profit breakdown
(Trading, LP, Yield, Maker, Taker, Sponsored, UMA). Outputs JSON to stdout.

Usage:
  python3 fetch-betmoar-breakdown.py > data/polymarket-breakdown.json
"""
import json, re, sys
from datetime import date
from curl_cffi import requests

WALLETS = [
    "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a",
    "0xfaf680c17a9cca24ff0773ae2d9f7db49c02cc47",
]

def bm_url(wallet):
    return f"https://www.betmoar.fun/profile/{wallet}"

# Fallback hash — used if dynamic discovery fails
_FALLBACK_HASH = "85d5ff77f7cca6369bc174dc6a4c1d46509ca4ab"

def discover_action_hash():
    """Scrape one profile page's JS bundles to find the current Next-Action hash."""
    probe_wallet = WALLETS[0]
    r = requests.get(bm_url(probe_wallet), impersonate="chrome")
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
                if _try_hash(m, probe_wallet):
                    return m
        except Exception:
            continue

    return None

def _try_hash(action_hash, wallet):
    try:
        body = json.dumps([wallet]).encode()
        r = requests.post(
            bm_url(wallet),
            data=body,
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

def fetch_stats(action_hash, wallet):
    body = json.dumps([wallet]).encode()
    r = requests.post(
        bm_url(wallet),
        data=body,
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
        per_wallet = []
        for w in WALLETS:
            stats = fetch_stats(action_hash, w)
            print(f"fetched stats for {w}", file=sys.stderr)
            per_wallet.append(stats)
    except Exception as e:
        print(f"error fetching stats: {e}", file=sys.stderr)
        sys.exit(1)

    def dollars(val):
        return round(val) if val else 0

    def sum_field(*keys):
        return dollars(sum((s.get(k) or 0) for s in per_wallet for k in keys))

    # Betmoar's `overallPNL` is the only field that nets out Polymarket trading
    # fees; the Polymarket user-pnl-api series and `tradingProfit` both ignore
    # them. Recover per-wallet fees as (sum of components − overallPNL), then
    # sum across wallets. Stored as a positive dollar amount of fees paid.
    def implied_fees(s):
        components = (
            (s.get("tradingProfit")    or 0)
            + (s.get("lpRewards")      or 0)
            + (s.get("makerRebates")   or 0)
            + (s.get("yieldRewards")   or 0)
            + (s.get("sponsoredRewards") or 0)
            + (s.get("takerRebates")   or 0)
            + (s.get("takerBackpay")   or 0)
            + (s.get("umaPnl")         or 0)
            + (s.get("refunds")        or 0)
        )
        return components - (s.get("overallPNL") or 0)

    breakdown = {
        "generatedAt": date.today().isoformat(),
        "wallets":     WALLETS,
        "sources":     [bm_url(w) for w in WALLETS],
        "totals": {
            "trading":   sum_field("tradingProfit"),
            "lp":        sum_field("lpRewards"),
            "yield":     sum_field("yieldRewards"),
            "maker":     sum_field("makerRebates"),
            # Taker-side fee rebates, plus the backpay betmoar reports separately
            # when Polymarket settles a rebate period late. Same fee-rebate stream
            # as `maker`, so the site charts the two together.
            "taker":     sum_field("takerRebates", "takerBackpay"),
            "sponsored": sum_field("sponsoredRewards"),
            "uma":       sum_field("umaPnl"),
            "fees":      dollars(sum(implied_fees(s) for s in per_wallet)),
        },
        # Current Polymarket net asset value, summed across wallets: open-position
        # market value (portfolioValue) + idle USDC (usdcBalance). Used by the
        # overview's capital-deployment bar to weigh Poly against IBKR NAV.
        "balances": {
            "positions": sum_field("portfolioValue"),
            "cash":      sum_field("usdcBalance"),
            "nav":       dollars(sum(
                (s.get("portfolioValue") or 0) + (s.get("usdcBalance") or 0)
                for s in per_wallet
            )),
        },
    }

    print(json.dumps(breakdown, indent=2))

main()
