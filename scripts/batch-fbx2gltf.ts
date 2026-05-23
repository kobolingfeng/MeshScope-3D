/// <reference types="bun-types" />
// batch-fbx2gltf.ts — 并发批量调用 FBX2glTF.exe 把 fbx 转成 glb
//
// 用法：
//   bun scripts/batch-fbx2gltf.ts <input_dir> -o <output_dir> [--tool <FBX2glTF.exe>] [--concurrency 8]
//   bun scripts/batch-fbx2gltf.ts --input-list <list.txt> -o <output_dir>
//
// 默认：扫描输入目录里的所有 *.fbx，按相对路径在输出目录生成同名 .glb，
//      并发数 = CPU 核心数

import { Glob } from 'bun';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import { resolve, basename, extname, dirname, isAbsolute, join, relative } from 'path';
import { argv } from 'process';
import { spawn } from 'child_process';
import { cpus } from 'os';

type CliArgs = {
    inputs: string[];
    inputListFile?: string;
    outputDir: string;
    tool: string;
    concurrency: number;
    flatten: boolean;
    skipExisting: boolean;
    extraArgs: string[];
};

function parseArgs(args: string[]): CliArgs {
    const inputs: string[] = [];
    let inputListFile: string | undefined;
    let outputDir = '';
    let tool = 'FBX2glTF.exe';
    let concurrency = Math.max(1, cpus().length);
    let flatten = false;
    let skipExisting = false;
    const extraArgs: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-o' || arg === '--output') {
            outputDir = args[++i] ?? '';
        } else if (arg === '--input-list') {
            inputListFile = args[++i];
        } else if (arg === '--tool') {
            tool = args[++i];
        } else if (arg === '--concurrency' || arg === '-j') {
            concurrency = Math.max(1, parseInt(args[++i] ?? '1', 10));
        } else if (arg === '--flatten') {
            flatten = true;
        } else if (arg === '--skip-existing') {
            skipExisting = true;
        } else if (arg === '--') {
            while (++i < args.length) extraArgs.push(args[i]);
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
    return { inputs, inputListFile, outputDir, tool, concurrency, flatten, skipExisting, extraArgs };
}

