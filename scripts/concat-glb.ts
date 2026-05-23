/// <reference types="bun-types" />
// concat-glb.ts — 把多个 GLB 拼接成单个 GLB
//
// 与 merge-glb.ts 的区别：
//   - merge-glb：把动画 retarget 到同一套骨骼上（要求 mesh 和 anim 共享骨骼名）
//   - concat-glb：保留各自原生骨骼/材质/动画，并列挂在同一个 scene 下
//
// 适用：合并互不兼容的多个 glb 为一个浏览方便的 prop 集合
//
// 用法：
//   bun scripts/concat-glb.ts <a.glb|glob>... -o <output.glb>

import { Glob } from 'bun';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { resolve, basename, extname, dirname, isAbsolute } from 'path';
import { argv } from 'process';

// ---------- GLB types ----------

type GltfBuffer = { byteLength: number; uri?: string };
type GltfBufferView = {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
    name?: string;
};
type GltfRoot = Record<string, any>;

type ParsedGlb = {
    json: GltfRoot;
    bin: Uint8Array;
};

// ---------- CLI ----------

type CliArgs = {
    inputs: string[];
    inputListFile?: string;
    outputPath: string;
    verbose: boolean;
    sceneName?: string;
    gridSpacing: number;
};

function parseArgs(args: string[]): CliArgs {
    const inputs: string[] = [];
    let inputListFile: string | undefined;
    let outputPath = '';
    let verbose = false;
    let sceneName: string | undefined;
    let gridSpacing = 0;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-o' || arg === '--output') {
            outputPath = args[++i] ?? '';
        } else if (arg === '--input-list') {
            inputListFile = args[++i];
        } else if (arg === '-v' || arg === '--verbose') {
            verbose = true;
        } else if (arg === '--scene-name') {
            sceneName = args[++i];
        } else if (arg === '--grid-spacing') {
            const value = parseFloat(args[++i] ?? '0');
            if (!Number.isFinite(value) || value < 0) throw new Error('--grid-spacing 需要正数');
            gridSpacing = value;
        } else if (arg === '-h' || arg === '--help') {
            printUsage();
            process.exit(0);
        } else if (arg.startsWith('-')) {
            throw new Error(`未知参数: ${arg}`);
        } else {
            inputs.push(arg);
        }
    }

    if (inputs.length === 0 && !inputListFile) throw new Error('需要至少一个输入文件，或者 --input-list');
    if (!outputPath) throw new Error('需要 -o 输出路径');

    return { inputs, inputListFile, outputPath, verbose, sceneName, gridSpacing };
}

function printUsage() {
    console.log(`concat-glb — 把多个 GLB 并列拼接成单个 GLB

用法：
  bun scripts/concat-glb.ts <input.glb|glob>... -o <output.glb> [-v]
  bun scripts/concat-glb.ts --input-list <list.txt> -o <output.glb>

参数：
  <input>           输入 GLB 路径或 glob（可重复）
  --input-list      文本文件，每行一个路径（绝对路径）
  -o, --output      输出 GLB 路径
  --scene-name      根 scene 名称（默认: Concat）
  --grid-spacing    每个源在 XZ 平面网格排开的间距（米，默认 0=全部叠在原点）
  -v, --verbose     详细输出
  -h, --help        显示帮助

示例：
  bun scripts/concat-glb.ts \\
    "props/*_Mesh.glb" \\
    "props/Prop_*.glb" \\
    -o "Survival_Props.glb"
`);
}

function readInputList(filePath: string): string[] {
    const text = readFileSync(filePath, 'utf8') as string;
    return text.split(/\r?\n/u).map((line: string) => line.trim()).filter((line: string) => line.length > 0 && !line.startsWith('#'));
}

