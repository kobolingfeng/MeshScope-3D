/// <reference types="bun-types" />
// bundle-props.ts — 自动把动画 glb 归类到对应的 mesh glb，每个物体输出一个完整 glb
//
// 算法：
//   1. 扫描所有输入 glb：
//      - meshFile：含 meshes 数组（自带 mesh）
//      - animOnly：不含 mesh 但含 animations
//   2. 对每个 animOnly：算它 channel.target.node 引用的 node name 集合，
//      与每个 meshFile 的 node name 集合做交集，匹配数最大的 mesh = 归属
//   3. 对每个 meshFile：
//      - 有归属 anim → 调用 merge-glb 把 anim retarget 进去
//      - 无归属 anim → 直接复制
//   4. 无归属的 animOnly：单独复制到输出目录
//
// 用法：
//   bun scripts/bundle-props.ts <input.glb|glob>... -o <output_dir>
//   bun scripts/bundle-props.ts --input-list <list.txt> -o <output_dir>

import { Glob } from 'bun';
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'fs';
import { resolve, basename, extname, dirname, isAbsolute, join } from 'path';
import { argv } from 'process';
import { spawnSync } from 'child_process';

type GltfRoot = Record<string, any>;

interface FileInfo {
    path: string;
    base: string;
    hasMesh: boolean;
    hasAnim: boolean;
    nodeNames: Set<string>;
    animTargets: Set<string>;
    animCount: number;
    channelCount: number;
}

// ---------- CLI ----------

type CliArgs = {
    inputs: string[];
    inputListFile?: string;
    outputDir: string;
    verbose: boolean;
    mergeScript: string;
};

function parseArgs(args: string[]): CliArgs {
    const inputs: string[] = [];
    let inputListFile: string | undefined;
    let outputDir = '';
    let verbose = false;
    let mergeScript = resolve(import.meta.dir, 'merge-glb.ts');

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-o' || arg === '--output') {
            outputDir = args[++i] ?? '';
        } else if (arg === '--input-list') {
            inputListFile = args[++i];
        } else if (arg === '--merge-script') {
            mergeScript = resolve(args[++i] ?? mergeScript);
        } else if (arg === '-v' || arg === '--verbose') {
            verbose = true;
        } else if (arg === '-h' || arg === '--help') {
            printUsage();
            process.exit(0);
        } else if (arg.startsWith('-')) {
            throw new Error(`未知参数: ${arg}`);
        } else {
            inputs.push(arg);
        }
    }

    if (inputs.length === 0 && !inputListFile) throw new Error('需要输入');
    if (!outputDir) throw new Error('需要 -o 输出目录');
    return { inputs, inputListFile, outputDir, verbose, mergeScript };
}

function printUsage() {
    console.log(`bundle-props — 自动把动画归类到对应 mesh，每个物体输出一个 glb

用法：
  bun scripts/bundle-props.ts <input.glb|glob>... -o <output_dir>
  bun scripts/bundle-props.ts --input-list <list.txt> -o <output_dir>

参数：
  <input>           输入 GLB 路径或 glob（可重复）
  --input-list      文本文件，每行一个路径
  -o, --output      输出目录
  --merge-script    merge-glb.ts 脚本路径（默认: ./merge-glb.ts）
  -v, --verbose     详细输出
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

// ---------- GLB 头部解析 ----------

function parseGlbHeaderJson(filePath: string): GltfRoot {
    const data = readFileSync(filePath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${filePath}: 不是 GLB`);
    const jsonLen = view.getUint32(12, true);
    const jsonText = new TextDecoder().decode(data.subarray(20, 20 + jsonLen));
    return JSON.parse(jsonText);
}

function classify(filePath: string): FileInfo {
    const json = parseGlbHeaderJson(filePath);
    const nodes = json.nodes ?? [];
    const nodeNames = new Set<string>();
    for (const node of nodes) {
        if (node.name) nodeNames.add(node.name);
    }
    const animTargets = new Set<string>();
    let channelCount = 0;
    for (const anim of (json.animations ?? [])) {
        for (const channel of (anim.channels ?? [])) {
            channelCount += 1;
            const idx = channel.target?.node;
            if (typeof idx === 'number') {
                const name = nodes[idx]?.name;
                if (name) animTargets.add(name);
            }
        }
    }
    return {
        path: filePath,
        base: basename(filePath, extname(filePath)),
        hasMesh: (json.meshes?.length ?? 0) > 0,
        hasAnim: (json.animations?.length ?? 0) > 0,
        animCount: json.animations?.length ?? 0,
        channelCount,
        nodeNames,
        animTargets,
    };
}

// ---------- 主流程 ----------

type MatchResult = {
    match: FileInfo | null;
    score: number;
    reason: 'name-prefix' | 'node-name' | 'no-match';
};

