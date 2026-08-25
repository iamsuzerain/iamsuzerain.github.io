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
import json, math, os, sys, time, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
SEND = f"{BASE}/SendRequest"
GET  = f"{BASE}/GetStatement"
VERSION = "3"

# asset-class → legend color (mirrors the allocation palette the UI expects).
# Futures/FOP get hues off the violet-magenta axis so the six classes this account
# actually holds stay separable under deuteranopia; the emerald/teal pair was picked
# so the worst-separating pair in the set is a pre-existing one rather than one of
# these. Both are deliberately deep rather than bright — futures options can grow
# into a large slice, and a light turquoise or yellow would then dominate the ring
# while also colliding with the pink `options` step for red-blind viewers (classic
# turquoise #40e0d0 separates from it by only ΔE 3.1). teal-600 is additionally the
# only step here inside the dark-mode lightness band, and stays clear of the #5eead4
# the benchmark overlay already uses. The legend direct-labels every slice, which is
# what keeps the low-contrast `cash` step legible.
CLASS_COLORS = {
    "us equities":     "#a78bfa",
    "intl equities":   "#c4b5fd",
    "bonds":           "#7c5cf5",
    "crypto":          "#ff4fd8",
    "options":         "#ff9ae8",
    "futures":         "#34d399",
    "futures options": "#0d9488",
    "cash":            "#3d2a5c",
    "other":           "#5a4480",
}

