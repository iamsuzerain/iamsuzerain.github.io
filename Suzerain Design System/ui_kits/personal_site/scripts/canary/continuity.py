#!/usr/bin/env python3
"""continuity.py — day-over-day canary over the data files, against git HEAD.

Every data file this site publishes is a daily snapshot committed to git, which
means the copy in HEAD is a free second reading of everything except today. No
fetch, no API, no second opinion to invent: `git show HEAD:<path>` is a record
of what the same pipeline said about the same days twenty-four hours ago, and
the past is not supposed to move.

This is the same instrument as `flow_agreement` in fetch-ibkr.py — watch a
constant, say when it changes, print no amounts — generalized off IBKR's three
flow sources and onto the shape every data file here shares: a `rows` array
keyed by date.

WHAT IT CATCHES

  - a history file that rewrites its own past. Rows before today are closed; a
    run that restates them has either changed a derivation (intended, and worth
    seeing stated) or corrupted one (not intended, and currently invisible).
    polymarket-nav-history.json legitimately re-derives its pre-anchor rows,
    which is why a changed past is reported rather than fatal.
  - rows disappearing. A fetcher that half-fails and writes a short file will
    otherwise sail through: the JSON is valid, the site renders, the chart is
    just quietly shorter than it was.
  - dates out of order or duplicated. The only fatal class here, because there
    is no reading of the data under which it is correct, and because every
    chart on the site walks these arrays assuming both.
  - a snapshot flipping to a degraded source — `positionsSource` going from
    polymarket to betmoar, which is the silent fallback documented in
    fetch-betmoar-breakdown.py.

WHAT IT DOES NOT CATCH, AND WHY THE NAV THRESHOLD IS LOOSE

A day-over-day NAV move cannot be tuned to catch a pricing bug on this book.
The 2026-09-13 betmoar misread left ~$8k of positions out of a ~$300k NAV —
about 2.6%, and this book moves more than that on an ordinary day (5.5% on
2026-09-15, legitimately). A threshold tight enough to catch it would fire
constantly, and a canary that always cries is worse than none. So the jump flag
sits where only a structural break lands, and that particular bug is left to the
two-source comparison in fetch-betmoar-breakdown.py, which is the right
instrument for it.

PRIVACY

Reports counts, percentages and flags. No dollar amounts and no per-date
values, so it is safe in a world-readable Actions log — the constraint that
keeps reconcile_flows() local-only in fetch-ibkr.py.

Usage:
  python3 scripts/canary/continuity.py data/portfolio.json ...   # 1 on a fatal
  python3 scripts/canary/continuity.py --warn-only ...           # never nonzero
"""
import json, subprocess, sys
from pathlib import Path

# Per-file shape: which array holds the series, which key dates it, which field
# to watch for a structural jump, and whether the series is a rolling window or
# an append-only archive. A file absent from here is still checked for the
# things that need no configuration (valid JSON, present in HEAD).
#
# `rolling` is the difference between a row leaving because the window moved and
# a row leaving because something ate it. portfolio.json carries whatever the
# Flex statement's trailing window holds, so its oldest day drops off every time
# a new one lands — that is the design, and nav-history.json exists precisely to
# preserve what falls out of it. Flagging those would train the reader to ignore
# the flag by the end of the first week.
SERIES = {
    "nav-history.json":                  dict(rows="rows", key="d", value="n"),
    "polymarket-nav-history.json":       dict(rows="rows", key="d", value="nav"),
    "polymarket-breakdown-history.json": dict(rows="rows", key="d", value="nav"),
    "portfolio.json":                    dict(rows="navSeries", key="d", value="v",
                                              rolling=True),
    # Keyed by timestamp, not date, and its value is a cumulative P&L that
    # crosses zero — a percentage move against a near-zero base is noise, so
    # this file is watched for shape (order, count, a stable past) and not for
    # the size of its last step.
    "polymarket-pnl.json":               dict(rows="rows", key="t", value=None,
                                              rolling=True),
}

# A rolling window sheds its oldest row each run; it does not shed a fortnight.
ROLLING_DROP_MAX = 10

# Snapshot fields whose value is a source or a mode rather than a measurement.
# A change here is never noise: it means the pipeline took a different path
# today than it took yesterday, which is exactly what went unnoticed when
# /positions failed and betmoar's portfolioValue silently took over.
MODE_FIELDS = {
    "polymarket-breakdown.json": [("balances", "positionsSource")],
}

# Only a structural break should trip this. See the module docstring.
JUMP_PCT = 25.0


def head_version(path: Path) -> dict | None:
    """The committed copy of this file, or None if it is new, untracked or
    unparseable. All three mean the same thing here — no second reading to
    compare against — and none of them is the file's own fault."""
    # `HEAD:./x` resolves relative to the cwd; `HEAD:x` resolves from the repo
    # root. The data lives three directories down from the root, and the caller
    # is whatever directory the workflow happened to be standing in.
    try:
        blob = subprocess.run(["git", "show", f"HEAD:./{path.as_posix()}"],
                              capture_output=True, check=True).stdout
    except (subprocess.CalledProcessError, OSError):
        return None
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return None


def dig(obj, keys):
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


