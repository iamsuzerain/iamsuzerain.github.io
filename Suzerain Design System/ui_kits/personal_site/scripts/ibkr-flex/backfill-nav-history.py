#!/usr/bin/env python3
"""
Rebuild nav-history.json by replaying every portfolio.json snapshot in git.

Why: merge-nav-history.py only started running on 2026-07-25, so the history it
accumulates begins with that day's trailing-365-day Flex window — MAX and 1Y show
the identical span until enough days age out. But every daily `portfolio: refresh`
commit already stored a full trailing-year snapshot, and those reach back further
the older the commit. Replaying them oldest-first through the same merge() the
daily job uses reconstructs the history that would exist had the job always run.

Snapshots older than 2026-07-25 predate `pnlSeries`, so the cumulative-$ P&L is
re-derived from navSeries + perfSeries:

    daily HPR_i  = (1 + t_i) / (1 + t_{i-1}) - 1      (perfSeries is cumulative TWR)
    daily P&L_i  = nav_{i-1} * HPR_i                  (= nav_i - nav_{i-1} - CF_i)
    v_t          = Σ P&L_1..t

which is algebraically the same quantity build_pnl_series() computes from explicit
cash flows — the flows cancel out. Verified against the one snapshot that carries
both: max divergence $0.34 over 262 days, from perfSeries' 6-dp rounding.

Usage:
  backfill-nav-history.py [--write] [--out PATH]
Prints a summary by default; only touches nav-history.json with --write.

Stdlib only (shells out to git). Safe to re-run: output is a pure function of
git history plus the working-tree portfolio.json.
"""
from __future__ import annotations
import argparse, importlib.util, json, os, subprocess, sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "data"))
REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=HERE,
                      capture_output=True, text=True).stdout.strip()
# Path of portfolio.json relative to the repo root, as git wants it.
PF_REL = os.path.relpath(os.path.join(DATA, "portfolio.json"), REPO).replace("\\", "/")

# Reuse the daily job's merge() verbatim so a replay and a live run agree. Its
# filename has dashes, so it can't be imported by name — load it by path.
_spec = importlib.util.spec_from_file_location("mergenav", os.path.join(HERE, "merge-nav-history.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
merge = _mod.merge


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def snapshot_rows(pf: dict) -> list[dict]:
    """One portfolio.json -> [{d, v, t, n}] on that snapshot's own baseline
    (n is absolute NAV, which has no baseline)."""
    nav = pf.get("navSeries") or []
    perf = pf.get("perfSeries") or []
    if len(nav) < 2 or len(perf) != len(nav):
        return []                      # pre-perfSeries or placeholder snapshot
    pnl = pf.get("pnlSeries") or []
    if len(pnl) == len(nav):           # 2026-07-25 onward: trust the fetcher
        vals = [r["v"] for r in pnl]
    else:
        vals, cum = [0.0], 0.0
        for i in range(1, len(nav)):
            hpr = (1 + perf[i]["v"]) / (1 + perf[i - 1]["v"]) - 1
            cum += nav[i - 1]["v"] * hpr
            vals.append(cum)
    return [{"d": nav[i]["d"], "v": vals[i], "t": perf[i]["v"], "n": nav[i]["v"]}
            for i in range(len(nav))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="write nav-history.json (default: dry run)")
    ap.add_argument("--out", default=os.path.join(DATA, "nav-history.json"))
    args = ap.parse_args()

    commits = git("log", "--reverse", "--format=%H", "--", PF_REL).split()
    print(f"replaying {len(commits)} portfolio.json commits", file=sys.stderr)

    rows: list[dict] = []
    used = skipped = 0
    for h in commits:
        try:
            pf = json.loads(git("show", f"{h}:{PF_REL}"))
        except (RuntimeError, ValueError):
            skipped += 1
            continue
        inc = snapshot_rows(pf)
        if not inc:
            skipped += 1
            continue
        rows = merge(inc, rows)
        used += 1

    # Fold in the working-tree file too, in case it's ahead of the last commit.
    try:
        with open(os.path.join(DATA, "portfolio.json"), encoding="utf-8") as f:
            inc = snapshot_rows(json.load(f))
        if inc:
            rows = merge(inc, rows)
            used += 1
    except (FileNotFoundError, ValueError):
        pass

    if not rows:
        print("no usable snapshots — refusing to write", file=sys.stderr)
        return 1

    print(f"used {used} snapshots, skipped {skipped} -> "
          f"{len(rows)} rows ({rows[0]['d']} .. {rows[-1]['d']})", file=sys.stderr)
    if not args.write:
        print("dry run — pass --write to update nav-history.json", file=sys.stderr)
        return 0

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "rows": rows,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
