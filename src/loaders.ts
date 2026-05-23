// loaders.ts — 五格式动态加载器
// GLTF/GLB, OBJ, STL, PLY, FBX
import {
    AnimationClip,
    DoubleSide,
    LoadingManager,
    Mesh,
    MeshStandardMaterial,
    Object3D,
    Points,
    PointsMaterial,
} from 'three';
import { fs } from './api';

export type SupportedExt = 'gltf' | 'glb' | 'obj' | 'stl' | 'ply' | 'fbx';

export const ACCEPT_EXTS: SupportedExt[] = ['gltf', 'glb', 'obj', 'stl', 'ply', 'fbx'];

export function extOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isSupported(name: string): boolean {
    return (ACCEPT_EXTS as string[]).includes(extOf(name));
}

/**
 * 从一组 File 对象中载入一个 3D 模型。
 * - 支持单文件：GLB/OBJ/STL/PLY/FBX
 * - 支持多文件：GLTF + .bin + 贴图（同时拖入）
 */
export async function loadFromFiles(files: File[]): Promise<Object3D> {
    if (files.length === 0) throw new Error('没有文件');

    const mainFile = files.find((file) => isSupported(file.name));
    if (!mainFile) {
        throw new Error(`不支持的格式。支持: ${ACCEPT_EXTS.join(', ')}`);
    }

    const ext = extOf(mainFile.name) as SupportedExt;
    const buf = await mainFile.arrayBuffer();

    switch (ext) {
        case 'glb':
        case 'gltf':
            return loadGLTF(buf, buildAssetMapFromFiles(mainFile, files));
        case 'obj':
            return loadOBJ(new TextDecoder().decode(buf), buildAssetMapFromFiles(mainFile, files));
        case 'stl':
            return loadSTL(buf, mainFile.name);
        case 'ply':
            return loadPLY(buf, mainFile.name);
        case 'fbx':
            return loadFBX(buf);
    }
}

export async function loadFromPath(path: string): Promise<Object3D> {
    const ext = extOf(path) as SupportedExt;
    if (!isSupported(path)) {
        throw new Error(`不支持的格式。支持: ${ACCEPT_EXTS.join(', ')}`);
    }

    const name = fileNameOf(path);
    switch (ext) {
        case 'gltf': {
            const text = await fs.readTextFile(path);
            const assets = await collectGltfAssets(path, text);
            return loadGLTF(textToArrayBuffer(text), assets);
        }
        case 'glb':
            return loadGLTF(base64ToArrayBuffer(await fs.readBase64File(path)), new Map());
        case 'obj': {
            const text = await fs.readTextFile(path);
            const assets = await collectObjAssets(path, text);
            return loadOBJ(text, assets);
        }
        case 'stl':
            return loadSTL(base64ToArrayBuffer(await fs.readBase64File(path)), name);
        case 'ply':
            return loadPLY(base64ToArrayBuffer(await fs.readBase64File(path)), name);
        case 'fbx':
            return loadFBX(base64ToArrayBuffer(await fs.readBase64File(path)));
    }
}

async function loadGLTF(buf: ArrayBuffer, assets: Map<string, Blob>): Promise<Object3D> {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

    const { manager, blobMap } = createAssetManager(assets);

    const loader = new GLTFLoader(manager);

    return new Promise((resolve, reject) => {
        loader.parse(
            buf,
            '',
            (gltf: { scene: Object3D; animations?: AnimationClip[] }) => {
                blobMap.forEach((url) => URL.revokeObjectURL(url));
                attachAnimationsTo(gltf.scene, gltf.animations);
                resolve(gltf.scene);
            },
            (err: unknown) => {
                blobMap.forEach((url) => URL.revokeObjectURL(url));
                reject(new Error(`GLTF 解析失败: ${(err as any)?.message ?? err}`));
            },
        );
    });
}

