#!/usr/bin/env python3
"""
fetch-betmoar-breakdown.py
Polymarket profit-by-source breakdown (Trading, LP, Yield, Maker, Taker, UMA) and
balances. Outputs JSON to stdout. The filename is kept because the workflow, the canary
and three .jsx consumers reference it; betmoar is no longer involved.

Usage:
  python3 fetch-betmoar-breakdown.py > data/polymarket-breakdown.json

WHY BETMOAR IS GONE (2026-10-19)
Betmoar replaced its Next.js server action with an authenticated REST API
(`/api/user-data`, 401 anonymously). Its auth is a SIWE wallet signature - GET
/api/auth/nonce, sign the message, POST /api/auth/login - so a session cookie expires
and renewing it needs the PRIVATE KEY of the wallet holding the book. That is not a
secret worth planting in CI to read a stats page. Hash discovery was not broken by a
pattern change; the mechanism it discovered stopped existing.

WHERE THE NUMBERS COME FROM NOW
  trading, fees        data-api.polymarket.com/v2/user-pnl   (hourly series, no auth)
  lp, maker, yield,    data-api /activity filtered by type - each reward IS an event
    taker                with a usdcSize, so these sum from first principles
  positions            data-api /positions, as before
  cash                 CARRIED FORWARD - nothing public reports a USDC balance

The retired `user-pnl-api.polymarket.com` host names v2/user-pnl as its replacement.
Reconciliation against betmoar's last good read (2026-10-18):

    trading   betmoar 96,784   trade_pnl  96,823    within $39 (hourly vs daily sample)
    fees      betmoar  3,229   fees_paid   3,232    match
    maker     betmoar  4,001   summed      4,008    match
    yield     betmoar    132   summed        134    match
    taker     betmoar     82   summed         82    match

`lp` and `sponsored` move between columns and the TOTAL IS PRESERVED. Betmoar reported
lp 11,036 + sponsored 514 = 11,550; the REWARD event stream sums to 11,553, i.e. betmoar
was publishing lp as (REWARD stream minus sponsored). There is no first-party sponsored
figure, so the whole stream is reported as `lp` and `sponsored` is 0. Charts that add the
two are unaffected; a chart that plots sponsored alone goes flat from 2026-10-19.

Do NOT read the reward fields from v2/user-pnl. They are a stale snapshot: across 168
hourly points on 2026-10-19 reward_income, maker_rebate, yield_income and
sponsored_income each held ONE distinct value while trade_pnl moved 45-57 times.

CASH, AND WHY IT NEEDS A HUMAN OCCASIONALLY
No public endpoint reports the USDC balance: data-api /value is positions only; /balance,
/portfolio, /holdings and /collateral are 404; clob/balance-allowance and gamma/users
need keys; and both proxy wallets hold 0 in USDC.e and native USDC on Polygon, so an
on-chain balanceOf does not find the collateral. v2/user-pnl's deposits, withdrawals and
cashflow_net are null across all 52,814 points.

So cash is carried from the previous committed breakdown and advanced by the activity
since `balances.cashCursor`. A DEPOSIT OR WITHDRAWAL DOES NOT APPEAR IN THE FEED -
type=DEPOSIT and type=WITHDRAWAL are accepted by data-api (type=TRANSFER and
type=CONVERT are rejected with 400) but have never returned a row, on an account that
was plainly funded, because funding Polymarket is an on-chain bridge transaction. After
moving money, state the balance Polymarket shows in

    data/polymarket-cash-override.json      {"2026-10-20": 50000}

The newest entry at or before today wins and everything after it is re-derived. If
derived cash ever goes negative the run fails, because the activity feed cannot spend
money that was never there - that is proof a flow was missed.
"""
import json, os, sys
from datetime import datetime, timezone
from curl_cffi import requests

WALLETS = [
    "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a",
    "0xfaf680c17a9cca24ff0773ae2d9f7db49c02cc47",
]
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data")
PREV_FILE = os.path.join(DATA, "polymarket-breakdown.json")
OVERRIDE_FILE = os.path.join(DATA, "polymarket-cash-override.json")

