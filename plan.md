# 等高线 Figma 插件 — 实现方案

## 概述

将灰度图（位图填充、矢量纯色填充、矢量渐变填充）转换为平滑矢量等高线的 Figma 插件。使用 Marching Squares（行进方格）算法实现。明度越低的区域，等高线密度越高。

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Figma 插件                        │
│                                                      │
│  ┌──────────────┐       postMessage       ┌───────┐ │
│  │   code.ts    │◄────────────────────────►│ui.html│ │
│  │  (沙箱环境)   │                         │(iframe)│ │
│  │              │                         │       │ │
│  │ • 读取填充   │                         │ • 界面│ │
│  │ • 提取明度   │                         │ • 图片│ │
│  │ • 方格行进   │                         │   解码 │ │
│  │ • 曲线平滑   │                         │       │ │
│  │ • 生成矢量   │                         │       │ │
│  └──────────────┘                         └───────┘ │
└─────────────────────────────────────────────────────┘
```

## 数据流

1. **用户选中** 一个具有灰度填充的节点（IMAGE、SOLID 或 GRADIENT_*）
2. **UI 展示** 控制项：等高线数量、密度偏向、描边宽度、描边颜色等
3. **code.ts 读取** 选中节点的填充和几何信息
4. **明度场被提取** 为二维标量数组：
   - IMAGE 填充：原始字节 → UI 线程 Canvas API 解码 → 灰度像素
   - SOLID 填充：单一明度值 → 覆盖整个包围盒的均匀标量场
   - GRADIENT 填充：在网格点上通过渐变逆变换采样得到明度值
5. **Marching Squares** 在每个阈值上对明度场运行
6. **等值线被追踪** 为连通的折线（闭合和非闭合）
7. **平滑处理** 通过 Catmull-Rom 样条计算切线，生成平滑曲线
8. **生成 VectorNode**，设置 `vectorNetwork` 和 `handleMirroring: 'ANGLE_AND_LENGTH'`
9. **所有矢量被打入一个 GroupNode 中**

---

## 各模块详述

### 1. 明度场提取

**明度公式（感知亮度）：**
```
L = 0.299*r + 0.587*g + 0.114*b   （sRGB 值，0–1 范围）
```

**采样网格分辨率：** 以长边为基准，`min(300, max(图像宽, 图像高))` 格，保持宽高比。用户可在 UI 中手动调节。

**位图填充流程：**
1. 读取 `node.fills` → 找到 `ImagePaint` → 获取 `imageHash`
2. `figma.getImageByHash(hash)` → `image.getBytesAsync()` → `Uint8Array`
3. 将原始字节通过 postMessage 发往 UI 线程 → Canvas `drawImage` + `getImageData` 解码
4. 逐像素提取明度 → 将二维数组发回主线程

**纯色填充流程：**
```
fill.color → {r, g, b} → 明度 → 填充为均匀二维数组
```

**渐变填充流程（支持 linear / radial / angular / diamond 四种类型）：**
1. 读取 `fill.gradientTransform`（二维仿射矩阵 `[[a,b,tx],[c,d,ty]]`）
2. 读取 `fill.gradientStops`（`{color, position}` 数组）
3. 对对象空间中每个网格点 (px, py)：
   - 通过逆 transform 映射到渐变空间坐标 (gx, gy)
   - LINEAR（线性）：position = gx（沿渐变方向 0→1）
   - RADIAL（径向）：position = 到 (0.5, 0.5) 的距离 × 2
   - ANGULAR（角度）：position = atan2(gy-0.5, gx-0.5) / (2π) + 0.5
   - DIAMOND（菱形）：position = |gx-0.5| + |gy-0.5|
   - 在相邻 stop 之间做颜色插值 → 得到颜色 → 计算明度
4. 填充二维明度数组

### 2. 阈值选取（密度偏向）

给定等高线总数 N 和明度范围 B ∈ [B_min, B_max]：

**密度函数：** `weight(b) = (1 - b)^p`，其中 `p ≥ 0` 控制暗部偏向力度。
- `p = 0`：均匀分布（等间距阈值）
- `p = 1`：线性偏向暗部（默认推荐值）
- `p = 2`：强偏向暗部
- 用户可在 UI 中调节

**构造方法：**
```
CDF(b) = ∫_Bmin^b weight(t) dt / ∫_Bmin^Bmax weight(t) dt
```

阈值取该 CDF 在 N+1 等间距分位上的值（去掉最小和最大端）。这确保在明度低的区域阈值间距更小、等高线更密。

### 3. Marching Squares 算法

对每个阈值 `t`：

1. 对明度场中每个 2×2 单元格：
   - 读取四个角的值：v00, v10, v11, v01
   - 判断每个角在阈值之上 (1) 还是之下 (0)
   - 构成 4 位 case 索引 (0–15)
   - case 0 或 15：该格内无等值线经过
   - 其他 case：通过线性插值计算等值线与格边的交点
   - 记录线段及其格位置和 case

2. 追踪连通线段为折线：
   - 从线段端点构建邻接关系
   - 遍历连通分量，形成有序点列表
   - 判断闭合（首 ≈ 尾）或非闭合

**格边上的线性插值：**
```
对值分别为 v_a 和 v_b 的两个角之间的边：
  ratio = (t - v_a) / (v_b - v_a)
  point = corner_a_pos + ratio * (corner_b_pos - corner_a_pos)
