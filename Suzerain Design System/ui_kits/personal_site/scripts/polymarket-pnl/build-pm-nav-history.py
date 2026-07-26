#!/usr/bin/env python3
"""
build-pm-nav-history.py

Daily Polymarket NAV, so the overview's capital base can value the Polymarket
side at what it is actually worth instead of what was sent to it.

Why this exists: the base used to read the manual IBKR->Polymarket transfer
ledger, which prices transferred money at cost forever. That makes
base(D) = true capital(D) - PM cumulative P&L(D) — 8.2% wrong on 2026-07-24 —
which understates the benchmark line and inflates vol and drawdown.

Two sources, recorded first:

  recorded  polymarket-breakdown-history.json rows carrying `nav` (positions +
            idle USDC, straight off betmoar). Ground truth, but only from
            2026-07-15, the day the fetch started emitting `balances`.

  derived   Everything earlier, reconstructed by anchoring to the OLDEST
            recorded day and walking backwards:

                nav(d) = nav(D0) - (transfers(D0) - transfers(d))
                                 - (pnl(D0)       - pnl(d))
                                 - (rewards(D0)   - rewards(d))

            Anchoring backwards from a known value, rather than summing
            forwards from zero, is what lets this work at all: Polymarket was
            already funded before the transfer ledger begins (the user-pnl
            series starts 2024-11-28), and that seed capital is unrecorded.
            Building forward would silently omit it; differencing cancels it.

Accuracy, checked against the 12 days where both exist: mean residual 838
(0.36%), worst 3,485 (1.52%) — against 18,368 (8.2%) for the ledger it
replaces. Before 2026-06-26 the rewards term has no data and is held flat, so
its delta is zero there; that biases those days by at most the rewards accrued
by then (~2.6k, ~1%). Rows say which source they came from, so a consumer can
treat derived days differently if it ever matters.

Outputs JSON to stdout -> data/polymarket-nav-history.json

Env:
  PM_WALLET - comma-separated wallet addresses (defaults to the tracked pair)
"""
from __future__ import annotations
import json, os, sys
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "data"))

DEFAULT_WALLETS = [
    "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a",
    "0xfaf680c17a9cca24ff0773ae2d9f7db49c02cc47",
]
WALLETS = [w.strip() for w in os.environ.get("PM_WALLET", ",".join(DEFAULT_WALLETS)).split(",") if w.strip()]

# Polymarket was funded before the transfer ledger opens, so days before the
# first transfer describe capital this script cannot attribute. They are still
# emitted (the backward anchor handles them correctly) but the consumer floors
# at the first transfer anyway, where the reconstruction has something to stand on.
REWARD_KEYS = ("lp", "yield", "maker", "sponsored", "uma")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def load(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def pnl_series() -> dict[str, float]:
    """Summed cumulative user-pnl by date. Prefers the committed snapshot so a
    CI run without network still rebuilds; falls back to the live API."""
    snap = load(os.path.join(DATA, "polymarket-pnl.json"))
    rows = (snap or {}).get("rows") or []
    if rows:
        log(f"pnl: {len(rows)} rows from polymarket-pnl.json")
    else:
        from curl_cffi import requests
        sess = requests.Session(impersonate="chrome124")
        per = []
        for w in WALLETS:
            r = sess.get("https://user-pnl-api.polymarket.com/user-pnl"
                         f"?user_address={w}&interval=all&fidelity=1d", timeout=20)
            r.raise_for_status()
            raw = r.json()
            per.append(sorted((int(x["t"]), float(x["p"])) for x in raw if "t" in x and "p" in x))
            log(f"pnl: fetched {len(per[-1])} points for {w[:10]}")
        ts = sorted({t for s in per for t, _ in s})
        cur = [0.0] * len(per)
        idx = [0] * len(per)
        rows = []
        for t in ts:
            for i, s in enumerate(per):
                while idx[i] < len(s) and s[idx[i]][0] <= t:
                    cur[i] = s[idx[i]][1]
                    idx[i] += 1
            rows.append({"t": t, "p": sum(cur)})

    out = {}
    for r in rows:
        d = datetime.fromtimestamp(int(r["t"]), timezone.utc).date().isoformat()
        out[d] = float(r["p"])       # last point wins within a day
    return out


def step_lookup(m: dict[str, float]):
    """Last known value on or before a date; 0 before the series starts."""
    keys = sorted(m)
    def at(d: str) -> float:
        lo, hi, best = 0, len(keys) - 1, -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if keys[mid] <= d:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        return m[keys[best]] if best >= 0 else 0.0
    return at


def main() -> int:
    content = load(os.path.join(DATA, "content.json")) or {}
    transfers = content.get("pmTransfers") or []
    bd = load(os.path.join(DATA, "polymarket-breakdown-history.json")) or {}
    bd_rows = bd.get("rows") or []

    recorded = {r["d"]: float(r["nav"]) for r in bd_rows if r.get("d") and r.get("nav") is not None}
    if not recorded:
        log("no recorded PM nav yet — refusing to emit a fully derived series")
        return 1

    rewards = {r["d"]: float(sum(r.get(k, 0) or 0 for k in REWARD_KEYS))
               for r in bd_rows if r.get("d")}

    pnl = pnl_series()
    if not pnl:
        log("no pnl series available")
        return 1

    pnl_at = step_lookup(pnl)
    rew_at = step_lookup(rewards)

    def tr_at(d: str) -> float:
        return float(sum(t.get("amount", 0) for t in transfers if t.get("date") and t["date"] <= d))

    anchor = min(recorded)                      # oldest recorded day
    a_nav, a_tr = recorded[anchor], tr_at(anchor)
    a_pnl, a_rew = pnl_at(anchor), rew_at(anchor)
    log(f"anchor {anchor}: nav={a_nav:,.0f} transfers={a_tr:,.0f} pnl={a_pnl:,.0f} rewards={a_rew:,.0f}")

    # Floor at the first transfer. Differencing cancels a seed that sat there
    # the whole time, but not money that entered outside the ledger between two
    # dates — and running this unfloored puts NAV negative on every day from
    # 2025-10-02 to 2026-01-08, which is that exact hole showing itself. Before
    # the ledger opens there is no honest number here, so emit none and let the
    # consumer fall back (to a zero PM contribution, as today).
    first_transfer = min((t["date"] for t in transfers if t.get("date")), default=None)
    if not first_transfer:
        log("no transfers ledger — nothing to floor against")
        return 1
    start = date.fromisoformat(max(first_transfer, min(pnl)))
    end = date.fromisoformat(max(max(pnl), max(recorded)))
    log(f"flooring at first transfer {first_transfer}")
    rows, n_rec, n_der = [], 0, 0
    d = start
    while d <= end:
        ds = d.isoformat()
        if ds in recorded:
            rows.append({"d": ds, "nav": round(recorded[ds], 2), "src": "recorded"})
            n_rec += 1
        else:
            nav = a_nav - (a_tr - tr_at(ds)) - (a_pnl - pnl_at(ds)) - (a_rew - rew_at(ds))
            rows.append({"d": ds, "nav": round(nav, 2), "src": "derived"})
            n_der += 1
        d += timedelta(days=1)

    log(f"{len(rows)} rows ({rows[0]['d']} .. {rows[-1]['d']}): {n_rec} recorded, {n_der} derived")
    print(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "wallets": WALLETS,
        "method": {
            "recorded": "polymarket-breakdown-history.json balances.nav (from 2026-07-15)",
            "derived": "oldest recorded nav, walked back by transfers + user-pnl + rewards deltas",
            "anchor": anchor,
        },
        "rows": rows,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
