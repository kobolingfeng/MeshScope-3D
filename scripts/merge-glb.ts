/// <reference types="bun-types" />
// merge-glb.ts — 把多个 GLB 动画文件合并到一个 mesh GLB 上
//
// 用途：处理 Unity 拆分打包风格的 glTF 资产
//   - mesh.glb：含 mesh + skin（无 animations）
//   - anim*.glb：仅含 animations + 同名骨骼 nodes（无 mesh）
//
// 行为：把所有 anim 文件中的 AnimationClip retarget 到 mesh 的骨骼上
// （按节点 name 字符串严格匹配），并重写 accessor / bufferView / buffer 偏移，
// 输出一个含全部动画的 mesh.glb。
//
// 用法：
//   bun scripts/merge-glb.ts --mesh <mesh.glb> --anim <anim.glb|glob> [更多 --anim ...] -o <output.glb>
//   bun scripts/merge-glb.ts --mesh <mesh.glb> --anim-list <list.txt> -o <output.glb>
// 示例：
//   bun scripts/merge-glb.ts \
//     --mesh "D:\models\Android_SkeletalMesh.glb" \
//     --anim "D:\models\Survival_*.glb" \
//     -o "D:\models\Android_WithAllAnims.glb"

import { Glob } from 'bun';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { resolve, basename, extname, dirname, isAbsolute } from 'path';
import { argv } from 'process';

// ---------- GLB types (subset) ----------

type GltfBuffer = { byteLength: number; uri?: string };
type GltfBufferView = {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
    name?: string;
};
type GltfAccessor = {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    max?: number[];
    min?: number[];
    sparse?: {
        count: number;
        indices: { bufferView: number; byteOffset?: number; componentType: number };
        values: { bufferView: number; byteOffset?: number };
    };
    name?: string;
};
type GltfNode = { name?: string };
type GltfAnimSampler = { input: number; output: number; interpolation?: string };
type GltfAnimChannel = { sampler: number; target: { node?: number; path: string } };
type GltfAnimation = { name?: string; samplers: GltfAnimSampler[]; channels: GltfAnimChannel[] };

type GltfRoot = {
    asset?: { version?: string; generator?: string };
    buffers?: GltfBuffer[];
    bufferViews?: GltfBufferView[];
    accessors?: GltfAccessor[];
    nodes?: GltfNode[];
    animations?: GltfAnimation[];
    [key: string]: unknown;
};

type ParsedGlb = {
    json: GltfRoot;
    bin: Uint8Array; // 合并后的所有 buffer 数据，已按各 buffer 顺序拼接
};

// ---------- CLI 参数解析 ----------

type CliArgs = {
    meshPath: string;
    animPatterns: string[];
    outputPath: string;
    verbose: boolean;
};

function parseArgs(args: string[]): CliArgs {
    const meshArgs: string[] = [];
    const animArgs: string[] = [];
    let animListFile: string | undefined;
    let outputPath = '';
    let verbose = false;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--mesh') {
            const value = args[++i];
            if (!value) throw new Error('--mesh 需要一个路径参数');
            meshArgs.push(value);
        } else if (arg === '--anim') {
            const value = args[++i];
            if (!value) throw new Error('--anim 需要一个路径参数');
            animArgs.push(value);
        } else if (arg === '--anim-list') {
            const value = args[++i];
            if (!value) throw new Error('--anim-list 需要一个路径参数');
            animListFile = value;
        } else if (arg === '-o' || arg === '--output') {
            const value = args[++i];
            if (!value) throw new Error('-o 需要一个路径参数');
            outputPath = value;
        } else if (arg === '-v' || arg === '--verbose') {
            verbose = true;
        } else if (arg === '-h' || arg === '--help') {
            printUsage();
            process.exit(0);
        } else {
            throw new Error(`未识别的参数: ${arg}`);
        }
    }

    if (animListFile) {
        const text = readFileSync(animListFile, 'utf8') as string;
        for (const line of text.split(/\r?\n/u)) {
            const trimmed = line.trim();
            if (trimmed.length > 0 && !trimmed.startsWith('#')) animArgs.push(trimmed);
        }
    }

    if (meshArgs.length !== 1) throw new Error('需要恰好一个 --mesh');
    if (animArgs.length === 0) throw new Error('需要至少一个 --anim 或 --anim-list');
    if (!outputPath) throw new Error('需要 -o 输出路径');

    return {
        meshPath: meshArgs[0],
        animPatterns: animArgs,
        outputPath,
        verbose,
    };
}

