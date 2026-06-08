/**
 * Specs Inc. 2026
 * TopicColors – the single source of truth for "what color is this topic?".
 *
 * A small, dependency-free utility module (no @component) so ANY script can ask
 * for a topic's color without wiring up a scene reference. Mirrors the plain-data
 * style of InterestTopics.ts / cardDeckData.ts.
 *
 * Usage:
 *   import { colorForTopic, colorForTopics } from "../Interests/TopicColors"
 *   bubble.setColor(colorForTopics(card.topics))   // primary (first) topic
 *   text.color  = colorForTopic("Music", 0.9)      // explicit topic + alpha
 *
 * Topics not in TOPIC_COLORS get a STABLE, pleasant fallback hue derived from a
 * hash of their name, so a freshly-added user topic still reads consistently
 * every session. Override or extend at runtime with registerTopicColor().
 */

/** Linear RGB triple, each channel 0..1 (alpha is supplied per call). */
export type RGB = [number, number, number]

/**
 * Curated colors for the preset DEFAULT_TOPICS (InterestTopics.ts). Edit these
 * to re-theme the app; lookups are case-insensitive.
 */
export const TOPIC_COLORS: { [topic: string]: RGB } = {
  "Art History": [0.88, 0.66, 0.18], // warm gold
  "Chemistry":   [0.18, 0.77, 0.71], // teal
  "Biology":     [0.36, 0.73, 0.44], // green
  "Botany":      [0.49, 0.71, 0.09], // leaf green
  "Physics":     [0.26, 0.38, 0.93], // indigo
  "Space":       [0.48, 0.18, 0.75], // deep violet
  "Music":       [0.91, 0.29, 0.66], // magenta
  "History":     [0.71, 0.40, 0.11], // amber brown
  "Food":        [1.00, 0.48, 0.00], // orange
  "Design":      [0.00, 0.71, 0.85], // cyan
  "Trains":      [0.36, 0.42, 0.62], // slate blue
  "Aviation":    [0.28, 0.79, 0.89], // sky blue
  "XR":          [0.62, 0.31, 0.87], // electric purple
}

/** Used by colorForTopics() when a card carries no topics at all. */
const DEFAULT_RGB: RGB = [0.80, 0.80, 0.85]

// Case-insensitive lookup built once from TOPIC_COLORS.
const LOOKUP: { [key: string]: RGB } = buildLookup()

// Runtime additions/overrides. Reassigned (never mutated in place) to honor the
// project's immutability convention.
let overrides: { [key: string]: RGB } = {}

/**
 * Adds or replaces the color for a topic at runtime (e.g. a topic typed by the
 * user). Takes effect for every subsequent query, app-wide.
 */
export function registerTopicColor(topic: string, rgb: RGB): void {
  const key = normalizeKey(topic)
  if (key.length === 0) return
  overrides = { ...overrides, [key]: [rgb[0], rgb[1], rgb[2]] }
}

/** The RGB triple for a topic (curated -> override -> stable hashed fallback). */
export function rgbForTopic(topic: string): RGB {
  const key = normalizeKey(topic)
  if (key.length === 0) return DEFAULT_RGB
  if (overrides[key]) return overrides[key]
  if (LOOKUP[key]) return LOOKUP[key]
  return hashedRGB(key)
}

/** A topic's color as a vec4 (RGBA). `alpha` defaults to fully opaque. */
export function colorForTopic(topic: string, alpha: number = 1): vec4 {
  const c = rgbForTopic(topic)
  return new vec4(c[0], c[1], c[2], alpha)
}

/**
 * The color for a set of topics: the PRIMARY (first) topic drives the color so a
 * card has one dominant hue. Falls back to a neutral color when the list is empty.
 */
export function colorForTopics(topics: string[], alpha: number = 1): vec4 {
  if (topics && topics.length > 0) return colorForTopic(topics[0], alpha)
  return new vec4(DEFAULT_RGB[0], DEFAULT_RGB[1], DEFAULT_RGB[2], alpha)
}

/**
 * A point on a smooth, looping rainbow, used as the "topic is still unknown"
 * placeholder color (e.g. the card border while the AI caption is in flight).
 * `phase` is any continuously-increasing value (typically seconds * speed); the
 * hue wraps every 1.0 of phase, so the color flows endlessly without a seam.
 *
 * This is a SINGLE color for the whole shape. A spatially-flowing rainbow (a
 * different hue at each point around the border at the same instant) needs a
 * shader graph — see Assets/Scripts/CardBackdrop for the graph recipe — but the
 * script still drives that graph's reveal/topic uniforms through this module so
 * "what color is rainbow vs. topic?" stays answered in one place.
 */
export function rainbowColor(phase: number, alpha: number = 1): vec4 {
  const hue = ((phase % 1) + 1) % 1 // wrap into [0,1)
  const c = hsvToRgb(hue * 360, 0.85, 1.0)
  return new vec4(c[0], c[1], c[2], alpha)
}

// --- internal ---------------------------------------------------------------

function normalizeKey(topic: string): string {
  return (topic ?? "").trim().toLowerCase()
}

function buildLookup(): { [key: string]: RGB } {
  const out: { [key: string]: RGB } = {}
  for (const name in TOPIC_COLORS) {
    out[name.trim().toLowerCase()] = TOPIC_COLORS[name]
  }
  return out
}

// Deterministic, well-spread color for an unknown topic: hash -> hue, with a
// fixed saturation/value so every generated color reads as a vivid, legible chip.
function hashedRGB(key: string): RGB {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return hsvToRgb(hue, 0.62, 0.85)
}

// Standard HSV -> RGB. h in degrees [0,360), s/v in [0,1].
function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x; b = 0 }
  else if (hp < 2) { r = x; g = c; b = 0 }
  else if (hp < 3) { r = 0; g = c; b = x }
  else if (hp < 4) { r = 0; g = x; b = c }
  else if (hp < 5) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const m = v - c
  return [r + m, g + m, b + m]
}
