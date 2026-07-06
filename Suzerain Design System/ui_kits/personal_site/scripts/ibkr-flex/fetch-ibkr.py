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


def _norm_date(raw: str) -> str | None:
    """Normalize IBKR date strings (20260423 or 2026-04-23) to YYYY-MM-DD."""
    raw = raw.replace("-", "")
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    return None


def build_nav_series(root: ET.Element) -> list[dict]:
    """Prefer <EquitySummaryByReportDateInBase> rows — one per date.
    Also captures depositsWithdrawals per day for TWR computation.
    """
    series = []
    for row in root.iter("EquitySummaryByReportDateInBase"):
        d = row.get("reportDate") or row.get("fromDate")
        v = to_float(row.get("total"))
        if d and v:
            if len(d) == 8 and d.isdigit():
                d = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
            cf = to_float(row.get("depositsWithdrawals") or "0")
            series.append({"d": d, "v": v, "cf": cf})
    return sorted(series, key=lambda r: r["d"])


def build_cash_flows(root: ET.Element) -> dict[str, float]:
    """Per-day net deposits/withdrawals from CashTransaction nodes.
    Requires Cash Transactions section enabled in the Flex Query.
    """
    seen: set[str] = set()
    flows: dict[str, float] = {}
    for tx in root.iter("CashTransaction"):
        tx_type = (tx.get("type") or "").lower()
        if "deposit" not in tx_type and "withdrawal" not in tx_type:
            continue
        raw = (tx.get("reportDate") or tx.get("dateTime") or "").split(";")[0].split(" ")[0]
        d = _norm_date(raw.replace("-", ""))
        if not d:
            continue
        # Deduplicate: IBKR Flex returns each CashTransaction twice (once per
        # currency section — BASE and native currency). transactionID differs
        # between the two copies, so we use only the composite key.
        tx_id = f"{d}|{tx_type}|{tx.get('amount')}"
        if tx_id in seen:
            continue
        seen.add(tx_id)
        flows[d] = flows.get(d, 0.0) + to_float(tx.get("amount"))
    return flows


def build_perf_series(nav_series: list[dict], cash_flows: dict[str, float]) -> list[dict]:
    """Daily-chain TWR. v is cumulative return as a ratio (0.15 = +15%).

    Prefers CashTransaction-derived flows; falls back to depositsWithdrawals
    from EquitySummaryByReportDateInBase if no CashTransaction data is present.

    HPR_i = (NAV_i - CF_i) / NAV_{i-1} - 1
    """
    if len(nav_series) < 2:
        return [{"d": p["d"], "v": 0.0} for p in nav_series]

    use_cash_flows = bool(cash_flows)
    perf = [{"d": nav_series[0]["d"], "v": 0.0}]
    cumulative = 1.0
    for i in range(1, len(nav_series)):
        prev = nav_series[i - 1]["v"]
        curr = nav_series[i]["v"]
        d = nav_series[i]["d"]
        cf = cash_flows.get(d, 0.0) if use_cash_flows else nav_series[i].get("cf", 0.0)
        hpr = ((curr - cf) / prev - 1.0) if prev else 0.0
        cumulative *= (1.0 + hpr)
        perf.append({"d": d, "v": round(cumulative - 1.0, 6)})

    return perf


def period_flows(cash_flows: dict[str, float], from_date: str, to_date: str) -> float:
    """Sum daily cash flows (from build_cash_flows) between [from_date, to_date)."""
    return sum(v for d, v in cash_flows.items() if from_date <= d < to_date)


