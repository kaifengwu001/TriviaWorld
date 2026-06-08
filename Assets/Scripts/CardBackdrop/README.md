# CardBackdrop — flowing-rainbow → topic-color border

`CardBackdropController` wraps each spawned scanner card (picture + caption) in a
rounded-rect border built from a `BubbleMesh`. The border color tells a story:

1. **While the user is cropping / waiting for the AI caption** the topic is
   unknown, so the border **flows a rainbow**. Rainbow is **reserved for this
   capture phase only**.
2. **Once the caption arrives**, `PictureBehavior` derives the card's topic from
   the caption's hashtag line (the first hashtag is the chosen interest):
   - a topic was decided → border **cross-fades to that topic's color**
     (`Interests/TopicColors.ts`);
   - no topic could be decided → border **cross-fades to plain white** (never
     rainbow — text is already present, we just can't classify it).

The three states map to `PictureBehavior.getResolvedTopics()`: `null` (still
capturing → rainbow), `[]` (caption in, undecidable → white), `[..]` (topic
decided → topic color).

The script side is already wired:

- `PictureBehavior.getResolvedTopics()` returns `null` until the caption arrives,
  then the topics (primary first).
- `CardBackdrop.updateColor()` flows `rainbowColor()` while topics are `null`,
  then eases to `colorForTopics(topics)` over `Topic Reveal Seconds`.
- It drives the material every frame with:
  - `mat.mainPass.baseColor` — via `BubbleMesh.setColor()` — the **topic color**
    (and the border's alpha).
  - `mat.mainPass.<revealParam>` — via `CardBackdrop.setReveal()` — a **0→1**
    blend (`0` = rainbow, `1` = solid topic color). `revealParam` defaults to
    `"reveal"`.

On a **plain material** (no graph) the `reveal` write is a harmless no-op and the
script's color cycling still themes the border — but it's a single flat hue, not
a spatial rainbow. For a true *flowing* rainbow (a different hue at every point
around the border at the same instant), build the shader graph below and assign
it as the controller's **Base Material**.

---

## Building the rainbow shader graph

Snap does not ship a flowing-rainbow material, but every node needed exists in
the **Material Editor**. Create a new **Graph** material (Unlit), then:

### Exposed parameters (what code controls)

These two **must** exist for the script to drive them. Add the node, then set its
**Script Name** in the Inspector (this is the `mat.mainPass.<name>` key — it is
**case-sensitive**):

| Node | Script Name | Type | Driven by | Meaning |
|---|---|---|---|---|
| **Color Parameter** | `baseColor` | color (vec4) | `BubbleMesh.setColor()` | The resolved topic color; its **alpha** is the border opacity. |
| **Float Parameter** | `reveal` | float, 0–1, default `0` | `CardBackdrop.setReveal()` | `0` = flowing rainbow, `1` = solid topic color. |

> The first one's Script Name **must** be exactly `baseColor`, because
> `BubbleMesh` writes the color to `mainPass.baseColor`. The second must match the
> controller's **Reveal Param** input (default `reveal`).

Optional: a **Float Parameter** `flowSpeed` (default ~`0.15`) if you want to tune
the spatial flow at runtime; otherwise use a constant **Float Value**.

### Node graph

**1 — Centered UV → angle.** The mesh supplies UVs where `(u,v)` is the rect
position normalized to ~`[0,1]`, so `uv − 0.5` points out from the border center;
its angle is what we flow the rainbow around.

```
Surface UV Coord (Index 0) ─► Split Vector ─► u, v
u ─► Subtract (− 0.5) ─► px
v ─► Subtract (− 0.5) ─► py
ATan2( X = px, Y = py ) ─► angle           // radians, −π..π
```

**2 — angle → looping hue, animated.**

```
angle ─► Divide (÷ 6.2831853)  ─► angleN     // −0.5..0.5  (2π)
Elapsed Time ─► Multiply (× flowSpeed) ─► t
Add( angleN, t ) ─► Fract ─► hue             // 0..1, seamless loop
```

**3 — hue → rainbow RGB.** (Lens Studio's HSV hue is `0..1`, not degrees.)

```
Construct Vector( X = hue, Y = 0.85 (sat), Z = 1.0 (val) ) ─► hsv
HSV to RGB( hsv ) ─► rainbowRGB              // vec3
```

**4 — topic color + reveal blend.**

```
Color Parameter "baseColor" ─► Swizzle "xyz" ─► topicRGB
Color Parameter "baseColor" ─► Swizzle "w"   ─► alpha
Mix( A = rainbowRGB, B = topicRGB, T = reveal ) ─► outRGB
```

**5 — assemble + output.**

```
Construct Vector( outRGB.xyz, alpha ) ─► outColor (vec4)
outColor ─► Shader Base Color (and Opacity, if the template separates it)
```

### Material render settings

- **Two Sided** ON (a flat 2D band; also set in code defensively).
- **Blend Mode** `Normal` (alpha blend) so the border alpha shows.
- **Depth Write** OFF for a translucent border to avoid sorting artifacts.

### How the phases look at runtime

- **Capture (rainbow) phase:** script sets `reveal = 0`; `Mix` outputs
  `rainbowRGB`; the border alpha still comes from `baseColor.a`. (`baseColor.rgb`
  is also cycling as the script fallback, but `reveal = 0` ignores it.)
- **Reveal phase:** script eases `reveal 0→1` while `baseColor` lerps to the
  final color, so the flowing rainbow dissolves into the solid hue. That final
  color is the **topic color** when a topic was decided, or **white**
  (`baseColor = (1,1,1,a)`) when the caption had no decidable topic.
