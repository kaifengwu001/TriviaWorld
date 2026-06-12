#!/usr/bin/env python3
"""
Specs Inc. 2026
generate_water_mask.py — bake a per-city LAND/WATER mask from the ALREADY-BAKED
map textures, with NO network access.

Why this exists
---------------
CardStore only knows a card's CITY, so CardGeo scatters each card to a stable
pseudo-location inside a mile disk around that city's center. Some of those spots
land in the ocean (Puget Sound, Tokyo Bay, the LA coastline). This tool produces a
coarse land/water grid per city so the in-lens scatter can REJECT water spots and
re-draw on land — keeping every marker on land while staying deterministic.

No re-download
--------------
This reads the existing `Assets/Textures/Globe/<City>_L-1.png` files (the wide
"transition" captures, 3072px, centered on each city) that generate_map_textures.py
already wrote. It never touches the network and never depends on the tile cache. It
only borrows generate_map_textures.py's PURE Web-Mercator helpers (imported, so the
pixel<->latLng mapping is guaranteed identical to how the PNGs were cropped).

Output
------
Writes `Assets/Scripts/Globe/waterMask.ts`: one mask per city as a square grid of
'0' (water) / '1' (land) row strings, over a square-DEGREES window centered on the
city. The runtime (waterMask.ts's own isLandAt) maps a latLng to a cell with plain
linear math; the bake side does the exact Mercator inverse so the two agree.

Usage
-----
  python3 tools/generate_water_mask.py                 # all cities, default grid
  python3 tools/generate_water_mask.py --only Seattle  # one city
  python3 tools/generate_water_mask.py --span-deg 1.5 --res 96
"""

import argparse
import json
import os
import sys

# Borrow the EXACT pure mercator/tile helpers the capture used, so our
# latLng->pixel inverse matches the PNG crop bit-for-bit. The module has a clean
# `if __name__ == "__main__"` guard, so importing it runs no side effects.
import generate_map_textures as gmt

REPO_ROOT = gmt.REPO_ROOT
BOUNDS_JSON = gmt.BOUNDS_JSON
OUT_DIR = gmt.OUT_DIR
TILE_SIZE = gmt.TILE_SIZE
MASK_TS = os.path.join(REPO_ROOT, "Assets", "Scripts", "Globe", "waterMask.ts")

# --- water classification (OSM "standard" raster style) ----------------------
# OSM standard renders water as a flat pale blue ~#AAD3DF. We accept a generous
# ball around it AND a looser "pale blue" rule so anti-aliased shorelines and
# faint labels over water still count as water. Tune here if the style changes.
WATER_TARGET = (170, 211, 223)
WATER_DIST = 30          # max Euclidean RGB distance to WATER_TARGET
# A cell is water if >= this fraction of its sampled px are water. Kept LOW so a
# coastal cell that is partly sea is treated as water — markers then stay clearly
# inland rather than creeping onto the shoreline (the symptom of a coarse mask).
WATER_CELL_FRACTION = 0.35


def _is_water_px(r, g, b):
    dr = r - WATER_TARGET[0]
    dg = g - WATER_TARGET[1]
    db = b - WATER_TARGET[2]
    if dr * dr + dg * dg + db * db <= WATER_DIST * WATER_DIST:
        return True
    # Looser pale-blue catch-all for shoreline anti-aliasing.
    return b > r + 12 and b >= 205 and g >= 195 and g >= r and r >= 140


