"use strict";
// ============================================================
// Contour Line — Figma Plugin
// Converts grayscale fills to smooth vector contour lines
// using Marching Squares + Catmull-Rom smoothing.
// ============================================================
// ==================== BRIGHTNESS ====================
function rgbToBrightness(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}
function colorToBrightness(c) {
    return rgbToBrightness(c.r, c.g, c.b);
}
// ==================== SCALAR FIELD EXTRACTION ====================
async function extractScalarField(node, resolution) {
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
    const fill = fills[0];
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
function getNodeBounds(node) {
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
function extractSolid(bounds, fill, cols, rows) {
    const b = colorToBrightness(fill.color);
    const data = [];
    for (let r = 0; r < rows; r++) {
        const line = new Array(cols).fill(b);
        data.push(line);
    }
    return { data, width: cols, height: rows, bounds };
}
// Common path for all non-solid fills (IMAGE, GRADIENT_*):
// Export the node to PNG via Figma's own renderer, then decode in the UI
// thread to extract a per-pixel brightness field. This guarantees correct
// colors for every fill type without manual gradient/transform math.
async function extractRasterField(bounds, cols, rows, node) {
    const exportScale = Math.max(0.5, Math.min(2, (Math.max(cols, rows) * 2) / Math.max(bounds.width, bounds.height)));
    const pngBytes = await node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: exportScale },
    });
    const brightness = await decodePngInUI(pngBytes, cols, rows);
    const data = [];
    for (let r = 0; r < rows; r++) {
        data.push(brightness.slice(r * cols, (r + 1) * cols));
    }
    return { data, width: cols, height: rows, bounds };
}
// Round-trip to UI thread for PNG decode + bilinear sampling
let decodePromise = null;
function decodePngInUI(bytes, cols, rows) {
    return new Promise((resolve, reject) => {
        decodePromise = { resolve, reject };
        figma.ui.postMessage({ type: "decode-image", bytes, cols, rows });
    });
}
// ==================== THRESHOLD SELECTION ====================
function computeThresholds(field, count, bias) {
    // Flatten, find min/max
    const values = [];
    let vmin = 1, vmax = 0;
    for (let r = 0; r < field.height; r++) {
        for (let c = 0; c < field.width; c++) {
            const v = field.data[r][c];
            values.push(v);
            if (v < vmin)
                vmin = v;
            if (v > vmax)
                vmax = v;
        }
    }
    if (vmax - vmin < 0.001) {
        // Near-uniform field — evenly spaced
        const ts = [];
        for (let i = 1; i <= count; i++) {
            ts.push(vmin + (i / (count + 1)) * (vmax - vmin));
        }
        return ts;
    }
    // Sort values for weighted quantile computation
    values.sort((a, b) => a - b);
    // Weight function: w(v) = (1 - v)^bias
    // Compute cumulative weight
    const cumWeights = [];
    let total = 0;
    for (const v of values) {
        total += Math.pow(1 - v, bias);
        cumWeights.push(total);
    }
    // Pick thresholds at equally-spaced cumulative weight positions
    const thresholds = [];
    for (let i = 1; i <= count; i++) {
        const target = (i / (count + 1)) * total;
        // Binary search for the value at this cumulative weight
        let lo = 0, hi = values.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumWeights[mid] < target)
                lo = mid + 1;
            else
                hi = mid;
        }
        thresholds.push(values[lo]);
    }
    // Deduplicate (remove thresholds that are too close)
    const deduped = [];
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
const SQUARES_TABLE = {
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
function marchingSquares(field, threshold) {
    const segments = [];
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
            if (v_tl < threshold)
                caseIdx |= 1;
            if (v_tr < threshold)
                caseIdx |= 2;
            if (v_br < threshold)
                caseIdx |= 4;
            if (v_bl < threshold)
                caseIdx |= 8;
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
                }
                else {
                    // Default pairs from table
                    pairs = SQUARES_TABLE[caseIdx];
                }
            }
            for (const [e0, e1] of pairs) {
                const p0 = edgePoint(e0, i, j, v_tl, v_tr, v_br, v_bl, threshold, bounds, cw, ch);
                const p1 = edgePoint(e1, i, j, v_tl, v_tr, v_br, v_bl, threshold, bounds, cw, ch);
                if (p0 && p1) {
                    segments.push({ start: p0, end: p1 });
                }
            }
        }
    }
    return segments;
}
function edgePoint(edge, i, j, v_tl, v_tr, v_br, v_bl, t, bounds, cw, ch) {
    let a_val, b_val;
    let ax, ay, bx, by;
    switch (edge) {
        case 0: // top: TL → TR
            a_val = v_tl;
            b_val = v_tr;
            ax = bounds.x + j * cw;
            ay = bounds.y + i * ch;
            bx = bounds.x + (j + 1) * cw;
            by = bounds.y + i * ch;
            break;
        case 1: // right: TR → BR
            a_val = v_tr;
            b_val = v_br;
            ax = bounds.x + (j + 1) * cw;
            ay = bounds.y + i * ch;
            bx = bounds.x + (j + 1) * cw;
            by = bounds.y + (i + 1) * ch;
            break;
        case 2: // bottom: BL → BR
            a_val = v_bl;
            b_val = v_br;
            ax = bounds.x + j * cw;
            ay = bounds.y + (i + 1) * ch;
            bx = bounds.x + (j + 1) * cw;
            by = bounds.y + (i + 1) * ch;
            break;
        case 3: // left: TL → BL
            a_val = v_tl;
            b_val = v_bl;
            ax = bounds.x + j * cw;
            ay = bounds.y + i * ch;
            bx = bounds.x + j * cw;
            by = bounds.y + (i + 1) * ch;
            break;
        default:
            return null;
    }
    const denom = b_val - a_val;
    let ratio;
    if (Math.abs(denom) < 1e-14) {
        ratio = 0.5;
    }
    else {
        ratio = (t - a_val) / denom;
    }
    ratio = Math.max(0, Math.min(1, ratio));
    return {
        x: ax + ratio * (bx - ax),
        y: ay + ratio * (by - ay),
    };
}
// ==================== CONTOUR TRACING ====================
function traceContours(segments) {
    if (segments.length === 0)
        return [];
    // Build adjacency: endpoint → segment indices
    const eps = 1e-6;
    function key(p) {
        return Math.round(p.x / eps) * eps + "," + Math.round(p.y / eps) * eps;
    }
    const pointToSegs = new Map();
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
    const polylines = [];
    for (let si = 0; si < segments.length; si++) {
        if (visited[si])
            continue;
        // Start a new polyline
        const points = [];
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
                if (visited[ci])
                    continue;
                const s = segments[ci];
                // Orient correctly
                const sk = key(s.start);
                if (sk === k) {
                    points.push(s.end);
                    currentEnd = s.end;
                }
                else {
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
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
function polylineExtent(points) {
    if (points.length < 2)
        return 1;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX)
            minX = p.x;
        if (p.x > maxX)
            maxX = p.x;
        if (p.y < minY)
            minY = p.y;
        if (p.y > maxY)
            maxY = p.y;
    }
    return Math.max(maxX - minX, maxY - minY, 1);
}
// ==================== POLYLINE CLEANUP ====================
function deduplicatePoints(points, closed, minDist) {
    const result = [];
    for (let i = 0; i < points.length; i++) {
        if (result.length === 0 || dist(points[i], result[result.length - 1]) > minDist) {
            result.push({ x: points[i].x, y: points[i].y });
        }
    }
    if (result.length < 2)
        return points.slice(); // keep at least 2
    // For closed polylines, merge last into first if they're very close
    if (closed && result.length > 2) {
        if (dist(result[0], result[result.length - 1]) < minDist) {
            result.pop();
        }
    }
    return result;
}
// ==================== SMOOTHING ====================
function computeTangents(points, closed, tension) {
    const m = points.length;
    if (m < 2)
        return points.map(() => ({ x: 0, y: 0 }));
    const tangents = [];
    for (let i = 0; i < m; i++) {
        let tx, ty;
        if (closed) {
            const prev = points[(i - 1 + m) % m];
            const next = points[(i + 1) % m];
            tx = (next.x - prev.x) / 2;
            ty = (next.y - prev.y) / 2;
        }
        else {
            if (i === 0) {
                // Forward difference
                tx = points[1].x - points[0].x;
                ty = points[1].y - points[0].y;
            }
            else if (i === m - 1) {
                // Backward difference
                tx = points[m - 1].x - points[m - 2].x;
                ty = points[m - 1].y - points[m - 2].y;
            }
            else {
                // Central difference
                tx = (points[i + 1].x - points[i - 1].x) / 2;
                ty = (points[i + 1].y - points[i - 1].y) / 2;
            }
        }
        tangents.push({ x: tx * tension, y: ty * tension });
    }
    return tangents;
}
// ==================== VECTOR NETWORK ====================
function buildVectorNetwork(points, tangents, closed) {
    const m = points.length;
    if (m < 2) {
        return {
            vertices: points.map((p) => ({
                x: p.x,
                y: p.y,
                handleMirroring: "ANGLE_AND_LENGTH",
            })),
            segments: [],
            regions: [],
        };
    }
    const vertices = points.map((p) => ({
        x: p.x,
        y: p.y,
        handleMirroring: "ANGLE_AND_LENGTH",
    }));
    const segments = [];
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
async function generateContours(node, params) {
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
            if (v < vmin)
                vmin = v;
            if (v > vmax)
                vmax = v;
        }
    }
    const thresholds = computeThresholds(field, params.levels, params.bias);
    if (thresholds.length === 0) {
        throw new Error(`未找到有效的等高线阈值（明度范围: ${vmin.toFixed(3)}–${vmax.toFixed(3)}，` +
            `请减小密度偏向值或增大等高线层数）`);
    }
    // --- Phase 3: Marching squares for each threshold ---
    const allPolylines = [];
    for (let ti = 0; ti < thresholds.length; ti++) {
        const t = thresholds[ti];
        const pct = 15 + ((ti / thresholds.length) * 45);
        sendProgress(`正在计算等高线 ${ti + 1}/${thresholds.length}...`, Math.round(pct));
        const segments = marchingSquares(field, t);
        const polylines = traceContours(segments);
        // Filter out noise: polylines too short relative to the field size
        const minLen = Math.max(0.5, Math.min(field.bounds.width, field.bounds.height) * 0.001);
        const filtered = polylines.filter((pl) => {
            if (pl.points.length < 2)
                return false;
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
    const hexToRgb = (hex) => {
        hex = hex.replace("#", "");
        return {
            r: parseInt(hex.substring(0, 2), 16) / 255,
            g: parseInt(hex.substring(2, 4), 16) / 255,
            b: parseInt(hex.substring(4, 6), 16) / 255,
        };
    };
    const strokeColor = hexToRgb(params.strokeColor);
    const allVectorNodes = [];
    for (let li = 0; li < allPolylines.length; li++) {
        const { threshold, polylines } = allPolylines[li];
        const pct = 65 + ((li / allPolylines.length) * 25);
        sendProgress(`正在生成矢量图层 ${li + 1}/${allPolylines.length}...`, Math.round(pct));
        // Separate closed and open contours
        const closedList = polylines.filter((p) => p.closed);
        const openList = polylines.filter((p) => !p.closed);
        const levelNodes = [];
        for (const pl of [...closedList, ...openList]) {
            // Deduplicate before smoothing — ensures points[] and tangents[] align
            const cleanPts = deduplicatePoints(pl.points, pl.closed, 0.01);
            if (cleanPts.length < 2)
                continue;
            const tangents = computeTangents(cleanPts, pl.closed, params.smoothing);
            const network = buildVectorNetwork(cleanPts, tangents, pl.closed);
            if (network.segments.length === 0)
                continue;
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
        throw new Error(`未生成任何等高线（${thresholds.length} 个阈值，明度范围 ${vmin.toFixed(3)}–${vmax.toFixed(3)}），` +
            `请尝试减小平滑度或增大采样精度`);
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
function sendProgress(message, percent) {
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
    }
    else {
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
figma.ui.onmessage = async (msg) => {
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
        }
        catch (e) {
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
