#!/usr/bin/env python3
"""Stamp `logged` on any endorsement that changed since the last commit.

The date in the blurb is meant to say when a position was *taken*, which is
not something worth hand-maintaining — it is exactly the kind of field that
goes stale silently. This compares the working copy of politics.json against
the committed one and stamps today's date on any race whose pick moved,
leaving everything else alone.

Run it before committing a change to the log:

    ./scripts/politics/stamp-logged.py           # stamp changed races
    ./scripts/politics/stamp-logged.py --check   # report, change nothing

Deliberately not wired into build.sh: a build should not rewrite its own
sources, and stamping during deploy would date every endorsement to whenever
CI last ran.
"""

import argparse
import collections
import datetime
import io
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parent.parent / "data" / "politics.json"

# What counts as "the endorsement changed": only who you'd back. Warming or
# cooling on the same candidate is a revised feeling about a standing
# endorsement, not a new one, so it leaves the date alone — as does rewording
# the note, which is prose about a position rather than the position itself.
TRACKED = ("pick",)


def committed_copy(path):
    """The version of politics.json in HEAD, or None if it isn't committed."""
    repo = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, cwd=str(path.parent),
    )
    if repo.returncode != 0:
        return None
    root = pathlib.Path(repo.stdout.strip())
    rel = path.resolve().relative_to(root).as_posix()
    show = subprocess.run(
        ["git", "show", f"HEAD:{rel}"],
        capture_output=True, text=True, cwd=str(root),
    )
    if show.returncode != 0 or not show.stdout.strip():
        return None
    try:
        return json.loads(show.stdout)
    except json.JSONDecodeError:
        return None


def race_key(race):
    """Races are identified by office within a place; a renamed office is new."""
    return str(race.get("office", "")).strip().lower()


def old_races(old, scope, place):
    if not old:
        return {}
    entry = (old.get(scope) or {}).get(place) or {}
    races = entry.get("races")
    if not isinstance(races, list):
        races = [entry] if entry.get("office") else []
    return {race_key(r): r for r in races}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report without writing")
    ap.add_argument("--date", help="stamp this ISO date instead of today")
    ap.add_argument("--baseline", help="compare against this file instead of HEAD")
    args = ap.parse_args()

    today = args.date or datetime.date.today().isoformat()
    doc = json.load(io.open(DATA, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    if args.baseline:
        old = json.load(io.open(args.baseline, encoding="utf-8"))
    else:
        old = committed_copy(DATA)
    if old is None:
        print("no committed politics.json to compare against — "
              "stamping only races that have no date yet")

    changed = []
    for scope in ("world", "us"):
        for place, entry in (doc.get(scope) or {}).items():
            previous = old_races(old, scope, place)
            for race in entry.get("races", []):
                before = previous.get(race_key(race))
                if old is None:
                    # No baseline to diff against, so nothing can be shown to
                    # have moved. Only fill in blanks — never overwrite a date
                    # that is already there, or a first run would re-date every
                    # standing position to today.
                    moved = False
                else:
                    moved = before is None or any(
                        race.get(f) != before.get(f) for f in TRACKED
                    )
                # A race with no date yet always gets one, even unchanged —
                # otherwise entries written before this script stay blank.
                if moved or not race.get("logged"):
                    if race.get("logged") == today:
                        continue
                    changed.append(f"{scope}/{place}/{race.get('office')}")
                    if not args.check:
                        race["logged"] = today

    if not changed:
        print("no endorsements changed — nothing to stamp")
        return 0

    verb = "would stamp" if args.check else "stamped"
    print(f"{verb} {today} on {len(changed)}:")
    for c in changed:
        print(f"  {c}")

    if args.check:
        return 1
    io.open(DATA, "w", encoding="utf-8", newline="\n").write(
        json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