function printUsage(): void {
    console.log(`merge-glb — 把动画 retarget 合并到 mesh GLB

用法：
  bun scripts/merge-glb.ts --mesh <mesh.glb> --anim <pattern> [--anim ...] -o <output.glb> [-v]

参数：
  --mesh <path>      含 mesh + skin 的 GLB 文件（必须）
  --anim <pattern>   含动画的 GLB（支持 glob，如 "dir/Survival_*.glb"，可重复）
  -o, --output <p>   输出 GLB 路径
  -v, --verbose      打印每个 channel retarget 详情
  -h, --help         显示帮助

示例：
  bun scripts/merge-glb.ts \\
    --mesh "Android_SkeletalMesh.glb" \\
    --anim "Survival_*.glb" \\
    -o "Android_WithAllAnims.glb"
`);
}

// ---------- glob 展开 ----------

async function expandPatterns(patterns: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const pattern of patterns) {
        const absolute = isAbsolute(pattern) ? pattern : resolve(pattern);
        // 如果是具体文件就直接用
        try {
            const stat = statSync(absolute);
            if (stat.isFile()) {
                if (!seen.has(absolute)) {
                    seen.add(absolute);
                    result.push(absolute);
                }
                continue;
            }
        } catch {
            // 不是直接路径，按 glob 处理
        }

        const dir = dirname(absolute);
        const filePattern = basename(absolute);
        const glob = new Glob(filePattern);
        for await (const name of glob.scan({ cwd: dir, absolute: true, onlyFiles: true })) {
            if (!seen.has(name)) {
                seen.add(name);
                result.push(name);
            }
        }
    }

    result.sort();
    return result;
}

// ---------- GLB 二进制读写 ----------

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

function parseGlb(filePath: string): ParsedGlb {
    const data = readFileSync(filePath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const magic = view.getUint32(0, true);
    if (magic !== GLB_MAGIC) throw new Error(`${filePath}: 不是合法的 GLB（magic=0x${magic.toString(16)}）`);
    const version = view.getUint32(4, true);
    if (version !== 2) throw new Error(`${filePath}: 仅支持 GLB v2，得到 v${version}`);
    const totalLength = view.getUint32(8, true);
    if (totalLength > data.byteLength) {
        throw new Error(`${filePath}: 声明长度 ${totalLength} > 文件大小 ${data.byteLength}`);
    }

    let cursor = 12;
    let json: GltfRoot | null = null;
    let bin: Uint8Array | null = null;

    while (cursor < totalLength) {
        const chunkLen = view.getUint32(cursor, true);
        const chunkType = view.getUint32(cursor + 4, true);
        const dataStart = cursor + 8;
        const dataEnd = dataStart + chunkLen;
        if (dataEnd > totalLength) {
            throw new Error(`${filePath}: chunk 越界（${dataEnd} > ${totalLength}）`);
        }

        if (chunkType === CHUNK_TYPE_JSON) {
            const text = new TextDecoder('utf-8').decode(data.subarray(dataStart, dataEnd));
            json = JSON.parse(text) as GltfRoot;
        } else if (chunkType === CHUNK_TYPE_BIN) {
            bin = data.subarray(dataStart, dataEnd);
        }

        cursor = dataEnd;
    }

    if (!json) throw new Error(`${filePath}: 缺少 JSON chunk`);

    // 拼接所有 buffer 的数据。GLB 通常只有一个内嵌 buffer（uri 缺失），其余有 uri 的 buffer 我们暂不支持外部加载。
    if (!bin) bin = new Uint8Array(0);
    if (json.buffers && json.buffers.length > 0) {
        const firstBuffer = json.buffers[0];
        if (!firstBuffer.uri) {
            // 内嵌 GLB buffer，对应整个 BIN chunk 头部
            if (bin.byteLength < firstBuffer.byteLength) {
                throw new Error(`${filePath}: BIN chunk (${bin.byteLength}) 小于 buffer 声明长度 (${firstBuffer.byteLength})`);
            }
        }
        for (let i = 1; i < json.buffers.length; i += 1) {
            if (!json.buffers[i].uri) {
                throw new Error(`${filePath}: 含多个内嵌 buffer，目前不支持`);
            }
        }
    }

    return { json, bin };
}

function encodeGlb(json: GltfRoot, bin: Uint8Array): Uint8Array {
    const jsonText = JSON.stringify(json);
    const jsonBytes = new TextEncoder().encode(jsonText);
    const jsonPadLen = (4 - (jsonBytes.byteLength % 4)) % 4;
    const jsonChunkLen = jsonBytes.byteLength + jsonPadLen;

    const binPadLen = (4 - (bin.byteLength % 4)) % 4;
    const binChunkLen = bin.byteLength + binPadLen;

    const totalLength = 12 + 8 + jsonChunkLen + (binChunkLen > 0 ? 8 + binChunkLen : 0);
    const out = new Uint8Array(totalLength);
    const view = new DataView(out.buffer);

    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalLength, true);

    view.setUint32(12, jsonChunkLen, true);
    view.setUint32(16, CHUNK_TYPE_JSON, true);
    out.set(jsonBytes, 20);
    for (let i = 0; i < jsonPadLen; i += 1) {
        out[20 + jsonBytes.byteLength + i] = 0x20; // 空格填充
    }

    if (binChunkLen > 0) {
        const binStart = 20 + jsonChunkLen;
        view.setUint32(binStart, binChunkLen, true);
        view.setUint32(binStart + 4, CHUNK_TYPE_BIN, true);
        out.set(bin, binStart + 8);
        // padding 已经默认为 0，符合 BIN chunk 规范
    }

    return out;
}