def parse_cash_report(root: ET.Element, cash_flows: dict[str, float]) -> dict:
    """Net deposit/withdrawal flows for MTD, QTD, and YTD.

    Prefers per-day CashTransaction data (cash_flows) so QTD is computed
    directly from the quarter date range rather than guessed from the month.
    Falls back to CashReportCurrency pre-aggregated totals when no CashTransaction
    records are present (e.g. that section isn't enabled in the Flex Query).
    """
    now = datetime.now(timezone.utc)
    cur_year = str(now.year)
    cur_month = now.strftime("%Y-%m")
    quarter_start_month = ((now.month - 1) // 3) * 3 + 1
    cur_quarter = f"{cur_year}-{quarter_start_month:02d}-01"
    tomorrow = (now.date().isoformat())[:10]

    if cash_flows:
        return {
            "mtd": period_flows(cash_flows, cur_month + "-01", tomorrow),
            "qtd": period_flows(cash_flows, cur_quarter, tomorrow),
            "ytd": period_flows(cash_flows, f"{cur_year}-01-01", tomorrow),
        }

    # Fallback: CashReportCurrency pre-aggregated totals (no QTD field in IBKR).
    el = next((e for e in root.iter("CashReportCurrency")
               if e.get("levelOfDetail") == "BaseCurrency"), None)
    if el is None:
        return {"mtd": 0.0, "qtd": 0.0, "ytd": 0.0}

    mtd = to_float(el.get("depositWithdrawalsMTD") or "0")
    ytd = to_float(el.get("depositWithdrawalsYTD") or "0")
    # Best approximation without per-day data: YTD minus prior-quarter portion.
    # We don't have prior-quarter totals, so use MTD as a lower bound (correct
    # only in Q1/Q2/Q3/Q4 first month) — flag as approximate.
    qtd = mtd if now.month in (1, 4, 7, 10) else ytd
    return {"mtd": mtd, "qtd": qtd, "ytd": ytd}


def adjusted_pnl(start_v: float, end_v: float, net_deposits: float) -> tuple[float, float]:
    """Simple deposit-adjusted return. abs = (end-start) - net_deposits. pct = abs / start."""
    abs_chg = (end_v - start_v) - net_deposits
    return abs_chg, (abs_chg / start_v if start_v else 0.0)


def build_pnl(root: ET.Element, nav_series: list[dict], nav: float, cash_flows: dict[str, float],
              nav_correction: float = 0.0, perf_series: list[dict] | None = None) -> dict:
    """Deposit-adjusted PnL for MTD, QTD, YTD using CashReportCurrency pre-aggregated flows.
    1Y uses ChangeInNAV.twr — IBKR's own time-weighted return over the 365-day query period.
    """
    now = datetime.now(timezone.utc)
    cur_year = str(now.year)
    cur_month = now.strftime("%Y-%m")
    quarter_start_month = ((now.month - 1) // 3) * 3 + 1
    cur_quarter = f"{cur_year}-{quarter_start_month:02d}-01"

    flows = parse_cash_report(root, cash_flows)

    def start_nav(from_date: str) -> float:
        # Use the closing NAV of the last trading day before the period opens.
        # Deposits on the first day of a period are already in that day's closing NAV,
        # so we must start from the prior day to avoid double-counting them.
        candidates = [p for p in nav_series if p["d"] < from_date]
        return candidates[-1]["v"] if candidates else 0.0

    mtd_abs, mtd_pct = adjusted_pnl(start_nav(cur_month + "-01"),        nav, flows["mtd"])
    qtd_abs, qtd_pct = adjusted_pnl(start_nav(cur_quarter),               nav, flows["qtd"])
    ytd_abs, ytd_pct = adjusted_pnl(start_nav(f"{cur_year}-01-01"),       nav, flows["ytd"])

    cin = root.find(".//ChangeInNAV")
    if cin is not None:
        cin_start = to_float(cin.get("startingValue") or "0")
        cin_end   = to_float(cin.get("endingValue")   or "0") + nav_correction
        cin_dw    = to_float(cin.get("depositsWithdrawals") or "0")
        oney_abs  = (cin_end - cin_start) - cin_dw
        if nav_correction and perf_series:
            # The bad day is the statement's ending NAV, so it *does* corrupt the
            # 1Y figure (an intermediate bad day would cancel in TWR chaining).
            # IBKR's own TWR still embeds it, so use our corrected daily-chained
            # return over the (≈1-year) query window instead.
            oney_pct = perf_series[-1]["v"]
        else:
            oney_pct = to_float(cin.get("twr") or "0") / 100.0
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


# ── Manual corrections for known-bad vendor marks ───────────────────────────
# IBKR bakes a bad mark into that day's EquitySummary total *and* keeps it in
# every future statement's history, so corrections must be absolute and applied
# on every run — not just when the bad day is the statement's as-of date.
#
# POSITION_OVERRIDES — corrected total market value for a position leg, keyed by
#   (date, symbol). Fixes the OpenPosition snapshot (weights/allocation) on the
#   statement whose as-of date matches; a no-op on later statements, where that
#   date is no longer the open-position snapshot.
# NAV_OVERRIDES — corrected end-of-day NAV, keyed by date. Patches that day's
#   point in the historical equity curve on every run, so the spike never
#   reappears once the statement rolls forward.
#
# Keep both minimal and mutually consistent (Δ position == Δ NAV for the day);
# remove an entry once IBKR corrects the mark upstream.
# Emptied 2026-07-06: IBKR corrected the 2026-07-02 MU mark upstream, so the
# overrides below are no longer needed (and, being absolute + applied every run,
# would clobber IBKR's now-correct data). Retired values, for reference:
#   POSITION_OVERRIDES ("2026-07-02", "MU"): 292500.0   # 300 sh × $975.00
#   NAV_OVERRIDES      "2026-07-02":          700097.33032514  # was 751,181.33
POSITION_OVERRIDES: dict[tuple[str, str], float] = {}
NAV_OVERRIDES: dict[str, float] = {}


def apply_mark_overrides(positions: list[dict], nav_series: list[dict],
                         as_of: str | None) -> float:
    """Patch known-bad vendor marks in place.

    Corrects the OpenPosition snapshot for the statement's as-of date and every
    overridden day in the historical equity curve. Returns the net NAV
    correction applied *on the as-of date* (0 unless the bad day is the current
    snapshot), so the caller can propagate it into IBKR's pre-aggregated
    ChangeInNAV endpoints for that statement.
    """
    for p in positions:
        if as_of and (as_of, p["symbol"]) in POSITION_OVERRIDES:
            corrected = POSITION_OVERRIDES[(as_of, p["symbol"])]
            p["unrealized"] = corrected - p["costBasis"]
            p["mktValue"] = corrected
    nav_correction = 0.0
    for row in nav_series:
        if row["d"] in NAV_OVERRIDES:
            corrected = NAV_OVERRIDES[row["d"]]
            if row["d"] == as_of:
                nav_correction += corrected - row["v"]
            row["v"] = corrected
    return nav_correction


def transform(root: ET.Element) -> dict:
    stmt = root.find(".//FlexStatement")
    if stmt is None:
        raise SystemExit("no FlexStatement in response")
    acct_id = stmt.get("accountId") or ""

    # latest equity row = current cash (NAV comes from the corrected nav_series)
    rows = list(root.iter("EquitySummaryByReportDateInBase"))
    last = rows[-1] if rows else None
    cash = to_float(last.get("cash")) if last is not None else 0.0

    positions = build_positions(root)
    nav_series = build_nav_series(root)
    cash_flows = build_cash_flows(root)

    # Patch known-bad vendor marks before deriving NAV, weights, allocation, PnL.
    as_of = nav_series[-1]["d"] if nav_series else None
    nav_correction = apply_mark_overrides(positions, nav_series, as_of)
    positions.sort(key=lambda r: -abs(r["mktValue"]))

    nav = nav_series[-1]["v"] if nav_series else 0.0
    for p in positions:
        p["weight"] = (p["mktValue"] / nav) if nav > 0 else 0.0

    perf_series = build_perf_series(nav_series, cash_flows)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "account": {
            "id": mask_account(acct_id),
            "currency": "USD",
            "nav": nav,
            "cash": cash,
            "buyingPower": nav * 2,
        },
        "pnl": build_pnl(root, nav_series, nav, cash_flows, nav_correction, perf_series),
        "navSeries": [{"d": p["d"], "v": p["v"]} for p in nav_series],
        "perfSeries": perf_series,
        "allocation": build_allocation(positions, cash),
        "positions": positions[:20],  # top 20 by value
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