function buildAssetMapFromFiles(mainFile: File, allFiles: File[]): Map<string, Blob> {
    const assets = new Map<string, Blob>();
    for (const file of allFiles) {
        if (file === mainFile) continue;
        assets.set(file.name, file);
        if (file.webkitRelativePath) assets.set(file.webkitRelativePath, file);
    }
    return assets;
}

async function loadOBJ(text: string, assets: Map<string, Blob>): Promise<Object3D> {
    const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
        import('three/examples/jsm/loaders/OBJLoader.js'),
        import('three/examples/jsm/loaders/MTLLoader.js'),
    ]);

    const { manager, blobMap } = createAssetManager(assets);
    try {
        const loader = new OBJLoader(manager);
        const materialText = await collectObjMaterialText(text, assets);
        const assetsReady = waitForLoadingManager(manager);

        if (materialText) {
            const materials = new MTLLoader(manager).parse(materialText, '');
            materials.preload();
            loader.setMaterials(materials);
        }

        const obj = loader.parse(text);
        await assetsReady;
        finalizeObjectMaterials(obj);
        attachObjectUrlsToModel(obj, blobMap);
        return obj;
    } catch (error) {
        blobMap.forEach((url) => URL.revokeObjectURL(url));
        throw error;
    }
}

function waitForLoadingManager(manager: LoadingManager): Promise<void> {
    const previousOnStart = manager.onStart;
    const previousOnLoad = manager.onLoad;
    const previousOnError = manager.onError;
    let started = false;

    return new Promise((resolve) => {
        const done = () => {
            manager.onStart = previousOnStart;
            manager.onLoad = previousOnLoad;
            manager.onError = previousOnError;
            resolve();
        };

        manager.onStart = (...args) => {
            started = true;
            previousOnStart?.(...args);
        };
        manager.onLoad = () => {
            previousOnLoad?.();
            done();
        };
        manager.onError = (url) => {
            previousOnError?.(url);
        };

        queueMicrotask(() => {
            if (!started) done();
        });
    });
}

async function loadSTL(buf: ArrayBuffer, name: string): Promise<Object3D> {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const geometry = new STLLoader().parse(buf);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, defaultMaterial());
    mesh.name = name;
    return mesh;
}

async function loadPLY(buf: ArrayBuffer, name: string): Promise<Object3D> {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    const geometry = new PLYLoader().parse(buf);

    if (geometry.getIndex() || geometry.attributes.position.count % 3 === 0) {
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        const hasColor = !!geometry.attributes.color;
        const mesh = new Mesh(
            geometry,
            hasColor
                ? new MeshStandardMaterial({ vertexColors: true, metalness: 0.0, roughness: 0.85 })
                : defaultMaterial(),
        );
        mesh.name = name;
        return mesh;
    }

    const points = new Points(
        geometry,
        new PointsMaterial({
            size: 0.01,
            vertexColors: !!geometry.attributes.color,
            color: 0x4b8dfb,
            sizeAttenuation: true,
        }),
    );
    points.name = name;
    return points;
}

async function loadFBX(buf: ArrayBuffer): Promise<Object3D> {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const root = new FBXLoader().parse(buf, '');
    attachAnimationsTo(root, (root as Object3D & { animations?: AnimationClip[] }).animations);
    return root;
}

function attachAnimationsTo(target: Object3D, animations: AnimationClip[] | undefined): void {
    if (!animations || animations.length === 0) return;
    target.userData = target.userData ?? {};
    target.userData.animations = animations;
}

function defaultMaterial(): MeshStandardMaterial {
    return new MeshStandardMaterial({
        color: 0xaab3c0,
        metalness: 0.05,
        roughness: 0.7,
        side: DoubleSide,
        flatShading: false,
    });
}

