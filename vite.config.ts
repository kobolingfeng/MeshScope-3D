import { defineConfig } from 'vite';

export default defineConfig({
    root: '.',
    base: './',
    server: {
        port: 3000,
        strictPort: true,
    },
    build: {
        outDir: 'dist',
        emptyOutDir: process.env.MESHSCOPE_PRESERVE_NATIVE_EXE === '1' ? false : true,
        target: 'esnext',
        minify: 'esbuild',
        assetsInlineLimit: 4096,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('three/examples/jsm/controls/OrbitControls')) return 'three-controls';
                    if (id.includes('three/examples/jsm/loaders/GLTFLoader')) return 'loader-gltf';
                    if (id.includes('three/examples/jsm/loaders/FBXLoader')) return 'loader-fbx';
                    if (id.includes('three/examples/jsm/loaders/MTLLoader')) return 'loader-obj';
                    if (id.includes('three/examples/jsm/loaders/OBJLoader')) return 'loader-obj';
                    if (id.includes('three/examples/jsm/loaders/PLYLoader')) return 'loader-ply';
                    if (id.includes('three/examples/jsm/loaders/STLLoader')) return 'loader-stl';
                    if (id.includes('three/build/three.module')) return 'three-core';
                },
            },
        },
    },
});