function printUsage() {
    console.log(`batch-fbx2gltf — 并发批量 fbx → glb

用法:
  bun scripts/batch-fbx2gltf.ts <input_dir|*.fbx>... -o <output_dir>
  bun scripts/batch-fbx2gltf.ts --input-list <list.txt> -o <output_dir>

参数:
  <input>           输入路径或 glob（递归扫描 *.fbx）
  --input-list      文本文件，每行一个 fbx 绝对路径
  -o, --output      输出根目录
  --tool <path>     FBX2glTF 可执行文件路径（默认 PATH 中的 FBX2glTF.exe）
  --concurrency, -j 并发数（默认 = CPU 核心数）
  --flatten         所有输出 glb 直接放到 output 根目录（不保留子目录结构）
  --skip-existing   跳过已存在的 glb（断点续转）
  --                后续参数直接传给 FBX2glTF（如 --anim-framerate bake30）
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
            if (stat.isDirectory()) {
                const glob = new Glob('**/*.fbx');
                for await (const name of glob.scan({ cwd: absolute, absolute: true, onlyFiles: true })) {
                    if (!seen.has(name)) {
                        seen.add(name);
                        result.push(name);
                    }
                }
                continue;
            }
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

type Result = {
    fbx: string;
    out: string;
    ok: boolean;
    skipped: boolean;
    elapsed: number;
    error?: string;
};

function convertOne(tool: string, fbx: string, outBase: string, extraArgs: string[]): Promise<Result> {
    return new Promise((resolve) => {
        const start = Date.now();
        // FBX2glTF 输出参数 -o 不带后缀，加 -b 输出 .glb
        mkdirSync(dirname(outBase), { recursive: true });
        const args = ['-i', fbx, '-o', outBase, '-b', ...extraArgs];
        const proc = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', (err) => {
            resolve({ fbx, out: outBase + '.glb', ok: false, skipped: false, elapsed: Date.now() - start, error: err.message });
        });
        proc.on('close', (code) => {
            const out = outBase + '.glb';
            const ok = code === 0 && existsSync(out);
            resolve({
                fbx,
                out,
                ok,
                skipped: false,
                elapsed: Date.now() - start,
                error: ok ? undefined : (stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`),
            });
        });
    });
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<Result>): Promise<Result[]> {
    const results: Result[] = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;
    const total = items.length;

    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
        while (true) {
            const i = nextIndex++;
            if (i >= total) return;
            const result = await worker(items[i], i);
            results[i] = result;
            completed += 1;
            if (completed % 25 === 0 || completed === total) {
                const pct = ((completed / total) * 100).toFixed(1);
                const okCount = results.filter((r) => r?.ok || r?.skipped).length;
                process.stdout.write(`\r  进度 ${completed}/${total} (${pct}%)  成功: ${okCount}  当前: ${basename(result.fbx).slice(0, 40)}`.padEnd(110, ' '));
            }
        }
    });

    await Promise.all(workers);
    process.stdout.write('\n');
    return results;
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
    const fbxs = await expandPatterns([...cli.inputs, ...fromList]);
    if (fbxs.length === 0) {
        console.error('❌ 没有找到 fbx');
        process.exit(1);
        return;
    }

    // 计算输出路径策略：
    // - flatten：直接放到 outputDir 根目录，basename 保留
    // - 否则：保留相对路径结构（相对所有输入的最长公共前缀目录）
    let prefix = '';
    if (!cli.flatten) {
        prefix = computeCommonPrefix(fbxs);
    }

    console.log(`📥 找到 ${fbxs.length} 个 fbx，并发 ${cli.concurrency}`);
    console.log(`   工具: ${cli.tool}`);
    console.log(`   输出: ${resolve(cli.outputDir)}`);
    if (!cli.flatten) console.log(`   保留相对结构（公共前缀: ${prefix || '(none)'}）`);

    mkdirSync(cli.outputDir, { recursive: true });

    const start = Date.now();
    const results = await runWithConcurrency(fbxs, cli.concurrency, async (fbx) => {
        let outBase: string;
        if (cli.flatten) {
            outBase = join(cli.outputDir, basename(fbx, extname(fbx)));
        } else {
            const rel = relative(prefix, fbx);
            outBase = join(cli.outputDir, rel.slice(0, rel.length - extname(rel).length));
        }
        if (cli.skipExisting && existsSync(outBase + '.glb')) {
            return { fbx, out: outBase + '.glb', ok: true, skipped: true, elapsed: 0 };
        }
        return convertOne(cli.tool, fbx, outBase, cli.extraArgs);
    });

    const elapsed = (Date.now() - start) / 1000;
    const ok = results.filter((r) => r.ok).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.ok && !r.skipped);

    console.log('');
    console.log(`✅ 完成：${ok} 个成功（含 ${skipped} 跳过）, ${failed.length} 失败，耗时 ${elapsed.toFixed(1)}s`);
    if (failed.length > 0) {
        console.log('\n前 10 个失败：');
        for (const f of failed.slice(0, 10)) {
            console.log(`  ✗ ${basename(f.fbx)} — ${f.error}`);
        }
        const failLog = join(cli.outputDir, '_failed.txt');
        writeFileSync(failLog, failed.map((f) => `${f.fbx}\t${f.error}`).join('\n'), 'utf8');
        console.log(`完整失败列表: ${failLog}`);
    }
}

function computeCommonPrefix(paths: string[]): string {
    if (paths.length === 0) return '';
    if (paths.length === 1) return dirname(paths[0]);
    const split = paths.map((p) => p.split(/[\\/]/u));
    const first = split[0];
    let prefixLen = first.length;
    for (let i = 1; i < split.length; i += 1) {
        const cur = split[i];
        let j = 0;
        while (j < prefixLen && j < cur.length && first[j] === cur[j]) j += 1;
        prefixLen = j;
    }
    if (prefixLen <= 1) return '';
    return first.slice(0, prefixLen).join('\\');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
