/// <reference types="bun-types" />
// 用 three.js 的 GLTFLoader 实际解析 glb，看 animations 数组是否能被读出
// 这是 viewer 里使用的同一个解析路径
import { readFileSync } from 'fs';
import { argv } from 'process';

// three.js 不直接支持 node 环境的 fetch 解码，但 GLTFLoader.parse 是同步纯内存的
// 不依赖 DOM 也不依赖 fetch，可以在 bun 里直接跑
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

async function main() {
    for (const path of argv.slice(2)) {
        console.log(`\n=== ${path} ===`);
        try {
            const buf = readFileSync(path);
            const loader = new GLTFLoader();
            await new Promise<void>((resolve, reject) => {
                loader.parse(
                    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
                    '',
                    (gltf: any) => {
                        const anims = gltf.animations ?? [];
                        console.log(`  scene name : ${gltf.scene?.name ?? '(none)'}`);
                        console.log(`  scene children: ${gltf.scene?.children?.length ?? 0}`);
                        let meshCount = 0;
                        let skinnedMeshCount = 0;
                        let bonesCount = 0;
                        gltf.scene?.traverse((node: any) => {
                            if (node.isMesh) meshCount++;
                            if (node.isSkinnedMesh) {
                                skinnedMeshCount++;
                                bonesCount = node.skeleton?.bones?.length ?? 0;
                            }
                        });
                        console.log(`  meshes     : ${meshCount}`);
                        console.log(`  skinnedMeshes: ${skinnedMeshCount} (bones=${bonesCount})`);
                        console.log(`  animations : ${anims.length}`);
                        if (anims.length > 0) {
                            console.log(`  first 5    :`);
                            for (const a of anims.slice(0, 5)) {
                                console.log(`    - ${a.name} | duration=${a.duration.toFixed(3)}s | tracks=${a.tracks.length}`);
                            }
                        }
                        resolve();
                    },
                    (err: any) => {
                        console.log(`  ❌ parse error: ${err?.message ?? err}`);
                        reject(err);
                    },
                );
            }).catch(() => {});
        } catch (error) {
            console.log(`  ❌ ERROR: ${(error as Error).message}`);
        }
    }
}

main();
