/// <reference types="bun-types" />
// check-anim-firstframe.ts — 取动画第 0 帧的 keyframe 值，跟另一个 GLB 中同名骨骼的 bind transform 对比
//
// 用法: bun scripts/check-anim-firstframe.ts <mesh.glb> <anim.glb>

import { readFileSync } from 'fs';
import { argv } from 'process';

type GltfRoot = any;

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

function parseGlb(filePath: string): { json: GltfRoot; bin: Uint8Array } {
    const data = readFileSync(filePath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not GLB');
    const totalLen = view.getUint32(8, true);
    let cursor = 12;
    let json: GltfRoot | null = null;
    let bin = new Uint8Array(0);
    while (cursor < totalLen) {
        const chunkLen = view.getUint32(cursor, true);
        const chunkType = view.getUint32(cursor + 4, true);
        if (chunkType === CHUNK_TYPE_JSON) {
            json = JSON.parse(new TextDecoder().decode(data.subarray(cursor + 8, cursor + 8 + chunkLen)));
        } else if (chunkType === CHUNK_TYPE_BIN) {
            bin = data.subarray(cursor + 8, cursor + 8 + chunkLen);
        }
        cursor += 8 + chunkLen;
    }
    if (!json) throw new Error('no JSON chunk');
    return { json, bin };
}

function readAccessor(json: GltfRoot, bin: Uint8Array, accessorIdx: number): Float32Array | Int16Array | Int8Array {
    const accessor = json.accessors[accessorIdx];
    const view = json.bufferViews[accessor.bufferView];
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;
    const compMap: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const numComps = compMap[accessor.type] ?? 1;
    const total = count * numComps;
    const componentType = accessor.componentType;
    if (componentType === 5126) {
        return new Float32Array(bin.buffer, bin.byteOffset + offset, total);
    }
    throw new Error(`unsupported componentType ${componentType}`);
}

function quatDotAngleDeg(a: number[], b: number[]): number {
    let d = 0;
    for (let i = 0; i < 4; i += 1) d += a[i] * b[i];
    d = Math.min(1, Math.abs(d));
    return (Math.acos(d) * 2 * 180) / Math.PI;
}

function fmt(arr: number[] | Float32Array, digits = 3): string {
    return '[' + Array.from(arr).map((v) => v.toFixed(digits).padStart(8)).join(', ') + ']';
}

function main() {
    const args = argv.slice(2);
    if (args.length < 2 || args.includes('-h')) {
        console.log('用法: bun scripts/check-anim-firstframe.ts <mesh.glb> <anim.glb>');
        process.exit(args.length < 2 ? 2 : 0);
        return;
    }
    const mesh = parseGlb(args[0]);
    const anim = parseGlb(args[1]);

    const meshNodeByName = new Map<string, any>();
    for (const n of (mesh.json.nodes ?? [])) {
        if (n.name) meshNodeByName.set(n.name, n);
    }
    const animNodeByName = new Map<string, any>();
    for (let i = 0; i < (anim.json.nodes ?? []).length; i += 1) {
        const n = anim.json.nodes[i];
        if (n.name) animNodeByName.set(n.name, { ...n, _idx: i });
    }

    if (!anim.json.animations || anim.json.animations.length === 0) {
        console.log('anim glb 没有 animations');
        return;
    }
    const animation = anim.json.animations[0];
    console.log(`Animation: ${animation.name ?? '(unnamed)'}`);
    console.log(`  channels: ${animation.channels.length}`);
    console.log(`  samplers: ${animation.samplers.length}`);
    console.log('');

    let bigDiff = 0;
    let totalChannels = 0;
    const rows: { name: string; path: string; firstFrame: number[]; meshBind: number[] | undefined; animBind: number[] | undefined; diff: number }[] = [];

    for (const channel of animation.channels) {
        const targetNodeIdx = channel.target.node;
        if (typeof targetNodeIdx !== 'number') continue;
        const targetNode = anim.json.nodes[targetNodeIdx];
        const name = targetNode.name;
        const path = channel.target.path; // translation, rotation, scale, weights
        if (path !== 'rotation' && path !== 'translation' && path !== 'scale') continue;

        const sampler = animation.samplers[channel.sampler];
        const outputData = readAccessor(anim.json, anim.bin, sampler.output);
        // first frame
        const stride = path === 'rotation' ? 4 : 3;
        const firstFrame = Array.from(outputData.slice(0, stride));

        const meshNode = meshNodeByName.get(name);
        const meshBind = (meshNode?.[path]) as number[] | undefined;
        const animBind = (targetNode[path]) as number[] | undefined;

        let diff = 0;
        if (path === 'rotation' && firstFrame.length === 4 && meshBind?.length === 4) {
            diff = quatDotAngleDeg(firstFrame, meshBind);
        } else if (firstFrame.length === stride && meshBind?.length === stride) {
            for (let i = 0; i < stride; i += 1) diff += Math.abs(firstFrame[i] - meshBind[i]);
        }

        if (diff > (path === 'rotation' ? 1 : 0.001)) bigDiff += 1;
        totalChannels += 1;
        rows.push({ name, path, firstFrame, meshBind, animBind, diff });
    }

    console.log(`总 channel: ${totalChannels}, 第 0 帧值与 mesh bind pose 显著不同的: ${bigDiff}`);
    console.log('');

    rows.sort((a, b) => b.diff - a.diff);
    const top = rows.slice(0, 10);
    console.log('差异最大的 10 个 channel：');
    for (const r of top) {
        const unit = r.path === 'rotation' ? '°' : '';
        console.log(`  ${r.name}.${r.path}  diff=${r.diff.toFixed(3)}${unit}`);
        console.log(`    first frame:   ${fmt(r.firstFrame, 4)}`);
        console.log(`    mesh bind:     ${fmt(r.meshBind ?? [], 4)}`);
        console.log(`    anim bind:     ${fmt(r.animBind ?? [], 4)}`);
    }
}

main();