async function collectGltfAssets(mainPath: string, text: string): Promise<Map<string, Blob>> {
    const assets = new Map<string, Blob>();
    const directory = dirNameOf(mainPath);

    for (const asset of collectExternalGltfAssets(text)) {
        const uri = asset.uri;
        const fullPath = resolveNativePath(directory, uri);
        try {
            const base64 = await fs.readBase64File(fullPath);
            assets.set(uri, new Blob([base64ToArrayBuffer(base64)]));
        } catch (error) {
            if (asset.required) throw error;
            // Missing textures should not prevent geometry from loading.
        }
    }

    return assets;
}

async function collectObjAssets(mainPath: string, objText: string): Promise<Map<string, Blob>> {
    const assets = new Map<string, Blob>();
    const objDirectory = dirNameOf(mainPath);

    for (const materialRef of collectObjMaterialLibs(objText)) {
        const materialPath = resolveNativePath(objDirectory, materialRef);
        let materialText = '';
        try {
            materialText = await fs.readTextFile(materialPath);
        } catch {
            continue;
        }

        const normalizedMaterialDir = normalizeAssetDir(dirNameOfRelative(materialRef));
        const rewrittenMaterialText = rewriteMtlTextureUris(materialText, normalizedMaterialDir);
        assets.set(materialRef, new Blob([rewrittenMaterialText], { type: 'text/plain' }));

        const materialBaseDir = dirNameOf(materialPath);
        for (const textureRef of collectMtlTextureUris(rewrittenMaterialText)) {
            const texturePath = resolveNativePath(materialBaseDir, stripRelativePrefix(textureRef, normalizedMaterialDir));
            try {
                const base64 = await fs.readBase64File(texturePath);
                assets.set(textureRef, new Blob([base64ToArrayBuffer(base64)]));
            } catch {
                // Ignore missing textures so the OBJ can still load with partial materials.
            }
        }
    }

    return assets;
}

function collectExternalGltfAssets(text: string): Array<{ uri: string; required: boolean }> {
    try {
        const gltf = JSON.parse(text) as {
            buffers?: Array<{ uri?: string }>;
            images?: Array<{ uri?: string }>;
        };
        const assets = new Map<string, { uri: string; required: boolean }>();
        for (const item of gltf.buffers ?? []) {
            const uri = item?.uri?.trim();
            if (!isExternalGltfUri(uri)) continue;
            assets.set(uri, { uri, required: true });
        }
        for (const item of gltf.images ?? []) {
            const uri = item?.uri?.trim();
            if (!isExternalGltfUri(uri) || assets.has(uri)) continue;
            assets.set(uri, { uri, required: false });
        }
        return [...assets.values()];
    } catch (error) {
        throw new Error(`GLTF 清单解析失败: ${(error as Error)?.message ?? String(error)}`);
    }
}

function isExternalGltfUri(uri: string | undefined): uri is string {
    return Boolean(uri)
        && !uri!.startsWith('data:')
        && !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(uri!);
}

function collectObjMaterialLibs(text: string): string[] {
    const refs = new Set<string>();
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = stripComment(rawLine).trim();
        if (!line.toLowerCase().startsWith('mtllib ')) continue;
        const rest = line.slice(7).trim();
        if (!rest) continue;
        for (const item of splitMtlReferences(rest)) {
            if (item) refs.add(item);
        }
    }
    return [...refs];
}

async function collectObjMaterialText(text: string, assets: Map<string, Blob>): Promise<string> {
    const blocks: string[] = [];
    for (const materialRef of collectObjMaterialLibs(text)) {
        const asset = lookupAsset(assets, materialRef);
        if (!asset) continue;
        blocks.push(await asset.text());
    }
    return blocks.join('\n');
}

function collectMtlTextureUris(text: string): string[] {
    const refs = new Set<string>();
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = stripComment(rawLine).trim();
        if (!line) continue;
        const firstSpace = line.indexOf(' ');
        if (firstSpace <= 0) continue;
        const keyword = line.slice(0, firstSpace).toLowerCase();
        if (!isMtlTextureKeyword(keyword)) continue;
        const remainder = line.slice(firstSpace + 1).trim();
        const uri = parseMtlResourceUri(remainder);
        if (uri) refs.add(uri);
    }
    return [...refs];
}

