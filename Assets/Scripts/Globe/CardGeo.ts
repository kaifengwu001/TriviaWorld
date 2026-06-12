/**
 * Specs Inc. 2026
 * CardGeo – pure math for placing CARD markers on the globe / map table.
 *
 * NO engine dependencies (no vec3/SceneObject), mirroring GeoMath.ts: plain
 * numbers and plain objects only, so the scatter + clustering stay trivially
 * testable and reusable.
 *
 * Two responsibilities:
 *   1. SCATTER — the CardStore only knows a card's CITY, so each card gets a
 *      stable pseudo-location: a deterministic random point inside a disk of
 *      `rangeMiles` around the city's shared center. The randomness is seeded
 *      by the card id, so a card's spot NEVER moves between frames, zoom
 *      levels, or sessions — markers stay pinned through every animation.
 *   2. CLUSTER — markers that are close in IN-SCENE (world cm) distance merge
 *      into one marker at the average of their positions, so a dense city
 *      doesn't render a smeared pile of icons when zoomed out. Clustering
 *      NEVER merges across cities (so Seattle + Los Angeles always stay two
 *      markers in the globe view, however close they look).
 *
 * Immutability: every function RETURNS NEW objects; nothing is mutated.
 */
import { LatLng } from "./GeoMath";

const DEG2RAD = Math.PI / 180;

/** Miles per degree of latitude (and of longitude at the equator). */
export const MILES_PER_DEG_LAT = 69.0;

/** A plain world-space point (cm), engine-free mirror of vec3. */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

/** One card's marker candidate: a stable geo spot + tonight's world position. */
export interface ClusterablePoint {
  /** Card id (also the determinism key for cluster ordering). */
  id: string;
  /** Resolved city name; clusters never span two cities. */
  cityName: string;
  latLng: LatLng;
  world: WorldPoint;
}

/** A merged marker: 1..n cards collapsed to their average position. */
export interface MarkerCluster {
  cityName: string;
  /** How many card markers merged into this one (1 = a lone card). */
  count: number;
  ids: string[];
  /** Average of the member latLngs (what the visual marker is mapped from). */
  latLng: LatLng;
}

// --- deterministic scatter ---------------------------------------------------

/** 32-bit FNV-1a hash of a string. Stable across sessions and devices. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619 (FNV prime) via shift-adds to stay inside 32-bit math
    // without Math.imul (not guaranteed on every Lens Studio JS runtime).
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/**
 * A tiny deterministic PRNG (Park–Miller minimal standard). All intermediate
 * products fit in a float64 exactly (48271 * 2^31 < 2^53), so the sequence is
 * bit-stable everywhere. Returns a function yielding floats in [0, 1).
 */
