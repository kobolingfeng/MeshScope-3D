/// <reference types="bun-types" />
// dump-node-tree.ts — 打印 GLB 节点层级树
//
// 用法: bun scripts/dump-node-tree.ts <glb> [--max-depth N]

import { readFileSync } from 'fs';
import { argv } from 'process';

type GltfNode = {
    name?: string;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    mesh?: number;
    skin?: number;
};
type GltfRoot = {
    scene?: number;
    scenes?: { nodes?: number[] }[];
    nodes?: GltfNode[];
    skins?: { joints: number[]; skeleton?: number; name?: string }[];
    [k: string]: any;
};

function parseGlbJson(filePath: string): GltfRoot {
    const data = readFileSync(filePath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not GLB');
    const jsonLen = view.getUint32(12, true);
    const text = new TextDecoder('utf-8').decode(data.subarray(20, 20 + jsonLen));
    return JSON.parse(text);
}

function fmtTRS(n: GltfNode): string {
    const parts: string[] = [];
    if (n.translation) parts.push(`t=[${n.translation.map((v) => v.toFixed(2)).join(',')}]`);
    if (n.rotation) parts.push(`r=[${n.rotation.map((v) => v.toFixed(3)).join(',')}]`);
    if (n.scale && (n.scale[0] !== 1 || n.scale[1] !== 1 || n.scale[2] !== 1)) {
        parts.push(`s=[${n.scale.map((v) => v.toFixed(2)).join(',')}]`);
    }
    if (typeof n.mesh === 'number') parts.push(`mesh#${n.mesh}`);
    if (typeof n.skin === 'number') parts.push(`skin#${n.skin}`);
    return parts.join(' ');
}

function main() {
    const args = argv.slice(2);
    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        console.log('用法: bun scripts/dump-node-tree.ts <glb> [--max-depth N]');
        process.exit(args.length === 0 ? 2 : 0);
        return;
    }
    const file = args[0];
    let maxDepth = 99;
    const md = args.indexOf('--max-depth');
    if (md >= 0 && args[md + 1]) maxDepth = parseInt(args[md + 1], 10);

    const json = parseGlbJson(file);
    const nodes = json.nodes ?? [];
    const sceneIdx = json.scene ?? 0;
    const scene = json.scenes?.[sceneIdx];
    const roots = scene?.nodes ?? [];

    console.log(`File: ${file}`);
    console.log(`  total nodes: ${nodes.length}`);
    console.log(`  skins: ${json.skins?.length ?? 0}`);
    if (json.skins?.length) {
        for (let i = 0; i < json.skins.length; i += 1) {
            const skin = json.skins[i];
            const skName = skin.name ?? `(skin#${i})`;
            const sk = typeof skin.skeleton === 'number' ? nodes[skin.skeleton]?.name : '(none)';
            console.log(`    [${i}] ${skName}  skeleton=${sk}  joints=${skin.joints.length}`);
        }
    }
    console.log('');
    console.log('Scene tree:');

    const visit = (idx: number, depth: number) => {
        if (depth > maxDepth) return;
        const n = nodes[idx];
        const indent = '  '.repeat(depth);
        const name = n.name ?? `<unnamed#${idx}>`;
        const trs = fmtTRS(n);
        console.log(`${indent}- ${name}  [${idx}]  ${trs}`);
        if (n.children) {
            for (const c of n.children) visit(c, depth + 1);
        }
    };
    for (const r of roots) visit(r, 0);
}

main();
