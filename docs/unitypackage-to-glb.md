# Unity Package → GLB 处理流程

把 Unity 动画包（`*.unitypackage`）转换成单一 GLB（角色 + 全部动画）的完整流程。

---

## 已完成的样本

| 包 | 输入 | 输出 |
|---|---|---|
| `Unity Assets Survival Animations v1.0.unitypackage` | 138 fbx | `Android_WithAllAnims.glb` (26 MB / 89 anim) + 28 个 props |
| `Human Mega Animations Pack 2.0.unitypackage` | 1311 fbx | `HumanF_WithAllAnims.glb` (32 MB / 631 anim) + `HumanM_WithAllAnims.glb` (31 MB / 630 anim) + 49 个 props |

---

## 工具位置

| 工具 | 路径 | 用途 |
|---|---|---|
| **FBX2glTF.exe** | `D:\GodotProjects\千术之王\tools\FBX2glTF.exe` | FBX → GLB 转换器（外部二进制）|
| `batch-fbx2gltf.ts` | `D:\projects\3d便携查看器\scripts\batch-fbx2gltf.ts` | 并发批量调用 FBX2glTF |
| `merge-glb.ts` | `D:\projects\3d便携查看器\scripts\merge-glb.ts` | 把多个动画 GLB retarget 合并到一个 mesh GLB（按节点名严格匹配）|
| `concat-glb.ts` | `D:\projects\3d便携查看器\scripts\concat-glb.ts` | 多 GLB 并列拼接（不 retarget，可加网格布局）|
| `bundle-props.ts` | `D:\projects\3d便携查看器\scripts\bundle-props.ts` | 自动归类动画到 mesh，每物体一个 GLB |
| `inspect-glb.ts` | `D:\projects\3d便携查看器\scripts\inspect-glb.ts` | three.js 解析 GLB 的诊断报告 |
| `verify-glb-anims.ts` | `D:\projects\3d便携查看器\scripts\verify-glb-anims.ts` | 验证动画 clip 数 / duration / track 数 |

---

## 完整流程（Survival 风格：单角色 + 多动画 + 道具分包）

### 1. 解 unitypackage

unitypackage 实际是 gzipped tar，结构：每个 asset 在一个 GUID 目录里，有 `asset` (实际文件) + `pathname` (原路径)。

```powershell
$pkg = "D:\path\to\package.unitypackage"
$work = "D:\output\extracted"
$rawDir = "$work\_raw"
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null
tar -xzf $pkg -C $rawDir
```

### 2. 还原原始路径结构

**关键：pathname 文件末尾有 `\n00` 特殊后缀，要 split 取第一行**

```powershell
$assetsDir = "$work\unityassets"
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

Get-ChildItem $rawDir -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'pathname'
    $a = Join-Path $_.FullName 'asset'
    if ((Test-Path $p) -and (Test-Path $a)) {
        $raw = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
        $rel = ($raw -split "`n")[0].Trim()
        if ($rel) {
            $dest = Join-Path $assetsDir $rel
            $dd = Split-Path $dest -Parent
            if (-not (Test-Path $dd)) { New-Item -ItemType Directory -Force -Path $dd | Out-Null }
            Copy-Item -LiteralPath $a -Destination $dest -Force
        }
    }
}
```

### 3. 批量 FBX → GLB

```bash
bun scripts/batch-fbx2gltf.ts "<unityassets_dir>" \
    -o "<glb_out_dir>" \
    --tool "D:\GodotProjects\千术之王\tools\FBX2glTF.exe" \
    -j 16 \
    --skip-existing
```

**性能参考**：32 核 CPU 跑 16 路并发，**1311 个 fbx 仅 10 秒**。

`batch-fbx2gltf.ts` 自动：
- 递归扫描所有 `*.fbx`
- 计算公共前缀，输出保留相对子目录结构
- 自动 mkdir，进度条，失败列表写到 `_failed.txt`

### 4. 识别 mesh 和动画文件

通过 `inspect-glb.ts` 扫描产物：
- **mesh 文件**：`meshes` 数组非空（含 `*_Model.glb` / `*_SkelMesh.glb` 等）
- **动画文件**：`animations` 数组非空但 `meshes` 为空
- **道具 mesh**：`*_Mesh.glb` 之类纯网格

按命名约定快速分类（不同包命名不同）：
- Survival 包：`Android_SkeletalMesh.glb` 是角色，`Survival_*.glb` 都是动画，`*_Mesh.glb` 都是道具
- Human Mega 包：`HumanF_Model.glb` / `HumanM_Model.glb` 是角色，`Animations/Female/*` 和 `Animations/Male/*` 是动画，`Unity Demo Scenes/**/*.glb` 是道具

### 5. 合并角色 + 动画 → `<Character>_WithAllAnims.glb`

写 list 文件然后调用 `merge-glb.ts`：

```powershell
$animList = "$env:TEMP\_anims.txt"
Get-ChildItem "$glbDir\Animations\Female" -Recurse -Filter *.glb |
    Select-Object -ExpandProperty FullName | Out-File $animList -Encoding utf8

bun scripts/merge-glb.ts `
    --mesh "$glbDir\Models\HumanF_Model.glb" `
    --anim-list $animList `
    -o "$work\HumanF_WithAllAnims.glb"
```

`merge-glb.ts` 按节点名严格匹配 retarget。每个动画输出 `clips X, channels Y/Y` —— Y/Y 表示 100% 匹配。

### 6. 处理道具

- **纯 mesh 道具（无 anim）**：直接复制到 `propanim/`
- **道具 + 道具动画混合**：用 `bundle-props.ts` 自动归类

```bash
bun scripts/bundle-props.ts --input-list <list.txt> -o <propanim_dir>
```