# Absolute, because the jitter this absorbs is a rounding artifact rather than a
# proportional error. nav-history stores its TWR ratio `t` rounded to six
# decimals, and that ratio is a running product of ~350 daily factors: each
# rebuild re-multiplies the chain and the last stored digit moves. Between
# 2026-09-12 and 2026-09-15 it moved on 132 of the rows, every one of them
# noise, and the size of the move grows with the number of rebuilds — 1e-6
# after a day, 2e-6 after three.
#
# So the bound is set at ten units in the last stored place rather than at one
# day's observed drift, which would go amber the first time a refresh was
# skipped. It stays two orders of magnitude under anything meaningful: a day
# whose return is genuinely restated moves `t` by basis points (>=1e-4), and
# against a dollar figure this tolerance is a hundred-thousandth of a cent.
#
# It is deliberately not widened past a cent. Sizing futures legs by rate risk
# (2026-09-11) moved `v` on 59 past days by exactly $0.01 each — a rounding
# boundary, not a repricing, and still worth the one line it costs. A pricing
# change that reaches back through the archive is a thing to be told about on
# the day it lands, and on every other day this stays quiet.
ROW_ATOL = 1e-5


def rows_equal(a: dict, b: dict) -> bool:
    """Row equality that ignores last-digit rounding jitter but nothing else."""
    if a.keys() != b.keys():
        return False
    for k, av in a.items():
        bv = b[k]
        if isinstance(av, (int, float)) and isinstance(bv, (int, float)) \
                and not isinstance(av, bool) and not isinstance(bv, bool):
            if abs(av - bv) > ROW_ATOL:
                return False
        elif av != bv:
            return False
    return True


def check_order(rows: list, key: str) -> list[str]:
    """Dates strictly increasing and unique. Fatal — see the docstring."""
    out = []
    dates = [r.get(key) for r in rows if isinstance(r, dict)]
    if len(set(dates)) != len(dates):
        out.append(f"{len(dates) - len(set(dates))} duplicate date(s)")
    if dates != sorted(dates):
        out.append("dates out of order")
    return out


def check_file(path: Path) -> tuple[str, bool]:
    """Returns (one line for the log, is-fatal)."""
    name = path.name
    try:
        cur = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        return f"continuity {name}: unreadable ({type(e).__name__}) -> FATAL", True

    prev = head_version(path)
    flags: list[str] = []
    fatal: list[str] = []
    loud: list[str] = []

    def flag(text: str, *, quiet: bool = True) -> None:
        """Record one field of the line. `quiet=False` marks it as the reason
        the verdict turns. Whether a flag is loud is decided here, where the
        check is, rather than inferred from how its text happens to end."""
        flags.append(text)
        if not quiet:
            loud.append(text)

    if name in SERIES:
        shape = SERIES[name]
        arr, key, val = shape["rows"], shape["key"], shape["value"]
        rolling = shape.get("rolling", False)
        rows = cur.get(arr)
        if not isinstance(rows, list) or not rows:
            return f"continuity {name}: {arr} empty or missing -> FATAL", True

        fatal += check_order(rows, key)

        if prev is None:
            flag("no HEAD copy")
        else:
            old = {r[key]: r for r in (prev.get(arr) or [])
                   if isinstance(r, dict) and key in r}
            new = {r[key]: r for r in rows if isinstance(r, dict) and key in r}
            flag(f"rows {len(new) - len(old):+d}")

            dropped = [d for d in old if d not in new]
            if dropped and rolling:
                # Expected here — say how many left, and only shout if the
                # window lurched rather than stepped.
                lurch = len(dropped) > ROLLING_DROP_MAX
                flag(f"{len(dropped)} aged out" + (" LURCH" if lurch else ""),
                     quiet=not lurch)
            elif dropped:
                flag(f"{len(dropped)} DROPPED", quiet=False)

            # The newest date in HEAD is excluded: today's row is still open, and
            # a re-scrape restating it is the pipeline working, not drifting.
            newest_old = max(old) if old else ""
            changed = [d for d, r in old.items()
                       if d < newest_old and d in new and not rows_equal(r, new[d])]
            if changed:
                flag(f"past CHANGED ({len(changed)} rows)", quiet=False)
            else:
                flag("past==HEAD")

            if val and new:
                was = dig(old.get(newest_old) or {}, [val])
                now = dig(new[max(new)], [val])
                if isinstance(was, (int, float)) and isinstance(now, (int, float)) and was:
                    pct = (now - was) / abs(was) * 100
                    jump = abs(pct) > JUMP_PCT
                    flag(f"{val}{pct:+.1f}%" + (" JUMP" if jump else ""), quiet=not jump)

    for keys in MODE_FIELDS.get(name, []):
        label, now = keys[-1], dig(cur, keys)
        was = dig(prev, keys) if prev else None
        if was is not None and now != was:
            flag(f"{label} CHANGED ({was} -> {now})", quiet=False)
        else:
            flag(f"{label}={now}")

    if not flags and not fatal:
        flag("nothing configured to check")

    verdict = "; ".join(fatal) if fatal else ("look at it" if loud else "ok")
    return f"continuity {name}: {' '.join(flags)} -> {verdict}", bool(fatal)


def main(argv: list[str]) -> int:
    warn_only = "--warn-only" in argv
    paths = [Path(a) for a in argv if not a.startswith("--")]
    if not paths:
        print("usage: continuity.py [--warn-only] <data file> ...", file=sys.stderr)
        return 2
    bad = False
    for p in paths:
        line, is_fatal = check_file(p)
        print(line, file=sys.stderr)
        bad = bad or is_fatal
    return 1 if bad and not warn_only else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
