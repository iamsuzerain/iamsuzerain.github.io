#!/usr/bin/env python3
"""
Fetch latest IBKR Flex Query, transform to portfolio.json.

Env:
  IBKR_FLEX_TOKEN     — long-lived token from Client Portal → FlexWeb Service
  IBKR_FLEX_QUERY_ID  — numeric query id from your saved Flex Query

Writes JSON to stdout. Pipe it into ui_kits/personal_site/data/portfolio.json.
Stdlib only.
"""
from __future__ import annotations
import json, os, sys, time, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone

BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
SEND = f"{BASE}/SendRequest"
GET  = f"{BASE}/GetStatement"
VERSION = "3"

# asset-class → legend color (mirrors the allocation palette the UI expects)
CLASS_COLORS = {
    "us equities":   "#a78bfa",
    "intl equities": "#c4b5fd",
    "bonds":         "#7c5cf5",
    "crypto":        "#ff4fd8",
    "options":       "#ff9ae8",
    "cash":          "#3d2a5c",
    "other":         "#5a4480",
}


def fetch(url: str) -> ET.Element:
    req = urllib.request.Request(url, headers={"User-Agent": "suzerain-site/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    root = ET.fromstring(body)
    status = root.findtext("Status") or ""
    if status and status != "Success":
        err_code = root.findtext("ErrorCode") or "?"
        err_msg = root.findtext("ErrorMessage") or "unknown"
        raise SystemExit(f"IBKR Flex error {err_code}: {err_msg}")
    return root


def run_flex(token: str, query_id: str) -> ET.Element:
    # Step 1: SendRequest -> ReferenceCode
    params = urllib.parse.urlencode({"t": token, "q": query_id, "v": VERSION})
    root = fetch(f"{SEND}?{params}")
    ref = root.findtext("ReferenceCode")
    if not ref:
        raise SystemExit("no ReferenceCode in SendRequest response")

    # Step 2: GetStatement (poll, because IBKR renders on demand)
    get_params = urllib.parse.urlencode({"t": token, "q": ref, "v": VERSION})
    url = f"{GET}?{get_params}"
    last_err = None
    for attempt in range(8):
        time.sleep(5 + attempt * 4)  # 5, 9, 13, ... ~backoff
        try:
            root = fetch(url)
            # A successful statement has FlexStatements as the root tag, not Status
            if root.tag == "FlexQueryResponse":
                return root
        except SystemExit as e:
            last_err = e
            # code 1019 = "Statement generation in progress". Retry.
            if "1019" in str(e) or "1018" in str(e):
                continue
            raise
    raise last_err or SystemExit("Flex statement never ready after 8 polls")


# ---------- transforms ----------

def to_float(x, default=0.0):
    try: return float(x)
    except (TypeError, ValueError): return default

def to_int(x, default=0):
    try: return int(float(x))
    except (TypeError, ValueError): return default


def classify(asset_class: str, sub_category: str, currency: str) -> str:
    ac = (asset_class or "").upper()
    sub = (sub_category or "").upper()
    if ac == "CASH":  return "cash"
    if ac == "BOND" or "BOND" in sub: return "bonds"
    if ac == "OPT":   return "options"
    if ac == "CRYPTO" or "CRYPTO" in sub: return "crypto"
    if ac == "STK":
        return "us equities" if currency == "USD" else "intl equities"
    return "other"


def build_positions(root: ET.Element) -> list[dict]:
    out = []
    for p in root.iter("OpenPosition"):
        symbol = p.get("symbol") or ""
        if not symbol: continue
        qty = to_float(p.get("position"))
        mkt = to_float(p.get("positionValue") or p.get("fifoPnlUnrealized"))
        cost = to_float(p.get("costBasisMoney"))
        unreal = to_float(p.get("fifoPnlUnrealized"))
        out.append({
            "symbol": symbol,
            "name": p.get("description") or symbol,
            "qty": qty,
            "mktValue": mkt,
            "costBasis": cost,
            "unrealized": unreal,
            "assetClass": p.get("assetCategory") or "",
            "subCategory": p.get("subCategory") or "",
            "currency": p.get("currency") or "USD",
        })
    return sorted(out, key=lambda r: -abs(r["mktValue"]))


def build_allocation(positions: list[dict], cash: float) -> list[dict]:
    buckets: dict[str, float] = {}
    for p in positions:
        k = classify(p["assetClass"], p["subCategory"], p["currency"])
        buckets[k] = buckets.get(k, 0) + p["mktValue"]
    if cash > 0:
        buckets["cash"] = buckets.get("cash", 0) + cash
    total = sum(buckets.values()) or 1
    # preserve a canonical order
    order = ["us equities", "intl equities", "bonds", "crypto", "options", "cash", "other"]
    alloc = []
    for k in order:
        if k in buckets and buckets[k] > 0:
            alloc.append({
                "label": k,
                "pct": buckets[k] / total,
                "color": CLASS_COLORS.get(k, "#5a4480"),
            })
    return alloc


def build_nav_series(root: ET.Element) -> list[dict]:
    """Prefer <EquitySummaryByReportDateInBase> rows — one per date."""
    series = []
    for row in root.iter("EquitySummaryByReportDateInBase"):
        d = row.get("reportDate") or row.get("fromDate")
        v = to_float(row.get("total"))
        if d and v:
            # normalize 20260423 -> 2026-04-23
            if len(d) == 8 and d.isdigit():
                d = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
            series.append({"d": d, "v": v})
    return sorted(series, key=lambda r: r["d"])


def build_pnl(root: ET.Element, nav_series: list[dict], nav: float) -> dict:
    """Pull PnL from MTMPerformanceSummary / ChangeInNAV and NAV series."""
    def g(tag, attr):
        el = root.find(f".//{tag}")
        return to_float(el.get(attr)) if el is not None else 0.0

    def series_pnl(series: list[dict], from_date_prefix: str) -> tuple[float, float]:
        """Return (abs, pct) change from the first entry on/after from_date_prefix."""
        start = next((p for p in series if p["d"] >= from_date_prefix), None)
        if not start or nav == 0:
            return 0.0, 0.0
        start_v = start["v"]
        abs_chg = nav - start_v
        pct_chg = abs_chg / start_v if start_v else 0.0
        return abs_chg, pct_chg

    day_abs = g("MTMPerformanceSummaryUnderlying", "mtm")
    day_pct = g("MTMPerformanceSummaryUnderlying", "mtmPct") / 100.0
    mtd_abs = g("ChangeInNAV", "mtm")
    mtd_pct = g("ChangeInNAV", "twr") / 100.0

    cur_year = str(datetime.now(timezone.utc).year)
    cur_month = datetime.now(timezone.utc).strftime("%Y-%m")
    ytd_abs, ytd_pct = series_pnl(nav_series, f"{cur_year}-01-01")
    itd_abs, itd_pct = series_pnl(nav_series, "0000-00-00")  # first ever point

    # prefer mtd from ChangeInNAV if available, else derive from series
    if mtd_abs == 0.0:
        mtd_abs, mtd_pct = series_pnl(nav_series, cur_month + "-01")

    return {
        "day": {"abs": day_abs, "pct": day_pct},
        "mtd": {"abs": mtd_abs, "pct": mtd_pct},
        "ytd": {"abs": ytd_abs, "pct": ytd_pct},
        "itd": {"abs": itd_abs, "pct": itd_pct},
    }


def mask_account(acct_id: str) -> str:
    if not acct_id: return "U••••"
    return "U••••" + acct_id[-3:]


def transform(root: ET.Element) -> dict:
    stmt = root.find(".//FlexStatement")
    if stmt is None:
        raise SystemExit("no FlexStatement in response")
    acct_id = stmt.get("accountId") or ""

    # latest equity row = current NAV + cash
    rows = list(root.iter("EquitySummaryByReportDateInBase"))
    last = rows[-1] if rows else None
    nav = to_float(last.get("total")) if last is not None else 0.0
    cash = to_float(last.get("cash")) if last is not None else 0.0
    stock = to_float(last.get("stock")) if last is not None else 0.0

    positions = build_positions(root)
    for p in positions:
        p["weight"] = (p["mktValue"] / nav) if nav > 0 else 0.0

    nav_series = build_nav_series(root)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "account": {
            "id": mask_account(acct_id),
            "currency": "USD",
            "nav": nav,
            "cash": cash,
            "buyingPower": nav * 2,
        },
        "pnl": build_pnl(root, nav_series, nav),
        "navSeries": nav_series,
        "allocation": build_allocation(positions, cash),
        "positions": positions[:12],  # top 12 by value
    }


def main() -> int:
    token = os.environ.get("IBKR_FLEX_TOKEN")
    qid = os.environ.get("IBKR_FLEX_QUERY_ID")
    if not token or not qid:
        print("missing IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID", file=sys.stderr)
        return 2
    try:
        root = run_flex(token, qid)
        data = transform(root)
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return 1
    json.dump(data, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