```

每个 case 对应的线段配置参考标准 Marching Squares 查找表（共 16 种）。

### 4. 平滑处理（Catmull-Rom → VectorNetwork）

对每条折线 `[p0, p1, ..., pn]`：

**切线计算（Catmull-Rom）：**
```
闭合曲线：
  t_i = (p_{(i+1)%n} - p_{(i-1+n)%n}) / 2

非闭合曲线：
  t_0   = p_1 - p_0           （起点用前向差分）
  t_n   = p_n - p_{n-1}       （终点用后向差分）
  t_i   = (p_{i+1} - p_{i-1}) / 2   （内部点用中心差分）
```

**切线缩放（用于 Bézier 控制点）：**
引入张力系数 α（默认 0.33，用户可调）：
```
缩放后切线：t'_i = t_i * α
```

**VectorNetwork 构造（闭合曲线示例，m 个唯一点）：**
```typescript
const network: VectorNetwork = {
  vertices: points.map(p => ({ x: p.x, y: p.y })),
  segments: [],
  regions: []  // 无填充，仅描边
};

for (let i = 0; i < m; i++) {
  const next = (i + 1) % m;
  network.segments.push({
    start: i,
    end: next,
    tangentStart: {
      x: points[i].x + tangents[i].x,
      y: points[i].y + tangents[i].y
    },
    tangentEnd: {
      x: points[next].x - tangents[next].x,
      y: points[next].y - tangents[next].y
    }
  });
}
```

非闭合曲线同理，最后一个点无出边。

**`handleMirroring: 'ANGLE_AND_LENGTH'`** 作用于每个 VectorNode，确保所有顶点处以 C1 连续的平滑曲线通过。

### 5. VectorNode 生成与编组

```
GroupNode "Contour Lines"
├── GroupNode "Level 1 (明度 ≈ 0.12)"
│   ├── GroupNode "闭合曲线"
│   │   ├── VectorNode (闭合等高线 1)
│   │   └── VectorNode (闭合等高线 2)
│   └── GroupNode "非闭合曲线"
│       ├── VectorNode (开放等高线 1)
│       └── VectorNode (开放等高线 2)
├── GroupNode "Level 2 (明度 ≈ 0.25)"
│   └── ...
└── GroupNode "Level N (明度 ≈ 0.88)"
```

每个 VectorNode：
- `fills: []`（无填充）
- `strokes: [{ type: 'SOLID', color: 用户选择的描边颜色 }]`
- `strokeWeight: 用户选择的线宽`（默认 1）
- `handleMirroring: 'ANGLE_AND_LENGTH'`

### 6. UI 设计

```
┌──────────────────────────────────┐
│  Contour Line Generator          │
│                                  │
│  选中节点：[Rectangle 1 / 无]    │
│                                  │
│  等高线层数：[_______50______]   │
│  （生成的等高线总条数）           │
│                                  │
│  密度偏向：[_______1.0______]    │
│  （0=均匀, 1=暗部密集, 2=极暗部密集）
│                                  │
│  平滑度：[_______0.33______]    │
│  （0=折线, 0.33=自然平滑, 1=极度圆滑）
│                                  │
│  描边宽度：[_______1________]    │
│                                  │
│  描边颜色：[■ #000000]          │
│                                  │
│  网格精度：[______300_______]    │
│  （采样分辨率，影响细节和性能）    │
│                                  │
│  [ 生成等高线 ]                  │
│                                  │
│  状态：就绪                      │
└──────────────────────────────────┘
```

UI 通过 `parent.postMessage({ pluginMessage: msg }, '*')` 与 code.ts 通信。

---

## 文件结构

```
contour line/
├── manifest.json          # 插件清单（添加 "ui": "ui.html"）
├── code.ts                # 主逻辑
│   ├── 明度提取（image/solid/gradient → 2D 数组）
│   ├── 阈值计算（密度偏向分配）
│   ├── Marching Squares 算法
│   ├── 等值线追踪（连通分量）
│   ├── 平滑处理（Catmull-Rom → VectorNetwork）
│   ├── VectorNode 创建与编组
│   └── UI 消息处理
├── ui.html                # 插件 UI（HTML + CSS + 内联 JS）
├── package.json
├── tsconfig.json
└── eslint.config.js
```

---

## 实施阶段

### 第一阶段：基础骨架
1. 更新 `manifest.json`，添加 `"ui": "ui.html"`
2. 构建 `ui.html`，完成所有控件和消息通信
3. 实现 SOLID 纯色填充的明度提取（最简单场景）

### 第二阶段：核心算法
4. 实现 Marching Squares 算法
5. 实现等值线追踪（连通分量检测）
6. 实现 Catmull-Rom 平滑 + VectorNetwork 生成
7. 实现密度偏向的阈值选取

### 第三阶段：各种填充类型支持
8. 实现渐变填充采样（全部四种渐变类型）
9. 实现位图填充提取（通过 UI 线程 Canvas 解码）

### 第四阶段：集成联调
10. 贯通完整管线：选择节点 → 明度场 → 阈值 → Marching Squares → 平滑 → VectorNodes
11. 实现编组层级结构
12. 加入进度反馈到 UI
13. 处理边界情况：无选中、多节点选中、非灰度内容

### 第五阶段：打磨
14. 用各种节点类型和填充配置进行测试
15. 优化网格精度与性能的平衡
16. 错误处理与用户提示

---

## 关键 Figma API 参考

- `VectorNode.handleMirroring` — `'NONE' | 'ANGLE' | 'ANGLE_AND_LENGTH'`
- `VectorNode.vectorNetwork` — `{ vertices, segments, regions }`
- `VectorNode.setVectorNetworkAsync()` — 异步写入矢量网络
- `VectorNetwork.vertices` — `VectorVertex[]`，包含 `{x, y, handleMirroring?, strokeCap?, strokeJoin?}`
- `VectorNetwork.segments` — `VectorSegment[]`，包含 `{start, end, tangentStart, tangentEnd}`
- `figma.createVector()` — 创建空 VectorNode
- `figma.group(nodes, parent)` — 节点编组
- `figma.getImageByHash(hash)` — 通过 hash 获取图像
- `Image.getBytesAsync()` — 获取图像原始字节
- `node.fills` — `ReadonlyArray<Paint>`，类型包括 `SOLID`、`GRADIENT_LINEAR`、`GRADIENT_RADIAL`、`GRADIENT_ANGULAR`、`GRADIENT_DIAMOND`、`IMAGE`
- `GradientPaint.gradientTransform` — 2×3 仿射矩阵
- `GradientPaint.gradientStops` — `{color: RGBA, position: number}[]`
- `figma.ui.onmessage` / `figma.ui.postMessage` — UI 双向通信
- `figma.showUI(__html__, options)` — 显示插件 UI

---

## 已做出的设计决策

1. **位图解码策略**：在 UI 线程（Canvas API）解码 vs. 主线程实现 PNG 解码器。**决策：UI 线程** — 更简单，利用浏览器原生能力，避免在插件沙箱中手写复杂解码器。

2. **多节点选中**：每个选中节点独立生成等高线 vs. 合并处理。**决策：独立处理**，每个选中节点各自生成一组等高线。

3. **渐变采样精度**：根据节点大小自动计算（1x 缩放下每设备像素 1 个采样格），限制在 [50, 500] 范围内。**决策：用户可在 UI 中手动调节，默认使用自动值**。

4. **描边颜色**：使用原图颜色？黑色？用户自选？**决策：UI 中可配置，默认根据填充内容自动采样一个代表色**。

5. **等值线段合并策略**：相邻单元格中等值线段的连通性通过端点位置容差判断（容差 = 1e-6），确保浮点精度下的正确合并。
