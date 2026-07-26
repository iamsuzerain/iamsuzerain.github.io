#!/usr/bin/env python3
"""
fetch-polymarket-calibration.py

Reconstructs a per-resolved-position calibration / hit-rate dataset from
Polymarket activity across all tracked wallets, for the "win rate vs implied
odds" panel on the Combined tab.

Why this exists: the site's other feeds carry cumulative *dollar* P&L. A
reliability diagram needs the opposite shape — per-market records of
(implied odds at entry, win/loss outcome). The /positions endpoint can't
supply it (winning positions get redeemed and vanish, leaving a loss-biased
sample), so we rebuild the history from /activity trades and resolve outcomes
via gamma-api.

Pipeline:
  1. Paginate /activity per wallet -> all TRADE rows (BUY/SELL), merged across
     wallets by (conditionId, outcomeIndex) since the same market+side on two
     wallets is economically one position.
  2. Per position: dollar-weighted avg entry price (cost / shares bought),
     shares & proceeds sold.
  3. Resolve each traded market via gamma-api (batched condition_ids,
     closed=true) -> winning outcomeIndex from outcomePrices (["1","0"]).
  4. Emit records, splitting a position into up to two lots so the two views
     never blend (this is the decision point partial exits force):
       - 'settlement' lot: shares held to resolution. win = held side won.
       - 'exit' lot: shares sold before resolution. win = sold above entry
         (closed in profit). Sold-early has no resolution truth, so its "win"
         is realized-profit, which is a hit-rate signal, NOT a calibration one.
     Both lots share the entry price, so each still buckets by implied odds.
  5. Bucket into deciles per series with Wilson 95% bands; headline hit rate,
     Brier score, and mean calibration error (settlement series only, since the
     diagonal is only meaningful there).

Outputs JSON to stdout -> data/polymarket-calibration.json

Env:
  PM_WALLET - comma-separated wallet addresses (defaults to hardcoded list)
"""
import ast, json, math, os, sys
from collections import defaultdict
from datetime import datetime, timezone
from curl_cffi import requests

DEFAULT_WALLETS = [
    "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a",
    "0xfaf680c17a9cca24ff0773ae2d9f7db49c02cc47",
]
WALLETS = [w.strip() for w in os.environ.get("PM_WALLET", ",".join(DEFAULT_WALLETS)).split(",") if w.strip()]

ACTIVITY_URL = "https://data-api.polymarket.com/activity"
GAMMA_URL = "https://gamma-api.polymarket.com/markets"
EVENTS_URL = "https://gamma-api.polymarket.com/events"
PAGE = 500          # activity page size
OFFSET_CEIL = 5000  # /activity rejects offset past ~5500; slide the window before then
GAMMA_CHUNK = 25    # condition_ids per gamma request (URL-length safe)
EVENTS_CHUNK = 20   # event ids per gamma /events request
EPS = 1e-6          # share dust threshold
MIN_CATEGORY_N = 25 # below this a category is noise; the UI folds it into "other"
# Deciles below 0.9, then split the top decile finely: ~75% of this book's bets
# land in 0.9-1.0, so plain deciles would collapse it into one unreadable bin.
BUCKET_EDGES = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0]

# ── Market taxonomy ─────────────────────────────────────────────────────────
# Polymarket exposes categories ONLY on the /events endpoint. The market object
# has a `category` field but it is empty on every modern market, and the `events`
# array embedded in a /markets response is stripped of its `tags`. So the join is
# necessarily two hops: conditionId -> market.events[0].id -> event.tags[].label.
# Note `closed=true` is mandatory on the /markets query — without it gamma
# returns zero rows for a condition_ids filter.
#
# NOISE: tags describing HOW a market is priced or merchandised, not what it is
# about. They must never decide a category — several price-ladder markets carry
# `Hit Price` + `Finance` alongside the real subject tag, and matching on those
# files WTI crude under whatever generic bucket happens to be checked first.
NOISE_TAGS = {
    "Hit Price", "Hide From New", "Monthly", "Weekly", "Daily", "Recurring",
    "Finance Updown", "Pyth Finance", "Games", "All", "Featured", "New",
}

