#!/usr/bin/env python3
"""Build the embedded dataset for the East Midlands property visualiser.

Reads the Land Registry extract plus the postcode-district polygons and writes a
single classic <script> file (data.js) that index.html can load over file://.

    python3 build_data.py

Outputs: data.js
"""

import csv
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict  # noqa: F401

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "EastMidlands_LandRegistry_550k_2010on.csv")
GEO_DIR = os.path.join(HERE, "geo")
OUT_PATH = os.path.join(HERE, "data.js")
# A portable copy of the classification, for use in Excel, Sheets, R, or anything
# else. Every original row and column is preserved; two columns are appended.
CSV_OUT_PATH = os.path.join(HERE, "EastMidlands_550k_classified.csv")

# Polygon coordinates are rounded to this many decimals (~11m at UK latitudes).
COORD_DP = 4
# Rings with fewer points than this after simplification are dropped as specks.
MIN_RING_POINTS = 4
# Douglas-Peucker tolerance in degrees (~55m).
SIMPLIFY_TOL = 0.0005


# Which county each local authority district belongs to. Rutland is a unitary
# authority and a ceremonial county in its own right; Melton is the only
# Leicestershire district in this extract. Checked against the data at build
# time, so a district appearing in a future extract can't slip through unmapped.
DISTRICT_COUNTY = {
    "EAST LINDSEY":        "Lincolnshire",
    "WEST LINDSEY":        "Lincolnshire",
    "NORTH KESTEVEN":      "Lincolnshire",
    "SOUTH KESTEVEN":      "Lincolnshire",
    "RUSHCLIFFE":          "Nottinghamshire",
    "NEWARK AND SHERWOOD": "Nottinghamshire",
    "MELTON":              "Leicestershire",
    "RUTLAND":             "Rutland",
}

# Orientation markers for the map. The sales extract carries no coordinates, so
# these are reference points, not data. Each one is checked at build time to be
# inside the postcode district it claims (see verify_places), which catches a
# transposed or mistyped coordinate. "rank" drives label priority when two
# labels would collide — lower wins.
PLACES = [
    # name,                lat,      lon,     district, tier,   rank
    ("Nottingham",         52.9536, -1.1505, "NG1",  "city", 1),
    ("Lincoln",            53.2307, -0.5406, "LN2",  "city", 1),
    ("Leicester",          52.6369, -1.1398, "LE1",  "city", 1),
    ("Newark-on-Trent",    53.0766, -0.8110, "NG24", "town", 2),
    ("Grantham",           52.9120, -0.6403, "NG31", "town", 2),
    ("Melton Mowbray",     52.7661, -0.8860, "LE13", "town", 2),
    ("Stamford",           52.6510, -0.4830, "PE9",  "town", 2),
    ("Oakham",             52.6706, -0.7300, "LE15", "town", 2),
    ("Sleaford",           52.9970, -0.4090, "NG34", "town", 2),
    ("Louth",              53.3663, -0.0050, "LN11", "town", 2),
    ("Skegness",           53.1436,  0.3390, "PE25", "town", 2),
    ("Loughborough",       52.7721, -1.2062, "LE11", "town", 3),
    ("Boston",             52.9788, -0.0265, "PE21", "town", 3),
    ("Spalding",           52.7870, -0.1530, "PE11", "town", 3),
    ("Bourne",             52.7680, -0.3780, "PE10", "town", 3),
    ("Gainsborough",       53.3995, -0.7750, "DN21", "town", 3),
    ("Mansfield",          53.1440, -1.1980, "NG18", "town", 3),
    ("Market Harborough",  52.4780, -0.9210, "LE16", "town", 4),
    ("Peterborough",       52.5709, -0.2405, "PE1",  "city", 4),
    ("Scunthorpe",         53.5900, -0.6540, "DN15", "town", 4),
    ("Grimsby",            53.5675, -0.0800, "DN31", "town", 4),
    ("Derby",              52.9228, -1.4787, "DE1",  "city", 4),
]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def title_case(s):
    """AND SHERWOOD -> and Sherwood, keeping small words lowercase."""
    small = {"and", "of", "the", "on", "upon", "in"}
    out = []
    for i, w in enumerate(s.lower().split()):
        out.append(w if (w in small and i > 0) else w.capitalize())
    return " ".join(out)


def address_case(addr, postcode):
    """Title-case an address without mangling the postcode or house letters.

    "3A, THE POPLARS, ... , NG12 5RH" would otherwise come back as
    "3a, The Poplars, ... , Ng12 5rh".
    """
    out = title_case(addr)
    # 12a -> 12A, 3b -> 3B
    out = re.sub(r"\b(\d+)([a-z])\b", lambda m: m.group(1) + m.group(2).upper(), out)
    if postcode:
        out = re.sub(re.escape(postcode), postcode, out, flags=re.IGNORECASE)
    return out


