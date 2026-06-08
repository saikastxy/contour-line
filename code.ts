// ============================================================
// Contour Line — Figma Plugin
// Converts grayscale fills to smooth vector contour lines
// using Marching Squares + Catmull-Rom smoothing.
// ============================================================

// ==================== TYPES ====================

interface Point {
  x: number;
  y: number;
}

interface ScalarField {
  data: number[][]; // brightness[row][col], 0=black, 1=white
  width: number;    // columns
  height: number;   // rows
  bounds: Bounds;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Polyline {
  points: Point[];
  closed: boolean;
}

interface LineSegment {
  start: Point;
  end: Point;
}

// ==================== BRIGHTNESS ====================

function rgbToBrightness(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function colorToBrightness(c: RGB): number {
  return rgbToBrightness(c.r, c.g, c.b);
}

// ==================== SCALAR FIELD EXTRACTION ====================

async function extractScalarField(
  node: SceneNode,
  resolution: number
): Promise<ScalarField> {
  if (!("fills" in node)) {
    throw new Error("所选节点不支持填充属性");
  }

  const fills = node.fills;
  if (fills === figma.mixed) {
    // For compound nodes (groups, etc.), rasterise via export
    const bounds = getNodeBounds(node);
    const maxDim = Math.max(bounds.width, bounds.height);
    const cellSize = maxDim / (resolution - 1);
    const cols = Math.max(2, Math.round(bounds.width / cellSize) + 1);
    const rows = Math.max(2, Math.round(bounds.height / cellSize) + 1);
    return await extractRasterField(bounds, cols, rows, node);
  }
  if (!Array.isArray(fills) || fills.length === 0) {
    throw new Error("所选节点没有填充");
  }

  const fill = fills[0] as Paint;
  const bounds = getNodeBounds(node);

  // Determine grid dimensions (preserve aspect ratio)
  const maxDim = Math.max(bounds.width, bounds.height);
  const cellSize = maxDim / (resolution - 1);
  const cols = Math.max(2, Math.round(bounds.width / cellSize) + 1);
  const rows = Math.max(2, Math.round(bounds.height / cellSize) + 1);

  if (cols < 3 || rows < 3) {
    throw new Error("节点尺寸太小，无法生成等高线");
  }

  switch (fill.type) {
    case "SOLID":
      return extractSolid(bounds, fill, cols, rows);
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
    case "IMAGE":
      // All non-solid fills: render the node to PNG via Figma's own engine,
      // then decode to extract brightness. This avoids transform-direction
      // bugs in manual gradient math and guarantees correct colors.
      return await extractRasterField(bounds, cols, rows, node);
    default:
      throw new Error(`不支持的填充类型: ${fill.type}`);
  }
}

function getNodeBounds(node: SceneNode): Bounds {
  // Use node's intrinsic dimensions from its transform — this matches
  // what exportAsync renders, ensuring the scalar field and exported
  // PNG share the exact same coordinate system.
  return {
    x: node.absoluteTransform[0][2],
    y: node.absoluteTransform[1][2],
    width: node.width,
    height: node.height,
  };
}

function extractSolid(
  bounds: Bounds,
  fill: SolidPaint,
  cols: number,
  rows: number
): ScalarField {
  const b = colorToBrightness(fill.color);
  const data: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: number[] = new Array(cols).fill(b);
    data.push(line);
  }
  return { data, width: cols, height: rows, bounds };
}

// Common path for all non-solid fills (IMAGE, GRADIENT_*):
// Export the node to PNG via Figma's own renderer, then decode in the UI
// thread to extract a per-pixel brightness field. This guarantees correct
// colors for every fill type without manual gradient/transform math.
async function extractRasterField(
  bounds: Bounds,
  cols: number,
  rows: number,
  node: SceneNode
): Promise<ScalarField> {
  const exportScale = Math.max(
    0.5,
    Math.min(2, (Math.max(cols, rows) * 2) / Math.max(bounds.width, bounds.height))
  );
  const pngBytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: exportScale },
  });

  const brightness = await decodePngInUI(pngBytes, cols, rows);
  const data: number[][] = [];
  for (let r = 0; r < rows; r++) {
    data.push(brightness.slice(r * cols, (r + 1) * cols));
  }
  return { data, width: cols, height: rows, bounds };
}