def _png_to_pixel_mapper(entry, png_w):
    """
    Returns f(lat, lng) -> (px, py) in the SAVED PNG (png_w x png_w), reproducing
    generate_map_textures.build_entry_texture's square-in-Mercator-pixels crop.
    Using the PNG's actual width as the out_size makes this robust to whatever
    --res-scale produced the file (the crop was resized to exactly that width).
    """
    c = entry["centerLatLng"]
    span = entry["spanDeg"]
    half_deg = span / 2.0
    bbox = gmt.bbox_from_entry(entry)
    z = gmt.choose_zoom(bbox, png_w)
    x0, y0, _x1, _y1 = gmt.tile_range(bbox, z)
    cx = (gmt.lng_to_tile_x(c["lng"], z) - x0) * TILE_SIZE
    cy = (gmt.lat_to_tile_y(c["lat"], z) - y0) * TILE_SIZE
    half_px = (gmt.lng_to_tile_x(c["lng"] + half_deg, z) - gmt.lng_to_tile_x(c["lng"], z)) * TILE_SIZE
    left = cx - half_px
    top = cy - half_px
    extent = 2.0 * half_px

    def to_px(lat, lng):
        sx = (gmt.lng_to_tile_x(lng, z) - x0) * TILE_SIZE
        sy = (gmt.lat_to_tile_y(lat, z) - y0) * TILE_SIZE
        return ((sx - left) / extent * png_w, (sy - top) / extent * png_w)

    return to_px


def _erode_land(grid, res, rounds):
    """
    Shrinks LAND by `rounds` cells: any land cell touching water (8-neighbour)
    becomes water. This carves a small inland safety buffer along coastlines so a
    marker placed in a land cell can't sit in the water just past the cell edge.
    `grid` is a list of bytearrays (1 = land, 0 = water); returns a new grid.
    """
    g = grid
    for _ in range(max(0, rounds)):
        nxt = [bytearray(row) for row in g]
        for i in range(res):
            for j in range(res):
                if g[i][j] == 0:
                    continue
                touches_water = False
                for di in (-1, 0, 1):
                    for dj in (-1, 0, 1):
                        ni, nj = i + di, j + dj
                        if 0 <= ni < res and 0 <= nj < res and g[ni][nj] == 0:
                            touches_water = True
                            break
                    if touches_water:
                        break
                if touches_water:
                    nxt[i][j] = 0
        g = nxt
    return g


def _source_entry_for(city, tcfg, level):
    """
    The LOD entry to SAMPLE the mask from. level == -1 is the wide L-1 handoff
    capture (coarse); level >= 0 is a navigable level (L0 is the default, ~5x finer
    than L-1 and exactly what the table shows when docked, so the mask matches the
    map the player actually sees). Returns a level-shaped dict, or None.
    """
    if level == -1:
        return gmt.transition_entry(city, tcfg)
    for lv in city.get("levels", []):
        if lv["level"] == level:
            return lv
    return None


def _bake_city_mask(city, source, span_deg, res, pad_px, erode):
    """
    Builds a res x res land/water grid (row 0 = NORTH, col 0 = WEST) over a
    square `span_deg` window centered on the city, by sampling the `source` LOD
    PNG, then erodes land by `erode` cells to keep markers off the shoreline.
    Returns (rows, water_fraction) or None when the PNG is missing.
    """
    from PIL import Image

    if not source:
        print(f"  {city['name']}: no source level config; skipped.")
        return None
    png_path = os.path.join(OUT_DIR, f"{city['name']}_L{source['level']}.png")
    if not os.path.exists(png_path):
        print(f"  {city['name']}: missing {os.path.basename(png_path)} — run generate_map_textures.py first; skipped.")
        return None

    img = Image.open(png_path).convert("RGB")
    png_w = img.size[0]
    px = img.load()
    to_px = _png_to_pixel_mapper(source, png_w)

    center = city["centerLatLng"]
    grid = [bytearray(res) for _ in range(res)]  # 1 = land, 0 = water
    for i in range(res):
        # Row 0 = north (top); i increases southward.
        lat = center["lat"] + (0.5 - (i + 0.5) / res) * span_deg
        for j in range(res):
            lng = center["lng"] + ((j + 0.5) / res - 0.5) * span_deg
            cxp, cyp = to_px(lat, lng)
            wat = 0
            tot = 0
            # Sample a small box around the cell center for robustness to lines.
            for dy in range(-pad_px, pad_px + 1):
                sy = int(round(cyp)) + dy
                if sy < 0 or sy >= png_w:
                    continue
                for dx in range(-pad_px, pad_px + 1):
                    sx = int(round(cxp)) + dx
                    if sx < 0 or sx >= png_w:
                        continue
                    r, g, b = px[sx, sy]
                    tot += 1
                    if _is_water_px(r, g, b):
                        wat += 1
            is_water = tot > 0 and (wat / tot) >= WATER_CELL_FRACTION
            grid[i][j] = 0 if is_water else 1

    grid = _erode_land(grid, res, erode)
    rows = ["".join("1" if v else "0" for v in row) for row in grid]
    water_cells = sum(res - sum(row) for row in grid)
    return rows, water_cells / float(res * res)


