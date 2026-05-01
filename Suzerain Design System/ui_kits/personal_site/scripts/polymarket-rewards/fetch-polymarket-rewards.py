#!/usr/bin/env python3
"""
fetch-polymarket-rewards.py
Fetches Polymarket maker rebates and liquidity rewards for a wallet.
Outputs JSON to stdout → pipe to data/polymarket-rewards.json.

Incremental: loads existing file and only fetches new dates.

Env vars:
  PM_WALLET        - maker wallet address (defaults to hardcoded wallet)
  POLY_API_KEY     - CLOB API key (optional; required for liquidity rewards)
  POLY_SECRET      - CLOB API secret (optional; base64-encoded)
  POLY_PASSPHRASE  - CLOB API passphrase (optional)
"""
import json, os, sys, time, hmac, hashlib, base64
from datetime import date, timedelta
from urllib.request import urlopen, Request
from urllib.error import HTTPError

CLOB    = "https://clob.polymarket.com"
WALLET  = os.environ.get("PM_WALLET", "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a")
API_KEY = os.environ.get("POLY_API_KEY", "")
SECRET  = os.environ.get("POLY_SECRET", "")
PHRASE  = os.environ.get("POLY_PASSPHRASE", "")

# Earliest date to fetch when starting fresh — adjust to when you began market-making
START_DATE = date(2024, 10, 1)
EXISTING_PATH = "Suzerain Design System/ui_kits/personal_site/data/polymarket-rewards.json"

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def get_json(url, headers=None):
    req = Request(url, headers=headers or {})
    try:
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except HTTPError as e:
        if e.code in (404, 204):
            return []
        raise

def _hmac_sig(secret_b64, timestamp, method, path, body=""):
    message = timestamp + method + path + body
    key = base64.b64decode(secret_b64)
    sig = hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(sig).decode("utf-8")

def auth_headers(path):
    ts = str(int(time.time()))
    return {
        "POLY_ADDRESS":    WALLET,
        "POLY_SIGNATURE":  _hmac_sig(SECRET, ts, "GET", path),
        "POLY_TIMESTAMP":  ts,
        "POLY_API_KEY":    API_KEY,
        "POLY_PASSPHRASE": PHRASE,
    }

def fetch_rebates(d):
    url = f"{CLOB}/rebates/current?date={d}&maker_address={WALLET}"
    rows = get_json(url)
    return sum(float(r.get("rebated_fees_usdc", 0)) for r in rows)

def fetch_rewards(d):
    if not (API_KEY and SECRET and PHRASE):
        return None
    path = "/rewards/user/total"
    url  = f"{CLOB}{path}?date={d}&maker_address={WALLET}"
    rows = get_json(url, auth_headers(path))
    return sum(float(r.get("earnings", 0)) * float(r.get("asset_rate", 1)) for r in rows)

def main():
    existing = {}
    if os.path.exists(EXISTING_PATH):
        try:
            with open(EXISTING_PATH) as f:
                old = json.load(f)
            for row in old.get("byDate", []):
                existing[row["date"]] = row
            log(f"loaded {len(existing)} existing dates from {EXISTING_PATH}")
        except Exception as e:
            log(f"warning: could not load existing file: {e}")

    yesterday = date.today() - timedelta(days=1)
    fetch_from = START_DATE
    if existing:
        last = max(date.fromisoformat(d) for d in existing)
        fetch_from = last + timedelta(days=1)

    has_creds = bool(API_KEY and SECRET and PHRASE)
    log(f"fetch range: {fetch_from} → {yesterday}  |  rewards creds: {has_creds}")

    d = fetch_from
    while d <= yesterday:
        ds = d.isoformat()
        try:
            rebates = fetch_rebates(ds)
            rewards = fetch_rewards(ds)
            row = {
                "date":             ds,
                "makerRebates":     round(rebates, 6),
                "liquidityRewards": round(rewards, 6) if rewards is not None else None,
                "combined":         round(rebates + (rewards or 0), 6),
            }
            existing[ds] = row
            log(f"  {ds}  rebates={rebates:.4f}  rewards={rewards}")
        except Exception as e:
            log(f"  {ds}  error: {e}")
        time.sleep(0.2)
        d += timedelta(days=1)

    all_rows   = sorted(existing.values(), key=lambda r: r["date"], reverse=True)
    t_rebates  = sum(r["makerRebates"]              for r in all_rows)
    t_rewards  = sum(r["liquidityRewards"] or 0     for r in all_rows)
    has_rw     = any(r["liquidityRewards"] is not None for r in all_rows)

    print(json.dumps({
        "generatedAt":    date.today().isoformat(),
        "wallet":         WALLET,
        "hasRewardsData": has_rw,
        "totals": {
            "makerRebates":     round(t_rebates, 6),
            "liquidityRewards": round(t_rewards, 6),
            "combined":         round(t_rebates + t_rewards, 6),
        },
        "byDate": all_rows,
    }, indent=2))

main()