// Round-trip to UI thread for PNG decode + bilinear sampling
let decodePromise: {
  resolve: (v: number[]) => void;
  reject: (e: Error) => void;
} | null = null;

function decodePngInUI(
  bytes: Uint8Array,
  cols: number,
  rows: number
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    decodePromise = { resolve, reject };
    figma.ui.postMessage({ type: "decode-image", bytes, cols, rows });
  });
}

// ==================== THRESHOLD SELECTION ====================

function computeThresholds(
  field: ScalarField,
  count: number,
  bias: number
): number[] {
  // Flatten, find min/max
  const values: number[] = [];
  let vmin = 1,
    vmax = 0;
  for (let r = 0; r < field.height; r++) {
    for (let c = 0; c < field.width; c++) {
      const v = field.data[r][c];
      values.push(v);
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
  }

  if (vmax - vmin < 0.001) {
    // Near-uniform field — evenly spaced
    const ts: number[] = [];
    for (let i = 1; i <= count; i++) {
      ts.push(vmin + (i / (count + 1)) * (vmax - vmin));
    }
    return ts;
  }

  // Sort values for weighted quantile computation
  values.sort((a, b) => a - b);

  // Weight function: w(v) = (1 - v)^bias
  // Compute cumulative weight
  const cumWeights: number[] = [];
  let total = 0;
  for (const v of values) {
    total += Math.pow(1 - v, bias);
    cumWeights.push(total);
  }

  // Pick thresholds at equally-spaced cumulative weight positions
  const thresholds: number[] = [];
  for (let i = 1; i <= count; i++) {
    const target = (i / (count + 1)) * total;
    // Binary search for the value at this cumulative weight
    let lo = 0,
      hi = values.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumWeights[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    thresholds.push(values[lo]);
  }

  // Deduplicate (remove thresholds that are too close)
  const deduped: number[] = [];
  const minSpacing = Math.max(0.0005, (vmax - vmin) / (count * 5));
  for (const t of thresholds) {
    if (deduped.length === 0 || t - deduped[deduped.length - 1] > minSpacing) {
      deduped.push(t);
    }
  }
  // Always return at least one threshold if we have a brightness range
  if (deduped.length === 0 && thresholds.length > 0) {
    deduped.push(thresholds[Math.floor(thresholds.length / 2)]);
  }
  return deduped;
}

// ==================== MARCHING SQUARES ====================

// Edge numbering (clockwise from top):
//   0: between (i,j) top-left     and (i,j+1) top-right
//   1: between (i,j+1) top-right  and (i+1,j+1) bottom-right
//   2: between (i+1,j) bottom-left and (i+1,j+1) bottom-right
//   3: between (i,j) top-left     and (i+1,j) bottom-left

// Lookup: case index (4-bit) → array of edge pairs that form line segments
// bit 0=TL-below, bit 1=TR-below, bit 2=BR-below, bit 3=BL-below
type EdgePair = [number, number];
const SQUARES_TABLE: Record<number, EdgePair[]> = {
  0: [],
  1: [[0, 3]],
  2: [[0, 1]],
  3: [[1, 3]],
  4: [[1, 2]],
  5: [[0, 3], [1, 2]], // saddle — resolved with center value
  6: [[0, 2]],
  7: [[2, 3]],
  8: [[2, 3]],
  9: [[0, 2]],
  10: [[0, 1], [2, 3]], // saddle — resolved with center value
  11: [[1, 2]],
  12: [[1, 3]],
  13: [[0, 1]],
  14: [[0, 3]],
  15: [],
};

function marchingSquares(
  field: ScalarField,
  threshold: number
): LineSegment[] {
  const segments: LineSegment[] = [];
  const { data, width, height, bounds } = field;
  const cw = bounds.width / (width - 1);
  const ch = bounds.height / (height - 1);

  for (let i = 0; i < height - 1; i++) {
    for (let j = 0; j < width - 1; j++) {
      const v_tl = data[i][j];
      const v_tr = data[i][j + 1];
      const v_br = data[i + 1][j + 1];
      const v_bl = data[i + 1][j];

      let caseIdx = 0;
      if (v_tl < threshold) caseIdx |= 1;
      if (v_tr < threshold) caseIdx |= 2;
      if (v_br < threshold) caseIdx |= 4;
      if (v_bl < threshold) caseIdx |= 8;

      let pairs = SQUARES_TABLE[caseIdx] || [];

      // Resolve saddle ambiguity using center value
      if (caseIdx === 5 || caseIdx === 10) {
        const center = (v_tl + v_tr + v_br + v_bl) / 4;
        if (center < threshold) {
          // Pair as top-right + left-right connections
          pairs =
            caseIdx === 5
              ? [[0, 1], [2, 3]]
              : [[0, 3], [1, 2]];
        } else {
          // Default pairs from table
          pairs = SQUARES_TABLE[caseIdx];
        }
      }

      for (const [e0, e1] of pairs) {
        const p0 = edgePoint(
          e0,
          i,
          j,
          v_tl,
          v_tr,
          v_br,
          v_bl,
          threshold,
          bounds,
          cw,
          ch
        );
        const p1 = edgePoint(
          e1,
          i,
          j,
          v_tl,
          v_tr,
          v_br,
          v_bl,
          threshold,
          bounds,
          cw,
          ch
        );
        if (p0 && p1) {
          segments.push({ start: p0, end: p1 });
        }
      }
    }
  }

  return segments;
}

function edgePoint(
  edge: number,
  i: number,
  j: number,
  v_tl: number,
  v_tr: number,
  v_br: number,
  v_bl: number,
  t: number,
  bounds: Bounds,
  cw: number,
  ch: number
): Point | null {
  let a_val: number, b_val: number;
  let ax: number, ay: number, bx: number, by: number;

  switch (edge) {
    case 0: // top: TL → TR
      a_val = v_tl; b_val = v_tr;
      ax = bounds.x + j * cw;       ay = bounds.y + i * ch;
      bx = bounds.x + (j + 1) * cw; by = bounds.y + i * ch;
      break;
    case 1: // right: TR → BR
      a_val = v_tr; b_val = v_br;
      ax = bounds.x + (j + 1) * cw; ay = bounds.y + i * ch;
      bx = bounds.x + (j + 1) * cw; by = bounds.y + (i + 1) * ch;
      break;
    case 2: // bottom: BL → BR
      a_val = v_bl; b_val = v_br;
      ax = bounds.x + j * cw;       ay = bounds.y + (i + 1) * ch;
      bx = bounds.x + (j + 1) * cw; by = bounds.y + (i + 1) * ch;
      break;
    case 3: // left: TL → BL
      a_val = v_tl; b_val = v_bl;
      ax = bounds.x + j * cw; ay = bounds.y + i * ch;
      bx = bounds.x + j * cw; by = bounds.y + (i + 1) * ch;
      break;
    default:
      return null;
  }

  const denom = b_val - a_val;
  let ratio: number;
  if (Math.abs(denom) < 1e-14) {
    ratio = 0.5;
  } else {
    ratio = (t - a_val) / denom;
  }
  ratio = Math.max(0, Math.min(1, ratio));
  return {
    x: ax + ratio * (bx - ax),
    y: ay + ratio * (by - ay),
  };
}

// ==================== CONTOUR TRACING ====================

function traceContours(segments: LineSegment[]): Polyline[] {
  if (segments.length === 0) return [];

  // Build adjacency: endpoint → segment indices
  const eps = 1e-6;
  function key(p: Point): string {
    return Math.round(p.x / eps) * eps + "," + Math.round(p.y / eps) * eps;
  }

  const pointToSegs = new Map<string, number[]>();
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si];
    for (const p of [s.start, s.end]) {
      const k = key(p);
      const arr = pointToSegs.get(k) || [];
      arr.push(si);
      pointToSegs.set(k, arr);
    }
  }

  // Walk connected components
  const visited = new Array(segments.length).fill(false);
  const polylines: Polyline[] = [];

  for (let si = 0; si < segments.length; si++) {
    if (visited[si]) continue;

    // Start a new polyline
    const points: Point[] = [];
    let currentSeg = si;
    let currentEnd = segments[si].end;

    points.push(segments[si].start);
    points.push(segments[si].end);
    visited[si] = true;

    // Walk forward
    let extended = true;
    while (extended) {
      extended = false;
      const k = key(currentEnd);
      const candidates = pointToSegs.get(k) || [];
      for (const ci of candidates) {
        if (visited[ci]) continue;
        const s = segments[ci];
        // Orient correctly
        const sk = key(s.start);
        if (sk === k) {
          points.push(s.end);
          currentEnd = s.end;
        } else {
          points.push(s.start);
          currentEnd = s.start;
        }
        visited[ci] = true;
        extended = true;
        break;
      }
    }

    // Check if closed
    let closed = false;
    if (points.length >= 3) {
      const d = dist(points[0], points[points.length - 1]);
      // Closed if endpoints are very close relative to polyline extent
      const extent = polylineExtent(points);
      if (d < extent * 0.01 + 1e-6) {
        closed = true;
        // Snap last point to first
        points[points.length - 1] = { x: points[0].x, y: points[0].y };
      }
    }

    polylines.push({ points, closed });
  }

  return polylines;
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function polylineExtent(points: Point[]): number {
  if (points.length < 2) return 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(maxX - minX, maxY - minY, 1);
}

// ==================== POLYLINE CLEANUP ====================

function deduplicatePoints(
  points: Point[],
  closed: boolean,
  minDist: number
): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (result.length === 0 || dist(points[i], result[result.length - 1]) > minDist) {
      result.push({ x: points[i].x, y: points[i].y });
    }
  }
  if (result.length < 2) return points.slice(); // keep at least 2

  // For closed polylines, merge last into first if they're very close
  if (closed && result.length > 2) {
    if (dist(result[0], result[result.length - 1]) < minDist) {
      result.pop();
    }
  }
  return result;
}

