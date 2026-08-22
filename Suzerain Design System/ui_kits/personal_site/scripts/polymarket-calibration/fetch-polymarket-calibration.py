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
     shares & proceeds sold. MERGE rows are folded in here as a synthetic paired
     SELL (see apply_merges) — the trade feed carries no SELL for merged shares,
     so without this they masquerade as still-held and resurface as a phantom
     settlement pair. CONVERSION rows cannot be attributed at all (see main).
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
POSITIONS_URL = "https://data-api.polymarket.com/positions"
GAMMA_URL = "https://gamma-api.polymarket.com/markets"
EVENTS_URL = "https://gamma-api.polymarket.com/events"
PAGE = 500          # activity page size
OFFSET_CEIL = 5000  # /activity rejects offset past ~5500; slide the window before then
GAMMA_CHUNK = 25    # condition_ids per gamma request (URL-length safe)
EVENTS_CHUNK = 20   # event ids per gamma /events request
EPS = 1e-6          # share dust threshold
SHARE_TOL = 1.0     # sold-over-bought below this is float dust, not off-feed shares
MIN_LOT_USD = 1.0   # a lot that cost under a dollar is residue, not a forecast
# Selling at 0.998+ into a market that later resolved is a redemption wearing a
# trade's clothes: the outcome was already decided, you just took the last cent
# rather than waiting. Such lots are booked as settlements (scored on gamma's
# actual winner, never on the exit price) so the two series mean what they say —
# `settlement` is every position whose outcome was determined, `exit` is only
# the trades that were closed while the result was genuinely still live.
SETTLE_PX_HI = 0.998
SETTLE_PX_LO = 0.002
MIN_CATEGORY_N = 25 # below this a category is noise; the UI folds it into "other"
# Deciles below 0.9, then split the top decile finely: ~75% of this book's bets
# land in 0.9-1.0, so plain deciles would collapse it into one unreadable bin.
BUCKET_EDGES = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0]

# ── Market taxonomy ─────────────────────────────────────────────────────────
# Polymarket exposes categories ONLY on the /events endpoint. The market object
# has a `category` field but it is empty on every modern market, and the `events`
# array embedded in a /markets response is stripped of its `tags`. So the join is
# necessarily two hops: conditionId -> market.events[0].id -> event.tags[].label.
# `closed=true` is mandatory on the RESOLUTION query (step 3) — without it gamma
# returns zero rows for a condition_ids filter. It is NOT safe on the category
# query: positions exited while the market was still open match no closed row,
# so they used to fail hop 1 and land in "other". That made "other" a slice of
# the open book (100% exit lots, ~12% of exit stake) rather than a residual, and
# it starved every real category's exit sub-series — the leg where sizing damage
# shows. Hop 1 therefore runs twice, `closed=false` mopping up the first pass's
# misses. Verified: the misses return an event on `closed=false`, 35/35.
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
#
# DO NOT reorder casually — one bar's worth of P&L rides on two lines here.
# `geopolitics` above `politics` is a deliberate choice, not incidental: 130 of
# the 154 geopolitics markets (81% of its stake) carry BOTH tags — every Iran
# ceasefire / Hormuz / airspace market is tagged `Politics` too. Both-tagged
# markets are geopolitics; politics keeps only the politics-only ones (US/UK
# elections, primaries, nominations), which is why the politics row shows no
# geopolitics overlap — by construction it can't. Swapping the two lines moves
# ~$48k: geopolitics +50.5k -> +2.4k, politics +18.3k -> +66.3k (2026-07-26).
# The two together (+$68.8k) are the order-invariant figure if you ever need to
# state this book's political P&L without leaning on the split.
#
# Corollary: a higher line still wins over both. Crude ladders tagged
# `Geopolitics` go to commodities, "Fed Chair confirmed" tagged `Politics` goes
# to macro, World Cup props tagged `Politics` go to sports. 21 markets, ~$1.6k
# total, all correct on the merits — checked, not assumed.
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
        "firstTs": None, "lastTs": None,   # trade window, for hedge detection
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
        ts = a.get("timestamp")
        if ts is not None:
            p["firstTs"] = ts if p["firstTs"] is None else min(p["firstTs"], ts)
            p["lastTs"] = ts if p["lastTs"] is None else max(p["lastTs"], ts)
        shares = float(a.get("size") or 0)
        usd = float(a.get("usdcSize") or 0)
        if (a.get("side") or "").upper() == "BUY":
            p["buyShares"] += shares
            p["buyUsd"] += usd
        elif (a.get("side") or "").upper() == "SELL":
            p["sellShares"] += shares
            p["sellUsd"] += usd
    return pos


