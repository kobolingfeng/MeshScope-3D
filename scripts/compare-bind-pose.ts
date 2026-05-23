/// <reference types="bun-types" />
// compare-bind-pose.ts — 对比两个 GLB 中同名骨骼的初始 transform，诊断 bind pose 不一致
//
// 用法：
//   bun scripts/compare-bind-pose.ts <mesh.glb> <anim.glb> [--bones Hips,Spine,...]

import { readFileSync } from 'fs';
import { argv } from 'process';

type GltfNode = {
    name?: string;
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    children?: number[];
};
type GltfRoot = {
    nodes?: GltfNode[];
    [key: string]: any;
};

function parseGlbJson(filePath: string): GltfRoot {
    const data = readFileSync(filePath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${filePath}: 不是 GLB`);
    const jsonLen = view.getUint32(12, true);
    const text = new TextDecoder('utf-8').decode(data.subarray(20, 20 + jsonLen));
    return JSON.parse(text);
}

function quatToEulerDeg(q: [number, number, number, number]): [number, number, number] {
    const [x, y, z, w] = q;
    const sinr = 2 * (w * x + y * z);
    const cosr = 1 - 2 * (x * x + y * y);
    const roll = Math.atan2(sinr, cosr);
    const sinp = 2 * (w * y - z * x);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
    const siny = 2 * (w * z + x * y);
    const cosy = 1 - 2 * (y * y + z * z);
    const yaw = Math.atan2(siny, cosy);
    const r2d = 180 / Math.PI;
    return [roll * r2d, pitch * r2d, yaw * r2d];
}

function fmt(arr: number[] | undefined, digits = 3): string {
    if (!arr) return '(none)';
    return '[' + arr.map((v) => v.toFixed(digits).padStart(8)).join(', ') + ']';
}

function compare(meshPath: string, animPath: string, boneFilter: string[] | null): void {
    const meshJson = parseGlbJson(meshPath);
    const animJson = parseGlbJson(animPath);

    const meshNodes = meshJson.nodes ?? [];
    const animNodes = animJson.nodes ?? [];

    const meshByName = new Map<string, GltfNode>();
    for (const n of meshNodes) if (n.name) meshByName.set(n.name, n);

    console.log(`Mesh: ${meshPath}`);
    console.log(`  nodes: ${meshNodes.length}`);
    console.log(`Anim: ${animPath}`);
    console.log(`  nodes: ${animNodes.length}`);
    console.log('');

    let common = 0;
    let translationDiffs = 0;
    let rotationDiffs = 0;
    let scaleDiffs = 0;
    let largeRotationDiffs = 0;

    const rows: { name: string; meshT?: any; animT?: any; meshR?: any; animR?: any; meshS?: any; animS?: any; rotDeg?: number }[] = [];

    for (const animNode of animNodes) {
        const name = animNode.name;
        if (!name) continue;
        const meshNode = meshByName.get(name);
        if (!meshNode) continue;
        if (boneFilter && !boneFilter.includes(name)) continue;
        common += 1;

        const tEqual = arrEqual(meshNode.translation, animNode.translation, 1e-4);
        const rEqual = arrEqual(meshNode.rotation, animNode.rotation, 1e-4);
        const sEqual = arrEqual(meshNode.scale, animNode.scale, 1e-4);

        if (!tEqual) translationDiffs += 1;
        if (!rEqual) rotationDiffs += 1;
        if (!sEqual) scaleDiffs += 1;

        let rotDeg = 0;
        if (meshNode.rotation && animNode.rotation) {
            const dotV = dot(meshNode.rotation, animNode.rotation);
            rotDeg = (Math.acos(Math.min(1, Math.abs(dotV))) * 2 * 180) / Math.PI;
            if (rotDeg > 5) largeRotationDiffs += 1;
        } else if (meshNode.rotation || animNode.rotation) {
            rotDeg = 999;
        }

        if (!tEqual || !rEqual || !sEqual) {
            rows.push({
                name,
                meshT: meshNode.translation,
                animT: animNode.translation,
                meshR: meshNode.rotation,
                animR: animNode.rotation,
                meshS: meshNode.scale,
                animS: animNode.scale,
                rotDeg,
            });
        }
    }

    console.log(`共有同名骨骼: ${common}`);
    console.log(`  translation 不一致: ${translationDiffs}`);
    console.log(`  rotation 不一致:    ${rotationDiffs}`);
    console.log(`  scale 不一致:       ${scaleDiffs}`);
    console.log(`  rotation > 5°:      ${largeRotationDiffs}`);
    console.log('');

    if (rows.length === 0) {
        console.log('✅ 所有同名骨骼初始 transform 完全一致 — bind pose 不是问题');
        return;
    }

    console.log(`⚠ ${rows.length} 个骨骼 bind pose 不一致：`);
    console.log('');

    rows.sort((a, b) => (b.rotDeg ?? 0) - (a.rotDeg ?? 0));
    const top = rows.slice(0, 20);
    for (const r of top) {
        console.log(`  ${r.name} ${r.rotDeg !== undefined ? `(差 ${r.rotDeg.toFixed(1)}°)` : ''}`);
        if (!arrEqual(r.meshT, r.animT, 1e-4)) {
            console.log(`    pos:  mesh=${fmt(r.meshT)}  anim=${fmt(r.animT)}`);
        }
        if (!arrEqual(r.meshR, r.animR, 1e-4)) {
            const meshEuler = r.meshR ? quatToEulerDeg(r.meshR) : undefined;
            const animEuler = r.animR ? quatToEulerDeg(r.animR) : undefined;
            console.log(`    rot:  mesh=${fmt(r.meshR, 3)} ≈ ${fmt(meshEuler, 1)}°`);
            console.log(`          anim=${fmt(r.animR, 3)} ≈ ${fmt(animEuler, 1)}°`);
        }
        if (!arrEqual(r.meshS, r.animS, 1e-4)) {
            console.log(`    scale: mesh=${fmt(r.meshS)}  anim=${fmt(r.animS)}`);
        }
    }
    if (rows.length > 20) console.log(`  ...还有 ${rows.length - 20} 个差异骨骼`);
}

function arrEqual(a: any, b: any, eps: number): boolean {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (Math.abs(a[i] - b[i]) > eps) return false;
    }
    return true;
}

function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
    return s;
}

function main() {
    const args = argv.slice(2);
    if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
        console.log('用法: bun scripts/compare-bind-pose.ts <mesh.glb> <anim.glb> [--bones Hips,Spine]');
        process.exit(args.length < 2 ? 2 : 0);
        return;
    }
    const meshPath = args[0];
    const animPath = args[1];
    let boneFilter: string[] | null = null;
    const bf = args.indexOf('--bones');
    if (bf >= 0 && args[bf + 1]) {
        boneFilter = args[bf + 1].split(',').map((s) => s.trim());
    }
    compare(meshPath, animPath, boneFilter);
}

main();