`bundle-props.ts` 算法：
1. 文件名前缀优先（`<X>__Prop_*.glb` → `<X>_SkelMesh.glb`）
2. 节点名交集打分，平分时倾向节点更少的"基础 mesh"

### 7. 验证

```bash
bun scripts/verify-glb-anims.ts <output.glb>
```

输出示例：
```
scene name : Root_Scene
meshes     : 1
skinnedMeshes: 1 (bones=52)
animations : 631
first 5    :
  - HumanF@Attack1H01_L | duration=1.083s | tracks=101
  ...
```

### 8. 清理中间产物

```powershell
Remove-Item "$work\_raw" -Recurse -Force
Remove-Item "$work\unityassets" -Recurse -Force
Remove-Item "$work\glb" -Recurse -Force
```

最终目录只留：
```
<work>/
├── characteranim/      # 角色 + 全动画 GLB
└── propanim/           # 道具 GLB
```

---

## 已知坑 / 注意事项

### unitypackage 解包

- **pathname 末尾有 `\n00`**：必须 split `\n` 取 [0]，否则文件名带 trailing `00` 全部失败
- **大包**：解包后体积通常是原 unitypackage 的 **3-4 倍**（Human Mega Pack 292 MB → 解出 918 MB）

### FBX2glTF

- 输出参数 `-o` **不带后缀**，加 `-b` 输出 `.glb`
- 默认 30 fps 烘焙动画；可用 `--anim-framerate bake60`
- 单线程，所以批量必须并发

### merge-glb.ts retarget

- 仅按 **node name 字符串严格匹配**，骨骼名不一致就丢失 channel
- channels X/Y 显示 X<Y 时，说明有 channel 找不到对应骨骼（动画会缺帧或扭曲）
- **bind pose 假设一致**：如果 mesh 的初始骨骼姿势 ≠ 动画的初始姿势，retarget 后角色会扭曲（虽然 channels 显示 100% 匹配）。Kevin Iglesias Human 包就有这个问题（见下文）

### Unity humanoid 系统

Kevin Iglesias 包用了 Unity humanoid 重定向系统，FBX 里：
- 动画 fbx 的骨骼初始 transform 不一定跟 mesh fbx 一致
- 通过 Unity humanoid 抽象时不会有问题，但导出原生 FBX 后骨骼初始姿势对不上
- 表现：腿/手乱飞、抽搐、IK 区域明显错位

**修复方向**（待实现）：
1. **以 mesh 为准重新计算 channel 值**：动画 channel 写入前减去动画 fbx 的 bind pose 偏移，加上 mesh 的 bind pose
2. **用 Mixamo 风格 retarget 库**：解析 humanoid mapping，把抽象 muscle 重新写为骨骼空间
3. **简单 workaround**：用动画 fbx 自带的角色 mesh（如果有）而不是单独的 mesh fbx

---

## 命令一键脚本（PowerShell 模板）

```powershell
# 配置
$pkg = "D:\path\to\package.unitypackage"
$work = "D:\path\to\package_extracted"
$tool = "D:\GodotProjects\千术之王\tools\FBX2glTF.exe"
$viewer = "D:\projects\3d便携查看器"

# 1. 解包
$rawDir = "$work\_raw"
$assetsDir = "$work\unityassets"
$glbDir = "$work\glb"
New-Item -ItemType Directory -Force -Path $rawDir, $assetsDir | Out-Null
tar -xzf $pkg -C $rawDir

# 2. 还原路径
Get-ChildItem $rawDir -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'pathname'
    $a = Join-Path $_.FullName 'asset'
    if ((Test-Path $p) -and (Test-Path $a)) {
        $rel = ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) -split "`n")[0].Trim()
        if ($rel) {
            $dest = Join-Path $assetsDir $rel
            $dd = Split-Path $dest -Parent
            if (-not (Test-Path $dd)) { New-Item -ItemType Directory -Force -Path $dd | Out-Null }
            Copy-Item -LiteralPath $a -Destination $dest -Force
        }
    }
}

# 3. 批量转 fbx → glb
Push-Location $viewer
bun scripts/batch-fbx2gltf.ts $assetsDir -o $glbDir --tool $tool -j 16 --skip-existing
Pop-Location

# 4. 找 mesh + anim（手动调整）
# 5. 合并
$mesh = "$glbDir\path\to\Mesh.glb"
$animList = "$env:TEMP\_anims.txt"
Get-ChildItem "$glbDir\anims" -Recurse -Filter *.glb |
    Select-Object -ExpandProperty FullName | Out-File $animList -Encoding utf8
Push-Location $viewer
bun scripts/merge-glb.ts --mesh $mesh --anim-list $animList -o "$work\Output_WithAllAnims.glb"
Pop-Location

# 6. 验证
Push-Location $viewer
bun scripts/verify-glb-anims.ts "$work\Output_WithAllAnims.glb"
Pop-Location
```

---

## 性能基准

| 操作 | Survival (138 fbx) | Human Mega (1311 fbx) |
|---|---|---|
| 解包 | < 5s | 5.2s |
| 路径还原 | < 5s | 5.2s |
| FBX → GLB（16 路并发）| < 5s | **10.1s** |
| merge-glb 单角色 | < 10s | 30-40s |
| 输出体积 | 26 MB | 31-32 MB / 角色 |

---

## 后续可优化

- [ ] 写一个 `unitypackage-to-glb.ts` 一键脚本封装全流程
- [ ] `merge-glb.ts` 加 `--rebind-pose` 选项处理 bind pose 不一致问题
- [ ] 自动识别 mesh / anim glb（基于 inspect 结果）
- [ ] 支持从 unitypackage 直接读，不落盘（节省 2GB 磁盘）
