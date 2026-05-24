/// <reference types="bun-types" />
// inspect-glb.ts — 打印 GLB 文件的 JSON header 摘要
import { closeSync, openSync, readSync, statSync } from 'fs';
import { argv } from 'process';

for (const path of argv.slice(2)) {
    let fd = -1;
    try {
        fd = openSync(path, 'r');
        const header = Buffer.alloc(20);
        readSync(fd, header, 0, header.length, 0);
        const magic = header.readUInt32LE(0);
        const version = header.readUInt32LE(4);
        const jsonLen = header.readUInt32LE(12);
        const chunkType = header.toString('ascii', 16, 20);
        if (magic !== 0x46546c67 || version !== 2 || chunkType !== 'JSON') {
            throw new Error('不是 GLB v2 JSON 首块');
        }

        const jsonBytes = Buffer.alloc(jsonLen);
        readSync(fd, jsonBytes, 0, jsonLen, 20);
        const jsonText = new TextDecoder().decode(jsonBytes);
        const obj = JSON.parse(jsonText);
        const stat = statSync(path);
        console.log(`\n[${path}]`);
        console.log(`  size      : ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`  generator : ${obj.asset?.generator ?? '?'}`);
        console.log(`  meshes    : ${obj.meshes?.length ?? 0}`);
        console.log(`  skins     : ${obj.skins?.length ?? 0}`);
        console.log(`  nodes     : ${obj.nodes?.length ?? 0}`);
        console.log(`  bufferViews: ${obj.bufferViews?.length ?? 0}`);
        console.log(`  accessors : ${obj.accessors?.length ?? 0}`);
        console.log(`  animations: ${obj.animations?.length ?? 0}`);
        if (obj.animations?.length) {
            const sample = obj.animations.slice(0, 5).map((a: any) => `${a.name}(${a.channels.length})`);
            console.log(`  first clips: ${sample.join(', ')}`);
            const totalChannels = obj.animations.reduce((s: number, a: any) => s + a.channels.length, 0);
            console.log(`  total channels: ${totalChannels}`);
        }
        if (obj.skins?.length) {
            const skin = obj.skins[0];
            console.log(`  skin[0] joints: ${skin.joints?.length ?? 0}`);
        }
        // 打印前 10 个 node 的 name 帮诊断
        if (obj.nodes?.length) {
            const names = obj.nodes.slice(0, 10).map((n: any) => n.name ?? '<unnamed>');
            console.log(`  first nodes: ${names.join(', ')}`);
        }
    } catch (error) {
        console.log(`\n[${path}] ERROR: ${(error as Error).message}`);
    } finally {
        if (fd >= 0) closeSync(fd);
    }
}