# Specific asset/topic tags are matched before broad umbrella tags, so a market
# tagged both {Oil, Commodities, Finance} lands in commodities rather than a
# generic finance bucket. Order within this list IS the precedence rule.
CATEGORY_TAGS = [
    ("commodities", {"Oil", "Commodities", "WTI", "Metals", "Gas", "Gold",
                     "Natural Gas", "Silver", "Copper"}),
    ("crypto",      {"Crypto", "Bitcoin", "Ethereum", "Solana", "FDV",
                     "Pre-Market", "Memecoins", "Crypto Prices"}),
    ("equities",    {"SPX", "Indicies", "Indices", "Stocks", "Earnings",
                     "Nasdaq", "S&P"}),
    ("macro",       {"Fed", "Inflation", "Interest Rates", "Recession",
                     "Economy", "CPI", "Jobs", "GDP"}),
    ("sports",      {"Sports", "NFL", "NBA", "MLB", "Soccer", "EPL", "Tennis",
                     "F1", "NHL", "UFC", "Golf", "Chess", "Olympics", "Cricket",
                     "FIFA World Cup", "baseball", "football", "basketball"}),
    ("geopolitics", {"Geopolitics", "War", "Ukraine", "Russia", "Israel", "Iran",
                     "China", "Middle East", "Foreign Policy", "Venezuela",
                     "Iran Ceasefire", "U.S. x Iran", "World"}),
    ("politics",    {"Politics", "Elections", "US Election", "Trump", "Congress",
                     "Midterms", "Primaries", "Senate Primaries", "Polls",
                     "primary elections", "Governor midterms", "US-current-affairs",
                     "California Governor", "California Primary", "California Midterm",
                     "June 2 Primaries"}),
    ("tech",        {"Tech", "AI", "Science", "Space", "OpenAI", "SpaceX", "Elon Musk"}),
    ("culture",     {"Culture", "Pop Culture", "Awards", "Movies", "Music",
                     "Celebrities", "Weather", "Health", "Mentions"}),
]


def categorize(tags: list[str]) -> str:
    """Map an event's tag labels to one canonical category (first match wins)."""
    ts = set(tags or []) - NOISE_TAGS
    for name, keys in CATEGORY_TAGS:
        if ts & keys:
            return name
    return "other"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fetch_activity(sess, wallet):
    """Full-history activity via backward time-windowed pagination.

    The endpoint hard-caps offset at ~5500 (returns 4xx past it), which alone
    only reaches back a few months for an active wallet. But it accepts an `end`
    timestamp filter, so we page offset within an end-bounded window (newest
    first) until we near the ceiling, then move `end` to the oldest event seen
    and restart offset — sliding the window backward to the account's first
    trade. We deliberately keep /activity (not /trades) because /trades is
    taker-only and drops maker fills, which would corrupt entry prices. Overlap
    at each window edge is removed by a per-event dedup key."""
    seen, rows = set(), []
    end = None
    while True:
        window_oldest = None
        advanced = False
        off = 0
        while True:
            params = {"user": wallet, "limit": PAGE, "offset": off}
            if end is not None:
                params["end"] = end
            r = sess.get(ACTIVITY_URL, params=params, timeout=30)
            if r.status_code != 200:
                break
            page = r.json()
            if not isinstance(page, list) or not page:
                break
            for a in page:
                if not isinstance(a, dict):
                    continue
                key = (a.get("transactionHash"), a.get("asset"),
                       a.get("timestamp"), a.get("type"), a.get("size"))
                if key in seen:
                    continue
                seen.add(key)
                rows.append(a)
                advanced = True
                ts = a.get("timestamp")
                if ts is not None and (window_oldest is None or ts < window_oldest):
                    window_oldest = ts
            off += PAGE
            if len(page) < PAGE or off >= OFFSET_CEIL:
                break
        # Stop when a window yields nothing new or can't reach further back.
        if not advanced or window_oldest is None or (end is not None and window_oldest >= end):
            break
        end = window_oldest
    return rows


def aggregate_positions(all_rows):
    """Merge TRADEs across wallets into per-(conditionId, outcomeIndex) tallies."""
    pos = defaultdict(lambda: {
        "title": "", "slug": "", "outcome": "", "outcomeIndex": None,
        "buyShares": 0.0, "buyUsd": 0.0, "sellShares": 0.0, "sellUsd": 0.0,
    })
    for a in all_rows:
        if a.get("type") != "TRADE":
            continue
        cond, oi = a.get("conditionId"), a.get("outcomeIndex")
        if cond is None or oi is None:
            continue
        p = pos[(cond, oi)]
        p["title"] = a.get("title") or p["title"]
        p["slug"] = a.get("slug") or p["slug"]
        p["outcome"] = a.get("outcome") or p["outcome"]
        p["outcomeIndex"] = oi
        shares = float(a.get("size") or 0)
        usd = float(a.get("usdcSize") or 0)
        if (a.get("side") or "").upper() == "BUY":
            p["buyShares"] += shares
            p["buyUsd"] += usd
        elif (a.get("side") or "").upper() == "SELL":
            p["sellShares"] += shares
            p["sellUsd"] += usd
    return pos