def apply_merges(pos, all_rows):
    """Book each MERGE as a synthetic paired SELL across the market's two legs.

    A merge burns one share of every outcome and returns $1. The trade feed
    carries no SELL for those shares, so without this they sit in `held` and
    resurface as a settlement lot on EACH leg once the market resolves — a
    manufactured win/loss pair polluting `n`, `hitRate`, `brier` and
    `calibrationError`. Five of the seventeen markets that currently contribute
    both legs as settlement lots are this artifact, not a real two-sided trade;
    removing them moves the settlement hit rate 0.8657 -> 0.8718. Merges on
    markets still open are worse than wrong — they are invisible.

    The dollar P&L was never wrong, which is why this went unnoticed: a merge
    pays $1/pair and the two settlement payouts also sum to $1, so the phantom
    pair nets to the true merge economics. Verified on the Argentina World Cup
    merge: booked +$340 / -$3,080 = -$2,740 against a true -$2,740. Only the
    counts and the timing (dated to resolution, not to the merge) were off.

    Splitting the $1 pro-rata by each leg's entry price, rather than 50/50, is
    what keeps the verdict honest. A merge is ONE decision, so both legs must
    book the same sign. 50/50 on Argentina (entries 0.981 / 0.172) would record
    the cheap leg as a win and the dear leg as a loss purely as an artifact of
    the split; pro-rata gives every leg the same return ratio, so the pair
    agrees. Total P&L is identical under either split — only the win/loss
    verdict, and therefore the hit rate, moves.

    Entry prices come from TRADE rows alone, so this must run AFTER
    aggregate_positions and never feed its own synthetic sells back into them.
    """
    legs = defaultdict(list)
    for (cond, oi) in pos:
        legs[cond].append(oi)

    applied = skipped = 0
    for a in all_rows:
        if a.get("type") != "MERGE":
            continue
        cond = a.get("conditionId")
        shares, usd = float(a.get("size") or 0), float(a.get("usdcSize") or 0)
        ois = sorted(legs.get(cond) or [])
        # Price every leg off its own trades. A merge whose other side never
        # appears in the trade feed (its shares arrived off-feed) can't be split
        # pro-rata, so leave it untouched and say so rather than guess a basis.
        entries = {oi: pos[(cond, oi)]["buyUsd"] / pos[(cond, oi)]["buyShares"]
                   for oi in ois
                   if pos[(cond, oi)]["buyShares"] > EPS and pos[(cond, oi)]["buyUsd"] > 0}
        if len(ois) != 2 or len(entries) != 2 or shares <= EPS or usd <= 0:
            log(f"merge not attributable ({len(ois)} legs, {len(entries)} priced): "
                f"${usd:,.0f} {(a.get('title') or cond or '?')[:55]}")
            skipped += 1
            continue
        denom = sum(entries.values())
        for oi, e in entries.items():
            p = pos[(cond, oi)]
            p["sellShares"] += shares
            p["sellUsd"] += usd * (e / denom)
        applied += 1
    return applied, skipped


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