// 计算 anim → mesh 的最佳归属
//   优先级 1: anim 文件名以 `<X>__` 前缀，优先归到 `<X>_SkelMesh` / `<X>_Mesh`
//             （前提：节点名交集 > 0，确认骨骼相符）
//   优先级 2: 节点名交集分数最高
//             （平分时倾向"基础 mesh"——节点更少更专一的 mesh 优先 = X_SkelMesh）
function findBestMesh(anim: FileInfo, meshFiles: FileInfo[]): MatchResult {
    const score = (m: FileInfo): number => {
        let s = 0;
        for (const name of anim.animTargets) if (m.nodeNames.has(name)) s += 1;
        return s;
    };

    // 1. 文件名前缀优先匹配（如 Spear__Prop_* → Spear_SkelMesh）
    const prefixMatch = /^([^_]+(?:_[^_]+)*?)__/.exec(anim.base);
    if (prefixMatch) {
        const prefix = prefixMatch[1];
        const candidates = meshFiles.filter((m) =>
            m.base === `${prefix}_SkelMesh` || m.base === `${prefix}_Mesh`,
        );
        for (const candidate of candidates) {
            const sc = score(candidate);
            if (sc > 0) return { match: candidate, score: sc, reason: 'name-prefix' };
        }
    }

    // 2. 节点名交集打分；平分时倾向节点数较少的（基础 mesh 优先于复合 mesh）
    let best: FileInfo | null = null;
    let bestScore = 0;
    for (const m of meshFiles) {
        const sc = score(m);
        if (sc > bestScore || (sc === bestScore && sc > 0 && best && m.nodeNames.size < best.nodeNames.size)) {
            bestScore = sc;
            best = m;
        }
    }
    return { match: best, score: bestScore, reason: best ? 'node-name' : 'no-match' };
}

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
    console.log(`📥 输入：${inputs.length} 个 glb`);

    // 1. 分类
    const infos = inputs.map(classify);
    const meshFiles = infos.filter((f) => f.hasMesh);
    const animOnlyFiles = infos.filter((f) => !f.hasMesh && f.hasAnim);
    const otherFiles = infos.filter((f) => !f.hasMesh && !f.hasAnim);

    console.log(`   meshFiles:  ${meshFiles.length}  (有 mesh，可作为输出基础)`);
    console.log(`   animOnly:   ${animOnlyFiles.length}  (待归属到 mesh)`);
    if (otherFiles.length > 0) {
        console.log(`   其他:       ${otherFiles.length}  (无 mesh 无 anim，单独复制)`);
    }

    // 2. 给每个 anim 找最佳归属
    const assigned = new Map<string, FileInfo[]>();
    for (const m of meshFiles) assigned.set(m.path, []);
    const unassignedAnims: FileInfo[] = [];

    console.log('\n🔍 归类动画：');
    for (const a of animOnlyFiles) {
        const totalTargets = a.animTargets.size;
        const result = findBestMesh(a, meshFiles);

        if (result.match && result.score >= Math.max(1, totalTargets * 0.5)) {
            assigned.get(result.match.path)!.push(a);
            if (cli.verbose) {
                console.log(`  ${a.base} → ${result.match.base} [${result.reason}] (${result.score}/${totalTargets} 节点匹配)`);
            }
        } else {
            unassignedAnims.push(a);
            console.log(`  ⚠ ${a.base} 无匹配 mesh (最佳=${result.match?.base ?? 'none'} ${result.score}/${totalTargets})`);
        }
    }

    // 3. 输出
    mkdirSync(cli.outputDir, { recursive: true });
    console.log(`\n📤 输出到: ${resolve(cli.outputDir)}\n`);

    let okCount = 0;
    let copyCount = 0;
    let mergeCount = 0;
    let failCount = 0;

    for (const m of meshFiles) {
        const anims = assigned.get(m.path)!;
        const outPath = join(cli.outputDir, `${m.base}.glb`);
        if (anims.length === 0) {
            copyFileSync(m.path, outPath);
            const animSelf = m.animCount > 0 ? ` (自带 ${m.animCount} anim)` : '';
            console.log(`  ✓ ${m.base}.glb${animSelf} [copied]`);
            copyCount += 1;
            okCount += 1;
        } else {
            const args = [
                cli.mergeScript,
                '--mesh', m.path,
                ...anims.flatMap((a) => ['--anim', a.path]),
                '-o', outPath,
            ];
            const result = spawnSync('bun', args, {
                stdio: cli.verbose ? 'inherit' : 'pipe',
            });
            if (result.status === 0) {
                console.log(`  ✓ ${m.base}.glb (含 ${anims.length} 个外部 anim) [merged]`);
                mergeCount += 1;
                okCount += 1;
            } else {
                console.warn(`  ✗ ${m.base}.glb merge failed (exit ${result.status})`);
                if (!cli.verbose && result.stderr) {
                    console.warn(`    stderr: ${result.stderr.toString().split('\n').slice(0, 3).join(' | ')}`);
                }
                failCount += 1;
            }
        }
    }

    for (const a of unassignedAnims) {
        const outPath = join(cli.outputDir, `${a.base}.glb`);
        copyFileSync(a.path, outPath);
        console.log(`  ✓ ${a.base}.glb (无匹配 mesh) [copied]`);
        copyCount += 1;
        okCount += 1;
    }

    for (const o of otherFiles) {
        const outPath = join(cli.outputDir, `${o.base}.glb`);
        copyFileSync(o.path, outPath);
        console.log(`  ✓ ${o.base}.glb (空 glb) [copied]`);
        copyCount += 1;
        okCount += 1;
    }

    console.log('');
    console.log(`✅ 完成：成功 ${okCount} (copy ${copyCount}, merge ${mergeCount}), 失败 ${failCount}`);
    console.log(`   输出目录：${resolve(cli.outputDir)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