def fetch_resolutions(sess, condition_ids):
    """conditionId -> winning outcomeIndex, for markets gamma reports closed."""
    winners = {}
    ids = list(condition_ids)
    for i in range(0, len(ids), GAMMA_CHUNK):
        chunk = ids[i:i + GAMMA_CHUNK]
        params = [("condition_ids", c) for c in chunk] + [("closed", "true"), ("limit", GAMMA_CHUNK)]
        try:
            d = sess.get(GAMMA_URL, params=params, timeout=30).json()
        except Exception as e:
            log("gamma chunk failed:", e)
            continue
        if not isinstance(d, list):
            continue
        for m in d:
            cond = m.get("conditionId")
            if not cond or not m.get("closed"):
                continue
            try:
                prices = [float(x) for x in ast.literal_eval(m.get("outcomePrices") or "[]")]
            except Exception:
                continue
            if not prices:
                continue
            win_idx = max(range(len(prices)), key=lambda k: prices[k])
            # Only trust an unambiguous settlement (one outcome ~1).
            if prices[win_idx] >= 0.99:
                winners[cond] = win_idx
    return winners


def fetch_categories(sess, condition_ids):
    """conditionId -> canonical category, via market -> event -> tags.

    Two hops because gamma only carries tags on /events (see NOISE_TAGS above).
    Markets that fail either hop are left uncategorized and surface as "other".
    """
    cond_event = {}
    ids = list(condition_ids)
    for i in range(0, len(ids), GAMMA_CHUNK):
        chunk = ids[i:i + GAMMA_CHUNK]
        params = ([("condition_ids", c) for c in chunk]
                  + [("closed", "true"), ("limit", GAMMA_CHUNK)])
        try:
            d = sess.get(GAMMA_URL, params=params, timeout=30).json()
        except Exception as e:
            log("category markets chunk failed:", e)
            continue
        if not isinstance(d, list):
            continue
        for m in d:
            cond, evs = m.get("conditionId"), (m.get("events") or [])
            if cond and evs and evs[0].get("id"):
                cond_event[cond] = str(evs[0]["id"])

    event_cat = {}
    eids = sorted(set(cond_event.values()))
    for i in range(0, len(eids), EVENTS_CHUNK):
        chunk = eids[i:i + EVENTS_CHUNK]
        params = [("id", e) for e in chunk] + [("limit", 100)]
        try:
            d = sess.get(EVENTS_URL, params=params, timeout=30).json()
        except Exception as e:
            log("category events chunk failed:", e)
            continue
        if not isinstance(d, list):
            continue
        for ev in d:
            labels = [t.get("label") for t in (ev.get("tags") or []) if t.get("label")]
            event_cat[str(ev.get("id"))] = categorize(labels)

    out = {c: event_cat[e] for c, e in cond_event.items() if e in event_cat}
    log(f"categories: {len(cond_event)}/{len(ids)} markets -> events, "
        f"{len(out)} categorized")
    return out


def build_records(pos, winners):
    """One position -> up to two lots (settlement + exit), each bucketable."""
    records = []
    for (cond, oi), p in pos.items():
        bought, cost = p["buyShares"], p["buyUsd"]
        if bought <= EPS or cost <= 0:
            continue  # only measure positions we actually paid to open
        entry = cost / bought
        if not (0 < entry < 1):
            continue
        sold, proceeds = p["sellShares"], p["sellUsd"]
        held = max(0.0, bought - sold)
        base = {
            "conditionId": cond, "outcomeIndex": oi,
            "title": p["title"], "outcome": p["outcome"],
            "impliedEntry": round(entry, 4),
        }

        # exit lot: shares sold before resolution -> outcome = closed in profit.
        # An exit that nets $0.00 (sold at cost) is a push — a scratch, neither a
        # win nor a loss — so it's excluded from the win-rate denominator rather
        # than counted against you.
        if sold > EPS:
            exit_price = proceeds / sold
            notional = entry * sold
            rp = round(proceeds - notional, 2)
            records.append({**base,
                "resolvedVia": "exit",
                "shares": round(sold, 2),
                "volume": round(notional, 2),
                "exitPrice": round(exit_price, 4),
                "win": rp > 0,
                "push": rp == 0,
                "realizedPnl": rp,
            })

        # settlement lot: shares held to a *resolved* market (binary — no push)
        if held > EPS and cond in winners:
            won = (oi == winners[cond])
            notional = entry * held
            records.append({**base,
                "resolvedVia": "settlement",
                "shares": round(held, 2),
                "volume": round(notional, 2),
                "settlePrice": 1.0 if won else 0.0,
                "win": bool(won),
                "push": False,
                "realizedPnl": round(held * (1.0 if won else 0.0) - notional, 2),
            })
        # held but unresolved -> still open, no outcome yet: skip.
    return records