def fetch_market_events(sess, ids, closed):
    """conditionId -> primary event id, for one `closed` filter value."""
    out = {}
    for i in range(0, len(ids), GAMMA_CHUNK):
        chunk = ids[i:i + GAMMA_CHUNK]
        params = ([("condition_ids", c) for c in chunk]
                  + [("closed", closed), ("limit", GAMMA_CHUNK)])
        try:
            d = sess.get(GAMMA_URL, params=params, timeout=30).json()
        except Exception as e:
            log(f"category markets chunk failed (closed={closed}):", e)
            continue
        if not isinstance(d, list):
            continue
        for m in d:
            cond, evs = m.get("conditionId"), (m.get("events") or [])
            if cond and evs and evs[0].get("id"):
                out[cond] = str(evs[0]["id"])
    return out


def fetch_categories(sess, condition_ids):
    """conditionId -> canonical category, via market -> event -> tags.

    Two hops because gamma only carries tags on /events (see NOISE_TAGS above).
    Hop 1 runs closed=true then closed=false over the misses, so markets still
    open at the time of the exit get categorized too (see the `closed=true` note
    above). Markets that fail either hop are left uncategorized -> "other".

    Every market a hop-1 pass returns has so far matched at least one category
    tag, so a non-empty "other" is a signal that this join is failing, not that
    the taxonomy has a gap — check the hop counts in the log line below.
    """
    ids = list(condition_ids)
    cond_event = fetch_market_events(sess, ids, "true")
    n_closed = len(cond_event)
    missing = [c for c in ids if c not in cond_event]
    if missing:
        cond_event.update(fetch_market_events(sess, missing, "false"))
    log(f"hop 1: {n_closed} closed + {len(cond_event) - n_closed} open "
        f"= {len(cond_event)}/{len(ids)} markets -> events")

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
    log(f"hop 2: {len(event_cat)}/{len(eids)} events tagged -> {len(out)} "
        f"of {len(ids)} markets categorized")
    return out


