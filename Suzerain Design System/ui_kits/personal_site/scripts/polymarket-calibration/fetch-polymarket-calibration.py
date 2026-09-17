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
     settlement pair. CONVERSION rows carry no legs, so they are booked from
     their on-chain receipts as synthetic trades (see apply_conversions).
  3. Resolve each traded market via gamma-api (batched condition_ids,
     closed=true) -> winning outcomeIndex from outcomePrices (["1","0"]).
  4. Emit records, splitting a position into up to two lots so the two views
     never blend (this is the decision point partial exits force):
       - 'settlement' lot: shares held to resolution. win = held side won.
       - 'exit' lot: shares sold before resolution. win = sold above entry
         (closed in profit). Sold-early has no resolution truth, so its "win"
         is realized-profit, which is a hit-rate signal, NOT a calibration one.
     Both lots share the entry price, so each still buckets by implied odds.
  5. Date each lot by the day its shares left the book (last trade if sold,
     gamma's resolution date if held) and emit them trimmed as `lots`, which is
     what lets the attribution panel window itself instead of only ever showing
     a lifetime aggregate.
  6. Bucket into deciles per series with Wilson 95% bands; headline hit rate,
     Brier score, and mean calibration error (settlement series only, since the
     diagonal is only meaningful there).

Outputs JSON to stdout -> data/polymarket-calibration.json

Env:
  PM_WALLET - comma-separated wallet addresses (defaults to hardcoded list)
"""
import ast, json, math, os, sys
from collections import Counter, defaultdict
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
PRICES_URL = "https://clob.polymarket.com/prices-history"
# Public Polygon RPCs, tried in order, for conversion receipts (see apply_conversions).
POLYGON_RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://1rpc.io/matic",
]
CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"   # Polymarket's ERC-1155 outcome tokens
TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"
TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"
PRICE_WINDOW = 3600   # seconds either side of a conversion to look for a market price
CASH_TOL_USD = 25.0   # per-event gap between lots and cash worth logging
PAGE = 500          # activity page size
OFFSET_CEIL = 5000  # /activity rejects offset past ~5500; slide the window before then
GAMMA_CHUNK = 25    # condition_ids per gamma request (URL-length safe)
EVENTS_CHUNK = 20   # event ids per gamma /events request
EPS = 1e-6          # share dust threshold
SHARE_TOL = 1.0     # sold-over-bought below this is float dust, not off-feed shares
MIN_LOT_USD = 1.0   # a lot that cost under a dollar is residue, not a forecast
HEDGE_MIN_RATIO = 0.25  # smaller leg's shares vs larger's before overlapping legs count as a hedge
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
    taker-only and drops maker fills, which would corrupt entry prices.

    Overlap between windows is removed by multiplicity, not by set membership.
    One transaction can carry several fills that are identical in every field
    the feed returns — three 58.07-share buys at 0.87 in one hash on the
    September Fed 25bp-hike market — and a plain `seen` set kept one of each,
    silently dropping 16,422 shares ($10.9k) from that position alone. Pages
    inside one window are disjoint (the first window is pinned to `end=now` so
    fresh activity can't shift them), so the only overlap is the boundary
    timestamp shared with the previous window, which the new window returns in
    full. Keeping each key's larger count across windows is therefore exact."""
    rows, have = [], Counter()
    end = int(datetime.now(timezone.utc).timestamp())
    first = True
    while True:
        window, window_oldest = [], None
        off = 0
        while True:
            params = {"user": wallet, "limit": PAGE, "offset": off, "end": end}
            r = sess.get(ACTIVITY_URL, params=params, timeout=30)
            if r.status_code != 200:
                break
            page = r.json()
            if not isinstance(page, list) or not page:
                break
            for a in page:
                if not isinstance(a, dict):
                    continue
                window.append(a)
                ts = a.get("timestamp")
                if ts is not None and (window_oldest is None or ts < window_oldest):
                    window_oldest = ts
            off += PAGE
            if len(page) < PAGE or off >= OFFSET_CEIL:
                break
        counts, added = Counter(), 0
        for a in window:
            key = (a.get("transactionHash"), a.get("asset"),
                   a.get("timestamp"), a.get("type"), a.get("size"))
            counts[key] += 1
            if counts[key] > have[key]:
                have[key] += 1
                rows.append(a)
                added += 1
        # Stop when a window yields nothing new or can't reach further back.
        if not added or window_oldest is None or (not first and window_oldest >= end):
            break
        end, first = window_oldest, False
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

    Entry prices come from buys alone (trades, plus shares a conversion
    delivered), so this must run AFTER aggregate_positions and apply_conversions
    and never feed its own synthetic sells back into them.
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


def fetch_receipt(sess, tx):
    """Polygon transaction receipt from the first public RPC that answers."""
    for url in POLYGON_RPCS:
        try:
            r = sess.post(url, json={"jsonrpc": "2.0", "id": 1,
                                     "method": "eth_getTransactionReceipt",
                                     "params": [tx]}, timeout=30)
            res = r.json().get("result")
            if res and isinstance(res.get("logs"), list):
                return res
        except Exception:
            continue
    return None


def ctf_moves(receipt, wallet):
    """(token id, shares, +1 received / -1 sent) for every outcome-token transfer
    touching `wallet` in one receipt."""
    wallet = wallet.lower()[2:]
    out = []
    for lg in receipt.get("logs") or []:
        topics = lg.get("topics") or []
        if (lg.get("address") or "").lower() != CTF or len(topics) < 4:
            continue
        frm, to = topics[2][-40:].lower(), topics[3][-40:].lower()
        if wallet not in (frm, to) or frm == to:
            continue
        sign = 1 if to == wallet else -1
        data = lg.get("data") or "0x"
        w = [int(data[2 + i:66 + i], 16) for i in range(0, len(data) - 2, 64)]
        if topics[0] == TRANSFER_SINGLE and len(w) >= 2:
            out.append((str(w[0]), w[1] / 1e6, sign))
        elif topics[0] == TRANSFER_BATCH and len(w) >= 4:
            n = w[2]
            ids, vals = w[3:3 + n], w[4 + n:4 + 2 * n]
            out += [(str(i), v / 1e6, sign) for i, v in zip(ids, vals)]
    return out


def fetch_event_tokens(sess, slugs):
    """token id -> (conditionId, outcomeIndex, title, outcome) for every market in
    the given events, including siblings the book never traded (a conversion mints
    into all of them)."""
    tokens = {}
    for slug in slugs:
        try:
            d = sess.get(EVENTS_URL, params={"slug": slug}, timeout=30).json()
        except Exception as e:
            log(f"event tokens failed for {slug}:", e)
            continue
        for ev in d if isinstance(d, list) else []:
            for m in ev.get("markets") or []:
                try:
                    ids = json.loads(m.get("clobTokenIds") or "[]")
                    outs = json.loads(m.get("outcomes") or "[]")
                except Exception:
                    continue
                for oi, (t, o) in enumerate(zip(ids, outs)):
                    tokens[str(t)] = (m.get("conditionId"), oi, m.get("question") or "", o)
    return tokens


def price_at(sess, token, ts, fills):
    """Market price of one outcome token at `ts`: the CLOB's own history if it has
    a point within PRICE_WINDOW, else this book's nearest fill on the token within
    the same window. None when neither exists."""
    try:
        h = sess.get(PRICES_URL, params={"market": token, "startTs": ts - PRICE_WINDOW,
                                         "endTs": ts + PRICE_WINDOW, "fidelity": 1},
                     timeout=30).json().get("history") or []
        if h:
            return float(min(h, key=lambda p: abs(p["t"] - ts))["p"])
    except Exception:
        pass
    near = [(abs(t - ts), px) for t, px in fills.get(token, []) if abs(t - ts) <= PRICE_WINDOW]
    return min(near)[1] if near else None


def apply_conversions(sess, pos, all_rows):
    """Book each negRisk CONVERSION as synthetic trades on the legs it actually moved.

    A conversion hands in N NO shares on k markets of an event and gets back
    (k-1)*N USDC plus N YES shares on every other market in it. The activity feed
    records only the event and the USDC — outcomeIndex 999, no legs — so for
    a long time the shares were invisible. On the September 2026 Fed decision
    that was 46k YES shares on the 25bp hike: the lot read 55c and +$62k where
    the position really cost 50c and the event's cash says +$88.8k.

    The legs are not guessable from share balances (several NO legs routinely
    hold enough to be the source), but the transaction receipt is exact: the
    outcome-token contract logs every token leaving and entering the wallet.
    Those become a synthetic SELL on each NO leg handed in and a synthetic BUY on
    each YES leg received.

    Pricing: each received YES leg is bought at its market price at the time,
    so its basis is what those shares were worth. The NO legs' proceeds are then
    set to the USDC received plus that YES value, split across them by their own
    prices. That makes every conversion cash-exact by construction — prices only
    decide which leg the money lands on, never how much there is.

    A conversion whose receipt or token map can't be read is left out and logged;
    the sold-over-bought clamp in build_records still covers its shares.
    """
    conv = [a for a in all_rows if a.get("type") == "CONVERSION"]
    if not conv:
        return 0, 0
    tokens = fetch_event_tokens(sess, sorted({a.get("eventSlug") for a in conv} - {None}))
    fills = defaultdict(list)
    for a in all_rows:
        if a.get("type") == "TRADE" and a.get("asset") and a.get("price"):
            fills[str(a["asset"])].append((a.get("timestamp") or 0, float(a["price"])))

    # A receipt holds every conversion in its transaction, so book it once with
    # the USDC of all the rows that share it.
    by_tx = {}
    for a in conv:
        tx = a.get("transactionHash")
        if tx in by_tx:
            by_tx[tx] = {**by_tx[tx], "usdcSize": float(by_tx[tx].get("usdcSize") or 0)
                         + float(a.get("usdcSize") or 0)}
        else:
            by_tx[tx] = a

    applied = skipped = unpriced = 0
    for a in by_tx.values():
        ts, usd = int(a.get("timestamp") or 0), float(a.get("usdcSize") or 0)
        label = (a.get("title") or "?")[:45]
        rc = fetch_receipt(sess, a.get("transactionHash"))
        moves = ctf_moves(rc, a.get("proxyWallet") or "") if rc else []
        legs = [(tokens.get(t), t, sh, sign) for t, sh, sign in moves]
        if not legs or any(leg is None for leg, *_ in legs):
            log(f"conversion not attributable ({'no receipt' if not rc else 'unmapped tokens'}): "
                f"${usd:,.0f} {label}")
            skipped += 1
            continue
        px = {t: price_at(sess, t, ts, fills) for _, t, _, _ in legs}
        unpriced += sum(1 for t in px.values() if t is None)
        got = [(leg, t, sh) for leg, t, sh, sign in legs if sign > 0]
        gave = [(leg, t, sh) for leg, t, sh, sign in legs if sign < 0]
        yes_value = sum(sh * (px[t] or 0) for _, t, sh in got)
        weight = sum(sh * (px[t] or 0) for _, t, sh in gave)
        for leg, t, sh in got:
            p = pos[(leg[0], leg[1])]
            p["buyShares"] += sh
            p["buyUsd"] += sh * (px[t] or 0)
        for leg, t, sh in gave:
            p = pos[(leg[0], leg[1])]
            share = (sh * (px[t] or 0) / weight) if weight > 0 else sh / sum(s for *_, s in gave)
            p["sellShares"] += sh
            p["sellUsd"] += (usd + yes_value) * share
        for leg, _, _ in got + gave:
            p = pos[(leg[0], leg[1])]
            p["title"] = p["title"] or leg[2]
            p["outcome"] = p["outcome"] or leg[3]
            p["outcomeIndex"] = leg[1]
            p["firstTs"] = ts if p["firstTs"] is None else min(p["firstTs"], ts)
            p["lastTs"] = ts if p["lastTs"] is None else max(p["lastTs"], ts)
        applied += 1
    if unpriced:
        # Siblings nobody has traded (a 30-candidate election's long shots) have
        # no price history; their YES arrives at 0, which is what it was worth.
        log(f"conversions: {unpriced} legs had no market price and were booked at 0")
    return applied, skipped


def check_event_cash(records, all_rows, positions, live_conds):
    """Tripwire: each finished event's lots must add up to the cash it moved.

    Cash is the one figure nothing here reconstructs — USDC out on buys, in on
    sells, redemptions, merges and conversions — so it cannot share a bug with
    the lot logic. Polymarket's own P&L can't serve: it has mis-marked
    conversions before (+$16k wrong way on Bev Craig, +$20k on 2026-08-26).
    Events with a position still live are skipped; a resolved winner not yet
    redeemed counts at its redeemable value. Gaps are logged, never fatal.
    """
    event_of, cash = {}, defaultdict(float)
    for a in all_rows:
        ev, cond = a.get("eventSlug"), a.get("conditionId")
        if not ev:
            continue
        if cond:
            event_of.setdefault(cond, ev)
        usd, kind = float(a.get("usdcSize") or 0), a.get("type")
        if kind == "TRADE":
            cash[ev] += usd if (a.get("side") or "").upper() == "SELL" else -usd
        elif kind in ("REDEEM", "MERGE", "CONVERSION"):
            cash[ev] += usd
        elif kind == "SPLIT":
            cash[ev] -= usd
    live = {event_of.get(c) for c in live_conds}
    for p in positions:
        if p.get("redeemable"):
            cash[p.get("eventSlug") or event_of.get(p.get("conditionId"))] += float(p.get("currentValue") or 0)
    lots = defaultdict(float)
    for r in records:
        ev = event_of.get(r["conditionId"])
        if ev:
            lots[ev] += r["realizedPnl"]
    checked = [ev for ev in lots if ev not in live]
    gaps = sorted(((lots[ev] - cash[ev], ev) for ev in checked
                   if abs(lots[ev] - cash[ev]) > CASH_TOL_USD), key=lambda g: -abs(g[0]))
    log(f"cash check: {len(checked)} closed events, {len(gaps)} off by more than "
        f"${CASH_TOL_USD:,.0f} (net ${sum(g for g, _ in gaps):+,.0f})")
    for g, ev in gaps[:10]:
        log(f"  lots {lots[ev]:+,.0f} vs cash {cash[ev]:+,.0f} ({g:+,.0f}) {ev[:60]}")
    return {"events": len(checked), "offBy": len(gaps),
            "netGap": round(sum(g for g, _ in gaps), 2)}


def fetch_resolutions(sess, condition_ids):
    """conditionId -> (winning outcomeIndex, resolution date), for closed markets.

    The date rides along because it is free: this call already pulls every
    resolved market the book touched, and `closedTime` is on the same object.
    It is what dates a lot that was HELD to resolution (see lot_closed_on) —
    the last trade on such a position can be months before the money lands.

    `closedTime` is the actual resolution ('2026-05-01 12:00:00+00'); `endDate`
    is only the SCHEDULED end and can sit either side of it, so it is a fallback
    rather than a first choice.
    """
    winners = {}
    closed_on = {}
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
                stamp = m.get("closedTime") or m.get("endDate")
                if stamp and len(str(stamp)) >= 10:
                    closed_on[cond] = str(stamp)[:10]
    return winners, closed_on


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


def fetch_categories(sess, condition_ids, titles=None):
    """conditionId -> canonical category, via market -> event -> tags.

    Pass `titles` (a dict) to also collect conditionId -> event title off the
    same hop-2 responses, at no extra request. The event is what groups sibling
    markets — every strike of "what will WTI hit in June" is its own market but
    one event — so the records view can rank a trade rather than its legs.

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

    event_cat, event_title = {}, {}
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
            if ev.get("title"):
                event_title[str(ev.get("id"))] = ev["title"]

    out = {c: event_cat[e] for c, e in cond_event.items() if e in event_cat}
    if titles is not None:
        titles.update({c: event_title[e] for c, e in cond_event.items() if e in event_title})
    log(f"hop 2: {len(event_cat)}/{len(eids)} events tagged -> {len(out)} "
        f"of {len(ids)} markets categorized")
    return out


def fetch_open_book(sess, resolved_conds, settled_conds):
    """Unrealized mark on positions still genuinely open, per position and in total.

    Everything else in this file measures CLOSED lots — settled or exited. That
    left the open book invisible, and a book with $172k of live cost basis is not
    a footnote to its own attribution: a category can be quiet in the closed
    figures because its bets are still riding, which reads as "no activity" when
    it is the opposite. The per-position rows come back so main can attribute
    them by category alongside the realized ones.

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
    return ob, live, rows


def open_by_category(live, cats):
    """Live positions grouped by the same taxonomy the closed lots use.

    `cost` is what is still at risk and `unrealized` is the mark against it —
    deliberately kept apart from every realized figure rather than added into
    one number. A mark is an opinion the market is currently holding; a realized
    P&L is a fact. Merging them would let a category's bar move because nothing
    happened except a quote, and the panel's whole argument (picking vs sizing,
    read off resolved outcomes) rests on the distinction.
    """
    out = defaultdict(lambda: {"n": 0, "cost": 0.0, "mark": 0.0, "unrealized": 0.0})
    for p in live:
        e = out[cats.get(p.get("conditionId"), "other")]
        e["n"] += 1
        e["cost"] += float(p.get("initialValue") or 0)
        e["mark"] += float(p.get("currentValue") or 0)
        e["unrealized"] += float(p.get("cashPnl") or 0)
    return {k: {"n": v["n"], "cost": round(v["cost"], 2),
                "mark": round(v["mark"], 2),
                "unrealized": round(v["unrealized"], 2)}
            for k, v in sorted(out.items())}


def iso_day(ts):
    """Activity-feed epoch seconds -> 'YYYY-MM-DD' UTC."""
    if ts is None:
        return None
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")


def lot_closed_on(p, cond, sold_off, closed_on):
    """The day a lot's money became final — what the panel's range windows read.

    One rule covers all three lot shapes: a lot closes when its shares LEFT the
    book. Sold shares left at the last trade; held shares left at resolution.

    That distinction is not pedantry. A position held to resolution can have its
    last trade months before it pays — dating it by the trade would file the
    money in the wrong quarter, which is the whole thing these windows exist to
    get right. Conversely a lot sold at 0.999 into a market resolving a week
    later (the `decided` branch, booked as a settlement) had its cash in hand at
    the SALE, so it takes the trade date even though it scores as a settlement.

    Falls back to the last trade when gamma returned no resolution date, which
    dates the lot slightly early rather than dropping it from every window.
    """
    if sold_off:
        return iso_day(p["lastTs"])
    return closed_on.get(cond) or iso_day(p["lastTs"])


def build_records(pos, winners, closed_on):
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
        # Shares can leave the wallet on a leg that never recorded a BUY. Twelve
        # positions once had a running share balance that went negative (worst:
        # -22,222 on WTI LOW $60 May) — they sold stock the trade feed never shows
        # them buying. Conversions were the known source and apply_conversions
        # now books them; this clamp stays for whatever else arrives off-feed
        # (and for a conversion whose receipt couldn't be read).
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
                # sold at ~$1 — the cash landed at the trade, not at resolution
                "closedOn": lot_closed_on(p, cond, True, closed_on),
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
                "closedOn": lot_closed_on(p, cond, True, closed_on),
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
                # held to the end — dated by resolution, which is later than the
                # last trade and is the day this money actually arrived
                "closedOn": lot_closed_on(p, cond, False, closed_on),
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

    Overlap alone is not enough, though: the smaller leg has to be big enough to
    lock a real spread. Only matched shares pair off to a guaranteed $1, so the
    test is shares on the smaller leg against the larger (HEDGE_MIN_RATIO). By
    timing alone, the September Fed 25bp-hike market was a "hedge" — 1,788 NO
    shares held for a day against 192k YES — and its $106k, 50-cent directional
    call vanished from the diagram.
    """
    legs = defaultdict(list)
    for (cond, oi), p in pos.items():
        if p["firstTs"] is not None:
            legs[cond].append((p["firstTs"], p["lastTs"], p["buyShares"]))
    out = set()
    for cond, spans in legs.items():
        if len(spans) != 2:
            continue
        (a0, a1, sa), (b0, b1, sb) = spans
        if a1 <= b0 or b1 <= a0:          # sequential -> a flip, not a hedge
            continue
        if min(sa, sb) >= HEDGE_MIN_RATIO * max(sa, sb):
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


# Columns of a `lots` row, in order. Arrays rather than objects because this is
# the one ~900-row array in the payload: repeating seven keys on every row would
# roughly triple its bytes for data the panel reads positionally anyway.
# `market` and `outcome` come after the seven statistical columns so those keep
# their positions; they are read by the lot tape's tooltip, which names the
# position under the pointer. `event` is last of all, so every reader indexing
# the older nine columns by position is untouched; the records view groups
# sibling markets by it and reads it by name through `lotColumns`. It is null
# when the event's title is the market's own, so a reader falls back to `market`.
LOT_COLUMNS = ["category", "closedOn", "via", "volume", "realizedPnl",
               "win", "impliedEntry", "market", "outcome", "event"]
LOTS_SENTINEL = "__LOTS_GO_HERE__"


def lots_rows(records):
    """Per-lot rows for the attribution panel's range windows.

    `byCategory` is a lifetime aggregate and so cannot be sliced after the fact,
    which is the whole reason this exists: the panel recomputes category_stats
    in the browser over whichever window is selected. That needs one row per
    closed lot — but only the seven fields those statistics actually read, plus
    the market title and outcome the lot tape labels positions with. Not the
    full record (conditionId, shares, entry/exit/settle prices), which is what
    keeps this a ~130KB addition rather than a ~500KB one.

    `win` is 1 / 0 / null, null being a push — the same three-way split
    category_stats draws when it keeps a scratch exit in `n` and `volume` but
    out of the hit-rate denominator. Collapsing it to a boolean here would make
    every browser-side window disagree with the lifetime figures beside it.

    Sorted by close date so a daily commit appends rather than reshuffles.
    """
    rows = [[r["category"], r["closedOn"],
             "s" if r["resolvedVia"] == "settlement" else "e",
             r["volume"], r["realizedPnl"],
             None if r.get("push") else (1 if r["win"] else 0),
             r["impliedEntry"], r["title"], r["outcome"],
             # Only where it differs: most events hold one market under the
             # same title, and repeating it doubled the column's bytes.
             r.get("event") if r.get("event") != r["title"] else None]
            for r in records]
    rows.sort(key=lambda x: (x[1] or "", x[0]))
    return rows


def check_lots(records, rows):
    """Guard: the trimmed rows must reproduce byCategory exactly.

    The panel reads the server's `byCategory` at all-time and its own in-browser
    recomputation at every other range, so the two sit one toggle apart. If a
    field ever stops round-tripping through the trim, it surfaces as all-time
    disagreeing with 12mo on a book that hasn't traded in a year — which reads
    as a data error rather than the code error it is. Cheap to check here.
    """
    faux = [{"category": c, "closedOn": d,
             "resolvedVia": "settlement" if v == "s" else "exit",
             "volume": vol, "realizedPnl": pnl,
             "win": w == 1, "push": w is None, "impliedEntry": imp}
            for c, d, v, vol, pnl, w, imp, *_ in rows]
    a, b = by_category(records), by_category(faux)
    bad = [k for k in set(a) | set(b) if a.get(k) != b.get(k)]
    if bad:
        log(f"WARNING: lots do not reproduce byCategory for {sorted(bad)}")
    undated = sum(1 for r in rows if not r[1])
    if undated:
        log(f"WARNING: {undated} lots have no close date — invisible to every "
            f"range but all-time")


def main():
    sess = requests.Session(impersonate="chrome124")
    all_rows = []
    for w in WALLETS:
        rows = fetch_activity(sess, w)
        log(f"fetched {len(rows)} activity rows for {w[:8]}")
        all_rows += rows

    pos = aggregate_positions(all_rows)
    log(f"{len(pos)} distinct market-outcome positions")

    # Conversions before merges, so a merge of converted shares is split by an
    # entry price that includes them.
    conv = [a for a in all_rows if a.get("type") == "CONVERSION"]
    applied, conv_skipped = apply_conversions(sess, pos, all_rows)
    log(f"conversions: {len(conv)} rows, "
        f"${sum(float(a.get('usdcSize') or 0) for a in conv):,.0f} — "
        f"{applied} transactions booked from receipts, {conv_skipped} unattributable")

    applied, skipped = apply_merges(pos, all_rows)
    log(f"merges: {applied} booked as paired sells, {skipped} unattributable")

    conds = {cond for (cond, _) in pos.keys()}
    winners, closed_on = fetch_resolutions(sess, conds)
    log(f"{len(winners)}/{len(conds)} markets resolved via gamma "
        f"({len(closed_on)} carrying a resolution date)")

    records = build_records(pos, winners, closed_on)
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

    titles = {}
    cats = fetch_categories(sess, conds, titles)
    for r in records:
        r["category"] = cats.get(r["conditionId"], "other")
        r["event"] = titles.get(r["conditionId"])
    log(f"events: {sum(1 for r in records if r['event'])}/{len(records)} records titled")
    uncat = sum(1 for r in records if r["category"] == "other")
    log(f"uncategorized records: {uncat}/{len(records)}")

    open_book, live, positions = fetch_open_book(
        sess, winners.keys(),
        {r["conditionId"] for r in records if r["resolvedVia"] == "settlement"})

    # Almost every live position was bought on the trade feed and so is already
    # categorized, but not all: shares delivered by a negRisk CONVERSION arrive
    # without a BUY, so their market never entered `conds`. Categorize the
    # stragglers rather than letting them pile into "other", which is the one
    # bucket a reader cannot act on.
    missing = {p.get("conditionId") for p in live} - set(cats) - {None}
    if missing:
        cats.update(fetch_categories(sess, missing))
        log(f"open book: categorized {len(missing)} live markets not seen in trades")
    open_cats = open_by_category(live, cats)

    cash_check = check_event_cash(records, all_rows, positions,
                                  {p.get("conditionId") for p in live})

    lots = lots_rows(records)
    check_lots(records, lots)
    log(f"lots: {len(lots)} closed rows, {lots[0][1]} -> {lots[-1][1]}"
        if lots else "lots: none")

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
            "conversion": ("negRisk CONVERSION booked from its on-chain receipt: a SELL on each "
                           "NO leg handed in, a BUY at market price on each YES leg received, "
                           "cash-exact per conversion"),
            "minLotUsd": MIN_LOT_USD,
            "hedges": "concurrently two-sided markets excluded from calibration, kept in P&L",
            "bucketEdges": BUCKET_EDGES,
            "category": "gamma event tags -> canonical category; venue tags ignored",
            "minCategoryN": MIN_CATEGORY_N,
            "closedOn": ("a lot is dated when its shares left the book — the last "
                         "trade if sold, gamma's resolution date if held"),
            "lotColumns": LOT_COLUMNS,
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
        # The same open book split by market type, so the panel can show what is
        # still riding in a category next to what that category has booked.
        "openByCategory": open_cats,
        # The same taxonomy per live market, so the open-positions table can
        # filter by market type. The page fetches positions live from data-api,
        # so this is a lookup keyed on conditionId, not a copy of the book: a
        # market opened since this ran simply reads as unclassified there.
        "openCategories": {c: cats.get(c, "other")
                           for c in sorted({p.get("conditionId") for p in live} - {None})},
        # Companion scope note to openBook: what the CLOSED-lot figures above
        # still don't cover. `hedged` is money that was real but wasn't a
        # forecast (kept in byCategory, dropped from the diagram); `conversions`
        # counts any whose receipt couldn't be attributed; `cashCheck` is how
        # many finished events' lots disagree with the cash they moved.
        "excluded": {
            "hedged": {
                "markets": len(hedges),
                "records": len(records) - len(calib),
                "realizedPnl": round(sum(r["realizedPnl"] for r in records if r["hedge"]), 2),
            },
            "conversions": {
                "rows": len(conv),
                "usd": round(sum(float(a.get("usdcSize") or 0) for a in conv), 2),
                "unattributed": conv_skipped,
            },
            "cashCheck": cash_check,
            "minLotUsd": MIN_LOT_USD,
        },
        # The trimmed per-lot rows the attribution panel windows by date. The
        # FULL records are still not emitted — shipping conditionId, shares
        # and three prices per lot would bloat the payload for fields no view
        # reads. See lots_rows for the columns that are kept.
        "lots": LOTS_SENTINEL,
    }

    # `lots` is serialized one row per line, compact, rather than at indent=2:
    # seven scalars spread over nine lines each would turn a ~50KB array into
    # ~350KB, and the daily commit's diff from a legible append into a wall.
    text = json.dumps(out, indent=2)
    body = ",\n".join("    " + json.dumps(r, separators=(",", ":")) for r in lots)
    print(text.replace(f'"{LOTS_SENTINEL}"',
                       f"[\n{body}\n  ]" if lots else "[]"))


main()
