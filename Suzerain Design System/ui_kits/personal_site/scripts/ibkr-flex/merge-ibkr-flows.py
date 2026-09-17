#!/usr/bin/env python3
"""
Accumulate portfolio.json's `flows` (IBKR deposits/withdrawals of $5k and up,
see build_flow_marks in fetch-ibkr.py) into a growing history, ibkr-flows.json.

Why: the Flex query only returns ~365 trailing days, so a flow ages out of
portfolio.json a year after it happened. The capital chart's MAX range still
needs its marker. Same reason nav-history.json exists, same shape of fix.

Contract:
  ibkr-flows.json = { "generatedAt": ISO8601,
                      "rows": [{ "d": "YYYY-MM-DD", "amount": int }] }
  amount is the day's net flow in USD, rounded to the nearest $1k; positive is
  money into IBKR. Only days with |amount| >= FLOW_MARK_MIN are present.

Merge: stored rows before the incoming window's first NAV day are kept
verbatim; from that day on the incoming statement wins, including by leaving a
day out, so a restated or reclassified flow is corrected rather than stacked.

Seed: with no history file yet, the stored side is derived from nav-history.json,
which carries both NAV (`n`) and deposit-adjusted P&L (`v`) per day. Their
difference only moves by a flow, so each day's flow is dNAV - dP&L. The first
statement run afterwards replaces the trailing year with build_cash_flows' own
figures; only the days before its window stay derived.

Usage:
  merge-ibkr-flows.py [portfolio.json] [nav-history.json] [ibkr-flows.json]
Defaults resolve to ../../data/ relative to this file.

Stdlib only. Never destroys history on a bad/empty input — it exits 0 untouched.
"""
from __future__ import annotations
import importlib.util, json, os, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "data"))

# One definition of the threshold and the rounding, shared with the fetch.
_spec = importlib.util.spec_from_file_location("fetch_ibkr", os.path.join(HERE, "fetch-ibkr.py"))
fetch_ibkr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch_ibkr)


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def derive_from_nav_history(rows: list[dict]) -> list[dict]:
    flows: dict[str, float] = {}
    prev = None
    for r in sorted((r for r in rows if r.get("d")), key=lambda r: r["d"]):
        if prev is not None and r.get("n") is not None and prev.get("n") is not None \
                and r.get("v") is not None and prev.get("v") is not None:
            flows[r["d"]] = (r["n"] - prev["n"]) - (r["v"] - prev["v"])
        prev = r
    return fetch_ibkr.build_flow_marks(flows)


def merge(incoming: list[dict], window_start: str, existing: list[dict]) -> list[dict]:
    kept = [r for r in existing if r.get("d") and r["d"] < window_start]
    fresh = [{"d": r["d"], "amount": int(r["amount"])}
             for r in incoming if r.get("d") and r["d"] >= window_start]
    return sorted(kept + fresh, key=lambda r: r["d"])


def main() -> int:
    portfolio_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "portfolio.json")
    nav_history_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "nav-history.json")
    history_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(DATA, "ibkr-flows.json")

    history = load_json(history_path)
    if history is not None:
        existing = history.get("rows") or []
        source = "history"
    else:
        existing = derive_from_nav_history((load_json(nav_history_path) or {}).get("rows") or [])
        source = "seeded from nav-history"

    portfolio = load_json(portfolio_path) or {}
    nav_series = portfolio.get("navSeries") or []
    if "flows" in portfolio and nav_series:
        rows = merge(portfolio["flows"] or [], nav_series[0]["d"], existing)
    elif history is not None:
        # An old-format or failed snapshot says nothing about flows. Leave the
        # history alone rather than reading silence as "no flows this year".
        print("no flows in portfolio.json - ibkr-flows history left unchanged", file=sys.stderr)
        return 0
    else:
        rows = existing

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "rows": rows,
    }
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    # Counts only: this runs in a world-readable Actions log.
    print(f"ibkr-flows: {len(existing)} ({source}) -> {len(rows)} rows", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