def zone_label(s):
    """south_notts_wolds -> South Notts Wolds"""
    fixes = {
        "nw": "NW", "ne": "NE", "sw": "SW", "se": "SE",
        "notts": "Notts", "lincoln": "Lincoln", "nottingham": "Nottingham",
    }
    words = []
    for w in s.split("_"):
        words.append(fixes.get(w, w.capitalize()))
    return " ".join(words)


def perpendicular_distance(pt, a, b):
    (x, y), (x1, y1), (x2, y2) = pt, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points, tol):
    """Iterative Douglas-Peucker (recursion blows the stack on long rings)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        worst_d, worst_i = 0.0, first
        for i in range(first + 1, last):
            d = perpendicular_distance(points[i], points[first], points[last])
            if d > worst_d:
                worst_d, worst_i = d, i
        if worst_d > tol:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    return [p for p, k in zip(points, keep) if k]


def ring_area(ring):
    """Shoelace area, used only to rank rings by size."""
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


# --------------------------------------------------------------------------
# sales
# --------------------------------------------------------------------------

# Human-readable names for the exclusion_reason tokens, so the page can say what
# was set aside rather than just how much.
RESIDENTIAL_TYPES = {"Detached", "Semi-detached", "Terraced", "Flat"}

# Reasons a record is not a comparable sale of a single dwelling, in the order
# they are tested. They are mutually exclusive, so the counts sum to the total.
R_NOT_HOME = "not a home — commercial, agricultural or mixed use"
R_DUPLICATE = "a duplicate of another record in the extract"
R_SPLIT = "one property split across titles, sold at a single price"
R_NOT_DWELLING = "priced beyond any verified sale of its type — land or a portfolio, not a dwelling"


def classify(all_rows):
    """Decide which records are comparable sales of a single dwelling.

    We do NOT use the extract's own `residential_comparable` column, because it
    also drops every Land Registry category B record as "not full market value".
    That is not what category B means: it is an *additional price paid entry*,
    covering repossessions but also buy-to-lets and purchases by companies, and
    those transact at market price. Excluding them withheld ~300 ordinary house
    sales whose price distribution is indistinguishable from the kept ones.

    Returns (keep_flags, reason_counts).
    """
    # Same price on the same day flags a portfolio, but only when the titles are
    # the same property — a farmhouse and its cottage. Two unrelated houses that
    # happened to fetch the same price on the same day are a coincidence, and
    # the upstream rule dropped those too (14 and 16 Wellingtonia Crescent, two
    # new builds at one developer price, among them).
    groups = defaultdict(list)
    for i, r in enumerate(all_rows):
        if "portfolio_same_price_same_date" in r["exclusion_reason"]:
            groups[(r["date"], r["price"])].append(i)
    split = set()
    for members in groups.values():
        roots = {(all_rows[i]["settlement"], all_rows[i]["street"]) for i in members}
        if len(roots) == 1:
            split.update(members)

    # Category A is Land Registry's verified full-market-value standard entry, so
    # the dearest category A sale of each type is the highest price a single
    # dwelling of that type is known to reach in this region. An unverified
    # category B record above that line is land or an apportioned portfolio
    # price, not a house — an £8.5m "terraced house" in Melton Mowbray.
    cap = {}
    for t in RESIDENTIAL_TYPES:
        prices = [int(r["price"]) for r in all_rows
                  if r["property_type"] == t and r["category"] == "A"]
        cap[t] = max(prices) if prices else float("inf")

    keep, reasons, counts = [], [], Counter()
    for i, r in enumerate(all_rows):
        if r["property_type"] not in RESIDENTIAL_TYPES:
            reason = R_NOT_HOME
        elif "duplicate_record" in r["exclusion_reason"]:
            reason = R_DUPLICATE
        elif i in split:
            reason = R_SPLIT
        elif r["category"] == "B" and int(r["price"]) > cap[r["property_type"]]:
            reason = R_NOT_DWELLING
        else:
            reason = None
        keep.append(reason is None)
        reasons.append(reason)
        if reason:
            counts[reason] += 1
    return keep, reasons, counts, cap


def write_classified_csv(all_rows, keep, reasons, fieldnames):
    """Write every original row and column, plus our verdict on each.

    The source CSV is never modified — this is a separate, additive file, so the
    classification can be checked, argued with, or used in another tool.
    """
    out_fields = list(fieldnames) + ["is_home_sale", "set_aside_reason"]
    with open(CSV_OUT_PATH, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=out_fields)
        w.writeheader()
        for r, k, reason in zip(all_rows, keep, reasons):
            row = dict(r)
            row["is_home_sale"] = "yes" if k else "no"
            row["set_aside_reason"] = reason or ""
            w.writerow(row)


def build_sales():
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        all_rows = list(reader)
        fieldnames = reader.fieldnames

    keep, reasons, counts, cap = classify(all_rows)
    write_classified_csv(all_rows, keep, reasons, fieldnames)

    # Filtered here rather than in the browser: a record that is not an
    # arm's-length sale of a home has no honest use anywhere in the app, so it
    # should not be shipped to it at all.
    rows = [r for r, k in zip(all_rows, keep) if k]
    excluded = {
        "total": len(all_rows) - len(rows),
        "kept": len(rows),
        "ofFile": len(all_rows),
        "reasons": [[label, n] for label, n in counts.most_common()],
        "caps": {t: cap[t] for t in sorted(cap)},
    }

    rows.sort(key=lambda r: (r["date"], r["price"]))

    districts, zones, ptypes, pcds, settlements = [], [], [], [], []
    streets, sectors = [], []
    idx = {"d": {}, "z": {}, "t": {}, "p": {}, "s": {}, "r": {}, "c": {}}

    def intern(bucket, store, value):
        if value not in idx[bucket]:
            idx[bucket][value] = len(store)
            store.append(value)
        return idx[bucket][value]

    out = {k: [] for k in (
        "date", "day", "price", "district", "zone", "ptype", "pcd", "sector",
        "street", "settlement", "flags", "address", "txn",
    )}

    for r in rows:
        y, m, d = (int(x) for x in r["date"].split("-"))
        # months since 2010-01, so a month index is a single small integer;
        # the day rides alongside so an export can rebuild the exact date
        out["date"].append((y - 2010) * 12 + (m - 1))
        out["day"].append(d)
        out["price"].append(int(r["price"]))
        out["district"].append(intern("d", districts, title_case(r["district"])))
        out["zone"].append(intern("z", zones, zone_label(r["settlement_zone"])))
        out["ptype"].append(intern("t", ptypes, r["property_type"]))
        out["pcd"].append(intern("p", pcds, r["postcode_district"] or "—"))
        out["settlement"].append(intern("s", settlements, title_case(r["settlement"])))
        out["street"].append(intern("r", streets, title_case(r["street"]) if r["street"] else "—"))
        # postcode sector: the outward code plus the first digit of the inward,
        # e.g. NG2 6. It splits a big town that is one row at every other grain.
        pc = (r["postcode"] or "").strip()
        sector = "—"
        if " " in pc:
            out_code, in_code = pc.rsplit(" ", 1)
            if in_code:
                sector = out_code + " " + in_code[0]
        out["sector"].append(intern("c", sectors, sector))

        flags = 0
        if r["residential_comparable"] == "yes":
            flags |= 1
        if r["in_search_geography"] == "yes":
            flags |= 2
        if r["new_build"] == "yes":
            flags |= 4
        if r["tenure"] == "leasehold":
            flags |= 8
        if r["category"] == "B":
            flags |= 16
        out["flags"].append(flags)

        out["address"].append(address_case(r["address"], r["postcode"]))
        out["txn"].append(r["txn_id"])

    return {
        "n": len(rows),
        "excluded": excluded,
        "cols": out,
        "dict": {
            "district": districts,
            "zone": zones,
            "ptype": ptypes,
            "pcd": pcds,
            "sector": sectors,
            "street": streets,
            "settlement": settlements,
        },
    }


# --------------------------------------------------------------------------
# geography
# --------------------------------------------------------------------------

def build_geo(needed):
    """Return simplified polygons for the postcode districts we actually have
    sales in, keyed by district code."""
    areas = sorted({re.match(r"[A-Z]+", code).group() for code in needed if code != "—"})
    shapes = {}
    missing = set(needed) - {"—"}

    for area in areas:
        path = os.path.join(GEO_DIR, f"{area}.geojson")
        if not os.path.exists(path):
            print(f"  ! missing polygon file {path}", file=sys.stderr)
            continue
        with open(path, encoding="utf-8") as fh:
            fc = json.load(fh)
        for feat in fc["features"]:
            name = feat["properties"].get("name")
            if name not in missing:
                continue
            geom = feat["geometry"]
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]

            rings = []
            for poly in polys:
                outer = [(round(x, COORD_DP + 2), round(y, COORD_DP + 2)) for x, y in poly[0]]
                outer = simplify(outer, SIMPLIFY_TOL)
                if len(outer) < MIN_RING_POINTS:
                    continue
                rings.append(outer)
            if not rings:
                continue
            # keep the largest few rings; the rest are offshore specks
            rings.sort(key=ring_area, reverse=True)
            rings = rings[:6]
            biggest = rings[0]
            area_big = ring_area(biggest)
            rings = [r for r in rings if ring_area(r) > area_big * 0.02]

            shapes[name] = [
                [[round(x, COORD_DP), round(y, COORD_DP)] for x, y in ring]
                for ring in rings
            ]
            missing.discard(name)

    if missing:
        print(f"  ! no polygon for: {', '.join(sorted(missing))}", file=sys.stderr)
    return shapes


# --------------------------------------------------------------------------
# orientation markers
# --------------------------------------------------------------------------

def point_in_ring(lon, lat, ring):
    """Ray casting, on the raw (unsimplified) ring."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            if lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
                inside = not inside
        j = i
    return inside