def wilson(wins, n, z=1.96):
    """95% Wilson score interval for a binomial proportion."""
    if n == 0:
        return (0.0, 0.0)
    phat = wins / n
    denom = 1 + z * z / n
    center = (phat + z * z / (2 * n)) / denom
    half = (z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def bucketize(records, series):
    rows = [r for r in records if r["resolvedVia"] == series]
    buckets = []
    n_edges = len(BUCKET_EDGES) - 1
    for b in range(n_edges):
        lo, hi = BUCKET_EDGES[b], BUCKET_EDGES[b + 1]
        inb = [r for r in rows if (lo <= r["impliedEntry"] < hi) or (b == n_edges - 1 and r["impliedEntry"] == 1.0)]
        n = len(inb)
        wins = sum(1 for r in inb if r["win"])
        pushes = sum(1 for r in inb if r.get("push"))
        decided = n - pushes  # pushes excluded from the win-rate denominator
        vol = sum(r["volume"] for r in inb)
        vwins = sum(r["volume"] for r in inb if r["win"])
        pnl = sum(r["realizedPnl"] for r in inb)
        # Unsigned P&L: wins and losses both counted positive, so a bucket that
        # churned a lot to end flat doesn't cancel itself out. This is what the
        # panel sizes its bubbles by — `volume` (cost basis) overstates buckets
        # you merely parked money in, and net P&L would erase the busy-but-even
        # ones entirely.
        gross = sum(abs(r["realizedPnl"]) for r in inb)
        wlo, whi = wilson(wins, decided)
        buckets.append({
            "lo": round(lo, 2), "hi": round(hi, 2),
            "n": n, "wins": wins, "pushes": pushes,
            "winRate": round(wins / decided, 4) if decided else None,
            "avgImplied": round(sum(r["impliedEntry"] for r in inb) / n, 4) if n else None,
            "volume": round(vol, 2),
            "realizedPnl": round(pnl, 2),
            "grossPnl": round(gross, 2),
            "winRateByVolume": round(vwins / vol, 4) if vol else None,
            "wilsonLo": round(wlo, 4), "wilsonHi": round(whi, 4),
        })
    return buckets


def headline(records, series):
    rows = [r for r in records if r["resolvedVia"] == series]
    n = len(rows)
    if not n:
        return {"n": 0}
    wins = sum(1 for r in rows if r["win"])
    pushes = sum(1 for r in rows if r.get("push"))
    decided = n - pushes
    vol = round(sum(r["volume"] for r in rows), 2)
    rpnl = round(sum(r["realizedPnl"] for r in rows), 2)
    out = {
        "n": n,
        "wins": wins,
        "pushes": pushes,
        "hitRate": round(wins / decided, 4) if decided else None,
        "volume": vol,
        "realizedPnl": rpnl,
        # Dollar-weighted edge: realized profit per $ of cost basis. The signed,
        # size-aware counterpart to the bet-weighted `edge` below.
        "roi": round(rpnl / vol, 4) if vol else None,
    }
    if series == "settlement":
        # Brier + calibration error only mean something against resolution truth.
        out["brier"] = round(sum((r["impliedEntry"] - (1 if r["win"] else 0)) ** 2 for r in rows) / n, 4)
        # Signed edge = won − priced (NOT the absolute value). Positive = you won
        # more often than the price implied = genuine directional edge/profit;
        # negative = you overpaid. Perfect calibration -> edge ~0 -> break-even
        # before fees. `edge` is bet-weighted (each bet one vote); `roi` (above) is
        # the dollar-weighted counterpart, so the two together show whether the
        # edge sits in your small bets or your big ones.
        avg_implied = sum(r["impliedEntry"] for r in rows) / n
        out["avgImplied"] = round(avg_implied, 4)
        out["edge"] = round(wins / n - avg_implied, 4)
        bk = [b for b in bucketize(records, "settlement") if b["n"]]
        if bk:
            out["calibrationError"] = round(
                sum(b["n"] * abs(b["winRate"] - b["avgImplied"]) for b in bk) / sum(b["n"] for b in bk), 4)
    return out


def category_stats(rows):
    """P&L attribution for one slice of records.

    The panel reads the picking-vs-sizing story off two edges in the units the
    calibration headline already uses, rather than a Brier score (which isn't
    comparable across categories — it falls automatically as odds shorten, so a
    book of favourites scores well with no skill):

      edge  — won − priced, one vote per bet (probability points). Directional
              picking skill: did the side win more often than its entry price
              implied? Meaningful on settled lots only, so the UI reads it from
              the settlement slice.
      roi   — realized P&L per dollar staked. The dollar-weighted counterpart —
              this is what actually hit the book.

    Their disagreement is the finding: edge ≈ 0 (fairly priced) with a deeply
    negative roi means the picking was fine and the sizing wasn't — the losses
    rode on a few oversized bets. `top1Share` guards the read by flagging a
    category that is really one trade wearing a category's name.
    """
    n = len(rows)
    if not n:
        return None
    decided = [r for r in rows if not r.get("push")]
    wins = sum(1 for r in decided if r["win"])
    vol = sum(r["volume"] for r in rows)
    pnl = sum(r["realizedPnl"] for r in rows)
    avg_implied = sum(r["impliedEntry"] for r in rows) / n
    # Share of the slice's gross P&L carried by its single largest move — guards
    # against reading a one-trade category as a systematic edge (or leak).
    gross = sum(abs(r["realizedPnl"]) for r in rows)
    top1 = (max(abs(r["realizedPnl"]) for r in rows) / gross) if gross else None
    hit = (wins / len(decided)) if decided else None
    return {
        "n": n,
        "volume": round(vol, 2),
        "realizedPnl": round(pnl, 2),
        "roi": round(pnl / vol, 4) if vol else None,
        "hitRate": round(hit, 4) if hit is not None else None,
        "avgImplied": round(avg_implied, 4),
        "edge": round(hit - avg_implied, 4) if hit is not None else None,
        "top1Share": round(top1, 4) if top1 is not None else None,
    }


def by_category(records):
    """Per-category attribution, for the whole book and split by lot type.

    `combined` is what the P&L bars read; `settlement`/`exit` expose the split
    that shows whether a category's damage comes from the bets themselves or
    from trading out of them early.
    """
    cats = sorted({r["category"] for r in records})
    out = {}
    for cat in cats:
        rows = [r for r in records if r["category"] == cat]
        entry = {"combined": category_stats(rows)}
        for series in ("settlement", "exit"):
            s = category_stats([r for r in rows if r["resolvedVia"] == series])
            if s:
                entry[series] = s
        out[cat] = entry
    return out


def main():
    sess = requests.Session(impersonate="chrome124")
    all_rows = []
    for w in WALLETS:
        rows = fetch_activity(sess, w)
        log(f"fetched {len(rows)} activity rows for {w[:8]}")
        all_rows += rows

    pos = aggregate_positions(all_rows)
    log(f"{len(pos)} distinct market-outcome positions")

    conds = {cond for (cond, _) in pos.keys()}
    winners = fetch_resolutions(sess, conds)
    log(f"{len(winners)}/{len(conds)} markets resolved via gamma")

    records = build_records(pos, winners)
    settle = [r for r in records if r["resolvedVia"] == "settlement"]
    exit_ = [r for r in records if r["resolvedVia"] == "exit"]
    log(f"records: {len(settle)} settlement, {len(exit_)} exit")

    cats = fetch_categories(sess, conds)
    for r in records:
        r["category"] = cats.get(r["conditionId"], "other")
    uncat = sum(1 for r in records if r["category"] == "other")
    log(f"uncategorized records: {uncat}/{len(records)}")

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "wallets": WALLETS,
        "method": {
            "source": "data-api activity (trades) + gamma-api resolution",
            "settlement": "shares held to resolution; win = held side settled to 1",
            "exit": "shares sold before resolution; win = sold above avg entry (profit)",
            "bucketEdges": BUCKET_EDGES,
            "category": "gamma event tags -> canonical category; venue tags ignored",
            "minCategoryN": MIN_CATEGORY_N,
        },
        "headline": {
            "settlement": headline(records, "settlement"),
            "exit": headline(records, "exit"),
        },
        "buckets": {
            "settlement": bucketize(records, "settlement"),
            "exit": bucketize(records, "exit"),
        },
        "byCategory": by_category(records),
        # Note: the per-lot `positions` array is intentionally NOT emitted — the
        # panel only reads `buckets` + `headline` (a few KB, fixed size), so
        # shipping the ~700 raw records would bloat the static payload ~40x for
        # data the page never renders. Re-add a trimmed version if the UI ever
        # grows an in-browser drill-down.
    }
    print(json.dumps(out, indent=2))


main()