async function expandPatterns(patterns: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const pattern of patterns) {
        const absolute = isAbsolute(pattern) ? pattern : resolve(pattern);
        try {
            const stat = statSync(absolute);
            if (stat.isFile()) {
                if (!seen.has(absolute)) {
                    seen.add(absolute);
                    result.push(absolute);
                }
                continue;
            }
        } catch {}

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

// ---------- GLB 二进制 ----------

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

function parseGlb(filePath: string): ParsedGlb {
    const data = readFileSync(filePath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error(`${filePath}: 不是合法 GLB`);
    if (view.getUint32(4, true) !== 2) throw new Error(`${filePath}: 仅支持 GLB v2`);
    const totalLength = view.getUint32(8, true);

    let cursor = 12;
    let json: GltfRoot | null = null;
    let bin = new Uint8Array(0);

    while (cursor < totalLength) {
        const chunkLen = view.getUint32(cursor, true);
        const chunkType = view.getUint32(cursor + 4, true);
        const dataStart = cursor + 8;
        const dataEnd = dataStart + chunkLen;

        if (chunkType === CHUNK_TYPE_JSON) {
            const text = new TextDecoder('utf-8').decode(data.subarray(dataStart, dataEnd));
            json = JSON.parse(text) as GltfRoot;
        } else if (chunkType === CHUNK_TYPE_BIN) {
            bin = data.subarray(dataStart, dataEnd);
        }
        cursor = dataEnd;
    }

    if (!json) throw new Error(`${filePath}: 缺少 JSON chunk`);

    if (json.buffers) {
        for (let i = 1; i < json.buffers.length; i += 1) {
            if (!json.buffers[i].uri) throw new Error(`${filePath}: 多个内嵌 buffer，目前不支持`);
        }
    }

    return { json, bin };
}

function encodeGlb(json: GltfRoot, bin: Uint8Array): Uint8Array {
    const jsonText = JSON.stringify(json);
    const jsonBytes = new TextEncoder().encode(jsonText);
    const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
    const jsonChunkLen = jsonBytes.byteLength + jsonPad;

    const binPad = (4 - (bin.byteLength % 4)) % 4;
    const binChunkLen = bin.byteLength + binPad;
    const hasBin = binChunkLen > 0;

    const totalLength = 12 + 8 + jsonChunkLen + (hasBin ? 8 + binChunkLen : 0);
    const out = new Uint8Array(totalLength);
    const view = new DataView(out.buffer);

    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalLength, true);

    view.setUint32(12, jsonChunkLen, true);
    view.setUint32(16, CHUNK_TYPE_JSON, true);
    out.set(jsonBytes, 20);
    for (let i = 0; i < jsonPad; i += 1) out[20 + jsonBytes.byteLength + i] = 0x20;

    if (hasBin) {
        const binStart = 20 + jsonChunkLen;
        view.setUint32(binStart, binChunkLen, true);
        view.setUint32(binStart + 4, CHUNK_TYPE_BIN, true);
        out.set(bin, binStart + 8);
    }

    return out;
}

function alignTo4(n: number): number {
    return (n + 3) & ~3;
}

// ---------- 索引偏移 + 拼接核心 ----------

type Offsets = {
    bufferView: number;
    accessor: number;
    material: number;
    mesh: number;
    skin: number;
    texture: number;
    image: number;
    sampler: number;
    node: number;
    camera: number;
};

type Placement = {
    wrapperName?: string;
    translation?: [number, number, number];
};

function concatInto(target: ParsedGlb, source: ParsedGlb, sourcePath: string, placement?: Placement): void {
    target.json.bufferViews ??= [];
    target.json.accessors ??= [];
    target.json.images ??= [];
    target.json.samplers ??= [];
    target.json.textures ??= [];
    target.json.materials ??= [];
    target.json.meshes ??= [];
    target.json.skins ??= [];
    target.json.nodes ??= [];
    target.json.animations ??= [];
    target.json.cameras ??= [];

    const offsets: Offsets = {
        bufferView: target.json.bufferViews.length,
        accessor: target.json.accessors.length,
        material: target.json.materials.length,
        mesh: target.json.meshes.length,
        skin: target.json.skins.length,
        texture: target.json.textures.length,
        image: target.json.images.length,
        sampler: target.json.samplers.length,
        node: target.json.nodes.length,
        camera: target.json.cameras.length,
    };

    // 1. BIN 拼接
    const targetBinAlignedLen = alignTo4(target.bin.byteLength);
    const newBin = new Uint8Array(targetBinAlignedLen + source.bin.byteLength);
    newBin.set(target.bin, 0);
    newBin.set(source.bin, targetBinAlignedLen);
    target.bin = newBin;

    // 2. bufferViews
    for (const view of (source.json.bufferViews ?? [])) {
        const v = view as GltfBufferView;
        if (v.buffer !== 0) throw new Error(`${sourcePath}: bufferView 引用 buffer ${v.buffer}，仅支持 0`);
        target.json.bufferViews.push({
            ...v,
            buffer: 0,
            byteOffset: (v.byteOffset ?? 0) + targetBinAlignedLen,
        });
    }

    // 3. accessors
    for (const accessor of (source.json.accessors ?? [])) {
        const a: any = { ...accessor };
        if (typeof a.bufferView === 'number') a.bufferView += offsets.bufferView;
        if (a.sparse) {
            a.sparse = {
                count: a.sparse.count,
                indices: { ...a.sparse.indices, bufferView: a.sparse.indices.bufferView + offsets.bufferView },
                values: { ...a.sparse.values, bufferView: a.sparse.values.bufferView + offsets.bufferView },
            };
        }
        target.json.accessors.push(a);
    }

    // 4. images
    for (const image of (source.json.images ?? [])) {
        const img: any = { ...image };
        if (typeof img.bufferView === 'number') img.bufferView += offsets.bufferView;
        target.json.images.push(img);
    }

    // 5. samplers
    for (const sampler of (source.json.samplers ?? [])) {
        target.json.samplers.push({ ...sampler });
    }

    // 6. textures
    for (const texture of (source.json.textures ?? [])) {
        const t: any = { ...texture };
        if (typeof t.source === 'number') t.source += offsets.image;
        if (typeof t.sampler === 'number') t.sampler += offsets.sampler;
        target.json.textures.push(t);
    }

    // 7. materials (深拷贝，处理标准 PBR + KHR 扩展中的纹理引用)
    for (const material of (source.json.materials ?? [])) {
        const m = JSON.parse(JSON.stringify(material));
        shiftMaterialTextures(m, offsets);
        target.json.materials.push(m);
    }

    // 8. meshes (深拷贝，处理 primitives 索引)
    for (const mesh of (source.json.meshes ?? [])) {
        const m = JSON.parse(JSON.stringify(mesh));
        for (const prim of (m.primitives ?? [])) {
            if (prim.attributes) {
                for (const key of Object.keys(prim.attributes)) {
                    prim.attributes[key] += offsets.accessor;
                }
            }
            if (typeof prim.indices === 'number') prim.indices += offsets.accessor;
            if (typeof prim.material === 'number') prim.material += offsets.material;
            if (Array.isArray(prim.targets)) {
                for (const morph of prim.targets) {
                    for (const key of Object.keys(morph)) morph[key] += offsets.accessor;
                }
            }
        }
        target.json.meshes.push(m);
    }

    // 9. skins
    for (const skin of (source.json.skins ?? [])) {
        const s: any = { ...skin };
        if (typeof s.inverseBindMatrices === 'number') s.inverseBindMatrices += offsets.accessor;
        if (typeof s.skeleton === 'number') s.skeleton += offsets.node;
        if (Array.isArray(s.joints)) s.joints = s.joints.map((j: number) => j + offsets.node);
        target.json.skins.push(s);
    }

    // 10. cameras
    for (const camera of (source.json.cameras ?? [])) {
        target.json.cameras.push({ ...camera });
    }

    // 11. nodes
    for (const node of (source.json.nodes ?? [])) {
        const n: any = { ...node };
        if (typeof n.mesh === 'number') n.mesh += offsets.mesh;
        if (typeof n.skin === 'number') n.skin += offsets.skin;
        if (typeof n.camera === 'number') n.camera += offsets.camera;
        if (Array.isArray(n.children)) n.children = n.children.map((c: number) => c + offsets.node);
        target.json.nodes.push(n);
    }

    // 12. animations
    for (const animation of (source.json.animations ?? [])) {
        const fileBase = basename(sourcePath, extname(sourcePath));
        const animName = animation.name && animation.name !== 'Take 001'
            ? `${fileBase}__${animation.name}`
            : fileBase;
        const a = {
            name: animName,
            samplers: animation.samplers.map((s: any) => ({
                ...s,
                input: s.input + offsets.accessor,
                output: s.output + offsets.accessor,
            })),
            channels: animation.channels
                .map((c: any) => ({
                    sampler: c.sampler,
                    target: {
                        ...c.target,
                        node: typeof c.target.node === 'number' ? c.target.node + offsets.node : c.target.node,
                    },
                }))
                .filter((c: any) => typeof c.target.node === 'number'),
        };
        if (a.channels.length > 0) target.json.animations.push(a);
    }

    // 13. 把 source 主 scene 的 root node 索引加到 target 主 scene
    const sourceSceneIdx = typeof source.json.scene === 'number' ? source.json.scene : 0;
    const sourceScene = source.json.scenes?.[sourceSceneIdx];
    const sourceRootNodes: number[] = sourceScene?.nodes ?? [];
    target.json.scenes ??= [{ nodes: [] }];
    target.json.scenes[0].nodes ??= [];
    const shiftedRoots = sourceRootNodes.map((n) => n + offsets.node);

    if (placement && (placement.translation || placement.wrapperName)) {
        const wrapperIdx = target.json.nodes.length;
        const wrapper: any = {
            name: placement.wrapperName ?? basename(sourcePath, extname(sourcePath)),
            children: shiftedRoots,
        };
        if (placement.translation) wrapper.translation = placement.translation;
        target.json.nodes.push(wrapper);
        target.json.scenes[0].nodes.push(wrapperIdx);
    } else {
        for (const idx of shiftedRoots) {
            target.json.scenes[0].nodes.push(idx);
        }
    }
}

function shiftMaterialTextures(m: any, offsets: Offsets): void {
    const slots = [
        m.pbrMetallicRoughness?.baseColorTexture,
        m.pbrMetallicRoughness?.metallicRoughnessTexture,
        m.normalTexture,
        m.occlusionTexture,
        m.emissiveTexture,
    ];
    for (const slot of slots) {
        if (slot && typeof slot.index === 'number') slot.index += offsets.texture;
    }

    // 常见 KHR 扩展（直接遍历 extensions 字段，处理含 "*Texture.index" 的子对象）
    const ext = m.extensions;
    if (ext && typeof ext === 'object') {
        const visit = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
                const value = obj[key];
                if (key.endsWith('Texture') && value && typeof value === 'object' && typeof value.index === 'number') {
                    value.index += offsets.texture;
                } else if (typeof value === 'object') {
                    visit(value);
                }
            }
        };
        visit(ext);
    }
}