function rewriteMtlTextureUris(text: string, baseDir: string): string {
    if (!baseDir) return text;

    return text.split(/\r?\n/u).map((rawLine) => {
        const line = stripComment(rawLine);
        const trimmed = line.trim();
        if (!trimmed) return rawLine;

        const firstSpace = trimmed.indexOf(' ');
        if (firstSpace <= 0) return rawLine;

        const keyword = trimmed.slice(0, firstSpace).toLowerCase();
        if (!isMtlTextureKeyword(keyword)) return rawLine;

        const remainder = trimmed.slice(firstSpace + 1).trim();
        const uri = parseMtlResourceUri(remainder);
        if (!uri || isAbsoluteResourcePath(uri)) return rawLine;

        const prefixed = joinAssetPath(baseDir, uri);
        const marker = rawLine.lastIndexOf(uri);
        if (marker < 0) return rawLine;
        return `${rawLine.slice(0, marker)}${prefixed}${rawLine.slice(marker + uri.length)}`;
    }).join('\n');
}

function textToArrayBuffer(text: string): ArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    return new Uint8Array(bytes).buffer;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const bytes = base64ToBytes(base64);
    return new Uint8Array(bytes).buffer;
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function normalizeAssetKey(value: string): string {
    return decodeURIComponent(value)
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
}

function normalizeAssetDir(value: string): string {
    const normalized = normalizeAssetKey(value).replace(/\/+$/u, '');
    return normalized;
}

function dirNameOf(path: string): string {
    const normalized = path.replaceAll('/', '\\');
    const index = normalized.lastIndexOf('\\');
    return index >= 0 ? normalized.slice(0, index) : '';
}

function fileNameOf(path: string): string {
    const normalized = path.replaceAll('/', '\\');
    const index = normalized.lastIndexOf('\\');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function dirNameOfRelative(path: string): string {
    const normalized = normalizeAssetKey(path);
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(0, index) : '';
}

function resolveNativePath(baseDir: string, relativePath: string): string {
    const raw = decodeURIComponent(relativePath).replaceAll('/', '\\');
    if (/^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')) return raw;

    const segments = baseDir.replaceAll('/', '\\').split('\\').filter(Boolean);
    const prefix = /^[a-zA-Z]:$/.test(segments[0] ?? '') ? `${segments.shift()}\\` : '';
    for (const segment of raw.split('\\')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (segments.length > 0) segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return prefix + segments.join('\\');
}

function createAssetManager(assets: Map<string, Blob>): {
    manager: LoadingManager;
    blobMap: Map<string, string>;
} {
    const manager = new LoadingManager();
    const blobMap = new Map<string, string>();

    for (const [key, asset] of assets) {
        const normalized = normalizeAssetKey(key);
        if (!normalized || blobMap.has(normalized)) continue;
        const url = URL.createObjectURL(asset);
        blobMap.set(normalized, url);

        const baseName = normalizeAssetKey(fileNameOf(normalized));
        if (baseName && !blobMap.has(baseName)) blobMap.set(baseName, url);
    }

    manager.setURLModifier((url: string) => {
        const normalized = normalizeAssetKey(url);
        const exact = blobMap.get(normalized);
        if (exact) return exact;

        const baseName = normalizeAssetKey(fileNameOf(normalized));
        const byName = blobMap.get(baseName);
        if (byName) return byName;

        for (const [key, objectUrl] of blobMap) {
            if (normalized.endsWith(`/${key}`) || key.endsWith(`/${normalized}`)) return objectUrl;
        }

        return url;
    });
    return { manager, blobMap };
}

function attachObjectUrlsToModel(root: Object3D, blobMap: Map<string, string>): void {
    const urls = [...new Set(blobMap.values())];
    if (urls.length === 0) return;
    root.userData = root.userData ?? {};
    root.userData.__assetObjectUrls = [
        ...new Set([
            ...(Array.isArray(root.userData.__assetObjectUrls) ? root.userData.__assetObjectUrls : []),
            ...urls,
        ]),
    ];
}

function lookupAsset(assets: Map<string, Blob>, key: string): Blob | null {
    const normalized = normalizeAssetKey(key);
    if (assets.has(key)) return assets.get(key) ?? null;
    if (assets.has(normalized)) return assets.get(normalized) ?? null;

    const baseName = normalizeAssetKey(fileNameOf(normalized));
    if (assets.has(baseName)) return assets.get(baseName) ?? null;

    for (const [assetKey, asset] of assets) {
        const normalizedAssetKey = normalizeAssetKey(assetKey);
        if (normalizedAssetKey === normalized || normalizedAssetKey === baseName) return asset;
    }
    return null;
}

function finalizeObjectMaterials(obj: Object3D): void {
    obj.traverse((node: Object3D) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;

        if (!mesh.material) {
            mesh.material = defaultMaterial();
            return;
        }

        if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((material) => material ?? defaultMaterial());
        }
    });
}

function stripComment(line: string): string {
    const index = line.indexOf('#');
    return index >= 0 ? line.slice(0, index) : line;
}

function splitMtlReferences(value: string): string[] {
    const matches = value.match(/"[^"]+"|'[^']+'|\S+/gu) ?? [];
    return matches.map(unquote).filter(Boolean);
}

function parseMtlResourceUri(value: string): string | null {
    const tokens = tokenizeWithQuotes(value);
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const lower = token.toLowerCase();
        if (!lower.startsWith('-')) {
            return tokens.slice(index).join(' ').trim() || null;
        }

        const skip = MTL_OPTION_ARG_COUNTS[lower] ?? 0;
        index += skip;
    }
    return null;
}

