const { useState, useEffect, useRef } = React;

/* ------------------- Constants ------------------- */
const SVG_WIDTH = 461;
const SVG_HEIGHT = 1000;
const NUM_CIRCLES = 30;
const MIN_RADIUS = 10;
const MAX_RADIUS = 70;
const REFERENCE_RADIUS = 40;
const MIN_DIST_BETWEEN_CENTERS = 50;
const MAX_PLACEMENT_TRIES = 1200;
const NUM_POINTS = 120;
const RECT_WIDTH_RATIO = 0.8;
const RECT_HEIGHT_RATIO = 0.4;
const RECT_CORNER_RATIO = 0.15;
const RECT_CORNER_RADIUS = 20;

const ANIMATION_SPEED = 0.04;
const PUSH_SPEED = 0.2;
const MOUSE_MOVE_SPEED_BASE = 0.5;
const MOUSE_MOVE_SPEED_SCALE = 1.8;
const SUB_FRACTION = 0.1;
const ACTIVATION_RADIUS = 90;
const INDICATOR_WIPE_FRAMES = 40;
const INDICATOR_FADE_FRAMES = 20;
const BASE_INDICATOR_OPACITY = 0.3;


/* ---------- Perlin Noise Implementation ---------- */
class PerlinNoise {
  constructor() {
    this.p = new Array(512);
    this.permutation = [
      151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
      140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247,
      120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177,
      33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165,
      71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211,
      133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25,
      63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196,
      135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217,
      226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206,
      59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248,
      152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22,
      39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218,
      246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
      81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
      184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
      222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
    ];
    for (let i = 0; i < 256; i++) {
      this.p[i] = this.permutation[i];
      this.p[256 + i] = this.permutation[i];
    }
  }

  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  lerp(t, a, b) {
    return a + t * (b - a);
  }

  grad(hash, x, y) {
    const h = hash & 15;
    const grad2 = 1 + (h & 7);
    const u = h & 8 ? -x : x;
    const v = h & 4 ? -y : y;
    return ((h & 1) === 0 ? u : v) * grad2;
  }

  noise(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = this.fade(x);
    const v = this.fade(y);
    const A = this.p[X] + Y;
    const B = this.p[X + 1] + Y;
    return this.lerp(
      v,
      this.lerp(u, this.grad(this.p[A], x, y), this.grad(this.p[B], x - 1, y)),
      this.lerp(
        u,
        this.grad(this.p[A + 1], x, y - 1),
        this.grad(this.p[B + 1], x - 1, y - 1)
      )
    );
  }
}

/* ------------------- Helper Functions ------------------- */
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function determinePushSide(
  circle,
  rectX,
  rectY,
  rectW,
  rectH,
  marginBoundary = 15
) {
  const { x, y } = circle.baseCenter;
  const left = rectX;
  const right = rectX + rectW;
  const top = rectY;
  const bottom = rectY + rectH;

  let distLeft = Math.abs(x - left);
  let distRight = Math.abs(x - right);
  let distTop = Math.abs(y - top);
  let distBottom = Math.abs(y - bottom);

  if (x >= left - marginBoundary && x <= left) distLeft = 0;
  if (x <= right + marginBoundary && x >= right) distRight = 0;
  if (y >= top - marginBoundary && y <= top) distTop = 0;
  if (y <= bottom + marginBoundary && y >= bottom) distBottom = 0;

  const cornerThreshold = 25;
  if (distTop < cornerThreshold && distLeft < cornerThreshold) {
    return "tl";
  }
  if (distTop < cornerThreshold && distRight < cornerThreshold) {
    return "tr";
  }
  if (distBottom < cornerThreshold && distLeft < cornerThreshold) {
    return "bl";
  }
  if (distBottom < cornerThreshold && distRight < cornerThreshold) {
    return "br";
  }

  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  if (minDist === distTop) return "top";
  if (minDist === distBottom) return "bottom";
  if (minDist === distLeft) return "left";
  return "right";
}

function applySidePush(circle, pushSide, rectX, rectY, rectW, rectH) {
  const { x, y } = circle.baseCenter;
  const { radius } = circle;
  const offset = radius + 20;

  const left = rectX;
  const right = rectX + rectW;
  const top = rectY;
  const bottom = rectY + rectH;

  switch (pushSide) {
    case "tl":
      return { x: left - offset, y: top - offset };
    case "tr":
      return { x: right + offset, y: top - offset };
    case "bl":
      return { x: left - offset, y: bottom + offset };
    case "br":
      return { x: right + offset, y: bottom + offset };
    case "top":
      return { x, y: top - offset };
    case "bottom":
      return { x, y: bottom + offset };
    case "left":
      return { x: left - offset, y };
    case "right":
      return { x: right + offset, y };
    default:
      return { ...circle.baseCenter };
  }
}

