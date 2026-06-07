# Contour Line — Figma 等高线生成插件

将 Figma 中的灰度图（位图、渐变填充、纯色填充）转换为平滑矢量等高线的插件。基于 Marching Squares 算法 + Catmull-Rom 样条平滑。

## 功能

- 支持**位图填充**、**渐变填充**（线性/径向/角度/菱形）、**纯色填充**
- **暗部密度偏向**：亮度越低的区域等高线越密，可调节偏向强度
- 使用 `handleMirroring: ANGLE_AND_LENGTH` 生成**绝对平滑**的矢量曲线
- 闭合曲线和非闭合边界曲线自动分层编组
- 所有等高线输出为仅描边、无填充的 VectorNode，方便后续编辑

## 安装与使用

1. 克隆仓库
   ```bash
   git clone https://github.com/saikastxy/contour-line.git
   cd contour-line
   ```

2. 安装依赖并编译
   ```bash
   npm install
   npm run build
   ```

3. 在 Figma 桌面端加载
   - 打开 Figma → Plugins → Development → Import plugin from manifest…
   - 选择项目目录中的 `manifest.json`

4. 使用
   - 选中一个含有灰度填充的图层
   - 运行插件：Plugins → Contour Line
   - 调节参数后点击「生成等高线」

## 参数说明

| 参数 | 范围 | 默认值 | 说明 |
|------|------|--------|------|
| 等高线层数 | 5–200 | 50 | 生成的等高线总条数 |
| 暗部密度偏向 | 0–3 | 1.0 | 0=均匀分布，值越大暗部等高线越密集 |
| 平滑度 | 0–0.6 | 0.33 | 0=折线，0.33=自然平滑，0.6=极度圆滑 |
| 描边宽度 | 0.5–5 | 1 | 等高线描边粗细 |
| 描边颜色 | — | #000000 | 等高线颜色 |
| 采样精度 | 50–500 | 200 | 采样网格分辨率，越高细节越多但速度越慢 |

## 技术原理

1. **明度场提取**：从 Figma 填充（Solid / Gradient / Image）中采样二维明度（亮度）数组
2. **阈值选取**：按 `weight(b) = (1-b)^p` 加权分位分配，暗部阈值更密集
3. **Marching Squares**：标准 16-case 查找表，鞍点 ambiguity 用中心值判定
4. **等值线追踪**：基于端点邻接的连通分量提取
5. **Catmull-Rom 平滑**：计算顶点切线，转 Bézier 控制点
6. **VectorNetwork 生成**：`handleMirroring: ANGLE_AND_LENGTH` 确保 C1 连续平滑曲线

## 项目结构

```
contour-line/
├── manifest.json    # Figma 插件清单
├── code.ts          # 主逻辑（Figma API 访问）
├── ui.html          # 插件 UI
├── package.json
└── tsconfig.json
```

## License

MIT