PNL = "https://data-api.polymarket.com/v2/user-pnl"
ACT = "https://data-api.polymarket.com/activity"
POS = "https://data-api.polymarket.com/positions"
VAL = "https://data-api.polymarket.com/value"

# Each reward stream is an activity type carrying a usdcSize, so the cumulative figure
# sums from the feed with no prior state. REWARD includes what betmoar called sponsored.
REWARD_TYPES = {"REWARD": "lp", "MAKER_REBATE": "maker",
                "YIELD": "yield", "TAKER_REBATE": "taker"}
CASH_IN = {"REDEEM", "MERGE", "CONVERSION", "REWARD", "YIELD",
           "MAKER_REBATE", "TAKER_REBATE", "DEPOSIT"}
CASH_OUT = {"SPLIT", "WITHDRAWAL"}


def _load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _load_prev(path):
    """The previous breakdown, from the working tree or else from git.

    `>` truncates its target before the command runs, so a workflow that redirects this
    script's stdout over polymarket-breakdown.json leaves an empty file for this process
    to read. Falling back to the committed copy makes the cursor survive that.
    """
    cur = _load(path)
    if cur and (cur.get("balances") or {}).get("cashCursor") is not None:
        return cur
    try:
        import subprocess
        out = subprocess.run(["git", "-C", os.path.dirname(path), "show",
                              "HEAD:./" + os.path.basename(path)],
                             capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            from_git = json.loads(out.stdout)
            print(f"prev breakdown read from git HEAD ({from_git.get('generatedAt')}); "
                  f"the working file was empty or had no cursor", file=sys.stderr)
            return from_git
    except Exception as e:
        print(f"WARNING could not read prev breakdown from git: {e}", file=sys.stderr)
    return cur


def user_pnl(wallet):
    """Latest point of the hourly P&L series."""
    r = requests.get(PNL, params={"user": wallet, "interval": "1d"},
                     impersonate="chrome", timeout=60)
    r.raise_for_status()
    pts = (r.json().get("data") or {}).get("points") or []
    if not pts:
        raise ValueError(f"v2/user-pnl returned no points for {wallet}")
    return pts[-1]


def activity(wallet, since=None, kind=None):
    """Paged /activity, optionally filtered by type and truncated at a timestamp."""
    out, offset = [], 0
    while offset <= 5000:
        params = {"user": wallet, "limit": 500, "offset": offset}
        if kind:
            params["type"] = kind
        r = requests.get(ACT, params=params, impersonate="chrome", timeout=40)
        r.raise_for_status()
        page = r.json()
        if not isinstance(page, list) or not page:
            break
        out += [x for x in page if since is None or x["timestamp"] > since]
        if len(page) < 500 or (since is not None
                               and min(x["timestamp"] for x in page) <= since):
            break
        offset += 500
    return out


def fetch_positions_value(wallet):
    """Open-position market value: sum of currentValue over data-api /positions.

    Not data-api /value, which is not a stable read of /positions: on 2026-09-13 it swung
    one wallet between $10.8k and $6.7k within twenty minutes while /positions returned
    identical books both times, and a scrape caught the low read and left ~$8k of
    positions out of NAV while counting the cash spent on them. /value is still fetched
    below, as the second source for the agreement check.
    """
    total, offset, limit = 0.0, 0, 500
    while True:
        r = requests.get(POS, params={"user": wallet, "sizeThreshold": 0,
                                      "limit": limit, "offset": offset},
                         impersonate="chrome", timeout=30)
        r.raise_for_status()
        page = r.json()
        if not isinstance(page, list):
            raise ValueError(f"unexpected /positions response: {r.text[:200]}")
        total += sum(p.get("currentValue") or 0 for p in page)
        if len(page) < limit:
            return total
        offset += limit


def fetch_value(wallet):
    """data-api /value - the figure betmoar's portfolioValue tracked."""
    r = requests.get(VAL, params={"user": wallet}, impersonate="chrome", timeout=25)
    r.raise_for_status()
    rows = r.json()
    if isinstance(rows, list) and rows:
        return rows[0].get("value")
    return None


def positions_agreement(pairs, source):
    """One line saying whether the two position-value sources still agree.

    Modeled on `flow_agreement` in fetch-ibkr.py: a per-wallet equality flag and a
    verdict, no dollar amounts, safe for a world-readable Actions log.

    The constant it watches is that Polymarket /positions and /value describe the same
    book. They did until 2026-09-13, when /value swung one wallet between $10.8k and
    $6.7k in twenty minutes while /positions returned an identical book both times. A
    scrape caught the low read, NAV published ~$8k light, and nothing in the pipeline
    said so - the gap was found by eye, days later. Betmoar's portfolioValue tracked
    /value, so this is the same check against the same upstream, one hop shorter.

    Tolerance is absolute, not proportional, because the failure is. Fourteen readings in
    the Actions logs between 2026-09-12 and 2026-09-16 say the healthy state is agreement
    *to the dollar* - thirteen of them differ by exactly $0.

    The fourteenth is the 2026-09-13 incident, and it is why this is not a percentage:

        w0   polymarket  10,782   /value   6,704   gap $4,078   37.8%
        w1   polymarket 291,541   /value 287,382   gap $4,159    1.45%

    Both legs are the same ~$4k mistake; they read as wildly different percentages only
    because the wallets are different sizes. A 2% rule - the first thing written here,
    sized off the 38% - catches w0 and waves w1 through, which is half of the ~$8k that
    went out that day.

    $250 is a floor for genuine drift between two calls a second apart, not a measurement
    of anything.

    A disagreement is reported, not fatal. /positions is the better source and is already
    the one used; the run should still publish. What matters is that the day it starts
    disagreeing is a day somebody hears about.
    """
    TOL = 250.0
    flags, bad = [], 0
    for i, (pm, other) in enumerate(pairs):
        if pm is None:
            flags.append(f"w{i} PM?VAL")
            continue
        if not other:
            flags.append(f"w{i} PM?VAL")
            continue
        gap = pm - other
        if abs(gap) <= TOL:
            flags.append(f"w{i} PM==VAL")
        else:
            flags.append(f"w{i} PM!=VAL({gap:+,.0f} / {gap / abs(other) * 100:+.1f}%)")
            bad += 1

    if source != "polymarket":
        verdict = "FELL BACK to /value - positions may be missing"
    elif bad:
        verdict = f"{bad} of {len(pairs)} wallets disagree - /value drifting"
    else:
        verdict = "agree (source: polymarket)"
    return "positions-sources: " + " ".join(flags) + f" -> {verdict}"


def main():
    today = datetime.now(timezone.utc).date().isoformat()
    prev = _load_prev(PREV_FILE) or {}
    prev_bal = prev.get("balances") or {}

    # ---------------------------------------------------------------- measured
    try:
        pnl = {w: user_pnl(w) for w in WALLETS}
        for w in WALLETS:
            print(f"user-pnl {w}: trade_pnl {pnl[w].get('trade_pnl', 0):,.0f}",
                  file=sys.stderr)
    except Exception as e:
        print(f"error fetching v2/user-pnl: {e}", file=sys.stderr)
        sys.exit(1)

    def dollars(v):
        return round(v) if v else 0

    totals = {
        "trading": dollars(sum(pnl[w].get("trade_pnl") or 0 for w in WALLETS)),
        # Stored as a positive dollar amount of fees paid, as betmoar's `fees` was.
        "fees": dollars(-sum(pnl[w].get("fees_paid") or 0 for w in WALLETS)),
        "uma": 0,
        # No first-party split; the whole REWARD stream is reported as `lp` below.
        "sponsored": 0,
    }
    try:
        for kind, line in REWARD_TYPES.items():
            rows = [x for w in WALLETS for x in activity(w, kind=kind)]
            totals[line] = dollars(sum(x.get("usdcSize", 0) or 0 for x in rows))
            print(f"{line}: {len(rows)} {kind} events", file=sys.stderr)
    except Exception as e:
        print(f"error summing reward activity: {e}", file=sys.stderr)
        sys.exit(1)

    # ---------------------------------------------------------------- positions
    positions_source, pairs, positions = "polymarket", [], 0.0
    for w in WALLETS:
        other = None
        try:
            other = fetch_value(w)
        except Exception as e:
            print(f"WARNING /value failed for {w}: {e}", file=sys.stderr)
        try:
            live = fetch_positions_value(w)
            positions += live
            pairs.append((live, other))
            print(f"positions {w}: polymarket {live:,.0f} vs /value "
                  f"{(other or 0):,.0f}", file=sys.stderr)
        except Exception as e:
            positions_source = "value"
            positions += other or 0
            pairs.append((None, other))
            print(f"WARNING /positions failed for {w} ({e}); using /value, which can "
                  f"miss recent positions", file=sys.stderr)
    print(positions_agreement(pairs, positions_source), file=sys.stderr)

    # ---------------------------------------------------------------- cash, derived
    override = _load(OVERRIDE_FILE) or {}
    anchor = None
    past = sorted(d for d in override if d <= today)
    if past and past[-1] > (prev.get("generatedAt") or ""):
        anchor = (past[-1], float(override[past[-1]]))

    cursor = prev_bal.get("cashCursor")
    if anchor is None and cursor is None:
        print("REFUSING: no balances.cashCursor in the previous breakdown and no "
              "override for today. Seed one of them - cash cannot be derived from "
              "nothing.", file=sys.stderr)
        sys.exit(1)

    events = [x for w in WALLETS for x in activity(w, since=cursor)]
    net = 0.0
    unknown = {}
    for x in events:
        t, u = x["type"], (x.get("usdcSize", 0) or 0)
        if t == "TRADE":
            net += u if x.get("side") == "SELL" else -u
        elif t in CASH_IN:
            net += u
        elif t in CASH_OUT:
            net -= u
        else:
            unknown[t] = unknown.get(t, 0) + 1

    if anchor:
        cash = anchor[1] + net
        basis = (f"ANCHORED to a stated balance of {anchor[1]:,.2f} on {anchor[0]}, "
                 f"plus {len(events)} activity events since")
        print(f"cash override: anchored to {anchor[1]:,.2f} on {anchor[0]}",
              file=sys.stderr)
    else:
        cash = (prev_bal.get("cash") or 0) + net
        basis = (f"DERIVED: {prev.get('generatedAt', '?')} cash plus {len(events)} "
                 f"activity events; no public endpoint reports the USDC balance, and a "
                 f"transfer does NOT appear in the feed - state it in "
                 f"data/polymarket-cash-override.json")

    if cash < 0:
        print(f"REFUSING: derived cash is {cash:,.2f}, which is impossible - a deposit "
              f"or withdrawal is missing. Put the real balance in "
              f"data/polymarket-cash-override.json", file=sys.stderr)
        sys.exit(1)
    if unknown:
        print(f"WARNING unhandled activity types, cash may drift: {unknown}",
              file=sys.stderr)

    new_cursor = max([x["timestamp"] for x in events], default=cursor)
    print(f"cash {(anchor[1] if anchor else prev_bal.get('cash') or 0):,.0f} "
          f"{net:+,.0f} -> {cash:,.0f} ({'anchored' if anchor else 'carried'})",
          file=sys.stderr)

    breakdown = {
        "generatedAt": today,
        "wallets": WALLETS,
        "sources": [f"{PNL}?user={w}&interval=1d" for w in WALLETS] + [ACT, POS],
        "totals": totals,
        "totalsBasis": ("trading and fees from v2/user-pnl; lp/maker/yield/taker summed "
                        "from their own activity events; sponsored is folded into lp "
                        "from 2026-10-19 - no first-party split exists, and the total "
                        "of the two is unchanged"),
        "balances": {
            "positionsSource": positions_source,
            "positions": dollars(positions),
            "cash": dollars(cash),
            "nav": dollars(positions + cash),
            "cashBasis": basis,
            "cashCursor": new_cursor,
        },
    }
    print(json.dumps(breakdown, indent=2))


main()