// ---------- 合并核心 ----------

type MergeStats = {
    sourceFile: string;
    clipsTaken: number;
    channelsTaken: number;
    channelsDropped: number;
    droppedNodes: Set<string>;
};

function mergeAnimationGlb(
    target: ParsedGlb,
    source: ParsedGlb,
    sourcePath: string,
    verbose: boolean,
): MergeStats {
    const stats: MergeStats = {
        sourceFile: basename(sourcePath),
        clipsTaken: 0,
        channelsTaken: 0,
        channelsDropped: 0,
        droppedNodes: new Set(),
    };

    if (!source.json.animations || source.json.animations.length === 0) {
        return stats;
    }

    target.json.buffers = target.json.buffers ?? [{ byteLength: 0 }];
    target.json.bufferViews = target.json.bufferViews ?? [];
    target.json.accessors = target.json.accessors ?? [];
    target.json.animations = target.json.animations ?? [];
    target.json.nodes = target.json.nodes ?? [];

    // 1. 建立 mesh 端 node name → index
    const nameToTargetNode = new Map<string, number>();
    target.json.nodes.forEach((node, index) => {
        if (node.name) nameToTargetNode.set(node.name, index);
    });

    // 2. 计算 source bin 在 target bin 中的偏移（4 字节对齐）
    const targetBuffer = target.json.buffers[0];
    const targetBinAlignedLen = alignTo4(targetBuffer.byteLength);
    const srcBinAlignedLen = alignTo4(source.bin.byteLength);
    const newTargetBinLen = targetBinAlignedLen + source.bin.byteLength;

    // 3. 把 source 的 bufferViews 重写到 target 末尾
    const srcBufferViews = source.json.bufferViews ?? [];
    const bufferViewIndexOffset = target.json.bufferViews.length;
    for (const view of srcBufferViews) {
        if (view.buffer !== 0) {
            throw new Error(`${sourcePath}: bufferView 引用 buffer ${view.buffer}，目前仅支持 buffer 0`);
        }
        const newView: GltfBufferView = {
            ...view,
            buffer: 0,
            byteOffset: (view.byteOffset ?? 0) + targetBinAlignedLen,
        };
        target.json.bufferViews.push(newView);
    }

    // 4. 把 source 的 accessors 重写
    const srcAccessors = source.json.accessors ?? [];
    const accessorIndexOffset = target.json.accessors.length;
    for (const accessor of srcAccessors) {
        const newAccessor: GltfAccessor = { ...accessor };
        if (typeof newAccessor.bufferView === 'number') {
            newAccessor.bufferView = newAccessor.bufferView + bufferViewIndexOffset;
        }
        if (newAccessor.sparse) {
            newAccessor.sparse = {
                count: newAccessor.sparse.count,
                indices: {
                    ...newAccessor.sparse.indices,
                    bufferView: newAccessor.sparse.indices.bufferView + bufferViewIndexOffset,
                },
                values: {
                    ...newAccessor.sparse.values,
                    bufferView: newAccessor.sparse.values.bufferView + bufferViewIndexOffset,
                },
            };
        }
        target.json.accessors.push(newAccessor);
    }

    // 5. 处理每个 animation：retarget channel.target.node + 重写 sampler 索引
    const srcNodes = source.json.nodes ?? [];
    let clipIndexInFile = 0;
    for (const animation of source.json.animations) {
        const newSamplers: GltfAnimSampler[] = animation.samplers.map((sampler) => ({
            ...sampler,
            input: sampler.input + accessorIndexOffset,
            output: sampler.output + accessorIndexOffset,
        }));

        const newChannels: GltfAnimChannel[] = [];
        for (const channel of animation.channels) {
            const srcNodeIdx = channel.target.node;
            if (typeof srcNodeIdx !== 'number') {
                stats.channelsDropped += 1;
                continue;
            }
            const srcNode = srcNodes[srcNodeIdx];
            const srcName = srcNode?.name;
            if (!srcName) {
                stats.channelsDropped += 1;
                continue;
            }
            const targetIdx = nameToTargetNode.get(srcName);
            if (typeof targetIdx !== 'number') {
                stats.channelsDropped += 1;
                stats.droppedNodes.add(srcName);
                continue;
            }
            newChannels.push({
                sampler: channel.sampler,
                target: { node: targetIdx, path: channel.target.path },
            });
            stats.channelsTaken += 1;
            if (verbose) {
                console.log(`    [${srcName}.${channel.target.path}] src#${srcNodeIdx} → dst#${targetIdx}`);
            }
        }

        if (newChannels.length === 0) {
            // 全部 channel 都没匹配，跳过该 clip
            continue;
        }

        // 用文件名作为 clip 名（更直观）
        const fileBase = basename(sourcePath, extname(sourcePath));
        const suffix = (source.json.animations.length > 1) ? `_${clipIndexInFile}` : '';
        const newName = `${fileBase}${suffix}`;

        target.json.animations.push({
            name: newName,
            samplers: newSamplers,
            channels: newChannels,
        });
        stats.clipsTaken += 1;
        clipIndexInFile += 1;
    }

    // 6. 拼接 bin。即便没有 clip 命中，源 bin 已被 bufferViews 引用，删除它会破坏其他引用。
    // 但我们没把 bufferViews/accessors 撤回，这里简单做：保留 source 数据。
    // 后续可以做引用清理来减小文件。
    const newBin = new Uint8Array(newTargetBinLen);
    newBin.set(target.bin, 0);
    // 中间填充字节（4 对齐）保持为 0
    newBin.set(source.bin, targetBinAlignedLen);
    target.bin = newBin;
    targetBuffer.byteLength = newTargetBinLen;

    return stats;
}

