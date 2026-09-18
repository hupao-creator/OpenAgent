# Bart 的液体玻璃本体

对应 issue #16。生产组件提供显式启用入口，不修改未启用的挂载点，也不引入 Lab 页面。

```tsx
import { BartLogo } from '../src/renderer/src/components/BartLogo'
import { BartLiquidStage } from '../src/renderer/src/liquid/BartLiquidStage'

<BartLiquidStage style={{ width: 640, height: 640 }} backdrop={<SceneBackground />}>
  <BartLogo size={640} bodyMaterial="liquidGlass" bodyColor="#10110f" eyeColor="#f7f5ee" />
</BartLiquidStage>
```

`backdrop` 必须是真实衬底；角色、眼睛和前景控件放在 `children`，不能一起捕获。单个舞台可以承载多个角色，共用一张 WebGPU 画布；没有舞台、没有捕获能力或画布失败时，单独指定 `bodyMaterial` 不会令实体本体消失。它不是从任意孤立 SVG 自动读取整页背景的接口。动态画布等不会产生 DOM mutation 的衬底，通过 `backdropRevision` 通知重采样。

颜色只接受 `#rrggbb`，非法值退回默认值。默认本体 `#10110f`、眼睛 `#f7f5ee`；颜色贯穿 SVG 与 Worker 2D 绘制。现有过程式 WebGL 转场模型未修改，继续使用原实体外观。更新颜色不重建角色、不重置弹簧和眨眼时钟。未提供 `bodyMaterial` 时仍为实体。

## 几何与光学

使用本体中心 `(320, 300)`、半径 `164`，而不是 SVG 视口中心。舞台通过 SVG 坐标矩阵映射到实际尺寸；圆形 Frame 为 `328×328`、`cornerRadius=164`、`cornerSmoothing=0`。非圆形、展开布局、干预态、非等比缩放、斜切、出界及独立淡入淡出期间保留实体，不能用一个错位的圆代替它们。

640 坐标系的配方是 `blur=8`、`bezelWidth=39`、`thickness=234`、`specularOpacity=0.6`、`shadowBlur=78`、`shadowOffsetY=23`、`tint.a=0.8`。长度项再乘实际显示比例，blur 与 alpha 不缩放。配方通过 memo 保持 tint 对象稳定。

玻璃是刚性圆，不跟随 36 点轮廓的局部弹性形变；启用时本体不画实体，角色层也不重复施加本体的 bob/squash 变换。眼睛、眨眼、状态点、轨道仍由原 Worker 时钟绘制。切回实体恢复原有形变。空间转场借出的角色使用实体本体，落座时重新采用目标座位的材质，避免把“允许不画本体”带到没有玻璃的飞行场景。

## 生命周期

`installLiquidCaptureCompat()` 在舞台模块初始化时执行；Electron 的 `CanvasDrawElement` 开关沿用已有入口。挂载异常由局部 boundary 捕获，帧异常由 `onError` 处理；失败撤销玻璃确认并恢复实体，不重挂前景业务子树。Worker 外观更新使用版本确认，旧的异步回复不能重新显露上一材质的画面。

舞台使用 `frameloop="demand"`；DOM/尺寸/状态/字体变化合并为一段 240ms 的刷新窗口，结束后无自建常驻循环，卸载会取消未执行帧和监听。这里只调度玻璃采样，不把角色逐帧积分搬回主线程。外部纯合成动画超过该窗口时应在其更新边界发出 `backdropRevision`，或在运动期间维持实体材质。

## 验证

新增 `bart-glass.test.tsx`、`bart-character-appearance.test.tsx`、`bart-liquid.test.tsx`：覆盖配方、颜色、圆形准入、坐标映射、刷新合并/停止、Worker 颜色/实体互斥、飞行回退、DOM 所有权、挂载抛错和能力缺失。完整类型检查与回归按仓库 `verify` 工作流执行。

这些测试引用 renderer/Canvas 类型，按仓库约定使用 `.test.tsx`，由继承 DOM 类型环境的 `tsconfig.tests.json` 检查；不能命名为 `.test.ts`，否则会被 `tsconfig.node.json` 的 `tests/**/*.ts` 收入并将浏览器依赖带进 Node 项目。扩展名不改变 Vitest 的测试发现或运行环境。

DOM mock 不能证明折射效果。视觉验收需在启用 CanvasDrawElement 的 Electron 中，分别检查亮/暗条纹衬底，待机、思考、工具中、完成、失败；切换黑色眼睛、禁用玻璃、移除 WebGPU 适配器；观察玻璃边缘折射、非圆形回退、真实空间转场和卸载后资源释放。本提交不将尚未执行的真机验收记作通过。
