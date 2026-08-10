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

# Fallback hash — used if dynamic discovery fails. Betmoar rotates this on every
# redeploy, so it goes dead without warning; discovery is the real path and this
# only buys a day or two. Refreshed 2026-08-09.
_FALLBACK_HASH = "40e4d02f2fd0a00d3570b727b2686579471fa3b515"

class DiscoveryBroken(Exception):
    """The page no longer looks the way the scraper expects.

    Distinct from "discovery ran but no id validated": this means a regex
    matched nothing at all, so our assumptions about betmoar's markup or bundle
    layout are stale. The fallback hash is not a legitimate substitute here —
    whatever redeploy changed the format almost certainly rotated the ids too,
    and sliding to the fallback just relocates the failure to fetch_stats as a
    misleading "Server action not found".
    """

def discover_action_hash():
    """Scrape one profile page's JS bundles to find the current Next-Action hash."""
    probe_wallet = WALLETS[0]
    r = requests.get(bm_url(probe_wallet), impersonate="chrome")
    r.raise_for_status()
    html = r.text

    # Collect all /_next/static JS chunk URLs. Don't pin the directory under
    # /_next/static/ — betmoar's turbopack build moved chunks from
    # `static/chunks/` to `static/immutable/chunks/` (2026-08-09) and a path
    # pinned to the old layout matched zero bundles, so discovery found nothing
    # and the run died on the stale fallback.
    chunk_urls = re.findall(r'"(/_next/static/[^"]+\.js)"', html)
    chunk_urls = list(dict.fromkeys(chunk_urls))
    base = "https://www.betmoar.fun"

    if not chunk_urls:
        raise DiscoveryBroken(
            f"no /_next/static JS chunk URLs in {len(html)} bytes of profile HTML "
            f"— page markup or bundle layout changed")

    candidates = 0
    for path in chunk_urls:
        try:
            cr = requests.get(base + path, impersonate="chrome", timeout=10)
            # Match the createServerReference call rather than any quoted hex run:
            # that call site is what actually marks an id as a server action, and it
            # survives the id format changing. Next bumped these from 40 to 42 chars
            # (2026-08-08), which a hard `{40}` between quotes silently missed —
            # discovery found nothing and the dead fallback took the run down.
            matches = re.findall(
                r'createServerReference\)?\(\s*["\'`]([0-9a-f]{40,64})', cr.text)
            candidates += len(matches)
            for m in matches:
                # Quick sanity-check: try the hash and see if the response contains tradingProfit
                if _try_hash(m, probe_wallet):
                    return m
        except Exception:
            continue

    if not candidates:
        raise DiscoveryBroken(
            f"scanned {len(chunk_urls)} chunks, found no createServerReference ids "
            f"— call-site pattern or id format changed")

    # Ids were found but none answered with stats: they may have rotated between
    # the page load and the probe, or a network blip ate the check. Worth one
    # shot at the fallback, loudly.
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
        action_hash = discover_action_hash()
        if action_hash:
            print(f"using action hash: {action_hash} (discovered)", file=sys.stderr)
        else:
            # Say this loudly: a passing run on the fallback still means discovery
            # is broken, and the panel freezes the day betmoar rotates the id.
            action_hash = _FALLBACK_HASH
            print(f"WARNING: action hash discovery failed, using stale fallback "
                  f"{action_hash} — fix discovery before it rotates", file=sys.stderr)
        per_wallet = []
        for w in WALLETS:
            stats = fetch_stats(action_hash, w)
            print(f"fetched stats for {w}", file=sys.stderr)
            per_wallet.append(stats)
    except DiscoveryBroken as e:
        print(f"action hash discovery is broken: {e}", file=sys.stderr)
        print(f"refusing to fall back to {_FALLBACK_HASH} — fix discovery, then "
              f"refresh the fallback from the id it finds", file=sys.stderr)
        sys.exit(1)
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
