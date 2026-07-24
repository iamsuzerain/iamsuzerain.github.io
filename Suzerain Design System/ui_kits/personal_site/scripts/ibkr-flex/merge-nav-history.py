#!/usr/bin/env python3
"""
Stitch each daily portfolio.json `pnlSeries` snapshot into a growing multi-year
cumulative-$ P&L history (nav-history.json).

Why: the IBKR Flex query only returns ~365 trailing days, so portfolio.json's
series rolls forward and drops its oldest day every run. The site's combined
chart needs a curve that spans the *full* account history so old blog markers
(dated log entries) keep charting under the MAX range. This script preserves the
days that age out of the Flex window.

Contract:
  nav-history.json = { "generatedAt": ISO8601,
                       "rows": [{ "d": "YYYY-MM-DD", "v": float, "t": float }] }
  where v is cumulative deposit-adjusted $ P&L (drives the combined chart) and t
  is cumulative time-weighted return as a ratio (drives the IBKR chart), both on
  the *seed snapshot's* baseline (v = 0 and t = 0 at the earliest date recorded).
  v stitches additively; t stitches multiplicatively (returns chain). `t` is
  optional per row — rows seeded before it was tracked simply won't extend the
  TWR curve.

Usage:
  merge-nav-history.py [portfolio.json] [nav-history.json]
Defaults resolve to ../../data/{portfolio,nav-history}.json relative to this file.

Stdlib only. Never destroys history on a bad/empty input — it exits 0 untouched.
"""
from __future__ import annotations
import json, os, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "data"))


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def merge(incoming: list[dict], existing: list[dict]) -> list[dict]:
    """Overlap-align the incoming snapshot onto the stored history's baseline,
    then keep older stored rows and let incoming win on the recent overlap.

    Each series is rebased to its own origin, so we align the incoming block to
    the stored baseline at their newest common date (the seam): the $ P&L `v`
    shifts additively; the TWR `t` scales multiplicatively (chained returns).
    Incoming wins on overlapping dates so NAV corrections/overrides propagate.
    Rows older than the incoming window are retained verbatim.
    """
    inc = []
    for r in incoming:
        if not r.get("d"):
            continue
        row = {"d": r["d"], "v": round(float(r["v"]), 2)}
        if r.get("t") is not None:
            row["t"] = round(float(r["t"]), 6)
        inc.append(row)
    inc.sort(key=lambda r: r["d"])
    if not inc:
        return existing
    if not existing:
        return inc  # first run: seed directly, incoming's origin becomes the baseline

    ex = {r["d"]: r for r in existing if r.get("d")}
    inc_map = {r["d"]: r for r in inc}
    inc_start = inc[0]["d"]

    common = sorted(d for d in ex if d in inc_map)
    seam = common[-1] if common else max(ex)     # newest shared date, else last stored
    base_inc = inc_map[seam] if common else inc[0]
    v_off = round(ex[seam]["v"] - base_inc["v"], 2)
    et, it = ex[seam].get("t"), base_inc.get("t")
    t_factor = (1 + et) / (1 + it) if (et is not None and it is not None and (1 + it) != 0) else None

    merged = {d: r for d, r in ex.items() if d < inc_start}   # keep the pre-window tail
    for r in inc:
        row = {"d": r["d"], "v": round(r["v"] + v_off, 2)}    # incoming wins on overlap
        if "t" in r:
            row["t"] = round((1 + r["t"]) * t_factor - 1, 6) if t_factor is not None else r["t"]
        merged[r["d"]] = row
    return [merged[d] for d in sorted(merged)]


def main() -> int:
    portfolio_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "portfolio.json")
    history_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "nav-history.json")

    portfolio = load_json(portfolio_path)
    pnl = (portfolio or {}).get("pnlSeries") or []
    if not pnl:
        # Nothing to merge — leave any existing history untouched so a bad or
        # partial IBKR fetch can never wipe the accumulated record.
        print("no pnlSeries in portfolio.json — history left unchanged", file=sys.stderr)
        return 0

    # Pair each $ P&L point with the same day's TWR (perfSeries) so the history
    # carries both the combined chart's $ curve and the IBKR chart's TWR curve.
    twr = {r["d"]: r["v"] for r in ((portfolio or {}).get("perfSeries") or []) if r.get("d")}
    incoming = [{"d": r["d"], "v": r["v"], "t": twr.get(r["d"])} for r in pnl]

    history = load_json(history_path)
    existing = (history or {}).get("rows") or []

    rows = merge(incoming, existing)
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "rows": rows,
    }
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"nav-history: {len(existing)} -> {len(rows)} rows "
          f"({rows[0]['d']} .. {rows[-1]['d']})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
