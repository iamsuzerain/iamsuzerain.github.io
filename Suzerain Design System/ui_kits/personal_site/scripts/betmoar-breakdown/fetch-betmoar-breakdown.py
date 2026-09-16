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

def fetch_positions_value(wallet):
    """Open-position market value: sum of currentValue over data-api /positions.

    Betmoar's `portfolioValue` tracks data-api /value, and /value is not a
    stable read of /positions. On 2026-09-13 it swung one wallet between
    $10.8k and $6.7k within twenty minutes while /positions returned identical
    books both times; the scrape caught a low read and left ~$8k of positions
    out of NAV while counting the cash spent on them. /positions is paged
    because the other wallet already holds ~100.
    """
    total, offset, limit = 0.0, 0, 500
    while True:
        r = requests.get("https://data-api.polymarket.com/positions",
                         params={"user": wallet, "sizeThreshold": 0,
                                 "limit": limit, "offset": offset},
                         impersonate="chrome", timeout=15)
        r.raise_for_status()
        page = r.json()
        if not isinstance(page, list):
            raise ValueError(f"unexpected /positions response: {r.text[:200]}")
        total += sum(p.get("currentValue") or 0 for p in page)
        if len(page) < limit:
            return total
        offset += limit

def positions_agreement(pairs, source):
    """One line saying whether the two position-value sources still agree.

    Modeled on `flow_agreement` in fetch-ibkr.py: a per-wallet equality flag and
    a verdict, no dollar amounts, safe for a world-readable Actions log.

    The constant it watches is that Polymarket /positions and betmoar's
    portfolioValue describe the same book. They did until 2026-09-13, when
    betmoar's figure (which tracks data-api /value) swung one wallet between
    $10.8k and $6.7k in twenty minutes while /positions returned an identical
    book both times. The scrape caught a low read, NAV published ~$8k light, and
    nothing in the pipeline said so — the gap was found by eye, days later.

    Tolerance is absolute, not proportional, because the failure is. Fourteen
    readings in the Actions logs between 2026-09-12 and 2026-09-16 say the
    healthy state is agreement *to the dollar* — thirteen of them differ by
    exactly $0, which is what you would expect if betmoar's /value is derived
    from the same snapshot as /positions whenever it is fresh.

    The fourteenth is the 2026-09-13 incident, and it is why this is not a
    percentage:

        w0   polymarket  10,782   betmoar   6,704   gap $4,078   37.8%
        w1   polymarket 291,541   betmoar 287,382   gap $4,159    1.45%

    Both legs are the same ~$4k mistake; they read as wildly different
    percentages only because the wallets are different sizes. A 2% rule — the
    first thing written here, sized off the 38% — catches w0 and waves w1
    through, which is half of the ~$8k that went out that day.

    $250 is a floor for genuine drift between two calls a second apart, not a
    measurement of anything. Every healthy reading so far has been $0.

    A disagreement is reported, not fatal. /positions is the better source and
    is already the one used; the run should still publish. What matters is that
    the day it starts disagreeing is a day somebody hears about.
    """
    TOL = 250.0
    flags, bad = [], 0
    for i, (pm, bm) in enumerate(pairs):
        if pm is None:
            flags.append(f"w{i} PM?BM")      # /positions failed; nothing compared
            continue
        if not bm:
            flags.append(f"w{i} PM?BM")      # betmoar reported nothing to compare
            continue
        gap = pm - bm
        if abs(gap) <= TOL:
            flags.append(f"w{i} PM==BM")
        else:
            # The gap in dollars, which is the thing that went wrong, and the
            # percentage after it, which is the thing that made it look small.
            flags.append(f"w{i} PM!=BM({gap:+,.0f} / {gap / abs(bm) * 100:+.1f}%)")
            bad += 1

    if source == "betmoar":
        verdict = "FELL BACK to betmoar portfolioValue - positions may be missing"
    elif bad:
        verdict = f"{bad} of {len(pairs)} wallets disagree - betmoar /value drifting"
    else:
        verdict = "agree (source: polymarket)"
    return "positions-sources: " + " ".join(flags) + f" -> {verdict}"


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

    # A failed /positions call falls back to betmoar's figure rather than failing the
    # run — losing the day's breakdown is worse than a possibly stale position
    # value — but says so, and the source is recorded in the output.
    positions_source = "polymarket"
    pairs = []
    for w, s in zip(WALLETS, per_wallet):
        betmoar_value = s.get("portfolioValue") or 0
        try:
            live = fetch_positions_value(w)
            print(f"positions {w}: polymarket {live:,.0f} vs betmoar "
                  f"{betmoar_value:,.0f}", file=sys.stderr)
            s["portfolioValue"] = live
            pairs.append((live, betmoar_value))
        except Exception as e:
            positions_source = "betmoar"
            pairs.append((None, betmoar_value))
            print(f"WARNING: polymarket /positions failed for {w} ({e}); using "
                  f"betmoar portfolioValue, which can miss recent positions",
                  file=sys.stderr)

    # Always on, including in CI. The comparison above prints the two figures
    # and leaves a human to notice; this states the verdict. See
    # positions_agreement for the constant it watches and why it is safe to log.
    print(positions_agreement(pairs, positions_source), file=sys.stderr)

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
        # market value (Polymarket /positions, see fetch_positions_value) + idle USDC
        # (betmoar usdcBalance). Used by the book view's capital-deployment bar
        # to weigh Poly against IBKR NAV.
        "balances": {
            "positionsSource": positions_source,
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