function computePushTarget(
  circle,
  rectX,
  rectY,
  rectW,
  rectH,
  marginBoundary = 15
) {
  const { x, y } = circle.baseCenter;
  const left = rectX;
  const right = rectX + rectW;
  const top = rectY;
  const bottom = rectY + rectH;

  const offset = circle.radius + 20;
  if (
    x < left - marginBoundary - offset ||
    x > right + marginBoundary + offset ||
    y < top - marginBoundary - offset ||
    y > bottom + marginBoundary + offset
  ) {
    return { ...circle.baseCenter };
  }

  if (!circle.pushSide) {
    circle.pushSide = determinePushSide(
      circle,
      rectX,
      rectY,
      rectW,
      rectH,
      marginBoundary
    );
  }
  return applySidePush(circle, circle.pushSide, rectX, rectY, rectW, rectH);
}

/* ------------------- Main Component ------------------- */
function MorphingShapes() {
  const [noiseScale, setNoiseScale] = useState(0.48);
  const [distortionScale, setDistortionScale] = useState(4.0);
  const [noise, setNoise] = useState(null);
  
  const [indicatorWipeProgress, setIndicatorWipeProgress] = useState(0);
  const [indicatorOpacity, setIndicatorOpacity] = useState(BASE_INDICATOR_OPACITY);
  const [isWiping, setIsWiping] = useState(false);
  const wipeFramesRef = useRef(0);
  const fadeFramesRef = useRef(0);


  const MAX_FADE_FRAMES = 20;

  const [shapes, setShapes] = useState(() => {
    const arr = [];
    const isFarFromExisting = (x, y) => {
      for (const s of arr) {
        const dx = s.baseCenter?.x - x;
        const dy = s.baseCenter?.y - y;
        if (
          dx * dx + dy * dy <
          MIN_DIST_BETWEEN_CENTERS * MIN_DIST_BETWEEN_CENTERS
        ) {
          return false;
        }
      }
      return true;
    };

    let i = 0;
    while (i < NUM_CIRCLES) {
      let tries = 0;
      let placed = false;
      while (tries < MAX_PLACEMENT_TRIES && !placed) {
        const x = Math.random() * (SVG_WIDTH * 2) - SVG_WIDTH * 0.5;
        const y = Math.random() * (SVG_HEIGHT * 2) - SVG_HEIGHT * 0.5;
        const r = randBetween(MIN_RADIUS, MAX_RADIUS);

        if (isFarFromExisting(x, y)) {
          arr.push({
            baseCenter: { x, y },
            center: { x, y },
            targetCenter: { x, y },
            pushSide: null,

            radius: r,
            isActive: false,
            rawProgress: 0,
            progress: 0,
            targetProgress: 0,
            timeOffset: Math.random() * 9999,
            // Add a random increment in the range [0.001, 0.004], with random sign
            timeOffsetIncrement:
              (Math.random() * 0.003 + 0.001) * (Math.random() < 0.5 ? 1 : -1),
          });
          placed = true;
          i++;
        }
        tries++;
      }
      if (!placed) {
        const x = Math.random() * (SVG_WIDTH * 2) - SVG_WIDTH * 0.5;
        const y = Math.random() * (SVG_HEIGHT * 2) - SVG_HEIGHT * 0.5;
        const r = randBetween(MIN_RADIUS, MAX_RADIUS);
        arr.push({
          baseCenter: { x, y },
          center: { x, y },
          targetCenter: { x, y },
          pushSide: null,

          radius: r,
          isActive: false,
          rawProgress: 0,
          progress: 0,
          targetProgress: 0,
          timeOffset: Math.random() * 9999,
        });
        i++;
      }
    }
    return arr;
  });

  const [activeIndex, setActiveIndex] = useState(null);
  const rectPointsRef = useRef([]);
  const lastMouse = useRef(null);

  useEffect(() => {
    setNoise(new PerlinNoise());
  }, []);

  // Check which circle is near center for activation
  useEffect(() => {
    if (!shapes.length) return;
    const cx = SVG_WIDTH / 2;
    const cy = SVG_HEIGHT / 2;
    const radiusThresholdSq = ACTIVATION_RADIUS * ACTIVATION_RADIUS;

    let minDistSq = Infinity;
    let closest = null;

    shapes.forEach((s, i) => {
      const dx = s.center.x - cx;
      const dy = s.center.y - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq <= radiusThresholdSq && distSq < minDistSq) {
        minDistSq = distSq;
        closest = i;
      }
    });

    if (minDistSq === Infinity) closest = null;
    
    if (closest !== activeIndex) {
      if (closest === null) {
        // Deactivation
        setActiveIndex(null);
        setIsWiping(false);
        wipeFramesRef.current = 0;
        setIndicatorWipeProgress(0);
        fadeFramesRef.current = INDICATOR_FADE_FRAMES;
      } else {
        // Activation
        setActiveIndex(closest);
        setIsWiping(true);
        wipeFramesRef.current = 0;
        fadeFramesRef.current = 0;
      }
    }
  }, [shapes, activeIndex]);

  // Update targetProgress based on activeIndex
  useEffect(() => {
    if (activeIndex === null) {
      setShapes((prev) =>
        prev.map((s) => ({
          ...s,
          isActive: false,
          targetProgress: 0,
        }))
      );
      return;
    }

        // Only set target progress to 1 after wipe is complete
        const shouldTransform = !isWiping && indicatorWipeProgress >= 1;

        setShapes((prev) =>
          prev.map((s, i) => ({
            ...s,
            isActive: i === activeIndex,
            targetProgress: i === activeIndex && shouldTransform ? 1 : 0,
          }))
        );
      }, [activeIndex, isWiping, indicatorWipeProgress]);


  // Mouse moves shift each shape's baseCenter
  const handleMouseMove = (e) => {
    if (!lastMouse.current) {
      lastMouse.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;

    setShapes((prev) =>
      prev.map((s) => {
        const radiusFraction = s.radius / MAX_RADIUS;
        const speedFactor =
          MOUSE_MOVE_SPEED_BASE + radiusFraction * MOUSE_MOVE_SPEED_SCALE;
        return {
          ...s,
          baseCenter: {
            x: s.baseCenter.x - dx * speedFactor,
            y: s.baseCenter.y - dy * speedFactor,
          },
        };
      })
    );
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };

  // Precompute rectangle shape points once
  const getRectPoints = () => {
    const x = (SVG_WIDTH - RECT_WIDTH_RATIO * SVG_WIDTH) / 2;
    const y = (SVG_HEIGHT - RECT_HEIGHT_RATIO * SVG_HEIGHT) / 2;
    const width = RECT_WIDTH_RATIO * SVG_WIDTH;
    const height = RECT_HEIGHT_RATIO * SVG_HEIGHT;
    const pointsPerCorner = Math.floor((NUM_POINTS * RECT_CORNER_RATIO) / 4);
    const pointsPerEdge = Math.floor((NUM_POINTS - pointsPerCorner * 4) / 4);
    const remaining = NUM_POINTS - (pointsPerCorner * 4 + pointsPerEdge * 4);
    const pts = [];

    const addEdgePoints = (x1, y1, x2, y2, count) => {
      for (let i = 0; i < count; i++) {
        const t = i / count;
        pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
      }
    };

    const addCornerPoints = (cx, cy, startAngle, count) => {
      for (let i = 0; i < count; i++) {
        const angle = startAngle + (i / count) * (Math.PI / 2);
        pts.push([
          cx + RECT_CORNER_RADIUS * Math.cos(angle),
          cy + RECT_CORNER_RADIUS * Math.sin(angle),
        ]);
      }
    };

    // Right edge
    addEdgePoints(
      x + width,
      y + RECT_CORNER_RADIUS,
      x + width,
      y + height - RECT_CORNER_RADIUS,
      pointsPerEdge
    );
    // Bottom-right corner
    addCornerPoints(
      x + width - RECT_CORNER_RADIUS,
      y + height - RECT_CORNER_RADIUS,
      0,
      pointsPerCorner
    );
    // Bottom edge
    addEdgePoints(
      x + width - RECT_CORNER_RADIUS,
      y + height,
      x + RECT_CORNER_RADIUS,
      y + height,
      pointsPerEdge
    );
    // Bottom-left corner
    addCornerPoints(
      x + RECT_CORNER_RADIUS,
      y + height - RECT_CORNER_RADIUS,
      Math.PI / 2,
      pointsPerCorner
    );
    // Left edge
    addEdgePoints(
      x,
      y + height - RECT_CORNER_RADIUS,
      x,
      y + RECT_CORNER_RADIUS,
      pointsPerEdge
    );
    // Top-left corner
    addCornerPoints(
      x + RECT_CORNER_RADIUS,
      y + RECT_CORNER_RADIUS,
      Math.PI,
      pointsPerCorner
    );
    // Top edge (+ leftover points)
    addEdgePoints(
      x + RECT_CORNER_RADIUS,
      y,
      x + width - RECT_CORNER_RADIUS,
      y,
      pointsPerEdge + remaining
    );
    // Top-right corner
    addCornerPoints(
      x + width - RECT_CORNER_RADIUS,
      y + RECT_CORNER_RADIUS,
      -Math.PI / 2,
      pointsPerCorner
    );

    return pts;
  };

  if (!rectPointsRef.current.length) {
    rectPointsRef.current = getRectPoints();
  }

  // Return circle points or fallback
  const getCirclePoints = (
    cx,
    cy,
    r,
    timeOffset,
    noiseScaleVal,
    distortionScaleVal
  ) => {
    if (!noise) {
      const ptsFallback = [];
      for (let i = 0; i < NUM_POINTS; i++) {
        const angle = (i / NUM_POINTS) * Math.PI * 2;
        ptsFallback.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
      }
      return ptsFallback;
    }
    const radiusRatio = r / REFERENCE_RADIUS;
    const pts = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      const angle = -Math.PI / 3 + (i / NUM_POINTS) * Math.PI * 2;
      const nVal = noise.noise(
        Math.cos(angle) * noiseScaleVal + timeOffset,
        Math.sin(angle) * noiseScaleVal + timeOffset
      );
      const baseOffset = REFERENCE_RADIUS + nVal * distortionScaleVal;
      const finalOffset = radiusRatio * baseOffset;
      pts.push([
        cx + Math.cos(angle) * finalOffset,
        cy + Math.sin(angle) * finalOffset,
      ]);
    }
    return pts;
  };

  // Morph circle points to rect points
  const morphPoints = (circlePts, rectPts, prog) => {
    return circlePts.map((cPt, i) => {
      const [cx, cy] = cPt;
      const [rx, ry] = rectPts[i % rectPts.length];
      return [cx + (rx - cx) * prog, cy + (ry - cy) * prog];
    });
  };

  const buildPathString = (pts) => {
    const [startX, startY] = pts[0];
    let d = `M ${startX},${startY}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i][0]},${pts[i][1]}`;
    }
    return d + " Z";
  };

  const buildRingPath = (outerPts, innerPts, rectPts, progress) => {
    const outerMorph = morphPoints(outerPts, rectPts, progress);
    const innerMorph = morphPoints(innerPts, rectPts, progress);
    return buildPathString(outerMorph) + " " + buildPathString(innerMorph);
  };

  // Animation loop
  useEffect(() => {
    let animId;
    const animate = () => {

      // Handle indicator animations
      if (isWiping) {
        // Wipe out the indicator
        wipeFramesRef.current++;
        if (wipeFramesRef.current >= INDICATOR_WIPE_FRAMES) {
          setIsWiping(false);
          setIndicatorWipeProgress(1);
        } else {
          setIndicatorWipeProgress(wipeFramesRef.current / INDICATOR_WIPE_FRAMES);
        }
        setIndicatorOpacity(BASE_INDICATOR_OPACITY);
      } else if (activeIndex === null) {
        // Reset wipe and handle fade in
        setIndicatorWipeProgress(0);
        if (fadeFramesRef.current > 0) {
          fadeFramesRef.current--;
          setIndicatorOpacity(
            BASE_INDICATOR_OPACITY * (1 - fadeFramesRef.current / INDICATOR_FADE_FRAMES)
          );
        }
      }
            
      setShapes((prevShapes) => {
        const next = prevShapes.map((s) => {
          // 1) Update morph progress
          const diff = s.targetProgress - s.rawProgress;
          let newRaw = s.rawProgress;
          if (Math.abs(diff) > 0.001) {
            newRaw += diff * ANIMATION_SPEED;
          } else {
            newRaw = s.targetProgress;
          }
          const clamped = Math.max(0, Math.min(1, newRaw));

          return {
            ...s,
            rawProgress: clamped,
            progress: easeInOutQuad(clamped),
          };
        });

        // 2) If we have an active shape, push others
        if (activeIndex !== null) {
          const rectX = (SVG_WIDTH - RECT_WIDTH_RATIO * SVG_WIDTH) / 2;
          const rectY = (SVG_HEIGHT - RECT_HEIGHT_RATIO * SVG_HEIGHT) / 2;
          const rectW = RECT_WIDTH_RATIO * SVG_WIDTH;
          const rectH = RECT_HEIGHT_RATIO * SVG_HEIGHT;

          const activeP = next[activeIndex].progress;

          next.forEach((circle, i) => {
            if (i === activeIndex) {
              // Active shape not pushed
              circle.targetCenter = { ...circle.baseCenter };
              return;
            }
            const fullPushTarget = computePushTarget(
              circle,
              rectX,
              rectY,
              rectW,
              rectH
            );
            circle.targetCenter = {
              x:
                circle.baseCenter.x +
                (fullPushTarget.x - circle.baseCenter.x) * activeP,
              y:
                circle.baseCenter.y +
                (fullPushTarget.y - circle.baseCenter.y) * activeP,
            };
          });
        } else {
          // No active shape => no push
          next.forEach((circle) => {
            circle.targetCenter = { ...circle.baseCenter };
            circle.pushSide = null;
          });
        }

        // 3) Move each circle.center toward its targetCenter
        next.forEach((circle) => {
          circle.center.x +=
            (circle.targetCenter.x - circle.center.x) * PUSH_SPEED;
          circle.center.y +=
            (circle.targetCenter.y - circle.center.y) * PUSH_SPEED;
        });

        // 4) **Increment timeOffset** so that circles gently undulate (// ADD THIS)
        next.forEach((circle) => {
          circle.timeOffset += circle.timeOffsetIncrement;
        });

        return next;
      });

      animId = requestAnimationFrame(animate);
    };
    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [activeIndex, isWiping]);

  return (
    <div 
      style={{ 
        width: "100%", 
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        position: "relative"
      }} 
      onMouseMove={handleMouseMove}
    >
      <svg
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
        style={{ 
          background: "#fafafa", 
          border: "1px solid #ccc"
        }}
      >
        {/* Indicator with radial wipe */}
        <circle
          cx={SVG_WIDTH / 2}
          cy={SVG_HEIGHT / 2}
          r={9}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeDasharray={`${2 * Math.PI * 9}`}
          strokeDashoffset={`${2 * Math.PI * 9 * indicatorWipeProgress}`}
          strokeOpacity={indicatorOpacity}
        />
        
        {/* Existing shapes */}
        {shapes.map((s, i) => {
          const circlePts = getCirclePoints(
            s.center.x,
            s.center.y,
            s.radius,
            s.timeOffset,
            noiseScale,
            distortionScale
          );
          const subRadius = s.radius * (1 - SUB_FRACTION);
          const subCirclePts = getCirclePoints(
            s.center.x,
            s.center.y,
            subRadius,
            s.timeOffset,
            noiseScale * (1 - SUB_FRACTION),
            distortionScale * (1 - SUB_FRACTION)
          );
          const ringD = buildRingPath(
            circlePts,
            subCirclePts,
            rectPointsRef.current,
            s.progress
          );
          const outerPath = buildPathString(
            morphPoints(circlePts, rectPointsRef.current, s.progress)
          );
          const circleStroke =
            2 + (s.radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS);
          const strokeW = circleStroke * (1 - s.progress) + 3 * s.progress;
          return (
            <g key={i}>
              <path
                d={ringD}
                fill="currentColor"
                fillRule="evenodd"
                fillOpacity={0.9}
                stroke="none"
              />
              <path
                d={outerPath}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeW}
                strokeOpacity={1}
              />
            </g>
          );
        })}
      </svg>

      {/* Controls (hidden) */}
      <div style={{ 
        position: "absolute",
        top: "20px",
        left: "20px",
        background: "white",
        padding: "10px",
        borderRadius: "8px",
        boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
        display: "none"
      }}>
        <div style={{ marginBottom: 16, width: 300 }}>
          <label>
            Noise Scale: {noiseScale.toFixed(2)}
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={noiseScale}
              onChange={(e) => setNoiseScale(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
        </div>
        <div style={{ marginBottom: 16, width: 300 }}>
          <label>
            Distortion Scale: {distortionScale.toFixed(1)}
            <input
              type="range"
              min="1"
              max="17"
              step="0.1"
              value={distortionScale}
              onChange={(e) => setDistortionScale(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

// Render
ReactDOM.createRoot(document.getElementById("root")).render(<MorphingShapes />);