export function makeRandom(seed: number): () => number {
  let state = (((seed % 2147483646) + 2147483646) % 2147483646) + 1; // [1, 2147483646]
  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * A stable pseudo-location for a card: a uniform random point inside a disk of
 * `rangeMiles` around `center`, seeded by `seedKey` (the card id). The same
 * (center, range, key) always yields the same spot, so markers never drift.
 */
export function scatterLatLng(center: LatLng, rangeMiles: number, seedKey: string): LatLng {
  if (rangeMiles <= 0) return { lat: center.lat, lng: center.lng };
  const rand = makeRandom(hashString(seedKey));
  // sqrt(u) makes the distribution uniform over the disk AREA (not clumped at center).
  const r = rangeMiles * Math.sqrt(rand());
  const theta = 2 * Math.PI * rand();
  const northMiles = r * Math.sin(theta);
  const eastMiles = r * Math.cos(theta);
  // Longitude degrees shrink by cos(lat); clamp so polar cities can't blow up.
  const cosLat = Math.max(0.2, Math.cos(center.lat * DEG2RAD));
  return {
    lat: center.lat + northMiles / MILES_PER_DEG_LAT,
    lng: center.lng + eastMiles / (MILES_PER_DEG_LAT * cosLat),
  };
}

/** True when a candidate coordinate is allowed (on land). See scatterLatLngOnLand. */
export interface LandSampler {
  (latLng: LatLng): boolean;
}

/**
 * Like {@link scatterLatLng} but REJECTS spots that aren't on land, so markers
 * never land in the ocean (Puget Sound, Tokyo Bay, the LA coastline). Draws from
 * the SAME seeded stream as scatterLatLng, so:
 *   - determinism/stability are preserved (same card -> same spot every run), and
 *   - a card whose FIRST candidate is already on land keeps the exact position it
 *     had before ocean-avoidance existed (only water-first cards relocate).
 *
 * It redraws up to `maxTries` times; if every candidate is water (astronomically
 * unlikely unless a city is almost entirely sea), it returns the first candidate
 * rather than dropping the card — a rare wet marker beats a missing one.
 */
export function scatterLatLngOnLand(
  center: LatLng,
  rangeMiles: number,
  seedKey: string,
  isLand: LandSampler,
  maxTries: number = 24
): LatLng {
  if (rangeMiles <= 0) return { lat: center.lat, lng: center.lng };
  const rand = makeRandom(hashString(seedKey));
  const cosLat = Math.max(0.2, Math.cos(center.lat * DEG2RAD));
  const tries = Math.max(1, Math.floor(maxTries));
  let first: LatLng | null = null;
  for (let i = 0; i < tries; i++) {
    const r = rangeMiles * Math.sqrt(rand());
    const theta = 2 * Math.PI * rand();
    const cand: LatLng = {
      lat: center.lat + (r * Math.sin(theta)) / MILES_PER_DEG_LAT,
      lng: center.lng + (r * Math.cos(theta)) / (MILES_PER_DEG_LAT * cosLat),
    };
    if (first === null) first = cand;
    if (isLand(cand)) return cand;
  }
  return first as LatLng;
}

// --- distances ----------------------------------------------------------------

/**
 * Approximate angular distance (degrees) between two coordinates, using the
 * small-area equirectangular approximation (consistent with GeoMath's linear
 * treatment of city-scale spans). Longitude is wrapped to the short way round.
 */
export function angularDistanceDeg(a: LatLng, b: LatLng): number {
  const dLat = a.lat - b.lat;
  let dLng = a.lng - b.lng;
  while (dLng > 180) dLng -= 360;
  while (dLng < -180) dLng += 360;
  const east = dLng * Math.cos(((a.lat + b.lat) / 2) * DEG2RAD);
  return Math.sqrt(dLat * dLat + east * east);
}

function worldDistance(a: WorldPoint, b: WorldPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// --- clustering ----------------------------------------------------------------

// Running sums for one cluster while it is being built (internal only).
interface ClusterAccumulator {
  cityName: string;
  ids: string[];
  latSum: number;
  lngSum: number;
  xSum: number;
  ySum: number;
  zSum: number;
  n: number;
}

/**
 * Greedy centroid clustering by IN-SCENE distance: points whose world position
 * is within `mergeDistCm` of an existing cluster's centroid join it (and shift
 * the centroid); otherwise they start a new cluster. Points are processed in
 * id order so the result is deterministic for a given frame's positions —
 * clusters don't flicker while nothing moves.
 *
 * A cluster never spans two cities, guaranteeing one-marker-per-city minimum
 * however far out the camera zooms (e.g. Seattle vs Los Angeles on the globe).
 */
export function clusterByWorldDistance(points: ClusterablePoint[], mergeDistCm: number): MarkerCluster[] {
  const dist = Math.max(0, mergeDistCm);
  const accs: ClusterAccumulator[] = [];
  const ordered = points.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const p of ordered) {
    let best: ClusterAccumulator | null = null;
    let bestD = dist;
    for (const acc of accs) {
      if (acc.cityName !== p.cityName) continue;
      const centroid: WorldPoint = { x: acc.xSum / acc.n, y: acc.ySum / acc.n, z: acc.zSum / acc.n };
      const d = worldDistance(centroid, p.world);
      if (d <= bestD) {
        bestD = d;
        best = acc;
      }
    }
    if (best) {
      best.ids.push(p.id);
      best.latSum += p.latLng.lat;
      best.lngSum += p.latLng.lng;
      best.xSum += p.world.x;
      best.ySum += p.world.y;
      best.zSum += p.world.z;
      best.n += 1;
    } else {
      accs.push({
        cityName: p.cityName,
        ids: [p.id],
        latSum: p.latLng.lat,
        lngSum: p.latLng.lng,
        xSum: p.world.x,
        ySum: p.world.y,
        zSum: p.world.z,
        n: 1,
      });
    }
  }

  return accs.map((acc) => ({
    cityName: acc.cityName,
    count: acc.n,
    ids: acc.ids.slice(),
    latLng: { lat: acc.latSum / acc.n, lng: acc.lngSum / acc.n },
  }));
}