function tokenizeWithQuotes(value: string): string[] {
    const matches = value.match(/"[^"]+"|'[^']+'|\S+/gu) ?? [];
    return matches.map(unquote);
}

function unquote(value: string): string {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

function isMtlTextureKeyword(keyword: string): boolean {
    return MTL_TEXTURE_KEYWORDS.has(keyword);
}

function isAbsoluteResourcePath(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/u.test(value) || value.startsWith('/') || value.startsWith('\\');
}

function joinAssetPath(baseDir: string, relativePath: string): string {
    const left = normalizeAssetDir(baseDir);
    const right = normalizeAssetKey(relativePath).replace(/^\/+/u, '');
    if (!left) return right;
    if (!right) return left;
    return `${left}/${right}`;
}

function stripRelativePrefix(value: string, prefix: string): string {
    const normalizedValue = normalizeAssetKey(value);
    const normalizedPrefix = normalizeAssetDir(prefix);
    if (!normalizedPrefix) return normalizedValue;
    if (normalizedValue === normalizedPrefix) return '';
    if (normalizedValue.startsWith(`${normalizedPrefix}/`)) {
        return normalizedValue.slice(normalizedPrefix.length + 1);
    }
    return normalizedValue;
}

const MTL_TEXTURE_KEYWORDS = new Set([
    'map_ka',
    'map_kd',
    'map_ks',
    'map_ke',
    'map_ns',
    'map_d',
    'map_bump',
    'bump',
    'disp',
    'decal',
    'norm',
    'refl',
]);

const MTL_OPTION_ARG_COUNTS: Record<string, number> = {
    '-blendu': 1,
    '-blendv': 1,
    '-boost': 1,
    '-mm': 2,
    '-o': 3,
    '-s': 3,
    '-t': 3,
    '-texres': 1,
    '-clamp': 1,
    '-bm': 1,
    '-imfchan': 1,
    '-type': 1,
    '-colorspace': 1,
};