function alignTo4(n: number): number {
    return (n + 3) & ~3;
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
    let cli: CliArgs;
    try {
        cli = parseArgs(argv.slice(2));
    } catch (error) {
        console.error(`参数错误：${(error as Error).message}\n`);
        printUsage();
        process.exit(2);
        return;
    }

    const meshPath = resolve(cli.meshPath);
    console.log(`📥 读取 mesh: ${meshPath}`);
    const target = parseGlb(meshPath);

    if (!target.json.nodes || target.json.nodes.length === 0) {
        console.warn('⚠️  mesh 中没有 nodes，retarget 将无法匹配任何骨骼');
    }

    const animPaths = await expandPatterns(cli.animPatterns);
    if (animPaths.length === 0) {
        console.error('❌ --anim 没有匹配到任何文件');
        process.exit(2);
    }
    // 如果用户的 anim 模式恰好包含了 mesh 文件本身，剔除避免自合并
    const filteredAnimPaths = animPaths.filter((p) => resolve(p) !== meshPath);
    console.log(`📥 找到 ${filteredAnimPaths.length} 个动画文件`);

    const allStats: MergeStats[] = [];
    let processed = 0;
    for (const animPath of filteredAnimPaths) {
        processed += 1;
        try {
            const source = parseGlb(animPath);
            if (!source.json.animations || source.json.animations.length === 0) {
                console.log(`  [${processed}/${filteredAnimPaths.length}] ${basename(animPath)} — 跳过（无动画）`);
                continue;
            }
            const stats = mergeAnimationGlb(target, source, animPath, cli.verbose);
            allStats.push(stats);
            console.log(`  [${processed}/${filteredAnimPaths.length}] ${basename(animPath)} — clips ${stats.clipsTaken}, channels ${stats.channelsTaken}/${stats.channelsTaken + stats.channelsDropped}`);
            if (stats.droppedNodes.size > 0 && cli.verbose) {
                console.log(`      丢弃节点: ${[...stats.droppedNodes].join(', ')}`);
            }
        } catch (error) {
            console.warn(`  [${processed}/${filteredAnimPaths.length}] ${basename(animPath)} — 失败: ${(error as Error).message}`);
        }
    }

    const totalClips = allStats.reduce((sum, s) => sum + s.clipsTaken, 0);
    const totalChannels = allStats.reduce((sum, s) => sum + s.channelsTaken, 0);

    if (totalClips === 0) {
        console.error('❌ 没有任何动画 clip 能 retarget 到 mesh，输出未生成');
        process.exit(1);
    }

    const outputPath = resolve(cli.outputPath);
    const outBytes = encodeGlb(target.json, target.bin);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, outBytes);

    console.log('');
    console.log(`✅ 合并完成`);
    console.log(`   clips: ${totalClips}`);
    console.log(`   channels: ${totalChannels}`);
    console.log(`   输出: ${outputPath}`);
    console.log(`   大小: ${(outBytes.byteLength / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