def fetch_open_book(sess, resolved_conds, settled_conds):
    """Unrealized mark on positions still genuinely open, for the panel's scope note.

    Everything else in this file measures CLOSED lots — settled or exited. That
    leaves the open book invisible, so the panel can't say how much of the story
    it isn't telling. This quantifies exactly that, and nothing else consumes it.

    The trap: /positions keeps RESOLVED-BUT-UNREDEEMED LOSERS. Their curPrice is
    0.00 and currentValue 0, but `redeemable` is True and initialValue still
    carries the full cost, so cashPnl reads as a huge unrealized loss for a bet
    that already lost and is already counted as a settlement lot. Counting those
    double-counted ~$102k against commodities alone. Filter on gamma's `closed`
    flag plus the conds we already booked as settlements — and never test
    openness by summing redeemable currentValue, which is $0 for precisely these
    rows and so cannot detect them.
    """
    rows = []
    for w in WALLETS:
        off = 0
        while True:
            try:
                d = sess.get(POSITIONS_URL,
                             params={"user": w, "limit": 500, "offset": off},
                             timeout=30).json()
            except Exception as e:
                log("positions fetch failed:", e)
                break
            if not isinstance(d, list) or not d:
                break
            rows += d
            if len(d) < 500:
                break
            off += 500

    # gamma's own closed flag for the markets we still hold
    conds = sorted({p.get("conditionId") for p in rows if p.get("conditionId")})
    closed = set()
    for i in range(0, len(conds), GAMMA_CHUNK):
        chunk = conds[i:i + GAMMA_CHUNK]
        for flag in ("true", "false"):
            params = ([("condition_ids", c) for c in chunk]
                      + [("closed", flag), ("limit", GAMMA_CHUNK)])
            try:
                d = sess.get(GAMMA_URL, params=params, timeout=30).json()
            except Exception as e:
                log("open-book gamma chunk failed:", e)
                continue
            for m in d if isinstance(d, list) else []:
                if m.get("closed") and m.get("conditionId"):
                    closed.add(m["conditionId"])

    stale = closed | set(resolved_conds) | set(settled_conds)
    live = [p for p in rows if p.get("conditionId") not in stale]
    ob = {
        "n": len(live),
        "cost": round(sum(float(p.get("initialValue") or 0) for p in live), 2),
        "mark": round(sum(float(p.get("currentValue") or 0) for p in live), 2),
        "unrealized": round(sum(float(p.get("cashPnl") or 0) for p in live), 2),
    }
    log(f"open book: {ob['n']}/{len(rows)} positions live "
        f"({len(rows) - ob['n']} already resolved), unrealized {ob['unrealized']:,.0f}")
    return ob


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
        # Shares can leave the wallet on a leg that never recorded a BUY: a
        # negRisk CONVERSION delivers NO shares into every sibling market of an
        # event, but the feed books it once, on the parent, with outcomeIndex 999
        # and no side. Twelve positions here have a running share balance that
        # goes negative (worst: -22,222 on WTI LOW $60 May) — they sold stock the
        # trade feed never shows them buying.
        #
        # `held` already floors at 0, so the settlement lot is safe. The exit lot
        # is not: it would book `proceeds - entry*sold` over shares that were
        # never paid for, $48,489 of phantom cost basis inflating exit `volume`
        # and flattening its roi.
        #
        # Scale BOTH sides. Capping `sold` while leaving `proceeds` whole is not
        # a partial fix, it is a worse bug — it keeps every dollar of revenue
        # against a shrunken cost base and turns $48k of phantom volume into $48k
        # of phantom PROFIT, flipping the book's closed-lot total from -$16.7k to
        # +$31.8k. Pro-rata lands at -$16.8k, i.e. -$15 from where it started,
        # which is the honest size of this correction.
        if sold > bought:
            if sold - bought > SHARE_TOL:
                log(f"off-feed shares: sold exceeds bought by {sold - bought:,.0f} sh "
                    f"(likely conversion) — {p['title'][:50]}")
            proceeds *= bought / sold
            sold = bought
        held = max(0.0, bought - sold)
        # (the settlement lot's own residue check lives at the emit below)
        base = {
            "conditionId": cond, "outcomeIndex": oi,
            "title": p["title"], "outcome": p["outcome"],
            "impliedEntry": round(entry, 4),
        }

        # Was the outcome already decided when these shares left? A sale at
        # SETTLE_PX_HI+ (or SETTLE_PX_LO-) into a market that later resolved is a
        # redemption in all but name, so it is scored as a settlement instead of
        # as a trade. That is what makes the two series honest: `settlement` =
        # every position whose result was determined, `exit` = only the trades
        # closed while the outcome was genuinely still live — real swing trades.
        #
        # `win` comes from gamma's winner and NEVER from the exit price. At this
        # threshold the two happen to agree 62/62, but the agreement is a
        # property of the threshold, not a rule: relax it to 0.99 and this book
        # already contains a counterexample — "Iran x Israel/US conflict ends by
        # April 7?" sold at 0.9905 and resolved LOST. Reading the outcome off the
        # price would have booked that as a win.
        exit_price = (proceeds / sold) if sold > EPS else None
        decided = (exit_price is not None and cond in winners
                   and (exit_price >= SETTLE_PX_HI or exit_price <= SETTLE_PX_LO))

        if decided:
            won = (oi == winners[cond])
            # Fold any held remainder into the SAME lot. Emitting two settlement
            # records at one entry price for one outcome would weight this
            # position twice in the reliability diagram.
            if entry * held < MIN_LOT_USD:
                held = 0.0
            shares = sold + held
            # P&L keeps the ACTUAL proceeds on the sold part — those shares went
            # at 0.998, not 1.00 — so reclassifying never moves a dollar of
            # realized P&L, it only changes which series scores the position.
            rp = round((proceeds - entry * sold)
                       + (held * (1.0 if won else 0.0) - entry * held), 2)
            records.append({**base,
                "resolvedVia": "settlement",
                "shares": round(shares, 2),
                "volume": round(entry * shares, 2),
                "settlePrice": 1.0 if won else 0.0,
                "exitPrice": round(exit_price, 4),
                "win": bool(won),
                "push": False,
                "realizedPnl": rp,
            })
            continue

        # exit lot: shares sold before resolution -> outcome = closed in profit.
        # An exit that nets $0.00 (sold at cost) is a push — a scratch, neither a
        # win nor a loss — so it's excluded from the win-rate denominator rather
        # than counted against you.
        if sold > EPS:
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
        #
        # The cost floor is doing real work, not tidying. A position sold down to
        # 9,999.97 of 10,000 shares leaves 0.03 shares riding to resolution, and
        # at EPS (1e-6) that crumb became a settlement record: $0.00 of capital,
        # one FULL vote in `n`, `hitRate`, `brier` and `calibrationError`, ranked
        # equal to a $23k position. 98 of the 596 settlement records were this.
        #
        # They are not a discarded sample — they are a DUPLICATE. Every one of
        # them belongs to a position whose real size already appears as that same
        # position's exit lot (a residue this small can only exist because almost
        # everything was sold, which by construction emits an exit lot). Counting
        # both said the book made 596 forecasts when it made ~498.
        #
        # The tell that they were noise rather than signal: those 98 hit 51-82%
        # against 94% for lots over $100, i.e. near coin-flips carrying $5.90 of
        # cost basis between them. Dropping them moves hitRate 0.8725 -> 0.9056
        # and `edge` +0.0056 -> +0.0199. Note calibrationError gets slightly
        # WORSE (0.0326 -> 0.0349) — dust that happened to sit near the diagonal
        # was flattering the fit, which is the evidence this floor is measuring
        # more honestly rather than just polishing the number upward.
        if held > EPS and entry * held >= MIN_LOT_USD and cond in winners:
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


