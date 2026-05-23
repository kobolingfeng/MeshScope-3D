# 3D 便携查看器

极速超轻量 Windows 桌面 3D 模型查看器 + 简易网格编辑器。

基于 **[强强](https://linux.do)** 框架 (C++ Win32 + WebView2) + **Three.js** 构建，单 exe 分发，零依赖运行。

## 特性

- **支持格式**: GLTF / GLB / OBJ / STL / PLY / FBX
- **操作**:
  - 鼠标拖动 / 滚轮 / 右键 — OrbitControls 全套
  - 线框 / 网格 / 坐标轴 / 浅色背景切换
  - 自适应相机缩放（自动对焦到模型）
- **编辑**（浏览 / 顶点 / 面 / 边 四种模式）:
  - 点击选择 → Delete 删除
  - Ctrl+Z 撤销 / Ctrl+Y 重做 / Esc 取消选中
- **支持 .glb 单文件** 和 **.gltf + .bin + 贴图** 多文件同时拖入
- **启动 ~0.5s，单 exe < 3MB**（加上 WebView2 默认已在 Win10/11）

## 开发

### 前置

- [Bun](https://bun.sh)
- [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)（勾选"使用 C++ 的桌面开发"）

### 步骤

```bash
bun install
bun run setup         # 首次下载 WebView2 SDK + nlohmann/json
bun run build:native  # 编译一次 C++ 原生壳
bun run dev           # 热重载开发
```

### 构建单 exe 分发

```bash
bun run build:single  # 生成 dist/app.exe（含所有前端资源）
bun run package       # 打包成 release/3D 便携查看器-portable.zip
```

## 架构

```
├── native/          # 强强 C++ 原生壳（不改动）
├── src/
│   ├── main.ts      # 入口 + UI 布线
│   ├── viewer.ts    # Three.js 场景 / 相机 / OrbitControls
│   ├── loaders.ts   # 五格式动态加载（按需拆 chunk）
│   ├── editor.ts    # 拾取 / 选中 / 删除 / 撤销重做
│   ├── api.ts       # 强强 IPC 命令封装
│   ├── ipc.ts       # 强强 IPC 桥
│   └── style.css
├── index.html       # Vite 入口
├── vite.config.ts
├── app.config.json  # 强强窗口配置
└── scripts/         # 强强构建脚本
```

## 操作说明

| 动作 | 方法 |
|---|---|
| 打开模型 | 点击"打开模型"或拖拽文件到视口 |
| 旋转视角 | 左键拖动（浏览模式） |
| 缩放 | 滚轮 |
| 平移 | 右键拖动 |
| 选顶点 | 切到"顶点"模式，点击靠近顶点的位置 |
| 选面 | 切到"面"模式，点击三角面 |
| 选边 | 切到"边"模式，点击靠近边的位置 |
| 删除选中 | Delete 或 Backspace |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Y（或 Ctrl+Shift+Z） |

## 约束

- 目前不支持二进制文件的原生拖放（强强 IPC 只传字节串，二进制会损坏）。请**拖到视口内**（由 WebView 处理）或用"打开模型"按钮。
- 导出功能暂未实现（用户按需）。
- 非索引几何在删除顶点/边前会自动转为索引几何。

## License

MIT