def _emit_ts(masks, span_deg, res):
    L = []
    L.append("/**")
    L.append(" * Specs Inc. 2026")
    L.append(" * waterMask.ts \u2013 per-city LAND/WATER grids for keeping card markers off the ocean.")
    L.append(" *")
    L.append(" * !!! GENERATED BY tools/generate_water_mask.py FROM THE BAKED <City>_L-1.png !!!")
    L.append(" * Do not hand-edit. Re-run the tool (no network) to refresh. Each mask is a square")
    L.append(" * `spanDeg`-wide window centered on the city: `rows[i]` runs NORTH(0)->SOUTH, each")
    L.append(" * char WEST(0)->EAST, '1' = land, '0' = water. isLandAt() maps a latLng to a cell")
    L.append(" * and FAILS OPEN (returns land) for unknown cities or out-of-window points, so a")
    L.append(" * marker is never lost to a missing mask.")
    L.append(" */")
    L.append('import { LatLng } from "./GeoMath";')
    L.append("")
    L.append("/** One city's land/water grid over a square window centered on the city. */")
    L.append("export interface CityWaterMask {")
    L.append("  name: string;")
    L.append("  centerLatLng: LatLng;")
    L.append("  /** Longitude/latitude width of the (square) window, degrees. */")
    L.append("  spanDeg: number;")
    L.append("  /** Grid resolution per side. */")
    L.append("  res: number;")
    L.append("  /** res row strings, NORTH->SOUTH; each char WEST->EAST, '1' land / '0' water. */")
    L.append("  rows: string[];")
    L.append("}")
    L.append("")
    L.append("export const CITY_WATER_MASKS: CityWaterMask[] = [")
    for m in masks:
        c = m["centerLatLng"]
        L.append("  {")
        L.append(f'    name: "{m["name"]}",')
        L.append(f'    centerLatLng: {{ lat: {c["lat"]}, lng: {c["lng"]} }},')
        L.append(f'    spanDeg: {span_deg},')
        L.append(f'    res: {res},')
        L.append("    rows: [")
        for row in m["rows"]:
            L.append(f'      "{row}",')
        L.append("    ],")
        L.append("  },")
    L.append("];")
    L.append("")
    L.append("const BY_NAME: { [name: string]: CityWaterMask } = {};")
    L.append("for (const m of CITY_WATER_MASKS) BY_NAME[m.name.toLowerCase()] = m;")
    L.append("")
    L.append("/**")
    L.append(" * True when `latLng` is on LAND for `cityName` (the inverse of the bake-side")
    L.append(" * grid mapping: row NORTH->SOUTH, col WEST->EAST). FAILS OPEN \u2014 returns true for")
    L.append(" * an unknown city or a point outside the mask window \u2014 so markers are never")
    L.append(" * dropped just because the mask doesn't cover them.")
    L.append(" */")
    L.append("export function isLandAt(cityName: string, latLng: LatLng): boolean {")
    L.append("  const m = BY_NAME[(cityName || \"\").toLowerCase()];")
    L.append("  if (!m) return true;")
    L.append("  const fLat = 0.5 - (latLng.lat - m.centerLatLng.lat) / m.spanDeg;")
    L.append("  const fLng = (latLng.lng - m.centerLatLng.lng) / m.spanDeg + 0.5;")
    L.append("  const i = Math.floor(fLat * m.res);")
    L.append("  const j = Math.floor(fLng * m.res);")
    L.append("  if (i < 0 || i >= m.res || j < 0 || j >= m.res) return true;")
    L.append("  return m.rows[i].charAt(j) === \"1\";")
    L.append("}")
    L.append("")
    with open(MASK_TS, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print(f"Wrote {MASK_TS}")


def main():
    parser = argparse.ArgumentParser(description="Bake per-city land/water masks from the existing L-1 PNGs (no network).")
    parser.add_argument("--only", help="Limit to a single city name (e.g. Seattle)")
    parser.add_argument("--level", type=int, default=0,
                        help="Which LOD texture to SAMPLE from. 0 = L0 (default): ~30m/px and exactly the "
                             "map shown when docked, so the mask matches what the player sees. -1 = the wide "
                             "L-1 handoff capture (~160m/px, too coarse to resolve harbors — the old default).")
    parser.add_argument("--span-deg", type=float, default=None,
                        help="Square window width (degrees) centered on each city. Default: match the source "
                             "level's own span (0.45 for L0), so the mask covers the full L0 texture at full "
                             "resolution and aligns 1:1 with the docked map.")
    parser.add_argument("--res", type=int, default=360,
                        help="Grid resolution per side (default 360 -> ~140m/cell over an L0 0.45deg window, "
                             "fine enough to resolve harbor channels and coastline that L-1 blurred away).")
    parser.add_argument("--pad-px", type=int, default=2,
                        help="Half-size (px) of the sample box per cell in the source PNG (default 2 -> 5x5; "
                             "L0 packs ~30m/px so a wider box still stays inside one cell while smoothing labels).")
    parser.add_argument("--erode", type=int, default=1,
                        help="Shrink land by this many cells (8-neighbour) so markers can't sit on the "
                             "shoreline just past a land cell's edge (default 1 -> ~0.14mi inland buffer).")
    args = parser.parse_args()

    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print("Missing dependency. Run: pip install pillow", file=sys.stderr)
        return 1

    with open(BOUNDS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    tcfg = data.get("transition")
    cities = data["cities"]
    if args.only:
        cities = [c for c in cities if c["name"].lower() == args.only.lower()]
        if not cities:
            print(f"No city named {args.only!r} in cityBounds.json", file=sys.stderr)
            return 1

    # Resolve the source LOD entry per city up front, and default the window span
    # to that level's own span so the mask aligns 1:1 with the sampled texture.
    sources = {c["name"]: _source_entry_for(c, tcfg, args.level) for c in cities}
    level_spans = [s["spanDeg"] for s in sources.values() if s]
    if not level_spans:
        print(f"No L{args.level} source available for the requested cities.", file=sys.stderr)
        return 1
    span = max(0.05, args.span_deg if args.span_deg is not None else min(level_spans))
    res = max(8, args.res)
    print(f"Baking land/water masks from L{args.level}: span={span} deg, res={res}x{res}, no network.")

    masks = []
    for city in cities:
        baked = _bake_city_mask(city, sources[city["name"]], span, res, max(0, args.pad_px), max(0, args.erode))
        if not baked:
            continue
        rows, water_frac = baked
        print(f"  {city['name']}: {water_frac * 100:.1f}% water cells")
        masks.append({
            "name": city["name"],
            "centerLatLng": city["centerLatLng"],
            "rows": rows,
        })

    if not masks:
        print(f"No masks baked (no L{args.level} PNGs found?).", file=sys.stderr)
        return 1

    _emit_ts(masks, span, res)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
