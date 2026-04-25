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
            if len(d) == 8 and d.isdigit():
                d = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
            series.append({"d": d, "v": v})
    return sorted(series, key=lambda r: r["d"])


def _norm_date(raw: str) -> str | None:
    """Normalize IBKR date strings (20260423 or 2026-04-23) to YYYY-MM-DD."""
    raw = raw.replace("-", "")
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    return None


def parse_cash_report(root: ET.Element) -> dict:
    """Read pre-aggregated deposit/withdrawal totals from CashReportCurrency (BASE_SUMMARY).

    Returns net flows (positive = deposit, negative = withdrawal) for MTD, QTD, and YTD.
    QTD is derived from YTD minus pre-quarter YTD; falls back to MTD when in the first
    month of the quarter since MTD == QTD in that case.
    """
    el = next((e for e in root.iter("CashReportCurrency")
               if e.get("levelOfDetail") == "BaseCurrency"), None)
    if el is None:
        return {"mtd": 0.0, "qtd": 0.0, "ytd": 0.0}

    mtd = to_float(el.get("depositWithdrawalsMTD") or "0")
    ytd = to_float(el.get("depositWithdrawalsYTD") or "0")

    # IBKR has no depositWithdrawalsQTD. When the current month is the first month
    # of the quarter (Jan/Apr/Jul/Oct), QTD == MTD. Otherwise approximate as unadjusted (0).
    now = datetime.now(timezone.utc)
    qtd = mtd if now.month in (1, 4, 7, 10) else 0.0

    return {"mtd": mtd, "qtd": qtd, "ytd": ytd}


def adjusted_pnl(start_v: float, end_v: float, net_deposits: float) -> tuple[float, float]:
    """Simple deposit-adjusted return. abs = (end-start) - net_deposits. pct = abs / start."""
    abs_chg = (end_v - start_v) - net_deposits
    return abs_chg, (abs_chg / start_v if start_v else 0.0)


def build_pnl(root: ET.Element, nav_series: list[dict], nav: float) -> dict:
    """Deposit-adjusted PnL for MTD, QTD, YTD using CashReportCurrency pre-aggregated flows.
    1Y uses ChangeInNAV.twr — IBKR's own time-weighted return over the 365-day query period.
    """
    now = datetime.now(timezone.utc)
    cur_year = str(now.year)
    cur_month = now.strftime("%Y-%m")
    quarter_start_month = ((now.month - 1) // 3) * 3 + 1
    cur_quarter = f"{cur_year}-{quarter_start_month:02d}-01"

    flows = parse_cash_report(root)

    def start_nav(from_date: str) -> float:
        p = next((p for p in nav_series if p["d"] >= from_date), None)
        return p["v"] if p else 0.0

    mtd_abs, mtd_pct = adjusted_pnl(start_nav(cur_month + "-01"),        nav, flows["mtd"])
    qtd_abs, qtd_pct = adjusted_pnl(start_nav(cur_quarter),               nav, flows["qtd"])
    ytd_abs, ytd_pct = adjusted_pnl(start_nav(f"{cur_year}-01-01"),       nav, flows["ytd"])

    cin = root.find(".//ChangeInNAV")
    if cin is not None:
        cin_start = to_float(cin.get("startingValue") or "0")
        cin_end   = to_float(cin.get("endingValue")   or "0")
        cin_dw    = to_float(cin.get("depositsWithdrawals") or "0")
        oney_abs  = (cin_end - cin_start) - cin_dw
        oney_pct  = to_float(cin.get("twr") or "0") / 100.0
    else:
        s = start_nav(nav_series[0]["d"] if nav_series else f"{cur_year}-01-01")
        oney_abs, oney_pct = adjusted_pnl(s, nav, flows["ytd"])

    return {
        "mtd":  {"abs": mtd_abs,  "pct": mtd_pct},
        "qtd":  {"abs": qtd_abs,  "pct": qtd_pct},
        "ytd":  {"abs": ytd_abs,  "pct": ytd_pct},
        "1y":   {"abs": oney_abs, "pct": oney_pct},
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