// ==================== POLYLINE SIMPLIFICATION ====================

// Ramer-Douglas-Peucker — reduces vertices while preserving shape.
// Eliminates the grid-quantised noise that causes Catmull-Rom oscillations.
function simplifyPolyline(
  points: Point[],
  closed: boolean,
  epsilon: number
): Point[] {
  if (points.length <= 2) return points;

  if (closed) {
    // Split the closed loop into two open chains at the farthest pair,
    // simplify each, then rejoin.
    let maxD = 0, maxI = 0;
    for (let i = 1; i < points.length; i++) {
      const d = distSq(points[0], points[i]);
      if (d > maxD) { maxD = d; maxI = i; }
    }

    const chain1 = points.slice(0, maxI + 1);
    const chain2 = points.slice(maxI).concat([points[0]]);

    const simp1 = rdpRecursive(chain1, 0, chain1.length - 1, epsilon);
    const simp2 = rdpRecursive(chain2, 0, chain2.length - 1, epsilon);

    // Merge, skipping the duplicate seam points
    const result = [...simp1];
    for (let i = 1; i < simp2.length - 1; i++) {
      result.push(simp2[i]);
    }
    return result;
  }

  return rdpRecursive(points, 0, points.length - 1, epsilon);
}

function distSq(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function rdpRecursive(
  points: Point[],
  start: number,
  end: number,
  epsilon: number
): Point[] {
  if (end - start <= 1) {
    return [points[start], points[end]];
  }

  let maxDist = 0, maxIdx = start;
  const dx = points[end].x - points[start].x;
  const dy = points[end].y - points[start].y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-14) {
    // Degenerate segment — use perpendicular distance from origin
    for (let i = start + 1; i < end; i++) {
      const d = distSq(points[i], points[start]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
  } else {
    const invLen = 1 / Math.sqrt(lenSq);
    for (let i = start + 1; i < end; i++) {
      // Perpendicular distance from point i to line start→end
      const cross = Math.abs(
        (points[i].x - points[start].x) * dy -
        (points[i].y - points[start].y) * dx
      );
      const d = cross * invLen;
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
  }

  if (maxDist <= epsilon) {
    return [points[start], points[end]];
  }

  const left = rdpRecursive(points, start, maxIdx, epsilon);
  const right = rdpRecursive(points, maxIdx, end, epsilon);

  // Merge, skipping the shared middle point
  const result = left.slice(0, -1).concat(right);
  return result;
}

// ==================== CURVATURE JITTER FILTER ====================

// After RDP, grid-quantised zigzag patterns may survive in dense regions.
// Instead of a blunt angle threshold, this version detects the *pattern*:
// jitter alternates turn direction (+ - + -), while a genuine curve keeps
// a consistent direction (++++ or ----). Only points whose turn direction
// flips relative to BOTH neighbours are candidates, and even then only if
// skipping them yields a straighter trajectory.
function filterJitter(
  points: Point[],
  closed: boolean,
  minAngleDeg: number
): Point[] {
  const n = points.length;
  if (n <= 3) return points;

  // ---- pass 1: compute signed turn direction & magnitude for every interior point ----
  const dirs: number[] = new Array(n).fill(0);   // +1 left, -1 right, 0 straight
  const minRad = (minAngleDeg * Math.PI) / 180;

  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;

    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const d1x = curr.x - prev.x;
    const d1y = curr.y - prev.y;
    const d2x = next.x - curr.x;
    const d2y = next.y - curr.y;

    const cross = d1x * d2y - d1y * d2x;
    const dot = d1x * d2x + d1y * d2y;
    const mag = Math.abs(Math.atan2(cross, dot));

    if (mag >= minRad) {
      dirs[i] = cross > 0 ? 1 : -1;
    }
  }

  // ---- pass 2: flag zigzag pivots ----
  // A point is a zigzag pivot when its direction is opposite BOTH neighbours'
  // directions (isolated flip). Points on a consistent curve will share the
  // same direction with at least one neighbour → never flagged.
  const remove = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    if (dirs[i] === 0) continue;                      // turn too small to matter

    const prevDir = dirs[(i - 1 + n) % n];
    const nextDir = dirs[(i + 1) % n];

    // Isolated flip: my sign opposes BOTH neighbours (and both are non-zero)
    if (
      prevDir !== 0 && prevDir === -dirs[i] &&
      nextDir !== 0 && nextDir === -dirs[i]
    ) {
      // Confirm: would skipping this point yield a gentler trajectory?
      const prev = points[(i - 1 + n) % n];
      const curr = points[i];
      const next = points[(i + 1) % n];

      const dInX = curr.x - prev.x;
      const dInY = curr.y - prev.y;
      const dOutX = next.x - curr.x;
      const dOutY = next.y - curr.y;
      const lenIn = Math.sqrt(dInX * dInX + dInY * dInY);
      const lenOut = Math.sqrt(dOutX * dOutX + dOutY * dOutY);
      if (lenIn < 1e-12 || lenOut < 1e-12) continue;

      const dSkipX = next.x - prev.x;
      const dSkipY = next.y - prev.y;
      const lenSkip = Math.sqrt(dSkipX * dSkipX + dSkipY * dSkipY);
      if (lenSkip < 1e-12) continue;

      // cos(turn) with current point  vs  cos without it
      const cosTurn = (dInX * dOutX + dInY * dOutY) / (lenIn * lenOut);
      const cosSkip = (dInX * dSkipX + dInY * dSkipY) / (lenIn * lenSkip);

      if (cosSkip > cosTurn) {
        remove[i] = true;
      }
    }
  }

  return points.filter((_, i) => !remove[i]);
}

// ==================== SMOOTHING ====================

function computeTangents(
  points: Point[],
  closed: boolean,
  tension: number,
  curvatureGain: number = 0
): Point[] {
  const m = points.length;
  if (m < 2) return points.map(() => ({ x: 0, y: 0 }));

  const tangents: Point[] = [];

  for (let i = 0; i < m; i++) {
    let tx: number, ty: number;

    if (closed) {
      const prev = points[(i - 1 + m) % m];
      const next = points[(i + 1) % m];
      tx = (next.x - prev.x) / 2;
      ty = (next.y - prev.y) / 2;
    } else {
      if (i === 0) {
        // Forward difference
        tx = points[1].x - points[0].x;
        ty = points[1].y - points[0].y;
      } else if (i === m - 1) {
        // Backward difference
        tx = points[m - 1].x - points[m - 2].x;
        ty = points[m - 1].y - points[m - 2].y;
      } else {
        // Central difference
        tx = (points[i + 1].x - points[i - 1].x) / 2;
        ty = (points[i + 1].y - points[i - 1].y) / 2;
      }
    }

    tangents.push({ x: tx * tension, y: ty * tension });
  }

  // Curvature amplification: at high-curvature points, lengthen tangents
  // so the Catmull-Rom spline bends further with fewer control points.
  // Uses ANGLE_AND_LENGTH mirroring — both handles scale together.
  if (curvatureGain > 0) {
    const refAngle = (20 * Math.PI) / 180; // 20° reference for "moderate" curvature

    for (let i = 0; i < m; i++) {
      if (!closed && (i === 0 || i === m - 1)) continue;

      const prev = points[(i - 1 + m) % m];
      const curr = points[i];
      const next = points[(i + 1) % m];

      const d1x = curr.x - prev.x;
      const d1y = curr.y - prev.y;
      const d2x = next.x - curr.x;
      const d2y = next.y - curr.y;

      const cross = d1x * d2y - d1y * d2x;
      const dot = d1x * d2x + d1y * d2y;
      const turnAngle = Math.abs(Math.atan2(cross, dot));

      if (turnAngle > 0.001) {
        const gain = 1 + (turnAngle / refAngle) * curvatureGain;
        tangents[i].x *= gain;
        tangents[i].y *= gain;
      }
    }
  }

  return tangents;
}

// ==================== VECTOR NETWORK ====================

function buildVectorNetwork(
  points: Point[],
  tangents: Point[],
  closed: boolean
): VectorNetwork {
  const m = points.length;
  if (m < 2) {
    return {
      vertices: points.map((p) => ({
        x: p.x,
        y: p.y,
        handleMirroring: "ANGLE_AND_LENGTH" as HandleMirroring,
      })),
      segments: [],
      regions: [],
    };
  }

  const vertices: VectorVertex[] = points.map((p) => ({
    x: p.x,
    y: p.y,
    handleMirroring: "ANGLE_AND_LENGTH" as HandleMirroring,
  }));

  const segments: VectorSegment[] = [];
  const segCount = closed ? m : m - 1;

  for (let i = 0; i < segCount; i++) {
    const next = closed ? (i + 1) % m : i + 1;
    const tStart = tangents[i];
    const tEnd = tangents[next];

    segments.push({
      start: i,
      end: next,
      tangentStart: {
        x: tStart.x,
        y: tStart.y,
      },
      tangentEnd: {
        x: -tEnd.x,
        y: -tEnd.y,
      },
    });
  }

  return { vertices, segments, regions: [] };
}

// ==================== MAIN PIPELINE ====================

async function generateContours(
  node: SceneNode,
  params: {
    levels: number;
    bias: number;
    smoothing: number;
    strokeWidth: number;
    strokeColor: string;
    resolution: number;
  }
) {
  // --- Phase 1: Extract scalar field ---
  sendProgress("正在提取明度场...", 5);
  const field = await extractScalarField(node, params.resolution);

  // --- Phase 2: Compute thresholds ---
  sendProgress("正在计算阈值分布...", 15);

  // Compute field brightness range for diagnostics
  let vmin = 1, vmax = 0;
  for (let r = 0; r < field.height; r++) {
    for (let c = 0; c < field.width; c++) {
      const v = field.data[r][c];
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
  }

  const thresholds = computeThresholds(field, params.levels, params.bias);
  if (thresholds.length === 0) {
    throw new Error(
      `未找到有效的等高线阈值（明度范围: ${vmin.toFixed(3)}–${vmax.toFixed(3)}，` +
      `请减小密度偏向值或增大等高线层数）`
    );
  }

  // --- Phase 3: Marching squares for each threshold ---
  const allPolylines: { threshold: number; polylines: Polyline[] }[] = [];

  for (let ti = 0; ti < thresholds.length; ti++) {
    const t = thresholds[ti];
    const pct = 15 + ((ti / thresholds.length) * 45);
    sendProgress(
      `正在计算等高线 ${ti + 1}/${thresholds.length}...`,
      Math.round(pct)
    );

    const segments = marchingSquares(field, t);
    const polylines = traceContours(segments);

    // Filter out noise: polylines too short relative to the field size
    const minLen = Math.max(0.5, Math.min(field.bounds.width, field.bounds.height) * 0.001);
    const filtered = polylines.filter((pl) => {
      if (pl.points.length < 2) return false;
      if (pl.points.length === 2) {
        return dist(pl.points[0], pl.points[1]) > minLen;
      }
      return true;
    });

    if (filtered.length > 0) {
      allPolylines.push({ threshold: t, polylines: filtered });
    }
  }

  // --- Phase 4: Build VectorNodes ---
  sendProgress("正在创建平滑矢量曲线...", 65);

  const hexToRgb = (hex: string): RGB => {
    hex = hex.replace("#", "");
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255,
    };
  };

  const strokeColor = hexToRgb(params.strokeColor);
  const allVectorNodes: VectorNode[] = [];

  // RDP epsilon: half a grid cell — simplifies away quantisation noise
  // without losing real detail
  const cellW = field.bounds.width / (field.width - 1);
  const cellH = field.bounds.height / (field.height - 1);
  const simplifyEpsilon = Math.min(cellW, cellH) * 0.5;

  for (let li = 0; li < allPolylines.length; li++) {
    const { threshold, polylines } = allPolylines[li];
    const pct = 65 + ((li / allPolylines.length) * 25);
    sendProgress(
      `正在生成矢量图层 ${li + 1}/${allPolylines.length}...`,
      Math.round(pct)
    );

    // Separate closed and open contours
    const closedList = polylines.filter((p) => p.closed);
    const openList = polylines.filter((p) => !p.closed);

    const levelNodes: VectorNode[] = [];

    for (const pl of [...closedList, ...openList]) {
      // Deduplicate before smoothing — ensures points[] and tangents[] align
      const cleanPts = deduplicatePoints(pl.points, pl.closed, 0.01);
      if (cleanPts.length < 2) continue;

      // RDP simplification: remove grid-quantised collinear points that
      // cause Catmull-Rom oscillations (Runge phenomenon)
      const simplePts = simplifyPolyline(cleanPts, pl.closed, simplifyEpsilon);
      if (simplePts.length < 2) continue;

      // Curvature jitter filter: detect zigzag direction flips (isolated
      // +-+ or -+- patterns). Ignores turns < 8° (too straight to matter)
      // and never touches points on a consistent curve.
      const smoothPts = filterJitter(simplePts, pl.closed, 8);
      if (smoothPts.length < 2) continue;

      const tangents = computeTangents(smoothPts, pl.closed, params.smoothing, 0.5);
      const network = buildVectorNetwork(smoothPts, tangents, pl.closed);

      if (network.segments.length === 0) continue;

      const vec = figma.createVector();
      await vec.setVectorNetworkAsync(network);
      vec.handleMirroring = "ANGLE_AND_LENGTH";
      vec.fills = [];
      vec.strokes = [{ type: "SOLID", color: strokeColor }];
      vec.strokeWeight = params.strokeWidth;
      vec.strokeCap = "ROUND";
      vec.strokeJoin = "ROUND";
      vec.name = `L${li + 1}_${pl.closed ? "closed" : "open"}`;

      levelNodes.push(vec);
      allVectorNodes.push(vec);
    }
  }

  if (allVectorNodes.length === 0) {
    throw new Error(
      `未生成任何等高线（${thresholds.length} 个阈值，明度范围 ${vmin.toFixed(3)}–${vmax.toFixed(3)}），` +
      `请尝试减小平滑度或增大采样精度`
    );
  }

  // --- Phase 5: Grouping ---
  sendProgress("正在编组...", 92);

  // Group all vectors
  const rootGroup = figma.group(allVectorNodes, figma.currentPage);
  rootGroup.name = "Contour Lines";

  // Center view on the result
  figma.currentPage.selection = [rootGroup];
  figma.viewport.scrollAndZoomIntoView([rootGroup]);

  sendProgress("完成", 100);
}

function sendProgress(message: string, percent: number) {
  figma.ui.postMessage({ type: "progress", message, percent });
}

// ==================== UI HANDLING ====================

figma.showUI(__html__, { width: 300, height: 520, themeColors: true });

// Notify UI of initial selection
function notifySelection() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    figma.ui.postMessage({
      type: "selection-changed",
      nodeName: null,
      nodeType: null,
    });
  } else {
    figma.ui.postMessage({
      type: "selection-changed",
      nodeName: sel[0].name,
      nodeType: sel[0].type,
    });
  }
}
notifySelection();

figma.on("selectionchange", () => {
  notifySelection();
});

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === "generate") {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      figma.ui.postMessage({
        type: "error",
        message: "请先选择一个含有灰度填充的图层",
      });
      return;
    }

    try {
      // Process first selected node for now
      await generateContours(sel[0], msg.params);
      figma.ui.postMessage({
        type: "complete",
        message: `已生成 ${msg.params.levels} 层等高线`,
      });
    } catch (e: any) {
      figma.ui.postMessage({
        type: "error",
        message: e.message || "生成失败",
      });
    }
  }

  if (msg.type === "image-decoded") {
    if (decodePromise) {
      decodePromise.resolve(msg.brightness);
      decodePromise = null;
    }
  }

  if (msg.type === "image-decode-error") {
    if (decodePromise) {
      decodePromise.reject(new Error(msg.message));
      decodePromise = null;
    }
  }
};