def hedged_conditions(pos):
    """Markets where both legs were held AT THE SAME TIME — a hedge, not a forecast.

    29 markets here were traded on both sides, and they are two different things
    wearing one shape. Split them by whether the legs' trade windows overlap:

      20 SEQUENTIAL (a flip) — bought NO, closed it, later bought YES. Two real
         directional calls at two real prices, and they belong in the reliability
         diagram. They carry $242,530 of volume and -$32,864 of P&L, including
         the -$23,323 WTI LOW $70 June position. Genuine losses, not artifacts.

       9 OVERLAPPING (a hedge) — both sides open together. This is not a
         probability judgment at all; it is a spread. Whatever the market does,
         it settles one leg to $1 and the other to $0, so it posts a guaranteed
         win/loss PAIR into the calibration series at a known 50% rate. Twelve
         such settlement lots hit 58.3% against the book's 87%, purely by
         construction. They carry $17,455 of volume and -$63 of P&L.

    Only the overlapping set is excluded, and only from the calibration series —
    the reliability diagram, hit rate, Brier and calibration error. They stay in
    byCategory and in every P&L figure, because the money was real; it just was
    not a forecast. At -$63 of P&L the attribution loses nothing by keeping them.
    """
    legs = defaultdict(list)
    for (cond, oi), p in pos.items():
        if p["firstTs"] is not None:
            legs[cond].append((p["firstTs"], p["lastTs"]))
    out = set()
    for cond, spans in legs.items():
        if len(spans) != 2:
            continue
        (a0, a1), (b0, b1) = spans
        if not (a1 <= b0 or b1 <= a0):   # windows touch -> held concurrently
            out.add(cond)
    return out


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
    book of favorites scores well with no skill):

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

    applied, skipped = apply_merges(pos, all_rows)
    log(f"merges: {applied} booked as paired sells, {skipped} unattributable")

    # Conversions are the one hole this pipeline cannot close. A negRisk
    # CONVERSION burns NO shares in one outcome and returns USDC plus NO shares
    # in every sibling — but the feed records it on the parent event only, with
    # outcomeIndex 999, so there is nothing to attribute to a leg. The clamp in
    # build_records stops the delivered shares from inflating an exit lot when
    # they are later sold; it cannot recover the conversion's own P&L. Log the
    # exposure so the gap is visible rather than silent.
    conv = [a for a in all_rows if a.get("type") == "CONVERSION"]
    if conv:
        log(f"conversions: {len(conv)} rows, "
            f"${sum(float(a.get('usdcSize') or 0) for a in conv):,.0f} unattributed")

    conds = {cond for (cond, _) in pos.keys()}
    winners = fetch_resolutions(sess, conds)
    log(f"{len(winners)}/{len(conds)} markets resolved via gamma")

    records = build_records(pos, winners)
    settle = [r for r in records if r["resolvedVia"] == "settlement"]
    exit_ = [r for r in records if r["resolvedVia"] == "exit"]
    log(f"records: {len(settle)} settlement, {len(exit_)} exit")

    # A concurrently-held both-sides position is a spread, not a forecast, so it
    # is dropped from the calibration series only — `calib` feeds the reliability
    # diagram, `records` (untouched) still feeds byCategory and every P&L figure.
    hedges = hedged_conditions(pos)
    for r in records:
        r["hedge"] = r["conditionId"] in hedges
    calib = [r for r in records if not r["hedge"]]
    log(f"hedges: {len(hedges)} concurrently two-sided markets, "
        f"{len(records) - len(calib)} records excluded from calibration "
        f"(${sum(r['realizedPnl'] for r in records if r['hedge']):,.0f} P&L retained elsewhere)")

    cats = fetch_categories(sess, conds)
    for r in records:
        r["category"] = cats.get(r["conditionId"], "other")
    uncat = sum(1 for r in records if r["category"] == "other")
    log(f"uncategorized records: {uncat}/{len(records)}")

    open_book = fetch_open_book(
        sess, winners.keys(),
        {r["conditionId"] for r in records if r["resolvedVia"] == "settlement"})

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "wallets": WALLETS,
        "method": {
            "source": "data-api activity (trades) + gamma-api resolution",
            "settlement": ("outcome determined — held to resolution, or sold at "
                           f">={SETTLE_PX_HI}/<={SETTLE_PX_LO} into a market that resolved; "
                           "win = actual winning side, never inferred from price"),
            "exit": ("swing trades — closed while the outcome was still live; "
                     "win = sold above avg entry (profit)"),
            "merge": "MERGE booked as a paired exit on both legs, $1 split pro-rata by entry",
            "conversion": "negRisk CONVERSION unattributable (event-level, outcomeIndex 999)",
            "minLotUsd": MIN_LOT_USD,
            "hedges": "concurrently two-sided markets excluded from calibration, kept in P&L",
            "bucketEdges": BUCKET_EDGES,
            "category": "gamma event tags -> canonical category; venue tags ignored",
            "minCategoryN": MIN_CATEGORY_N,
        },
        "headline": {
            "settlement": headline(calib, "settlement"),
            "exit": headline(calib, "exit"),
        },
        "buckets": {
            "settlement": bucketize(calib, "settlement"),
            "exit": bucketize(calib, "exit"),
        },
        "byCategory": by_category(records),
        # Scope note for the by-market-type panel: every figure above is closed
        # lots, so this is what those bars leave out. Small in this book (+$10k
        # spread thin) but the panel shouldn't make the reader assume that.
        "openBook": open_book,
        # Companion scope note to openBook: what the CLOSED-lot figures above
        # still don't cover. `hedged` is money that was real but wasn't a
        # forecast (kept in byCategory, dropped from the diagram); `conversions`
        # is the one hole the pipeline genuinely cannot close, since the feed
        # books negRisk conversions at event level with no leg to attribute to.
        "excluded": {
            "hedged": {
                "markets": len(hedges),
                "records": len(records) - len(calib),
                "realizedPnl": round(sum(r["realizedPnl"] for r in records if r["hedge"]), 2),
            },
            "conversions": {
                "rows": len(conv),
                "usd": round(sum(float(a.get("usdcSize") or 0) for a in conv), 2),
            },
            "minLotUsd": MIN_LOT_USD,
        },
        # Note: the per-lot `positions` array is intentionally NOT emitted — the
        # panel only reads `buckets` + `headline` (a few KB, fixed size), so
        # shipping the ~700 raw records would bloat the static payload ~40x for
        # data the page never renders. Re-add a trimmed version if the UI ever
        # grows an in-browser drill-down.
    }
    print(json.dumps(out, indent=2))


main()