# Canonical slice order for the allocation donut.
ALLOC_ORDER = ["us equities", "intl equities", "bonds", "crypto", "options",
               "futures", "futures options", "cash", "other"]


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
    if ac == "FOP":   return "futures options"
    if ac == "FUT":   return "futures"
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
    """Share of *gross* exposure per asset class.

    Slices are weighted against gross exposure — Σ|market value| plus |cash| — not
    the signed sum of the buckets. A short position carries real exposure, so
    netting it against the longs shrinks the denominator instead of the numerator:
    with a −$372k short future in the book the old signed total made a single
    equity bucket read 140%, and the donut drew an arc longer than its own
    circumference. Buckets that netted negative were dropped outright, so the
    short leg was invisible on top of that.

    Each slice reports |value| as `pct` (what the arc draws, summing to 1.0) and
    keeps the signed `net` and unsigned `gross` in dollars, so the UI can mark a
    bucket that is net short rather than implying every slice is a long.
    """
    buckets: dict[str, dict] = {}

    def bucket(k: str) -> dict:
        return buckets.setdefault(k, {"gross": 0.0, "net": 0.0})

    for p in positions:
        b = bucket(classify(p["assetClass"], p["subCategory"], p["currency"]))
        b["gross"] += abs(p["mktValue"])
        b["net"] += p["mktValue"]
    if cash:
        # A negative cash balance is a margin loan — real financing exposure, so
        # it counts toward gross rather than being dropped.
        b = bucket("cash")
        b["gross"] += abs(cash)
        b["net"] += cash

    total = sum(b["gross"] for b in buckets.values()) or 1.0
    # Canonical order first, then anything classify() emitted that isn't listed —
    # a new instrument type stays visible instead of being silently dropped.
    order = ALLOC_ORDER + [k for k in buckets if k not in ALLOC_ORDER]
    alloc = []
    for k in order:
        b = buckets.get(k)
        if not b or b["gross"] <= 0:
            continue
        alloc.append({
            "label": k,
            "pct": b["gross"] / total,
            "gross": round(b["gross"], 2),
            "net": round(b["net"], 2),
            "short": b["net"] < 0,
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

    IBKR emits every movement at two levels of detail: a `DETAIL` row per actual
    transaction (real transactionID, real accountId) and one `SUMMARY` row per
    date that aggregates them (transactionID empty, accountId '-'). Both carry
    type "Deposits/Withdrawals", so a naive sum counts every day twice.

    This used to be deduplicated on a `date|type|amount` composite key, on the
    stated theory that the duplication was per-currency (BASE plus native). That
    theory was wrong, and the key it motivated failed in both directions:

      - on a date with ONE movement it worked by accident, because the DETAIL row
        and the SUMMARY row carry the same amount and collide;
      - on a date with SEVERAL, the DETAIL amounts differ from the SUMMARY total,
        nothing collided, and the day was counted twice. 2025-10-21 (-500, -1,000,
        summary -1,500) was read as -3,000;
      - and where two genuinely distinct movements shared a date, type and amount
        it collapsed them into one. 2026-01-23 held two separate -300 transfers a
        second apart; they became a single -300, and then the -600 summary was
        added on top of that.

    Across the 2025-08/2026-08 window those three dates over-counted by exactly
    $2,000, which is the gap that stood against ChangeInNAV for months.

    So: keep one level of detail, and deduplicate on transactionID, which is what
    IBKR actually guarantees unique. DETAIL is preferred over SUMMARY because it
    survives two movements that happen to share a date and amount. Statements
    that carry no levelOfDetail at all fall back to the old composite key.
    """
    rows = []
    for tx in root.iter("CashTransaction"):
        tx_type = (tx.get("type") or "").lower()
        if "deposit" not in tx_type and "withdrawal" not in tx_type:
            continue
        raw = (tx.get("reportDate") or tx.get("dateTime") or "").split(";")[0].split(" ")[0]
        d = _norm_date(raw.replace("-", ""))
        if not d:
            continue
        rows.append((d, tx_type, (tx.get("levelOfDetail") or "").upper(), tx))

    levels = {lod for _, _, lod, _ in rows if lod}
    keep = "DETAIL" if "DETAIL" in levels else ("SUMMARY" if "SUMMARY" in levels else None)

    seen: set[str] = set()
    flows: dict[str, float] = {}
    for d, tx_type, lod, tx in rows:
        if keep and lod != keep:
            continue
        # transactionID is unique per movement and empty on SUMMARY rows; the
        # composite key is the fallback for both of those cases.
        tx_id = tx.get("transactionID") or f"{d}|{tx_type}|{tx.get('amount')}"
        if tx_id in seen:
            continue
        seen.add(tx_id)
        flows[d] = flows.get(d, 0.0) + to_float(tx.get("amount"))
    return flows


# The CashTransaction attributes the reconciliation prints. IBKR sends 46 of
# them; the rest are empty or irrelevant here, and two are actively worth NOT
# echoing — `description` carries the name of the person who initiated the
# transfer, and `accountId` is the unmasked account number. Neither helps
# diagnose a dedup bug, and this report is read and pasted around.
_CT_REPORT_ATTRS = {"levelOfDetail", "transactionID", "currency", "fxRateToBase",
                    "dateTime", "settleDate", "code", "type"}


def _ct_rows(root: ET.Element) -> list[dict]:
    """Every CashTransaction row that build_cash_flows would consider, before
    dedup — date, type, amount, currency. Kept separate from build_cash_flows so
    the reconciliation can see what the dedup key suppressed."""
    out = []
    for tx in root.iter("CashTransaction"):
        tx_type = (tx.get("type") or "").lower()
        if "deposit" not in tx_type and "withdrawal" not in tx_type:
            continue
        raw = (tx.get("reportDate") or tx.get("dateTime") or "").split(";")[0].split(" ")[0]
        d = _norm_date(raw.replace("-", ""))
        if not d:
            continue
        out.append({"d": d, "type": tx_type, "amount": to_float(tx.get("amount")),
                    "currency": (tx.get("currency") or "").upper(),
                    "lod": (tx.get("levelOfDetail") or "").upper(),
                    # The dedup key exactly as build_cash_flows forms it, so the
                    # report can show which rows collide and which do not.
                    "key": tx.get("transactionID") or f"{d}|{tx_type}|{tx.get('amount')}",
                    "attrs": {k: v for k, v in tx.attrib.items()
                              if k in _CT_REPORT_ATTRS and v not in ("", "0.0")}})
    return out


def _pairing_report(rows: list[dict], cash_flows: dict[str, float]) -> list[str]:
    """Per-date check of the DETAIL/SUMMARY invariant build_cash_flows relies on.

    IBKR reports each date twice: one `DETAIL` row per movement, and one
    `SUMMARY` row aggregating them. So for every date, sum(DETAIL) must equal
    SUMMARY, and the flow this script records must equal both. A date where they
    diverge means either the statement is internally inconsistent or the dedup is
    dropping/duplicating a row, and its rows get dumped.

    (This check was originally written against a `raw sum / 2` rule, on the theory
    that the duplication was per-currency. It isn't, and raw/2 only happened to
    work on dates carrying a single movement — which is exactly the blind spot
    that hid the bug. Comparing the two levels directly has no such gap.)
    """
    by_date: dict[str, list[dict]] = {}
    for r in rows:
        by_date.setdefault(r["d"], []).append(r)

    L = ["  DETAIL vs SUMMARY, per date:",
         f"    {'date':11} {'nD':>3} {'sum(DETAIL)':>13} {'SUMMARY':>13} {'recorded':>13}  status"]
    bad: list[str] = []
    for d in sorted(by_date):
        rs = by_date[d]
        det = [r for r in rs if r["lod"] == "DETAIL"]
        summ = [r for r in rs if r["lod"] == "SUMMARY"]
        det_sum = sum(r["amount"] for r in det)
        summ_sum = sum(r["amount"] for r in summ)
        ded = cash_flows.get(d, 0.0)
        # Only compare against SUMMARY where one exists; some statements carry
        # only one level, and that is not an error.
        parts = [det_sum] if det else []
        if summ:
            parts.append(summ_sum)
        mismatch = any(abs(p - ded) >= 0.005 for p in parts)
        levels_disagree = bool(det and summ) and abs(det_sum - summ_sum) >= 0.005
        status = "ok"
        if levels_disagree: status = "DETAIL != SUMMARY"
        elif mismatch:      status = "RECORDED != STATEMENT"
        if status != "ok":
            bad.append(d)
        L.append(f"    {d:11} {len(det):>3} {det_sum:>13,.2f} "
                 f"{(summ_sum if summ else float('nan')):>13,.2f} {ded:>13,.2f}  {status}")

    if bad:
        L.append(f"  rows on the {len(bad)} suspect date(s):")
        for d in bad:
            for r in sorted(by_date[d], key=lambda r: (r["lod"], r["amount"])):
                extra = " ".join(f"{k}={v}" for k, v in sorted(r["attrs"].items()))
                L.append(f"    {d}  {r['lod']:<8} amount={r['amount']:>12,.2f}  key={r['key']}")
                L.append(f"      {extra}")
    else:
        L.append("  every date reconciles across both levels of detail")

    seen_levels = sorted({r["lod"] for r in rows if r["lod"]}) or ["(none)"]
    L.append(f"  levels of detail present: {', '.join(seen_levels)}")
    return L


def flow_totals(root: ET.Element, nav_series: list[dict],
                cash_flows: dict[str, float]) -> tuple[float, float, float | None]:
    """Window totals for the three deposit/withdrawal sources: (CT, ES, CIN).

    Day 0 is excluded from CT and ES, matching build_pnl_series — a flow dated on
    the window's first day is already inside nav_0's close. CIN makes no such
    exclusion, which is a structural difference rather than a data discrepancy.
    CIN is None when the statement carries no ChangeInNAV element.
    """
    if not nav_series:
        return 0.0, 0.0, None
    day0 = nav_series[0]["d"]
    in_window = {p["d"] for p in nav_series}
    ct_sum = sum(v for d, v in cash_flows.items() if d in in_window and d > day0)
    es_sum = sum(p.get("cf", 0.0) for p in nav_series if p["d"] > day0)
    cin = root.find(".//ChangeInNAV")
    cin_dw = to_float(cin.get("depositsWithdrawals") or "0") if cin is not None else None
    return ct_sum, es_sum, cin_dw


def flow_agreement(root: ET.Element, nav_series: list[dict],
                   cash_flows: dict[str, float]) -> str:
    """One line saying whether the three flow sources agree — and nothing else.

    Safe for a world-readable Actions log by construction: it emits three equality
    flags and a verdict, with no dollar figures, no dates, and no transaction
    counts. Compare against reconcile_flows(), which prints all of those and is
    therefore local-only.

    What it buys: CT and CIN stood a flat $2,000.00 apart on every snapshot from
    2026-07-24 until the DETAIL/SUMMARY fix in build_cash_flows closed it. The
    interesting event is the day that changes again, and a boolean watching a
    constant is exactly the right instrument for that.

    ES is treated as *absent* rather than as zero when the statement reports no
    depositsWithdrawals on any EquitySummary row, which is the case on the site's
    own Flex query. Reading a structural zero as a value would fail every
    comparison against it forever, and a canary that always cries is worse than
    none — it would have gone on printing "three-way disagreement" long after the
    only real disagreement was fixed.

    Tolerance is half a cent, since every input is already rounded to cents.
    """
    ct, es, cin = flow_totals(root, nav_series, cash_flows)
    es_present = any(abs(p.get("cf", 0.0)) >= 0.005 for p in nav_series)
    if not es_present:
        es = None
    eq = lambda a, b: a is not None and b is not None and abs(a - b) < 0.005

    ct_es, ct_cin, es_cin = eq(ct, es), eq(ct, cin), eq(es, cin)
    if cin is None:
        verdict = "no ChangeInNAV to check against"
    elif ct_cin and (es is None or ct_es):
        verdict = "all agree" if es is not None else "CT==CIN (ES not populated)"
    elif ct_cin:
        verdict = "CT==CIN, ES is the outlier"
    elif es is None:
        verdict = "CT!=CIN - suspect build_cash_flows"
    elif es_cin:
        verdict = "suspect build_cash_flows"
    elif ct_es:
        verdict = "suspect IBKR categorization of a transfer"
    else:
        verdict = "three-way disagreement"

    # An absent source is rendered as such rather than as a failed comparison —
    # "ES!=CIN" would claim a disagreement that was never tested.
    absent = {"CIN": cin is None, "ES": es is None, "CT": False}

    def flag(ok, a, b):
        if absent[a] or absent[b]:
            return f"{a}?{b}"
        return f"{a}{'==' if ok else '!='}{b}"

    return ("flow-sources: "
            + " ".join([flag(ct_es, "CT", "ES"),
                        flag(es_cin, "ES", "CIN"),
                        flag(ct_cin, "CT", "CIN")])
            + f" -> {verdict}")


def reconcile_flows(root: ET.Element, nav_series: list[dict],
                    cash_flows: dict[str, float]) -> list[str]:
    """Cross-check the three deposit/withdrawal sources this script mixes.

    The site derives its dollar P&L from two of them and they do not agree: the
    chart's pnlSeries nets out the CashTransaction sum, the "1y" tile nets out
    ChangeInNAV's own depositsWithdrawals, and as of 2026-08 the two land exactly
    $2,000.00 apart on every snapshot in the repo. Portfolio.jsx papers over the
    endpoint with a ratio (pfAnchorDollars), which spreads a fixed dollar error
    across all 262 points and quietly contaminates every shorter window.

    Three sources, in increasing order of aggregation:

      CT   CashTransaction rows, deduped   — drives perfSeries + pnlSeries
      ES   EquitySummaryByReportDateInBase@depositsWithdrawals, per day
           — IBKR's own daily figure, currently only a fallback in this script
      CIN  ChangeInNAV@depositsWithdrawals, one window total — drives the 1y tile

    ES is the useful third party. It is IBKR-derived like CIN but per-day like CT,
    so it both localizes the gap to a date and says which side is wrong:

      ES == CIN, CT differs  -> the bug is ours, in build_cash_flows
      ES == CT,  CIN differs -> IBKR books the movement somewhere other than
                                depositsWithdrawals (internal transfer, position
                                transfer), and the 1y tile is the odd one out

    Day 0 is reported separately rather than folded in. build_pnl_series and
    build_perf_series both start summing at day 1, on the grounds that day-0 flows
    are already inside nav_0's close; CIN makes no such exclusion, so a flow dated
    on the window's first day is a structural difference between the two rather
    than a discrepancy in the data.

    Returns report lines. The caller decides where they go — see main(): NOT the
    Actions log.
    """
    if not nav_series:
        return ["reconcile: no nav series"]

    day0 = nav_series[0]["d"]
    dates = [p["d"] for p in nav_series]
    in_window = set(dates)

    es = {p["d"]: p.get("cf", 0.0) for p in nav_series}
    ct = cash_flows

    # Shared with the canary, so the two can never disagree about the totals.
    ct_sum, es_sum, cin_dw = flow_totals(root, nav_series, cash_flows)
    ct_day0 = ct.get(day0, 0.0)
    es_day0 = es.get(day0, 0.0)

    cin = root.find(".//ChangeInNAV")
    cin_start = to_float(cin.get("startingValue") or "0") if cin is not None else None
    cin_end = to_float(cin.get("endingValue") or "0") if cin is not None else None

    L = [f"reconcile: window {day0} .. {dates[-1]} ({len(dates)} rows)",
         f"  CT  (CashTransaction, deduped, d>day0)  {ct_sum:>16,.2f}",
         f"  ES  (EquitySummary@depositsWithdrawals) {es_sum:>16,.2f}",
         f"  CIN (ChangeInNAV@depositsWithdrawals)   "
         + (f"{cin_dw:>16,.2f}" if cin_dw is not None else "        (absent)"),
         f"  day-0 flows, excluded above: CT {ct_day0:,.2f} / ES {es_day0:,.2f}"]

    if cin_dw is not None:
        L.append(f"  CT-CIN {ct_sum - cin_dw:>+14,.2f}   ES-CIN {es_sum - cin_dw:>+14,.2f}"
                 f"   CT-ES {ct_sum - es_sum:>+14,.2f}")

    # Endpoint check: pnlSeries is anchored on nav_series, the 1y tile on CIN's
    # own endpoints. If those disagree the gap is not about flows at all.
    if cin_start is not None:
        L.append(f"  endpoints: nav_0 {nav_series[0]['v']:,.2f} vs CIN start {cin_start:,.2f}"
                 f"  (delta {nav_series[0]['v'] - cin_start:+,.2f})")
        L.append(f"             nav_n {nav_series[-1]['v']:,.2f} vs CIN end   {cin_end:,.2f}"
                 f"  (delta {nav_series[-1]['v'] - cin_end:+,.2f})")

    # Per-day CT vs ES. Only meaningful when ES carries anything at all — on the
    # site's own Flex query every EquitySummary row reports depositsWithdrawals=0,
    # so the comparison degenerates to "CT vs nothing" and is worse than useless:
    # it prints a disagreement on every date a flow occurred and buries the one
    # that matters. Say so once instead.
    es_present = any(abs(v) >= 0.005 for v in es.values())
    if not es_present:
        L.append("  per-day CT vs ES: SKIPPED - ES is zero on every row, so this")
        L.append("    Flex query does not populate EquitySummary@depositsWithdrawals.")
        L.append("    Note this also makes the ES fallback in build_perf_series /")
        L.append("    build_pnl_series dead: if cash_flows were ever empty, they would")
        L.append("    silently chain a TWR with no flow adjustment at all.")
    else:
        diffs = [(d, ct.get(d, 0.0), es.get(d, 0.0)) for d in dates
                 if d > day0 and round(ct.get(d, 0.0) - es.get(d, 0.0), 2) != 0]
        if diffs:
            L.append(f"  per-day CT vs ES - {len(diffs)} date(s) disagree:")
            for d, a, b in diffs:
                L.append(f"    {d}  CT {a:>14,.2f}   ES {b:>14,.2f}   delta {a - b:>+14,.2f}")
        else:
            L.append("  per-day CT vs ES: agree on every date in the window")

    # Dedup diagnostics. The key is date|type|amount, so the BASE and native
    # copies of a NON-base-currency movement carry different amounts, neither is
    # suppressed, and the flow is counted twice. Any currency here other than the
    # base one is a candidate for exactly that.
    rows = _ct_rows(root)
    kept = len(cash_flows)
    by_ccy: dict[str, list[int | float]] = {}
    for r in rows:
        c = by_ccy.setdefault(r["currency"] or "?", [0, 0.0])
        c[0] += 1
        c[1] += r["amount"]
    L.append(f"  CT rows matching deposit/withdrawal: {len(rows)} raw -> {kept} dates after dedup")
    L.append("  raw CT rows by currency (pre-dedup, so a duplicated pair shows twice):")
    for c, (n, amt) in sorted(by_ccy.items()):
        L.append(f"    {c:<5} n={n:<4} raw sum {amt:>16,.2f}")
    if len(by_ccy) > 1:
        L.append("    NOTE: >1 currency present - the date|type|amount dedup cannot"
                 " suppress the native copy of a non-base movement.")
    raw_total = sum(r["amount"] for r in rows)
    L.append(f"  raw total {raw_total:>16,.2f}   raw/2 {raw_total / 2.0:>16,.2f}"
             + (f"   CIN {cin_dw:>16,.2f}" if cin_dw is not None else ""))
    if cin_dw is not None and abs(raw_total / 2.0 - cin_dw) < 0.005:
        L.append("    raw/2 == CIN exactly: every row is duplicated and IBKR's total"
                 " is the truth, so the deduped figure is the one that is wrong.")
    L.extend(_pairing_report(rows, cash_flows))
    return L


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


def build_pnl_series(nav_series: list[dict], cash_flows: dict[str, float]) -> list[dict]:
    """Daily cumulative deposit-adjusted $ P&L over the statement window, rebased
    to 0 at the first day. This is the dollar analogue of build_perf_series (which
    is a return *ratio*); the site plots it directly and stitches successive
    snapshots into a growing multi-year history (see merge-nav-history.py).

        v_t = (nav_t - nav_0) - Σ flows[day_1 .. day_t]

    Prefers CashTransaction-derived flows (cash_flows); falls back to the
    depositsWithdrawals `cf` carried on each EquitySummary row. nav_series is
    already override-corrected by the caller, so v_t reflects the corrected NAV.
    Day-0 flows are already embedded in nav_0's close, so summing starts at day 1
    — the same convention as build_perf_series / build_pnl's start_nav.
    """
    if not nav_series:
        return []
    base = nav_series[0]["v"]
    use_cash_flows = bool(cash_flows)
    cum_cf = 0.0
    out = [{"d": nav_series[0]["d"], "v": 0.0}]
    for i in range(1, len(nav_series)):
        d = nav_series[i]["d"]
        cf = cash_flows.get(d, 0.0) if use_cash_flows else nav_series[i].get("cf", 0.0)
        cum_cf += cf
        out.append({"d": d, "v": round((nav_series[i]["v"] - base) - cum_cf, 2)})
    return out


_FUT_MONTHS = set("FGHJKMNQUVXZ")  # CME month codes Jan–Dec


def _futures_root(code: str) -> str:
    """Strip a trailing <month-letter><1-2 year digits> so futures contract codes
    collapse to their commodity root: ESM6 -> ES, GCJ6 -> GC, NKDM6 -> NKD.
    Leaves equity tickers untouched (they don't end in month-letter+digits)."""
    n = len(code)
    for dlen in (2, 1):
        if n > dlen + 1 and code[n - dlen:].isdigit() and code[n - dlen - 1] in _FUT_MONTHS:
            root = code[:n - dlen - 1]
            if root:
                return root
    return code


def build_contribution(root: ET.Element) -> list[dict]:
    """Per-symbol contribution to the trailing-period return, from the
    Mark-to-Market Performance Summary (in Base). Each row's `total` is the
    base-currency MTM P&L for that symbol over the statement window — realized +
    unrealized mark-to-market change — so the rows sum to the account's period
    P&L. That is exactly each holding's contribution to the return.

    IBKR nests the rows as <MTMPerformanceSummaryUnderlying> inside
    <MTMPerformanceSummaryInBase>. We fall back to any MTM-performance element
    carrying both a symbol and a total. Rows are rolled up by underlying so one
    name (MU, ES, …) aggregates its stock + every option/future contract, rather
    than the hundreds of individual strikes IBKR lists per year. Summary/subtotal
    rows are skipped, and net-zero underlyings are dropped.
    """
    rows = list(root.iter("MTMPerformanceSummaryUnderlying"))
    if not rows:
        rows = [e for e in root.iter()
                if "MTMPerformanceSummary" in e.tag
                and e.get("symbol") and e.get("total") is not None]

    agg: dict[str, dict] = {}
    for r in rows:
        sym = (r.get("symbol") or "").strip()
        if not sym:
            continue
        lod = (r.get("levelOfDetail") or "").upper()
        if lod in ("SUMMARY", "ASSET_SUMMARY", "SUBTOTAL", "TOTAL"):
            continue
        # underlyingSymbol is the reliable grouping key; fall back to the leading
        # token of the symbol (equity options read as "MU  281215C…") and finally
        # the symbol itself for plain stocks.
        und = (r.get("underlyingSymbol") or "").strip()
        key = und or (sym.split()[0] if " " in sym else sym)
        key = _futures_root(key)  # ESM6/ESH6 -> ES, CL+CLM6 -> CL, GCJ6 -> GC
        total = to_float(r.get("total") or "0")
        is_root = (key == sym)  # the stock/root row carries a human name
        cur = agg.get(key)
        if cur:
            cur["total"] += total
            cur["legs"] += 1
            if is_root and cur["name"] == key:
                cur["name"] = r.get("description") or key
        else:
            agg[key] = {
                "symbol": key,
                "name": (r.get("description") or key) if is_root else key,
                "total": total,
                "assetClass": r.get("assetCategory") or "",
                "legs": 1,
            }

    out = [o for o in agg.values() if round(o["total"], 2) != 0.0]
    for o in out:
        o["total"] = round(o["total"], 2)
    out.sort(key=lambda x: -abs(x["total"]))
    return out


# IBKR asset-class codes → the labels the site uses. Anything unmapped falls
# through with its raw code so a new instrument type is visible rather than
# silently pooled into "other".
ASSET_CLASS_LABELS = {
    "STK": "stock",
    "OPT": "options",
    "FUT": "futures",
    "FOP": "futures options",
    "CRYPTO": "crypto",
    "EVENT_FORECASTX": "event contracts",
    "CASH": "fx",
    "BOND": "bonds",
    "FUND": "funds",
}


def build_asset_class(contribution: list[dict]) -> list[dict]:
    """Roll the per-underlying contribution rows up by instrument type.

    Same question the Polymarket category panel asks — where did the P&L
    actually come from — but the answer is already in the data: every
    contribution row carries the assetCategory IBKR reported for it. `share` is
    signed against NET P&L, so a losing class reads negative and the shares sum
    to 1.0 (they can exceed ±100% individually when winners and losers offset).
    """
    agg: dict[str, dict] = {}
    for row in contribution:
        code = (row.get("assetClass") or "").strip() or "?"
        cur = agg.setdefault(code, {
            "code": code,
            "label": ASSET_CLASS_LABELS.get(code, code.lower()),
            "total": 0.0,
            "names": 0,
            "legs": 0,
        })
        cur["total"] += row.get("total", 0.0)
        cur["names"] += 1
        cur["legs"] += row.get("legs", 0)

    net = sum(a["total"] for a in agg.values())
    out = list(agg.values())
    for a in out:
        a["total"] = round(a["total"], 2)
        a["share"] = round(a["total"] / net, 4) if net else None
    out.sort(key=lambda a: -a["total"])
    return out


TRADING_DAYS = 252  # annualization factor for daily-sampled series


def build_risk(perf_series: list[dict], positions: list[dict]) -> dict:
    """Risk/return analytics derived from the daily TWR curve (perf_series) and
    current positions. perf_series carries cumulative return as a ratio, so the
    wealth curve is 1 + v and daily HPRs are wealth_i / wealth_{i-1} - 1.

    Sharpe/Sortino assume a 0% risk-free rate (short-horizon rf is negligible
    against a ~50% annual return and keeps the figure provider-independent).
    """
    wealth = [1.0 + p["v"] for p in perf_series]
    rets = [wealth[i] / wealth[i - 1] - 1.0 for i in range(1, len(wealth))
            if wealth[i - 1] > 0]

    sharpe = vol = sortino = None
    if len(rets) >= 20:
        n = len(rets)
        mean = sum(rets) / n
        var = sum((r - mean) ** 2 for r in rets) / (n - 1)
        sd = math.sqrt(var)
        # Downside deviation about a 0 target (only losses contribute).
        dvar = sum(min(r, 0.0) ** 2 for r in rets) / n
        dd = math.sqrt(dvar)
        ann_ret = mean * TRADING_DAYS
        vol = sd * math.sqrt(TRADING_DAYS)
        sharpe = ann_ret / vol if vol else None
        sortino = ann_ret / (dd * math.sqrt(TRADING_DAYS)) if dd else None

    # Drawdown over the wealth curve: peak-to-trough decline as a negative ratio.
    max_dd = cur_dd = 0.0
    peak = wealth[0] if wealth else 1.0
    for w in wealth:
        if w > peak:
            peak = w
        if peak > 0:
            dd_t = w / peak - 1.0
            if dd_t < max_dd:
                max_dd = dd_t
    if wealth and peak > 0:
        cur_dd = wealth[-1] / peak - 1.0

    # Single-name concentration from portfolio weights (mktValue / NAV).
    weights = sorted((abs(p.get("weight", 0.0)) for p in positions), reverse=True)
    top = weights[0] if weights else 0.0
    top3 = sum(weights[:3])
    hhi = sum(w * w for w in weights)  # Herfindahl index on position weights

    return {
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "sortino": round(sortino, 2) if sortino is not None else None,
        "vol": round(vol, 4) if vol is not None else None,
        "maxDrawdown": round(max_dd, 4),
        "currentDrawdown": round(cur_dd, 4),
        "concentration": {
            "top": round(top, 4),
            "top3": round(top3, 4),
            "hhi": round(hhi, 4),
        },
    }


def period_flows(cash_flows: dict[str, float], from_date: str, to_date: str) -> float:
    """Sum daily cash flows (from build_cash_flows) between [from_date, to_date)."""
    return sum(v for d, v in cash_flows.items() if from_date <= d < to_date)


def period_bounds(as_of: str) -> dict[str, str]:
    """Calendar period starts, plus an exclusive end bound, measured off `as_of`.

    `as_of` is the last date the statement actually carries — never the wall
    clock. Chrome.jsx's szRangeCutoff makes the same demand of its caller, in the
    same words, and for the same reason: the two have to name identical periods or
    the tiles and the chart drift apart again the moment they disagree about what
    month it is.

    They disagree for roughly a day on every month, quarter and year boundary.
    Flex statements lag up to 24h, so a run at 09:55 UTC on 1 January sees a
    statement whose last row is 31 December: `now` would compute a ytd that has
    not started yet (start > end, everything zero) while the chart, working off
    the data, would draw the full previous year. Same trap one day into every
    quarter, and one day into every month for mtd.

    The end bound is as_of + 1 day, so a flow dated on the final row counts.
    """
    y, m = int(as_of[0:4]), int(as_of[5:7])
    end = (datetime.strptime(as_of, "%Y-%m-%d").replace(tzinfo=timezone.utc)
           + timedelta(days=1)).date().isoformat()
    return {
        "mtd": f"{y:04d}-{m:02d}-01",
        "qtd": f"{y:04d}-{((m - 1) // 3) * 3 + 1:02d}-01",
        "ytd": f"{y:04d}-01-01",
        "end": end,
    }


def parse_cash_report(root: ET.Element, cash_flows: dict[str, float], as_of: str) -> dict:
    """Net deposit/withdrawal flows for MTD, QTD, and YTD.

    Prefers per-day CashTransaction data (cash_flows) so QTD is computed
    directly from the quarter date range rather than guessed from the month.
    Falls back to CashReportCurrency pre-aggregated totals when no CashTransaction
    records are present (e.g. that section isn't enabled in the Flex Query).
    """
    p = period_bounds(as_of)

    if cash_flows:
        return {
            "mtd": period_flows(cash_flows, p["mtd"], p["end"]),
            "qtd": period_flows(cash_flows, p["qtd"], p["end"]),
            "ytd": period_flows(cash_flows, p["ytd"], p["end"]),
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
    qtd = mtd if int(as_of[5:7]) in (1, 4, 7, 10) else ytd
    return {"mtd": mtd, "qtd": qtd, "ytd": ytd}


def adjusted_pnl(start_v: float, end_v: float, net_deposits: float) -> tuple[float, float]:
    """Simple deposit-adjusted return. abs = (end-start) - net_deposits. pct = abs / start."""
    abs_chg = (end_v - start_v) - net_deposits
    return abs_chg, (abs_chg / start_v if start_v else 0.0)


def period_twr(perf_series: list[dict], from_date: str) -> float:
    """Chained TWR from the close before `from_date` through the end of the series.

    The percent half of every stat tile. It used to be adjusted_pnl's ratio —
    dollar P&L over the NAV the period *opened* on — which is a different question
    from the one the chart answers, and on a book whose size moves it is a wildly
    different answer: with $228k withdrawn during 2026 the ytd tile read +37.98%
    against a chart drawing +43.45%, and both were "right" under their own
    definition.

    TWR is the one that survives the capital moving, which is why the risk block,
    the alpha strip and every benchmark overlay were already computed on it. The
    tiles were the last thing on the page still dividing by a fixed denominator.

    The base is the last close strictly before from_date, matching start_nav() —
    a period owns the return of its own first day. Falls back to the series origin
    (v = 0 by construction) when the period opens at or before the data starts, so
    a ytd window on a statement that begins mid-year reads as far back as it can
    rather than returning nothing.
    """
    if not perf_series:
        return 0.0
    base = 0.0
    for p in perf_series:
        if p["d"] >= from_date:
            break
        base = p["v"]
    return (1.0 + perf_series[-1]["v"]) / (1.0 + base) - 1.0


def build_pnl(root: ET.Element, nav_series: list[dict], nav: float, cash_flows: dict[str, float],
              nav_correction: float = 0.0, perf_series: list[dict] | None = None) -> dict:
    """Per-period P&L for the four stat tiles, as a dollar/percent pair.

    `abs` is deposit-adjusted dollar P&L: (end - start) - net flows over the
    period. `pct` is the chained TWR over the same period, from period_twr().

    The two are deliberately NOT two views of one number — abs/pct will not
    reproduce the opening NAV, and should not be expected to. They answer
    different questions: how much money the period made, and how each dollar in
    the account performed while it was there. The chart's units toggle draws
    exactly this pair, which is the point; the tiles now agree with it under both
    units instead of only one.

    Without a perf_series to chain, pct degrades to adjusted_pnl's fixed-
    denominator ratio, which is what the whole page used before 2026-08.
    """
    # Periods are named off the statement's last row, not the wall clock — see
    # period_bounds. Only an empty nav_series falls back to today, and then there
    # is nothing to measure anyway.
    as_of = nav_series[-1]["d"] if nav_series else datetime.now(timezone.utc).date().isoformat()
    bounds = period_bounds(as_of)
    mtd_start, qtd_start, ytd_start = bounds["mtd"], bounds["qtd"], bounds["ytd"]

    flows = parse_cash_report(root, cash_flows, as_of)

    def start_nav(from_date: str) -> float:
        # Use the closing NAV of the last trading day before the period opens.
        # Deposits on the first day of a period are already in that day's closing NAV,
        # so we must start from the prior day to avoid double-counting them.
        candidates = [p for p in nav_series if p["d"] < from_date]
        return candidates[-1]["v"] if candidates else 0.0

    mtd_abs, mtd_fallback = adjusted_pnl(start_nav(mtd_start), nav, flows["mtd"])
    qtd_abs, qtd_fallback = adjusted_pnl(start_nav(qtd_start), nav, flows["qtd"])
    ytd_abs, ytd_fallback = adjusted_pnl(start_nav(ytd_start), nav, flows["ytd"])

    if perf_series:
        mtd_pct = period_twr(perf_series, mtd_start)
        qtd_pct = period_twr(perf_series, qtd_start)
        ytd_pct = period_twr(perf_series, ytd_start)
    else:
        mtd_pct, qtd_pct, ytd_pct = mtd_fallback, qtd_fallback, ytd_fallback

    cin = root.find(".//ChangeInNAV")
    if cin is not None:
        cin_start = to_float(cin.get("startingValue") or "0")
        cin_end   = to_float(cin.get("endingValue")   or "0") + nav_correction
        cin_dw    = to_float(cin.get("depositsWithdrawals") or "0")
        oney_abs  = (cin_end - cin_start) - cin_dw
        # Our own daily chain, not IBKR's ChangeInNAV@twr. The two disagree by
        # ~40bp (59.827% vs 60.224% on 2026-08-21) because IBKR weights flows
        # intraday and we chain on closes, and only one of them can be the number
        # the chart draws. Chaining ourselves also removes the special case the
        # nav_correction branch used to need: a bad vendor mark on the statement's
        # final day corrupts IBKR's figure and cannot be patched out of it, while
        # perf_series is built from the corrected nav_series to begin with.
        oney_pct = perf_series[-1]["v"] if perf_series else to_float(cin.get("twr") or "0") / 100.0
    else:
        s = start_nav(nav_series[0]["d"] if nav_series else ytd_start)
        oney_abs, oney_fallback = adjusted_pnl(s, nav, flows["ytd"])
        oney_pct = perf_series[-1]["v"] if perf_series else oney_fallback

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
POSITION_OVERRIDES: dict[tuple[str, str], float] = {
    # 2026-07-02 — IBKR marked MU common at $1,145.28, an ~+11% one-day spike,
    # while every MU option leg repriced as if MU fell (bad stock mark only).
    # True close was $975.00 → 300 sh = $292,500.
    ("2026-07-02", "MU"): 292500.0,
}
NAV_OVERRIDES: dict[str, float] = {
    # 2026-07-02 — reported total 751,181.33 embeds the bad MU mark (+$51,084);
    # corrected NAV is 700,097.33.
    "2026-07-02": 700097.33032514,
}


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
    contribution = build_contribution(root)

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
        "risk": build_risk(perf_series, positions),
        "contribution": contribution,
        "byAssetClass": build_asset_class(contribution),
        "navSeries": [{"d": p["d"], "v": p["v"]} for p in nav_series],
        "perfSeries": perf_series,
        "pnlSeries": build_pnl_series(nav_series, cash_flows),
        "allocation": build_allocation(positions, cash),
        "positions": positions[:20],  # top 20 by value
    }


def _load_root(args: list[str]) -> ET.Element:
    """Statement source: a local file if --from-file was given, else the API.

    The file path exists so the reconciliation can be run against an already
    archived statement (gunzipped and decrypted first) without burning a Flex
    request or waiting out the generate/retrieve handshake.
    """
    if "--from-file" in args:
        return ET.parse(args[args.index("--from-file") + 1]).getroot()
    token = os.environ.get("IBKR_FLEX_TOKEN")
    qid = os.environ.get("IBKR_FLEX_QUERY_ID")
    if not token or not qid:
        raise SystemExit("missing IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID")
    return run_flex(token, qid)


def main() -> int:
    args = sys.argv[1:]
    try:
        root = _load_root(args)
        data = transform(root)

        nav_series = build_nav_series(root)
        apply_mark_overrides([], nav_series,
                             nav_series[-1]["d"] if nav_series else None)
        cash_flows = build_cash_flows(root)

        # Always on, including in CI. Three equality flags and a verdict, no
        # amounts and no dates — see flow_agreement for why that is safe to put
        # in a world-readable Actions log, and why a boolean watching a constant
        # is worth having.
        print(flow_agreement(root, nav_series, cash_flows), file=sys.stderr)

        # The full report is opt-in and deliberately NOT wired into the workflow:
        # it prints per-date cash movements, precisely the metadata the archive
        # was moved to a private repo to stop publishing (see archive_raw), and
        # Actions logs on a public repo are world readable. Run it locally:
        #
        #   python fetch-ibkr.py --reconcile-flows > /dev/null
        #
        # stdout stays clean JSON either way, so the flag is safe to add to an
        # existing pipe; the report goes to stderr.
        if "--reconcile-flows" in args:
            for line in reconcile_flows(root, nav_series, cash_flows):
                print(line, file=sys.stderr)
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return 1
    json.dump(data, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