// ---------- 主流程 ----------

async function main() {
    let cli: CliArgs;
    try {
        cli = parseArgs(argv.slice(2));
    } catch (error) {
        console.error(`参数错误：${(error as Error).message}\n`);
        printUsage();
        process.exit(2);
        return;
    }

    const fromList = cli.inputListFile ? readInputList(cli.inputListFile) : [];
    const allPatterns = [...cli.inputs, ...fromList];
    const inputs = await expandPatterns(allPatterns);
    if (inputs.length === 0) {
        console.error('❌ 没有匹配到任何输入文件');
        process.exit(1);
        return;
    }
    console.log(`📥 输入文件：${inputs.length} 个`);

    const target: ParsedGlb = {
        json: {
            asset: { version: '2.0', generator: 'concat-glb' },
            scene: 0,
            scenes: [{ name: cli.sceneName ?? 'Concat', nodes: [] }],
            buffers: [{ byteLength: 0 }],
            bufferViews: [],
            accessors: [],
            images: [],
            samplers: [],
            textures: [],
            materials: [],
            meshes: [],
            skins: [],
            nodes: [],
            animations: [],
        },
        bin: new Uint8Array(0),
    };

    const stats: { file: string; meshes: number; anims: number; nodes: number }[] = [];

    const cols = cli.gridSpacing > 0 ? Math.ceil(Math.sqrt(inputs.length)) : 0;
    const offsetCenter = cols > 0 ? (cols - 1) / 2 : 0;

    let processed = 0;
    for (const inputPath of inputs) {
        const idx = processed;
        processed += 1;
        try {
            const source = parseGlb(inputPath);
            const meshesBefore = target.json.meshes!.length;
            const animsBefore = target.json.animations!.length;
            const nodesBefore = target.json.nodes!.length;

            let placement: Placement | undefined;
            if (cli.gridSpacing > 0) {
                const col = idx % cols;
                const row = Math.floor(idx / cols);
                const x = (col - offsetCenter) * cli.gridSpacing;
                const z = (row - offsetCenter) * cli.gridSpacing;
                placement = {
                    wrapperName: basename(inputPath, extname(inputPath)),
                    translation: [x, 0, z],
                };
            } else {
                placement = { wrapperName: basename(inputPath, extname(inputPath)) };
            }

            concatInto(target, source, inputPath, placement);
            stats.push({
                file: basename(inputPath),
                meshes: target.json.meshes!.length - meshesBefore,
                anims: target.json.animations!.length - animsBefore,
                nodes: target.json.nodes!.length - nodesBefore,
            });
            if (cli.verbose) {
                console.log(`  [${processed}/${inputs.length}] ${basename(inputPath)} → +meshes ${target.json.meshes!.length - meshesBefore}, +anims ${target.json.animations!.length - animsBefore}, +nodes ${target.json.nodes!.length - nodesBefore}`);
            }
        } catch (error) {
            console.warn(`  [${processed}/${inputs.length}] ${basename(inputPath)} — 失败: ${(error as Error).message}`);
        }
    }

    target.json.buffers![0].byteLength = target.bin.byteLength;

    const outputPath = resolve(cli.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    const outBytes = encodeGlb(target.json, target.bin);
    writeFileSync(outputPath, outBytes);

    const totalMeshes = stats.reduce((s, x) => s + x.meshes, 0);
    const totalAnims = stats.reduce((s, x) => s + x.anims, 0);
    const totalNodes = stats.reduce((s, x) => s + x.nodes, 0);

    console.log('');
    console.log(`✅ 拼接完成`);
    console.log(`   文件:  ${stats.length}`);
    console.log(`   meshes: ${totalMeshes}`);
    console.log(`   nodes:  ${totalNodes}`);
    console.log(`   anims:  ${totalAnims}`);
    console.log(`   输出: ${outputPath}`);
    console.log(`   大小: ${(outBytes.byteLength / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
