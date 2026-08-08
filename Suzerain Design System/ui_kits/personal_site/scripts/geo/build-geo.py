#!/usr/bin/env python3
"""Pre-project TopoJSON into flat SVG path data for the politics view.

The site ships no map library. Projecting at build time means the browser
only ever sees `<path d="...">`, so hover and click are native SVG events
and there's no runtime dependency to pin or hash.

Sources (downloaded, not vendored — re-run with --fetch to refresh):
  world: world-atlas@2.0.2/countries-110m.json   (Natural Earth 110m)
  us:    us-atlas@3.0.1/states-10m.json

Outputs:
  data/geo-world.json  { viewBox, features: [{id, name, d}] }
  data/geo-us.json     same shape, Albers USA composite

  ./build-geo.py --fetch     # download sources into ./cache, then build
  ./build-geo.py             # build from ./cache
"""

import argparse
import json
import math
import pathlib
import re
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
CACHE = HERE / "cache"
DATA = HERE.parent.parent / "data"

SOURCES = {
    "world": "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json",
    "us": "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json",
}

# ---------------------------------------------------------------- topojson --


def decode_arcs(topo):
    """Undo quantization + delta encoding. Returns arcs as [(lon, lat), ...]."""
    tf = topo.get("transform")
    out = []
    for arc in topo["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            if tf:
                x += dx
                y += dy
                points.append(
                    (
                        x * tf["scale"][0] + tf["translate"][0],
                        y * tf["scale"][1] + tf["translate"][1],
                    )
                )
            else:
                points.append((dx, dy))
        out.append(points)
    return out


def arc_points(arcs, index):
    """Resolve one arc reference; negative indices mean traverse backwards."""
    if index < 0:
        return arcs[~index][::-1]
    return arcs[index]


def stitch(arcs, ring_indices):
    """Join a ring's arcs, dropping the duplicated seam point between them."""
    ring = []
    for i in ring_indices:
        pts = arc_points(arcs, i)
        ring.extend(pts[1:] if ring else pts)
    return ring


def geometry_rings(arcs, geom):
    """Flatten Polygon / MultiPolygon into a list of lon/lat rings."""
    t = geom.get("type")
    if t == "Polygon":
        return [stitch(arcs, r) for r in geom["arcs"]]
    if t == "MultiPolygon":
        return [stitch(arcs, r) for poly in geom["arcs"] for r in poly]
    return []


# -------------------------------------------------------------- projections --

# Robinson: tabulated at 5° intervals. X scales the parallel's length,
# Y sets its distance from the equator.
ROBINSON_X = [
    1.0000, 0.9986, 0.9954, 0.9900, 0.9822, 0.9730, 0.9600, 0.9427, 0.9216,
    0.8962, 0.8679, 0.8350, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722,
    0.5322,
]
ROBINSON_Y = [
    0.0000, 0.0620, 0.1240, 0.1860, 0.2480, 0.3100, 0.3720, 0.4340, 0.4958,
    0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761,
    1.0000,
]


def _interp(table, t, i):
    """Catmull-Rom through the 5° table — linear leaves visible facets."""
    p0 = table[max(i - 1, 0)]
    p1 = table[i]
    p2 = table[min(i + 1, len(table) - 1)]
    p3 = table[min(i + 2, len(table) - 1)]
    return 0.5 * (
        2 * p1
        + (p2 - p0) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
    )


def robinson(lon, lat):
    alat = min(abs(lat), 89.999)
    i = min(int(alat / 5.0), 17)
    t = (alat - i * 5.0) / 5.0
    x = 0.8487 * math.radians(lon) * _interp(ROBINSON_X, t, i)
    y = 1.3523 * _interp(ROBINSON_Y, t, i)
    # Negated: the table is math-convention (Y grows north) and SVG's y axis
    # points down, so north has to come back as negative or the map is flipped.
    return (x, y if lat < 0 else -y)


def albers(lon0, phi1, phi2, phi0):
    """Albers conic equal-area, returned as a closure over its parameters."""
    p1, p2, p0 = map(math.radians, (phi1, phi2, phi0))
    n = 0.5 * (math.sin(p1) + math.sin(p2))
    c = math.cos(p1) ** 2 + 2 * n * math.sin(p1)
    rho0 = math.sqrt(c - 2 * n * math.sin(p0)) / n

    def project(lon, lat):
        # Wrap into ±180 of the central meridian, or Alaska's Aleutians (which
        # cross the antimeridian into positive longitude) streak right across.
        lam = math.radians(((lon - lon0 + 180) % 360) - 180)
        phi = math.radians(lat)
        inner = c - 2 * n * math.sin(phi)
        rho = math.sqrt(max(inner, 0.0)) / n
        theta = n * lam
        return (rho * math.sin(theta), -(rho0 - rho * math.cos(theta)))

    return project


# ------------------------------------------------------------------ helpers --


def unwrap_lon(ring):
    """Make longitudes continuous, even where that runs past ±180.

    Natural Earth stores Russia and Fiji crossing the antimeridian. Reading the
    stored values literally, Chukotka jumps from +179 to -179 mid-ring.
    """
    out, prev = [], None
    for lon, lat in ring:
        if prev is not None:
            while lon - prev > 180:
                lon -= 360
            while lon - prev < -180:
                lon += 360
        out.append((lon, lat))
        prev = lon
    return out


def _clip_edge(poly, keep, cross):
    """One Sutherland-Hodgman pass against a vertical line."""
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        a_in, b_in = keep(a), keep(b)
        if a_in:
            out.append(a)
        if a_in != b_in:
            out.append(cross(a, b))
    return out


def clip_to_strip(poly, xmin=-180.0, xmax=180.0):
    """Clip a ring to the ±180 strip, following the edge rather than cutting."""
    def at(a, b, x):
        dx = b[0] - a[0]
        t = 0.0 if dx == 0 else (x - a[0]) / dx
        return (x, a[1] + (b[1] - a[1]) * t)

    poly = _clip_edge(poly, lambda p: p[0] >= xmin, lambda a, b: at(a, b, xmin))
    if len(poly) < 3:
        return []
    poly = _clip_edge(poly, lambda p: p[0] <= xmax, lambda a, b: at(a, b, xmax))
    return poly if len(poly) >= 3 else []


def dateline_parts(ring):
    """Split a ring into the pieces visible on a ±180 map.

    Cutting the ring at the jump (the obvious approach) leaves open fragments,
    and closing those with Z draws a chord straight across the shape — which is
    what mangled Kamchatka. Clipping instead walks the map edge, so each piece
    comes back as a proper closed ring.

    The ring is unwrapped first, then clipped once per 360° window it reaches
    into, which is what puts Chukotka against the left edge while the rest of
    Russia stays on the right.
    """
    r = unwrap_lon(ring)
    lons = [p[0] for p in r]
    kmin = math.floor((-180.0 - max(lons)) / 360.0)
    kmax = math.ceil((180.0 - min(lons)) / 360.0)
    parts = []
    for k in range(int(kmin), int(kmax) + 1):
        piece = clip_to_strip([(lon + k * 360.0, lat) for lon, lat in r])
        if piece:
            parts.append(piece)
    return parts


def bounds(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def simplify(ring, tol):
    """Douglas-Peucker. 10m state outlines are far denser than a 900px map needs."""
    if len(ring) < 3:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        lo, hi = stack.pop()
        ax, ay = ring[lo]
        bx, by = ring[hi]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = ring[i]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, best_i = d, i
        if best > tol and best_i > 0:
            keep[best_i] = True
            stack.append((lo, best_i))
            stack.append((best_i, hi))
    return [p for p, k in zip(ring, keep) if k]


def to_path(rings, tol):
    """Rings -> one SVG path string, rounded to 1dp (sub-pixel at our scale)."""
    parts = []
    for ring in rings:
        ring = simplify(ring, tol)
        if len(ring) < 3:
            continue
        seg = [f"M{ring[0][0]:.1f} {ring[0][1]:.1f}"]
        prev = None
        for x, y in ring[1:]:
            cur = (round(x, 1), round(y, 1))
            if cur == prev:
                continue
            seg.append(f"L{cur[0]} {cur[1]}")
            prev = cur
        seg.append("Z")
        parts.append("".join(seg))
    return "".join(parts)


def fit(features, width, pad=4):
    """Scale/translate projected features into a tidy viewBox."""
    allrings = [r for f in features for r in f["rings"]]
    x0, y0, x1, y1 = bounds(allrings)
    k = (width - 2 * pad) / (x1 - x0)
    height = (y1 - y0) * k + 2 * pad
    for f in features:
        f["rings"] = [
            [((x - x0) * k + pad, (y - y0) * k + pad) for x, y in r]
            for r in f["rings"]
        ]
    return height


# -------------------------------------------------------------------- builds --


def load(name):
    path = CACHE / f"{name}.json"
    if not path.exists():
        sys.exit(f"missing {path} — run with --fetch first")
    return json.loads(path.read_text(encoding="utf-8"))


def build_world(width=980):
    topo = load("world")
    arcs = decode_arcs(topo)
    layer = topo["objects"]["countries"]
    features = []
    for geom in layer["geometries"]:
        name = (geom.get("properties") or {}).get("name")
        if not name:
            continue
        rings = geometry_rings(arcs, geom)
        if not rings:
            continue
        projected = [
            [robinson(lon, lat) for lon, lat in part]
            for ring in rings
            for part in dateline_parts(ring)
        ]
        if not projected:
            continue
        features.append(
            {"id": str(geom.get("id") or name), "name": name, "rings": projected}
        )
    height = fit(features, width)
    return emit(features, width, height, tol=0.35)


# Non-contiguous states get their own conic and are placed as insets, the way
# d3's albersUsa composite does it.
AK, HI = "02", "15"

# us-atlas ships the territories (PR 72, VI 78, AS 60, GU 66, MP 69) in the
# same layer as the states. Run through the lower-48 conic they land thousands
# of units off and wreck the fitted bounds, so keep FIPS <= 56 — the 50 states
# plus DC.
MAX_STATE_FIPS = 56


def build_us(width=980):
    topo = load("us")
    arcs = decode_arcs(topo)
    layer = topo["objects"]["states"]

    lower48 = albers(-96, 29.5, 45.5, 37.5)
    alaska = albers(-152, 55, 65, 50)
    hawaii = albers(-157, 8, 18, 13)

    groups = {"main": [], "ak": [], "hi": []}
    for geom in layer["geometries"]:
        props = geom.get("properties") or {}
        name = props.get("name")
        fips = str(geom.get("id") or "").zfill(2)
        if not name or not fips.isdigit() or int(fips) > MAX_STATE_FIPS:
            continue
        rings = geometry_rings(arcs, geom)
        if not rings:
            continue
        bucket = "ak" if fips == AK else "hi" if fips == HI else "main"
        proj = alaska if bucket == "ak" else hawaii if bucket == "hi" else lower48
        groups[bucket].append(
            {
                "id": fips,
                "name": name,
                "rings": [[proj(lon, lat) for lon, lat in r] for r in rings],
            }
        )

    height = place_us(groups, width)
    features = groups["main"] + groups["ak"] + groups["hi"]
    return emit(features, width, height, tol=0.4)


def normalize(features, target_w, ox, oy):
    """Scale a group to target width and drop it at (ox, oy)."""
    allrings = [r for f in features for r in f["rings"]]
    x0, y0, x1, y1 = bounds(allrings)
    k = target_w / (x1 - x0)
    for f in features:
        f["rings"] = [
            [((x - x0) * k + ox, (y - y0) * k + oy) for x, y in r] for r in f["rings"]
        ]
    return (y1 - y0) * k


def place_us(groups, width):
    """Lower 48 fills the frame; AK and HI sit in the empty ocean at lower-left.

    That corner is free because California's coast stops well above the bottom
    edge and Texas doesn't reach left of ~30% width. Both insets are sized to
    stay inside it — verified vertex-by-vertex, not by bounding box, since a
    shape like Texas has a box far wider than its southern tip.
    """
    pad = 4
    main_w = width - 2 * pad
    main_h = normalize(groups["main"], main_w, pad, pad)
    height = main_h + 2 * pad

    ak_w = main_w * 0.27
    ak_h = normalize(groups["ak"], ak_w, pad, height - pad - _aspect(groups["ak"], ak_w))
    hi_w = main_w * 0.085
    hi_h = _aspect(groups["hi"], hi_w)
    normalize(groups["hi"], hi_w, pad + ak_w + main_w * 0.02, height - pad - hi_h)
    return height


def _aspect(features, target_w):
    """Height the group will occupy once scaled to target_w."""
    x0, y0, x1, y1 = bounds([r for f in features for r in f["rings"]])
    return (y1 - y0) * (target_w / (x1 - x0))


def stroke_width(d):
    """How heavy an outline this shape can carry, in viewBox units.

    2·area/perimeter is an inradius-like measure of how *fat* a shape is. Big
    landmasses score 15–50; Japan scores 3.5 and the UK 3.9, because an
    archipelago is nearly all edge. A stroke centred on a path spills half its
    width to each side, so a fixed heavy border swallows the small ones whole
    while looking right on Texas. Scaling the width to this keeps the weight
    proportional to the thing it outlines.
    """
    area = perim = 0.0
    for sub in d.split("M")[1:]:
        ring = [
            (float(a), float(b))
            for a, b in re.findall(r"([-\d.]+) ([-\d.]+)", sub)
        ]
        if len(ring) < 3:
            continue
        for i, (x0, y0) in enumerate(ring):
            x1, y1 = ring[(i + 1) % len(ring)]
            area += x0 * y1 - x1 * y0
            perim += math.hypot(x1 - x0, y1 - y0)
    if perim <= 0:
        return 1.6
    return round(min(max(abs(area) / perim * 0.20, 1.6), 4.0), 1)


def emit(features, width, height, tol):
    out = []
    for f in features:
        d = to_path(f["rings"], tol)
        if not d:
            continue
        x0, y0, x1, y1 = bounds(f["rings"])
        out.append(
            {
                "id": f["id"],
                "name": f["name"],
                "d": d,
                # Outline weight this shape can carry — see stroke_width().
                "w": stroke_width(d),
                # Bounding-box centre — good enough to anchor a marker or label.
                "c": [round((x0 + x1) / 2, 1), round((y0 + y1) / 2, 1)],
            }
        )
    out.sort(key=lambda f: f["name"])
    return {"viewBox": f"0 0 {width} {round(height)}", "features": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="download sources first")
    args = ap.parse_args()

    if args.fetch:
        CACHE.mkdir(parents=True, exist_ok=True)
        for name, url in SOURCES.items():
            print(f"fetching {name} <- {url}")
            with urllib.request.urlopen(url) as r:
                (CACHE / f"{name}.json").write_bytes(r.read())

    DATA.mkdir(parents=True, exist_ok=True)
    for name, build in (("world", build_world), ("us", build_us)):
        result = build()
        path = DATA / f"geo-{name}.json"
        path.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        kb = path.stat().st_size / 1024
        print(f"{path.name}: {len(result['features'])} features, {kb:.0f}KB")


if __name__ == "__main__":
    main()