def verify_places():
    """Check every marker really sits inside the postcode district it names.

    Returns the verified list; any marker that fails is dropped rather than
    silently drawn in the wrong field.
    """
    wanted = {}
    for _, _, _, code, _, _ in PLACES:
        wanted.setdefault(re.match(r"[A-Z]+", code).group(), set()).add(code)

    polys = {}
    for area, codes in wanted.items():
        path = os.path.join(GEO_DIR, f"{area}.geojson")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for feat in json.load(fh)["features"]:
                name = feat["properties"].get("name")
                if name not in codes:
                    continue
                geom = feat["geometry"]
                parts = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
                polys[name] = [p[0] for p in parts]

    out = []
    for name, lat, lon, code, tier, rank in PLACES:
        rings = polys.get(code)
        if rings is None:
            print(f"  ? {name}: no polygon for {code}, cannot verify — dropped", file=sys.stderr)
            continue
        if not any(point_in_ring(lon, lat, r) for r in rings):
            print(f"  ! {name} ({lat}, {lon}) is not inside {code} — dropped", file=sys.stderr)
            continue
        out.append({"n": name, "lat": lat, "lon": lon, "t": tier, "r": rank})
    return out


# --------------------------------------------------------------------------

def main():
    print("reading sales…")
    sales = build_sales()
    ex = sales["excluded"]
    print(f"  {sales['n']:,} comparable sales kept, {ex['total']:,} of {ex['ofFile']:,} set aside")
    for label, n in ex["reasons"]:
        print(f"    {n:>5,}  {label}")
    print(f"  {len(sales['dict']['district'])} districts, "
          f"{len(sales['dict']['pcd'])} postcode districts")

    print("building geography…")
    shapes = build_geo(set(sales["dict"]["pcd"]))
    pts = sum(len(r) for s in shapes.values() for r in s)
    print(f"  {len(shapes)} shapes, {pts:,} points")

    # which local-authority district does each postcode district mostly sit in?
    # used to tint the map outline by district and to cross-link map <-> lists
    owner = defaultdict(Counter)
    for pcd_i, dist_i in zip(sales["cols"]["pcd"], sales["cols"]["district"]):
        owner[sales["dict"]["pcd"][pcd_i]][sales["dict"]["district"][dist_i]] += 1
    pcd_owner = {k: v.most_common(1)[0][0] for k, v in owner.items()}

    # county lookup, keyed the same way the districts are stored
    counties = {}
    unmapped = []
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as fh:
        raw_districts = {r["district"] for r in csv.DictReader(fh)}
    for raw in sorted(raw_districts):
        county = DISTRICT_COUNTY.get(raw)
        if county is None:
            unmapped.append(raw)
            continue
        counties[title_case(raw)] = county
    if unmapped:
        raise SystemExit(
            "district(s) with no county in DISTRICT_COUNTY: " + ", ".join(unmapped)
        )
    by_county = Counter(counties.values())
    print(f"  {len(by_county)} counties: " +
          ", ".join(f"{c} ({n})" for c, n in sorted(by_county.items())))

    print("verifying orientation markers…")
    places = verify_places()
    print(f"  {len(places)} of {len(PLACES)} markers verified inside their postcode district")

    payload = {
        "generated": "static",
        "sales": sales,
        "shapes": shapes,
        "pcdOwner": pcd_owner,
        "places": places,
        "counties": counties,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write("/* generated by build_data.py — do not edit by hand */\n")
        fh.write("window.EM_DATA = ")
        json.dump(payload, fh, separators=(",", ":"))
        fh.write(";\n")

    size = os.path.getsize(OUT_PATH) / 1024 / 1024
    print(f"wrote {OUT_PATH} ({size:.2f} MB)")
    print(f"wrote {CSV_OUT_PATH} "
          f"({os.path.getsize(CSV_OUT_PATH) / 1024 / 1024:.2f} MB, all {ex['ofFile']:,} rows classified)")
    print(f"source CSV untouched: {CSV_PATH}")


if __name__ == "__main__":
    main()
