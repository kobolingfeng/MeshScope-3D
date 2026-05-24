// viewer.ts — Three.js 场景封装
import {
    ACESFilmicToneMapping,
    AdditiveAnimationBlendMode,
    AnimationAction,
    AnimationClip,
    AnimationMixer,
    AxesHelper,
    Bone,
    BufferAttribute,
    BufferGeometry,
    Box3,
    Clock,
    Color,
    DoubleSide,
    DirectionalLight,
    Euler,
    FrontSide,
    Group,
    GridHelper,
    HemisphereLight,
    Line,
    LineBasicMaterial,
    LoopOnce,
    LoopRepeat,
    Material,
    Mesh,
    MeshBasicMaterial,
    NormalAnimationBlendMode,
    NumberKeyframeTrack,
    Object3D,
    PerspectiveCamera,
    Quaternion,
    QuaternionKeyframeTrack,
    Raycaster,
    RepeatWrapping,
    SRGBColorSpace,
    Scene,
    SkeletonHelper,
    SphereGeometry,
    Texture,
    Vector2,
    Vector3,
    VectorKeyframeTrack,
    WebGLRenderer,
} from 'three';
import type { KeyframeTrack } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

const DEFAULT_BONE_ROTATION_STEP_RADIANS = Math.PI / 90;
const DEFAULT_BONE_TRANSLATION_STEP_RATIO = 0.005;

export type MaterialEditMode = 'original' | 'solid' | 'xray';
export type TextureSlotId =
    | 'map'
    | 'normalMap'
    | 'roughnessMap'
    | 'metalnessMap'
    | 'emissiveMap'
    | 'alphaMap'
    | 'aoMap'
    | 'bumpMap';

export type TextureTransform = {
    offsetX: number;
    offsetY: number;
    repeatX: number;
    repeatY: number;
    rotation: number;
};

export type TextureSlotState = TextureTransform & {
    slot: TextureSlotId;
    label: string;
    hasTexture: boolean;
    textureCount: number;
    width: number | null;
    height: number | null;
    previewUrl: string | null;
    imageSource: CanvasImageSource | null;
    sourceName: string;
};

export type UvLayoutState = {
    hasUv: boolean;
    segments: Float32Array;
};

export type UvPointState = {
    id: number;
    x: number;
    y: number;
    islandId: number;
};

export type UvTriangleState = {
    a: number;
    b: number;
    c: number;
    islandId: number;
};

export type UvEditorState = {
    hasUv: boolean;
    points: UvPointState[];
    triangles: UvTriangleState[];
    segments: Float32Array;
    islandCount: number;
};

export type AnimationClipMeta = {
    index: number;
    name: string;
    duration: number;
    tracks: number;
    lazy?: boolean;
};

export type LazyAnimationClipSource = {
    type: 'large-glb-animation';
    path: string;
    index: number;
    name: string;
    duration: number;
    tracks: number;
};

export type AnimationPlaybackState = {
    hasAnimations: boolean;
    clips: AnimationClipMeta[];
    activeIndex: number;
    time: number;
    duration: number;
    playing: boolean;
    speed: number;
    loop: boolean;
    finished: boolean;
};

export type AnimationTrackProperty = 'position' | 'quaternion' | 'scale' | 'other';

export type AnimationTrackMeta = {
    index: number;
    name: string;
    target: string;
    property: AnimationTrackProperty;
    propertyLabel: string;
    valueSize: number;
    keyframes: number;
    editable: boolean;
};

export type AnimationEditorState = {
    hasAnimations: boolean;
    activeIndex: number;
    clipName: string;
    duration: number;
    tracks: AnimationTrackMeta[];
};

export type AnimationClipSnapshot = {
    clipIndex: number;
    clipName: string;
    duration: number;
    tracks: Array<{
        index: number;
        name: string;
        times: number[];
        values: number[];
    }>;
};

export type BonePoseSnapshot = {
    selectedBoneIndex: number;
    ikEnabled: boolean;
    transformMode: BoneTransformMode;
    transformSpace: BoneTransformSpace;
    ikTargetPosition: [number, number, number] | null;
    bones: Array<{
        index: number;
        uuid: string;
        name: string;
        position: [number, number, number];
        quaternion: [number, number, number, number];
        scale: [number, number, number];
    }>;
};

export type AnimationTrackVectorEdit = {
    x: number;
    y: number;
    z: number;
};

export type AnimationEasingCurve = [number, number, number, number];
export type AnimationBlendMode = 'normal' | 'additive';
export type BoneTransformMode = 'translate' | 'rotate';
export type BoneTransformSpace = 'local' | 'world';

export type SkeletonBoneMeta = {
    index: number;
    name: string;
    parentName: string;
    depth: number;
    selected: boolean;
};

export type AnimationTimelineMarker = {
    time: number;
    selectedBone: boolean;
};

export type SkeletonEditorState = {
    hasSkeleton: boolean;
    skeletonVisible: boolean;
    transformControlsVisible: boolean;
    bones: SkeletonBoneMeta[];
    selectedBoneIndex: number;
    selectedBoneName: string;
    transformMode: BoneTransformMode;
    transformSpace: BoneTransformSpace;
    ikEnabled: boolean;
    ikChainLength: number;
    keyframes: AnimationTimelineMarker[];
};

export type MaterialEditSnapshot = {
    mode: MaterialEditMode;
    visible: boolean;
    opacity: number;
    color: string;
    flatShading: boolean;
    doubleSided: boolean;
    roughness: number;
    metalness: number;
    colorOverride: boolean;
    flatOverride: boolean;
    doubleSidedOverride: boolean;
    roughnessOverride: boolean;
    metalnessOverride: boolean;
    textureTransforms: Partial<Record<TextureSlotId, TextureTransform>>;
};

type MaterialEditorState = MaterialEditSnapshot;

type UvPointRef = {
    attribute: BufferAttribute;
    uvIndex: number;
};

type UvEditorCache = {
    points: UvPointState[];
    triangles: UvTriangleState[];
    segments: Float32Array;
    refs: UvPointRef[];
    islandPointIds: number[][];
};

export class Viewer {
    readonly scene: Scene;
    readonly camera: PerspectiveCamera;
    readonly renderer: WebGLRenderer;
    readonly controls: OrbitControls;
    readonly modelGroup: Group;

    private grid: GridHelper;
    private axes: AxesHelper;
    private canvas: HTMLCanvasElement;
    private resizeObserver: ResizeObserver;

    private frameCount = 0;
    private lastFpsTs = performance.now();
    onFps: (fps: number) => void = () => {};
    onRender: () => void = () => {};
    onAnimationTick: (state: AnimationPlaybackState) => void = () => {};
    onAnimationsChanged: (state: AnimationPlaybackState) => void = () => {};
    onSkeletonChanged: (state: SkeletonEditorState) => void = () => {};
    onBonePoseEditStarted: () => void = () => {};
    onBonePoseEdited: () => void = () => {};

    private animClock = new Clock();
    private mixer: AnimationMixer | null = null;
    private mixerRoot: Object3D | null = null;
    private animClips: AnimationClip[] = [];
    private animClipMetas: AnimationClipMeta[] = [];
    private animationEditorCache: {
        clip: AnimationClip;
        index: number;
        trackCount: number;
        tracks: AnimationTrackMeta[];
    } | null = null;
    private timelineMarkerCache: {
        clip: AnimationClip;
        selectedBone: Bone | null;
        trackCount: number;
        markers: AnimationTimelineMarker[];
    } | null = null;
    private activeAction: AnimationAction | null = null;
    private activeClipIndex = -1;
    private animationPlaying = false;
    private animationSpeed = 1;
    private animationLoop = true;
    private animationBlendMode: AnimationBlendMode = 'normal';
    private animationFinished = false;
    private lastReportedTime = -1;

    private skeletonVisible = false;
    private transformControlsVisible = true;
    private skeletonEditorActivated = false;
    private skeletonHelper: SkeletonHelper | null = null;
    private bones: Bone[] = [];
    private boneMetaBase: Array<Omit<SkeletonBoneMeta, 'selected'>> = [];
    private boneRestPose = new Map<Bone, { position: Vector3; quaternion: Quaternion; scale: Vector3 }>();
    private selectedBone: Bone | null = null;
    private boneHandles = new Map<Bone, Mesh>();
    private boneLines = new Map<Bone, Line[]>();
    private handleToBone = new WeakMap<Object3D, Bone>();
    private lineToBone = new WeakMap<Object3D, Bone>();
    private boneHandleGeometry = new SphereGeometry(1, 16, 12);
    private boneHandleMaterial = new MeshBasicMaterial({
        color: 0x000000,
        depthTest: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
    });
    private selectedBoneHandleMaterial = new MeshBasicMaterial({
        color: 0x000000,
        depthTest: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
    });
    private boneLineMaterial = new LineBasicMaterial({
        color: 0x1378d1,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
        linewidth: 3,
    });
    private selectedBoneLineMaterial = new LineBasicMaterial({
        color: 0xff2a6d,
        depthTest: false,
        transparent: true,
        opacity: 1,
        linewidth: 6,
    });
    private fkChildLineMaterial = new LineBasicMaterial({
        color: 0xffb000,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
        linewidth: 5,
    });
    private ikChainLineMaterial = new LineBasicMaterial({
        color: 0x22c55e,
        depthTest: false,
        transparent: true,
        opacity: 0.98,
        linewidth: 5,
    });
    private ikTargetMaterial = new MeshBasicMaterial({
        color: 0x2fb37a,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
    });
    private raycaster = new Raycaster();
    private pointerNdc = new Vector2();
    private transformControls: TransformControls;
    private boneTransformMode: BoneTransformMode = 'rotate';
    private boneTransformSpace: BoneTransformSpace = 'local';
    private boneRotationStepRadians = DEFAULT_BONE_ROTATION_STEP_RADIANS;
    private boneTranslationStepRatio = DEFAULT_BONE_TRANSLATION_STEP_RATIO;
    private transformDragging = false;
    private transformChangedDuringDrag = false;
    private ikEnabled = false;
    private ikChainMaxLength = 4;
    private ikTarget: Object3D | null = null;
    private ikTargetMesh: Mesh | null = null;
    private ikChain: Bone[] = [];

    private wireframe = false;
    private currentBg = new Color(0xf2f5f8);
    private materialSnapshots = new WeakMap<Object3D, Material | Material[]>();
    private materialStates = new WeakMap<Object3D, MaterialEditorState>();
    private texturePreviewCache = new WeakMap<Texture, string>();
    private textureDrawableCache = new WeakMap<Texture, CanvasImageSource>();
    private uvEditorCache = new WeakMap<Object3D, UvEditorCache>();
    private boundsCache = new WeakMap<Object3D, { size: Vector3; center: Vector3 }>();

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;

        this.renderer = new WebGLRenderer({
            canvas,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.toneMapping = ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        this.scene = new Scene();
        this.scene.background = this.currentBg;

        this.camera = new PerspectiveCamera(45, 1, 0.01, 10000);
        this.camera.position.set(4, 3, 5);

        const hemi = new HemisphereLight(0xffffff, 0x202428, 1.0);
        hemi.position.set(0, 20, 0);
        this.scene.add(hemi);

        const dir = new DirectionalLight(0xffffff, 1.2);
        dir.position.set(5, 10, 7.5);
        this.scene.add(dir);

        const dir2 = new DirectionalLight(0xffffff, 0.4);
        dir2.position.set(-5, -2, -5);
        this.scene.add(dir2);

        this.grid = new GridHelper(10, 20, 0x333b47, 0x222831);
        (this.grid.material as Material).transparent = true;
        (this.grid.material as Material).opacity = 0.5;
        this.scene.add(this.grid);

        this.axes = new AxesHelper(1.5);
        this.scene.add(this.axes);

        this.modelGroup = new Group();
        this.modelGroup.name = '__models__';
        this.scene.add(this.modelGroup);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.screenSpacePanning = true;
        this.controls.minDistance = 0.01;
        this.controls.maxDistance = 5000;

        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.setMode(this.boneTransformMode);
        this.transformControls.setSpace(this.boneTransformSpace);
        this.transformControls.visible = false;
        this.scene.add(this.transformControls);
        this.transformControls.addEventListener('dragging-changed', (event) => {
            const dragging = Boolean(event.value);
            this.transformDragging = dragging;
            this.controls.enabled = !dragging;
            if (dragging) {
                this.transformChangedDuringDrag = false;
                this.pauseAnimation();
                this.onBonePoseEditStarted();
            } else {
                if (this.transformChangedDuringDrag) this.autoKeyframeCurrentBonePose();
                this.transformChangedDuringDrag = false;
                this.onBonePoseEdited();
            }
        });
        this.transformControls.addEventListener('objectChange', () => {
            if (this.transformDragging) this.transformChangedDuringDrag = true;
            if (this.ikEnabled) this.solveIk();
            this.refreshActiveRootMatrices();
            this.updateSkeletonOverlay();
            this.onSkeletonChanged(this.getSkeletonEditorState());
        });
        this.canvas.addEventListener('pointerdown', (event) => this.handleSkeletonPointerDown(event), true);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas.parentElement || canvas);
        this.resize();

        this.renderer.setAnimationLoop(() => this.tick());
    }

    private resize(): void {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        if (w === 0 || h === 0) return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    private tick(): void {
        const delta = this.animClock.getDelta();
        if (this.mixer && this.animationPlaying) {
            this.mixer.update(delta);
            const t = this.activeAction?.time ?? 0;
            // 30 Hz UI throttle for animation callbacks — viewport renders at full FPS,
            // but DOM/timeline updates don't need more than that and saved noticeable CPU.
            if (Math.abs(t - this.lastReportedTime) > 1 / 30) {
                this.lastReportedTime = t;
                this.onAnimationTick(this.getAnimationState());
            }
        }

        this.controls.update();
        if (this.bones.length > 0 && this.shouldUpdateSkeletonOverlay()) this.updateSkeletonOverlay();
        this.onRender();
        this.renderer.render(this.scene, this.camera);

        this.frameCount++;
        const now = performance.now();
        if (now - this.lastFpsTs >= 500) {
            const fps = (this.frameCount * 1000) / (now - this.lastFpsTs);
            this.onFps(fps);
            this.frameCount = 0;
            this.lastFpsTs = now;
        }
    }

    addModel(object: Object3D, opts: { fit?: boolean } = { fit: true }): void {
        this.modelGroup.add(object);
        if (opts.fit) this.frameObject(object);
        if (this.wireframe) this.applyWireframe(object, true);
        this.attachAnimations(object);
        this.attachSkeletonEditor(object);
    }

    detachModels(): Object3D[] {
        this.disposeSkeletonEditor();
        this.disposeAnimations();
        const children = [...this.modelGroup.children];
        for (const child of children) {
            this.modelGroup.remove(child);
        }
        return children;
    }

    setActiveModel(object: Object3D | null, opts: { fit?: boolean } = { fit: true }): void {
        this.detachModels();
        if (object) this.addModel(object, opts);
        else this.resetView();
    }

    clearScene(): void {
        for (const child of this.detachModels()) {
            this.disposeModel(child);
        }
    }

    disposeModel(obj: Object3D): void {
        const closedImages = new Set<ImageBitmap>();
        revokeModelObjectUrls(obj);
        obj.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh && !(mesh as any).isPoints && !(mesh as any).isLine) return;
            const snapshot = this.materialSnapshots.get(node);
            if (snapshot) {
                disposeMaterialSet(snapshot, { closeImages: true, closedImages });
                this.materialSnapshots.delete(node);
            }
            mesh.geometry?.dispose();
            disposeMaterialSet(mesh.material, { closeImages: true, closedImages });
        });
        this.materialStates.delete(obj);
        this.uvEditorCache.delete(obj);
        this.boundsCache.delete(obj);
    }

    frameObject(object: Object3D): void {
        const box = new Box3().setFromObject(object);
        if (box.isEmpty()) return;

        const size = box.getSize(new Vector3());
        const center = box.getCenter(new Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const fov = (this.camera.fov * Math.PI) / 180;
        const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.7;

        const dir = new Vector3(1, 0.7, 1).normalize();
        this.camera.position.copy(center).addScaledVector(dir, dist);
        this.camera.near = Math.max(dist / 1000, 0.001);
        this.camera.far = dist * 100;
        this.camera.updateProjectionMatrix();

        this.controls.target.copy(center);
        this.controls.update();
        this.updateGridScale(maxDim);
    }

    resetView(): void {
        if (this.modelGroup.children.length > 0) {
            const box = new Box3();
            for (const child of this.modelGroup.children) box.expandByObject(child);
            if (!box.isEmpty()) {
                this.frameObject(this.modelGroup);
                return;
            }
        }
        this.camera.position.set(4, 3, 5);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    private updateGridScale(maxDim: number): void {
        const base = Math.pow(10, Math.ceil(Math.log10(maxDim * 2)));

        if (this.grid.parent) this.scene.remove(this.grid);
        this.grid.geometry.dispose();
        disposeMaterialSet(this.grid.material);
        const nextGrid = new GridHelper(base, 20, 0x333b47, 0x222831);
        (nextGrid.material as Material).transparent = true;
        (nextGrid.material as Material).opacity = 0.5;
        nextGrid.visible = this.grid.visible;
        this.grid = nextGrid;
        this.scene.add(this.grid);

        if (this.axes.parent) this.scene.remove(this.axes);
        this.axes.dispose();
        this.axes = new AxesHelper(base * 0.15);
        this.axes.visible = this.grid.visible || this.axes.visible;
        this.scene.add(this.axes);
    }

    setWireframe(on: boolean): void {
        this.wireframe = on;
        this.applyWireframe(this.modelGroup, on);
    }

    private applyWireframe(root: Object3D, on: boolean): void {
        root.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh) return;
            const mat = mesh.material;
            if (Array.isArray(mat)) mat.forEach((item) => ((item as any).wireframe = on));
            else if (mat) (mat as any).wireframe = on;
        });
    }

    getCameraState(): {
        fov: number;
        exposure: number;
        position: Vector3;
        target: Vector3;
    } {
        return {
            fov: this.camera.fov,
            exposure: this.renderer.toneMappingExposure,
            position: this.camera.position.clone(),
            target: this.controls.target.clone(),
        };
    }

    setCameraFov(fov: number): void {
        this.camera.fov = Math.min(90, Math.max(20, fov));
        this.camera.updateProjectionMatrix();
    }

    setExposure(exposure: number): void {
        this.renderer.toneMappingExposure = Math.min(2.5, Math.max(0.4, exposure));
    }

    setViewPreset(preset: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'): void {
        const bounds = this.getModelBounds();
        const center = bounds?.center ?? new Vector3();
        const size = bounds?.size ?? new Vector3(1, 1, 1);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const fov = (this.camera.fov * Math.PI) / 180;
        const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.9;

        const direction = preset === 'front'
            ? new Vector3(0, 0, 1)
            : preset === 'back'
                ? new Vector3(0, 0, -1)
                : preset === 'left'
                    ? new Vector3(-1, 0, 0)
                    : preset === 'right'
                        ? new Vector3(1, 0, 0)
                        : preset === 'top'
                            ? new Vector3(0, 1, 0.01)
                            : preset === 'bottom'
                                ? new Vector3(0, -1, 0.01)
                                : new Vector3(1, 0.7, 1).normalize();

        this.camera.position.copy(center).addScaledVector(direction.normalize(), dist);
        this.controls.target.copy(center);
        this.controls.update();
    }

    setCameraPose(position: Vector3, target: Vector3): void {
        this.camera.position.copy(position);
        this.controls.target.copy(target);
        this.controls.update();
    }

    getModelBounds(): { size: Vector3; center: Vector3 } | null {
        if (this.modelGroup.children.length === 0) return null;
        return this.getBoundsFor(this.modelGroup);
    }

    getBoundsFor(root: Object3D): { size: Vector3; center: Vector3 } | null {
        const cached = this.boundsCache.get(root);
        if (cached) {
            return {
                size: cached.size.clone(),
                center: cached.center.clone(),
            };
        }

        const box = new Box3().setFromObject(root);
        if (box.isEmpty()) return null;
        const bounds = {
            size: box.getSize(new Vector3()),
            center: box.getCenter(new Vector3()),
        };
        this.boundsCache.set(root, {
            size: bounds.size.clone(),
            center: bounds.center.clone(),
        });
        return bounds;
    }

    setGridVisible(on: boolean): void { this.grid.visible = on; }
    setAxesVisible(on: boolean): void { this.axes.visible = on; }

    setLightBackground(light: boolean): void {
        this.currentBg.set(light ? 0xe8ecf0 : 0x111418);
        this.scene.background = this.currentBg;
    }

    getMaterialState(): {
        hasMaterial: boolean;
        visible: boolean;
        opacity: number;
        flatShading: boolean;
        color: string;
        mode: MaterialEditMode;
        doubleSided: boolean;
        roughness: number;
        metalness: number;
    } {
        const root = this.getActiveRoot();
        if (!root) {
            return {
                hasMaterial: false,
                visible: false,
                opacity: 1,
                flatShading: false,
                color: '#aab3c0',
                mode: 'original',
                doubleSided: false,
                roughness: 0.82,
                metalness: 0.02,
            };
        }

        const state = this.ensureMaterialEditorState(root);

        return {
            hasMaterial: this.hasRenderableMaterial(root),
            visible: state.visible,
            opacity: state.opacity,
            flatShading: state.flatShading,
            color: state.color,
            mode: state.mode,
            doubleSided: state.doubleSided,
            roughness: state.roughness,
            metalness: state.metalness,
        };
    }

    setModelVisible(on: boolean): void {
        const root = this.getActiveRoot();
        if (root) {
            const state = this.ensureMaterialEditorState(root);
            state.visible = on;
        }
        for (const child of this.modelGroup.children) {
            child.visible = on;
        }
    }

    setModelOpacity(opacity: number): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.opacity = Math.min(1, Math.max(0.1, opacity));
        this.applyMaterialEditorState(root);
    }

    setMaterialRoughness(roughness: number): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.roughness = clamp01(roughness);
        state.roughnessOverride = true;
        this.applyMaterialEditorState(root);
    }

    setMaterialMetalness(metalness: number): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.metalness = clamp01(metalness);
        state.metalnessOverride = true;
        this.applyMaterialEditorState(root);
    }

    setMaterialMode(mode: MaterialEditMode): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.mode = mode;
        if (mode === 'xray' && state.opacity > 0.72) state.opacity = 0.35;
        this.applyMaterialEditorState(root);
    }

    setDoubleSided(on: boolean): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.doubleSided = on;
        state.doubleSidedOverride = true;
        this.applyMaterialEditorState(root);
    }

    resetMaterialEdits(): void {
        const root = this.getActiveRoot();
        if (!root) return;
        this.materialStates.delete(root);
        const state = this.ensureMaterialEditorState(root);
        state.visible = true;
        root.visible = true;
        this.applyMaterialEditorState(root, { forceOriginal: true });
    }

    setModelColor(hex: string): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.color = hex;
        state.colorOverride = true;
        this.applyMaterialEditorState(root);
    }

    setFlatShading(on: boolean): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.flatShading = on;
        state.flatOverride = true;
        this.applyMaterialEditorState(root);
    }

    getMaterialEditSnapshot(): MaterialEditSnapshot | null {
        const root = this.getActiveRoot();
        if (!root) return null;
        return cloneMaterialEditSnapshot(this.ensureMaterialEditorState(root));
    }

    setMaterialEditSnapshot(snapshot: MaterialEditSnapshot): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const next = cloneMaterialEditSnapshot(snapshot);
        this.materialStates.set(root, next);
        root.visible = next.visible;
        this.applyMaterialEditorState(root);
    }

    getTextureState(): { hasTextures: boolean; slots: TextureSlotState[] } {
        const root = this.getActiveRoot();
        if (!root) return { hasTextures: false, slots: [] };

        const state = this.ensureMaterialEditorState(root);
        const slots = TEXTURE_SLOT_ORDER.map((slot) => {
            const textures = this.findTexturesInSnapshots(root, slot);
            const texture = textures[0] ?? null;
            const transform = state.textureTransforms[slot] ?? defaultTextureTransform();
            return {
                slot,
                label: TEXTURE_SLOT_LABELS[slot],
                hasTexture: Boolean(texture),
                textureCount: textures.length,
                width: getTextureWidth(texture),
                height: getTextureHeight(texture),
                previewUrl: texture ? this.getTexturePreviewUrl(texture) : null,
                imageSource: texture ? this.getTextureDrawableSource(texture) : null,
                sourceName: extractTextureSourceName(texture),
                ...transform,
            };
        }).filter((slot) => slot.hasTexture);

        return { hasTextures: slots.length > 0, slots };
    }

    getUvLayout(): UvLayoutState {
        const root = this.getActiveRoot();
        if (!root) return { hasUv: false, segments: new Float32Array() };

        const cached = this.getOrBuildUvEditorCache(root);
        return { hasUv: cached.points.length > 0, segments: cached.segments };
    }

    getUvEditorState(): UvEditorState {
        const root = this.getActiveRoot();
        if (!root) {
            return {
                hasUv: false,
                points: [],
                triangles: [],
                segments: new Float32Array(),
                islandCount: 0,
            };
        }

        const cache = this.getOrBuildUvEditorCache(root);
        return {
            hasUv: cache.points.length > 0,
            points: cache.points.map((point) => ({ ...point })),
            triangles: cache.triangles.map((triangle) => ({ ...triangle })),
            segments: cache.segments,
            islandCount: cache.islandPointIds.length,
        };
    }

    setUvPointPositions(updates: Array<{ pointId: number; x: number; y: number }>): void {
        const root = this.getActiveRoot();
        if (!root || updates.length === 0) return;

        const cache = this.getOrBuildUvEditorCache(root);
        const touched = new Set<BufferAttribute>();

        for (const update of updates) {
            const ref = cache.refs[update.pointId];
            const point = cache.points[update.pointId];
            if (!ref || !point) continue;

            ref.attribute.setXY(ref.uvIndex, update.x, update.y);
            touched.add(ref.attribute);
            point.x = update.x;
            point.y = update.y;
        }

        touched.forEach((attribute) => {
            attribute.needsUpdate = true;
        });
        cache.segments = buildUvSegmentsFromTriangles(cache.triangles, cache.points);
    }

    setTextureTransform(slot: TextureSlotId, partial: Partial<TextureTransform>): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        const current = state.textureTransforms[slot] ?? this.getSnapshotTextureTransform(root, slot);
        state.textureTransforms[slot] = {
            ...current,
            ...partial,
        };
        this.applyMaterialEditorState(root);
    }

    resetTextureTransform(slot: TextureSlotId): void {
        const root = this.getActiveRoot();
        if (!root) return;
        const state = this.ensureMaterialEditorState(root);
        state.textureTransforms[slot] = this.getSnapshotTextureTransform(root, slot);
        this.applyMaterialEditorState(root);
    }

    private getActiveRoot(): Object3D | null {
        return this.modelGroup.children[0] ?? null;
    }

    private ensureMaterialEditorState(
        root: Object3D,
        options: { forceRefresh?: boolean } = {},
    ): MaterialEditorState {
        if (options.forceRefresh) {
            root.traverse((node: Object3D) => {
                const mesh = node as Mesh;
                if (!mesh.isMesh) return;
                this.materialSnapshots.set(node, cloneMaterialSet(mesh.material));
            });
        } else {
            root.traverse((node: Object3D) => {
                const mesh = node as Mesh;
                if (!mesh.isMesh || this.materialSnapshots.has(node)) return;
                this.materialSnapshots.set(node, cloneMaterialSet(mesh.material));
            });
        }

        const existing = this.materialStates.get(root);
        if (existing && !options.forceRefresh) return existing;

        const primary = this.getPrimaryMaterial(root);
        const next: MaterialEditorState = {
            mode: 'original',
            visible: root.visible,
            opacity: extractMaterialOpacity(primary),
            color: extractMaterialColor(primary),
            flatShading: Boolean((primary as any)?.flatShading),
            doubleSided: extractDoubleSided(primary),
            roughness: extractMaterialScalar(primary, 'roughness', 0.82),
            metalness: extractMaterialScalar(primary, 'metalness', 0.02),
            colorOverride: false,
            flatOverride: false,
            doubleSidedOverride: false,
            roughnessOverride: false,
            metalnessOverride: false,
            textureTransforms: this.collectSnapshotTextureTransforms(root),
        };
        this.materialStates.set(root, next);
        return next;
    }

    private hasRenderableMaterial(root: Object3D): boolean {
        let found = false;
        root.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh || found) return;
            found = Boolean(mesh.material);
        });
        return found;
    }

    private getPrimaryMaterial(root: Object3D): Record<string, any> | null {
        let found: Record<string, any> | null = null;
        root.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh || found) return;
            const material = mesh.material as unknown;
            const primary = Array.isArray(material) ? material[0] : material;
            if (primary && typeof primary === 'object') found = primary as Record<string, any>;
        });
        return found;
    }

    private collectSnapshotTextureTransforms(root: Object3D): Partial<Record<TextureSlotId, TextureTransform>> {
        const transforms: Partial<Record<TextureSlotId, TextureTransform>> = {};
        for (const slot of TEXTURE_SLOT_ORDER) {
            const texture = this.findTextureInSnapshots(root, slot);
            if (!texture) continue;
            transforms[slot] = textureTransformOf(texture);
        }
        return transforms;
    }

    private getSnapshotTextureTransform(root: Object3D, slot: TextureSlotId): TextureTransform {
        const texture = this.findTextureInSnapshots(root, slot);
        return texture ? textureTransformOf(texture) : defaultTextureTransform();
    }

    private findTextureInSnapshots(root: Object3D, slot: TextureSlotId): Texture | null {
        return this.findTexturesInSnapshots(root, slot)[0] ?? null;
    }

    private findTexturesInSnapshots(root: Object3D, slot: TextureSlotId): Texture[] {
        const found: Texture[] = [];
        const seen = new Set<Texture>();
        root.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh) return;
            const snapshot = this.materialSnapshots.get(node);
            if (!snapshot) return;
            const materials = Array.isArray(snapshot) ? snapshot : [snapshot];
            for (const material of materials) {
                const candidate = getTextureSlot(material as unknown as Record<string, any>, slot);
                if (candidate && !seen.has(candidate)) {
                    seen.add(candidate);
                    found.push(candidate);
                }
            }
        });
        return found;
    }

    private getTexturePreviewUrl(texture: Texture): string | null {
        const cached = this.texturePreviewCache.get(texture);
        if (cached) return cached;

        const preview = buildTexturePreview(texture);
        if (preview) this.texturePreviewCache.set(texture, preview);
        return preview;
    }

    private getOrBuildUvEditorCache(root: Object3D): UvEditorCache {
        const existing = this.uvEditorCache.get(root);
        if (existing) return existing;

        const next = buildUvEditorCache(root);
        this.uvEditorCache.set(root, next);
        return next;
    }

    private getTextureDrawableSource(texture: Texture): CanvasImageSource | null {
        const cached = this.textureDrawableCache.get(texture);
        if (cached) return cached;

        const source = buildTextureDrawableSource(texture);
        if (source) this.textureDrawableCache.set(texture, source);
        return source;
    }

    private applyMaterialEditorState(
        root: Object3D,
        options: { forceOriginal?: boolean } = {},
    ): void {
        const state = this.ensureMaterialEditorState(root);
        root.visible = state.visible;

        root.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh) return;

            const snapshot = this.materialSnapshots.get(node);
            if (!snapshot) return;

            const nextMaterial = cloneMaterialSet(snapshot);
            const materials = Array.isArray(nextMaterial) ? nextMaterial : [nextMaterial];
            const sourceMaterials = Array.isArray(snapshot) ? snapshot : [snapshot];

            materials.forEach((material, index) => {
                const mutable = material as Record<string, any>;
                const sourceMaterial = (sourceMaterials[index] ?? sourceMaterials[0]) as unknown as Record<string, any>;

                if (!options.forceOriginal && state.mode !== 'original') {
                    stripMaterialTextures(mutable);
                    if (mutable.color?.isColor) mutable.color.set(state.color);
                    if (mutable.emissive?.isColor) {
                        mutable.emissive.set(state.mode === 'xray' ? state.color : '#000000');
                        if (typeof mutable.emissiveIntensity === 'number') {
                            mutable.emissiveIntensity = state.mode === 'xray' ? 0.28 : 0;
                        }
                    }
                    if (typeof mutable.roughness === 'number') mutable.roughness = state.roughness;
                    if (typeof mutable.metalness === 'number') mutable.metalness = state.metalness;
                } else {
                    if (state.colorOverride && mutable.color?.isColor) mutable.color.set(state.color);
                    if (state.flatOverride && typeof mutable.flatShading === 'boolean') mutable.flatShading = state.flatShading;
                    if (state.roughnessOverride && typeof mutable.roughness === 'number') mutable.roughness = state.roughness;
                    if (state.metalnessOverride && typeof mutable.metalness === 'number') mutable.metalness = state.metalness;
                }

                if (typeof mutable.opacity === 'number') {
                    mutable.opacity = state.opacity;
                    mutable.transparent = state.opacity < 0.999 || state.mode === 'xray';
                }

                if (typeof mutable.flatShading === 'boolean' && state.mode !== 'original') {
                    mutable.flatShading = state.flatShading;
                }

                if ('side' in mutable && (state.mode !== 'original' || state.doubleSidedOverride)) {
                    mutable.side = state.doubleSided || state.mode === 'xray' ? DoubleSide : FrontSide;
                }

                if (state.mode === 'xray') {
                    mutable.depthWrite = false;
                    if (mutable.color?.isColor) mutable.color.set(state.color);
                } else if ('depthWrite' in mutable) {
                    mutable.depthWrite = true;
                }

                applyTextureTransformsToMaterial(mutable, sourceMaterial, state.textureTransforms);
                mutable.needsUpdate = true;
            });

            disposeMaterialSet(mesh.material);
            mesh.material = nextMaterial;
        });
    }

    dispose(): void {
        this.resizeObserver.disconnect();
        this.renderer.setAnimationLoop(null);
        this.disposeSkeletonEditor();
        this.disposeAnimations();
        this.clearScene();
        this.grid.geometry.dispose();
        disposeMaterialSet(this.grid.material);
        this.axes.dispose();
        this.boneHandleGeometry.dispose();
        this.boneHandleMaterial.dispose();
        this.selectedBoneHandleMaterial.dispose();
        this.boneLineMaterial.dispose();
        this.selectedBoneLineMaterial.dispose();
        this.fkChildLineMaterial.dispose();
        this.ikChainLineMaterial.dispose();
        this.ikTargetMaterial.dispose();
        this.transformControls.dispose();
        this.controls.dispose();
        this.renderer.dispose();
    }

    getAnimationState(): AnimationPlaybackState {
        const clip = this.animClips[this.activeClipIndex];
        return {
            hasAnimations: this.animClips.length > 0,
            clips: this.animClipMetas.map((meta) => ({ ...meta })),
            activeIndex: this.activeClipIndex,
            time: this.activeAction?.time ?? 0,
            duration: clip?.duration ?? 0,
            playing: this.animationPlaying,
            speed: this.animationSpeed,
            loop: this.animationLoop,
            finished: this.animationFinished,
        };
    }

    getAnimationEditorState(): AnimationEditorState {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip) {
            return {
                hasAnimations: this.animClips.length > 0,
                activeIndex: this.activeClipIndex,
                clipName: '',
                duration: 0,
                tracks: [],
            };
        }

        return {
            hasAnimations: true,
            activeIndex: this.activeClipIndex,
            clipName: clip.name && clip.name.trim() ? clip.name : `Clip ${this.activeClipIndex + 1}`,
            duration: clip.duration,
            tracks: this.getCachedAnimationTrackMetas(clip),
        };
    }

    getSkeletonEditorState(options: { includeKeyframes?: boolean } = {}): SkeletonEditorState {
        const includeKeyframes = options.includeKeyframes ?? true;
        const selectedIndex = this.selectedBone ? this.bones.indexOf(this.selectedBone) : -1;
        const selectedName = this.selectedBone ? getBoneDisplayName(this.selectedBone, selectedIndex) : '';
        return {
            hasSkeleton: this.bones.length > 0,
            skeletonVisible: this.skeletonVisible,
            transformControlsVisible: this.transformControlsVisible,
            bones: this.boneMetaBase.map((bone) => ({
                ...bone,
                selected: bone.index === selectedIndex,
            })),
            selectedBoneIndex: selectedIndex,
            selectedBoneName: selectedName,
            transformMode: this.boneTransformMode,
            transformSpace: this.boneTransformSpace,
            ikEnabled: this.ikEnabled,
            ikChainLength: this.ikChainMaxLength,
            keyframes: includeKeyframes ? this.getTimelineMarkers() : [],
        };
    }

    setSkeletonVisible(visible: boolean): void {
        this.skeletonVisible = visible;
        if (visible) {
            this.skeletonEditorActivated = true;
            this.ensureSkeletonOverlay();
        }
        if (this.skeletonHelper) this.skeletonHelper.visible = false;
        for (const handle of this.boneHandles.values()) handle.visible = visible;
        for (const lines of this.boneLines.values()) {
            for (const line of lines) line.visible = visible;
        }
        this.attachTransformTarget();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    setTransformControlsVisible(visible: boolean): void {
        this.transformControlsVisible = visible;
        if (visible) this.skeletonEditorActivated = true;
        this.attachTransformTarget();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    selectBone(index: number): void {
        const bone = this.bones[index] ?? null;
        this.selectedBone = bone;
        this.timelineMarkerCache = null;
        this.refreshIkChain();
        this.attachTransformTarget();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    setBoneTransformMode(mode: BoneTransformMode): void {
        this.boneTransformMode = mode;
        if (!this.ikEnabled) this.transformControls.setMode(mode);
        this.attachTransformTarget();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    setBoneTransformSpace(space: BoneTransformSpace): void {
        this.boneTransformSpace = space;
        this.transformControls.setSpace(space);
        this.attachTransformTarget();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    setIkEnabled(enabled: boolean): void {
        this.ikEnabled = enabled && Boolean(this.selectedBone);
        this.refreshIkChain();
        this.attachTransformTarget();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    setIkChainLength(length: number): void {
        const next = Math.max(1, Math.min(12, Math.round(length)));
        if (next === this.ikChainMaxLength) return;
        this.ikChainMaxLength = next;
        this.refreshIkChain();
        if (this.ikEnabled) this.solveIk();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    setBoneStepSettings(settings: { rotationDegrees?: number; translationPercent?: number }): void {
        if (typeof settings.rotationDegrees === 'number' && Number.isFinite(settings.rotationDegrees)) {
            const degrees = Math.max(0.1, Math.min(45, settings.rotationDegrees));
            this.boneRotationStepRadians = degrees * Math.PI / 180;
        }
        if (typeof settings.translationPercent === 'number' && Number.isFinite(settings.translationPercent)) {
            const percent = Math.max(0.01, Math.min(10, settings.translationPercent));
            this.boneTranslationStepRatio = percent / 100;
        }
    }

    insertSelectedBoneKeyframe(): void {
        this.autoKeyframeCurrentBonePose();
    }

    insertSelectedBoneChainKeyframe(): number {
        const root = this.selectedBone;
        const clip = this.ensureActiveAnimationClip();
        if (!root || !clip) return 0;

        const targets = this.bones.filter((bone) => bone === root || this.isBoneDescendantOf(bone, root));
        if (!this.autoKeyframeBonePoseTargets(clip, targets)) return 0;
        return targets.length;
    }

    autoKeyframeCurrentBonePose(): boolean {
        const clip = this.ensureActiveAnimationClip();
        if (!clip || !this.selectedBone) return false;

        const targets = this.ikEnabled && this.ikChain.length > 0
            ? [...new Set([this.selectedBone, ...this.ikChain])]
            : [this.selectedBone];
        return this.autoKeyframeBonePoseTargets(clip, targets);
    }

    private autoKeyframeBonePoseTargets(clip: AnimationClip, targets: Bone[]): boolean {
        if (targets.length === 0) return false;
        const time = this.activeAction?.time ?? 0;
        for (const bone of targets) {
            upsertBoneKeyframe(clip, bone, 'position', time);
            upsertBoneKeyframe(clip, bone, 'quaternion', time);
            upsertBoneKeyframe(clip, bone, 'scale', time);
        }

        clip.duration = Math.max(clip.duration, time, 0.001);
        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    deleteSelectedBoneKeyframe(): void {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip || !this.selectedBone) return;

        const time = this.activeAction?.time ?? 0;
        this.deleteSelectedBoneKeyframesAtTimes([time]);
    }

    deleteSelectedBoneKeyframesAtTimes(times: number[]): void {
        if (!this.selectedBone) return;
        this.deleteKeyframesAtTimesInternal(times, this.selectedBone);
    }

    deleteKeyframesAtTimes(times: number[]): void {
        this.deleteKeyframesAtTimesInternal(times, null);
    }

    private deleteKeyframesAtTimesInternal(times: number[], bone: Bone | null): void {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip || times.length === 0) return;

        let changed = false;
        const nextTracks: KeyframeTrack[] = [];
        for (const track of clip.tracks) {
            let nextTrack: KeyframeTrack | null = track;
            for (const time of times) {
                if (!nextTrack) break;
                const candidate = removeKeyframeNearTime(nextTrack, bone, time);
                if (candidate !== nextTrack) changed = true;
                nextTrack = candidate;
            }
            if (nextTrack) nextTracks.push(nextTrack);
        }
        clip.tracks = nextTracks;

        if (changed) {
            this.refreshAnimationClipMetas();
            this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
            this.onSkeletonChanged(this.getSkeletonEditorState());
        }
    }

    moveSelectedBoneKeyframesAtTimes(fromTimes: number[], toTimes: number[]): void {
        if (!this.selectedBone) return;
        this.moveKeyframesAtTimesInternal(fromTimes, toTimes, this.selectedBone);
    }

    moveKeyframesAtTimes(fromTimes: number[], toTimes: number[]): void {
        this.moveKeyframesAtTimesInternal(fromTimes, toTimes, null);
    }

    private moveKeyframesAtTimesInternal(fromTimes: number[], toTimes: number[], bone: Bone | null): void {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip || fromTimes.length === 0 || toTimes.length === 0) return;

        const moves = fromTimes
            .map((from, index) => ({ from, to: toTimes[index] ?? from }))
            .filter((move) => Number.isFinite(move.from) && Number.isFinite(move.to) && !nearlyEqualTime(move.from, move.to));
        if (moves.length === 0) return;

        let changed = false;
        clip.tracks = clip.tracks.map((track) => {
            const nextTrack = moveKeyframesNearTimes(track, bone, moves);
            if (nextTrack !== track) changed = true;
            return nextTrack;
        });

        if (changed) {
            const maxMovedTime = moves.reduce((max, move) => Math.max(max, move.to), clip.duration);
            clip.duration = Math.max(clip.duration, maxMovedTime);
            this.refreshAnimationClipMetas();
            this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
            this.onSkeletonChanged(this.getSkeletonEditorState());
        }
    }

    getAnimationClipsForExport(options: { scope?: 'all' | 'current' } = {}): AnimationClip[] {
        if (options.scope === 'current') {
            const clip = this.animClips[this.activeClipIndex];
            return clip ? [clip] : [];
        }
        return [...this.animClips];
    }

    captureAnimationSnapshot(index = this.activeClipIndex): AnimationClipSnapshot | null {
        const clip = this.animClips[index];
        if (!clip) return null;

        return {
            clipIndex: index,
            clipName: clip.name,
            duration: clip.duration,
            tracks: clip.tracks.map((track, index) => ({
                index,
                name: track.name,
                times: Array.from(track.times as ArrayLike<number>),
                values: Array.from(track.values as ArrayLike<number>),
            })),
        };
    }

    captureKeyframesAtTimes(times: number[]): AnimationClipSnapshot | null {
        return this.captureKeyframesAtTimesInternal(times, null);
    }

    captureSelectedBoneKeyframesAtTimes(times: number[]): AnimationClipSnapshot | null {
        return this.captureKeyframesAtTimesInternal(times, this.selectedBone);
    }

    private captureKeyframesAtTimesInternal(times: number[], bone: Bone | null): AnimationClipSnapshot | null {
        const clip = this.animClips[this.activeClipIndex];
        const selectedTimes = normalizeKeyframeTimes(times);
        if (!clip || selectedTimes.length === 0) return null;

        const sourceStart = selectedTimes[0];
        const tracks: AnimationClipSnapshot['tracks'] = [];
        for (const track of clip.tracks) {
            if (bone) {
                const property = parseAnimationTrackName(track.name).property;
                if (property !== 'position' && property !== 'quaternion' && property !== 'scale') continue;
                if (!trackTargetsBoneProperty(track, bone, property)) continue;
            }
            const valueSize = track.getValueSize();
            if (valueSize <= 0) continue;
            const trackTimes = Array.from(track.times as ArrayLike<number>);
            const trackValues = Array.from(track.values as ArrayLike<number>);
            const copiedTimes: number[] = [];
            const copiedValues: number[] = [];

            for (let index = 0; index < trackTimes.length; index += 1) {
                if (!selectedTimes.some((time) => nearlyEqualTime(time, trackTimes[index]))) continue;
                copiedTimes.push(Math.max(0, trackTimes[index] - sourceStart));
                copiedValues.push(...trackValues.slice(index * valueSize, index * valueSize + valueSize));
            }

            if (copiedTimes.length > 0) {
                tracks.push({
                    index: tracks.length,
                    name: track.name,
                    times: copiedTimes,
                    values: copiedValues,
                });
            }
        }

        if (tracks.length === 0) return null;
        return {
            clipIndex: -1,
            clipName: clip.name,
            duration: Math.max(0, selectedTimes[selectedTimes.length - 1] - sourceStart),
            tracks,
        };
    }

    pasteKeyframesFromSnapshot(snapshot: AnimationClipSnapshot, startTime: number): boolean {
        const clip = this.ensureActiveAnimationClip();
        if (!clip || snapshot.tracks.length === 0 || !Number.isFinite(startTime)) return false;

        let changed = false;
        let maxPastedTime = clip.duration;
        for (const trackSnapshot of snapshot.tracks) {
            if (trackSnapshot.times.length === 0) continue;
            const shiftedTimes = trackSnapshot.times.map((time) => Math.max(0, startTime + time));
            const existingIndex = clip.tracks.findIndex((track) => track.name === trackSnapshot.name);
            if (existingIndex < 0) {
                clip.tracks.push(createTrackFromSnapshot(trackSnapshot.name, shiftedTimes, trackSnapshot.values));
            } else {
                clip.tracks[existingIndex] = upsertTrackKeyframes(
                    clip.tracks[existingIndex],
                    shiftedTimes,
                    trackSnapshot.values,
                );
            }
            maxPastedTime = shiftedTimes.reduce((max, time) => Math.max(max, time), maxPastedTime);
            changed = true;
        }

        if (!changed) return false;
        clip.duration = Math.max(clip.duration, maxPastedTime, 0.001);
        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    restoreAnimationSnapshot(snapshot: AnimationClipSnapshot): void {
        const clip = this.animClips[snapshot.clipIndex];
        if (!clip) return;

        clip.name = snapshot.clipName;
        clip.duration = snapshot.duration;
        clip.tracks = snapshot.tracks.map((trackSnapshot) => createTrackFromSnapshot(
            trackSnapshot.name,
            trackSnapshot.times,
            trackSnapshot.values,
        ));

        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(snapshot.clipIndex);
    }

    createRestPoseAnimationClip(name = 'T-Pose Action'): number {
        const root = this.getActiveRoot();
        if (!root || this.bones.length === 0) return -1;

        const previousPose = this.captureBonePoseSnapshot();
        if (this.activeAction) this.activeAction.paused = true;
        this.animationPlaying = false;
        let newIndex = -1;

        try {
            this.applyBindPose(root);
            root.updateMatrixWorld(true);

            const tracks: KeyframeTrack[] = [];
            const times = [0, 1];
            for (const bone of this.bones) {
                const position = [bone.position.x, bone.position.y, bone.position.z];
                const quaternion = [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
                const scale = [bone.scale.x, bone.scale.y, bone.scale.z];
                tracks.push(new VectorKeyframeTrack(getBoneTrackName(bone, 'position'), times, [...position, ...position]));
                tracks.push(new QuaternionKeyframeTrack(getBoneTrackName(bone, 'quaternion'), times, [...quaternion, ...quaternion]));
                tracks.push(new VectorKeyframeTrack(getBoneTrackName(bone, 'scale'), times, [...scale, ...scale]));
            }

            const clip = new AnimationClip(this.uniqueAnimationClipName(name), 1, tracks);
            this.animClips.push(clip);
            this.bindAnimationClipsToRoot(root);
            this.ensureAnimationMixer(root);
            newIndex = this.animClips.length - 1;
        } finally {
            if (previousPose) this.restoreBonePoseSnapshot(previousPose);
        }

        if (newIndex < 0) return -1;
        this.refreshAnimationClipMetas();
        this.selectAnimationClip(newIndex, { autoPlay: false });
        this.onAnimationsChanged(this.getAnimationState());
        return newIndex;
    }

    createCurrentPoseAnimationClip(name = 'Current Pose Action'): number {
        const root = this.getActiveRoot();
        if (!root || this.bones.length === 0) return -1;

        if (this.activeAction) this.activeAction.paused = true;
        this.animationPlaying = false;
        root.updateMatrixWorld(true);

        const tracks: KeyframeTrack[] = [];
        const times = [0, 1];
        for (const bone of this.bones) {
            const position = [bone.position.x, bone.position.y, bone.position.z];
            const quaternion = [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
            const scale = [bone.scale.x, bone.scale.y, bone.scale.z];
            tracks.push(new VectorKeyframeTrack(getBoneTrackName(bone, 'position'), times, [...position, ...position]));
            tracks.push(new QuaternionKeyframeTrack(getBoneTrackName(bone, 'quaternion'), times, [...quaternion, ...quaternion]));
            tracks.push(new VectorKeyframeTrack(getBoneTrackName(bone, 'scale'), times, [...scale, ...scale]));
        }

        const clip = new AnimationClip(this.uniqueAnimationClipName(name), 1, tracks);
        this.animClips.push(clip);
        this.bindAnimationClipsToRoot(root);
        this.ensureAnimationMixer(root);
        const newIndex = this.animClips.length - 1;
        this.refreshAnimationClipMetas();
        this.selectAnimationClip(newIndex, { autoPlay: false });
        this.onAnimationsChanged(this.getAnimationState());
        return newIndex;
    }

    replaceActiveAnimationTracksFromSnapshot(snapshot: AnimationClipSnapshot): boolean {
        const clip = this.ensureActiveAnimationClip();
        if (!clip) return false;

        const activeIndex = this.activeClipIndex >= 0 ? this.activeClipIndex : this.animClips.indexOf(clip);
        clip.duration = Math.max(0.001, snapshot.duration);
        clip.tracks = snapshot.tracks.map((trackSnapshot) => createTrackFromSnapshot(
            trackSnapshot.name,
            trackSnapshot.times,
            trackSnapshot.values,
        ));

        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(activeIndex);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    captureBonePoseSnapshot(): BonePoseSnapshot | null {
        if (this.bones.length === 0) return null;

        return {
            selectedBoneIndex: this.selectedBone ? this.bones.indexOf(this.selectedBone) : -1,
            ikEnabled: this.ikEnabled,
            transformMode: this.boneTransformMode,
            transformSpace: this.boneTransformSpace,
            ikTargetPosition: this.ikTarget
                ? [this.ikTarget.position.x, this.ikTarget.position.y, this.ikTarget.position.z]
                : null,
            bones: this.bones.map((bone, index) => ({
                index,
                uuid: bone.uuid,
                name: bone.name,
                position: [bone.position.x, bone.position.y, bone.position.z],
                quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
                scale: [bone.scale.x, bone.scale.y, bone.scale.z],
            })),
        };
    }

    restoreBonePoseSnapshot(snapshot: BonePoseSnapshot): void {
        if (this.bones.length === 0) return;

        for (const item of snapshot.bones) {
            const bone = this.bones.find((candidate) => candidate.uuid === item.uuid)
                ?? this.bones[item.index];
            if (!bone) continue;
            bone.position.fromArray(item.position);
            bone.quaternion.fromArray(item.quaternion);
            bone.scale.fromArray(item.scale);
            bone.updateMatrixWorld(true);
        }

        this.selectedBone = this.bones[snapshot.selectedBoneIndex] ?? this.selectedBone ?? null;
        this.boneTransformMode = snapshot.transformMode;
        this.boneTransformSpace = snapshot.transformSpace;
        this.ikEnabled = snapshot.ikEnabled && Boolean(this.selectedBone);
        this.refreshIkChain();
        if (snapshot.ikTargetPosition && this.ikEnabled) {
            this.ensureIkTarget();
            this.ikTarget?.position.fromArray(snapshot.ikTargetPosition);
        }
        this.attachTransformTarget();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    getSelectedBoneLocalTrs(): {
        boneIndex: number;
        boneName: string;
        position: [number, number, number];
        quaternion: [number, number, number, number];
        scale: [number, number, number];
    } | null {
        const bone = this.selectedBone;
        if (!bone) return null;
        const index = this.bones.indexOf(bone);
        return {
            boneIndex: index,
            boneName: bone.name,
            position: [bone.position.x, bone.position.y, bone.position.z],
            quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
            scale: [bone.scale.x, bone.scale.y, bone.scale.z],
        };
    }

    applyLocalTrsToBone(
        target: { boneIndex?: number; boneName?: string },
        trs: {
            position?: [number, number, number];
            quaternion?: [number, number, number, number];
            scale?: [number, number, number];
        },
    ): boolean {
        const bone = this.resolveBone(target);
        if (!bone) return false;
        if (trs.position) bone.position.fromArray(trs.position);
        if (trs.quaternion) bone.quaternion.fromArray(trs.quaternion);
        if (trs.scale) bone.scale.fromArray(trs.scale);
        bone.updateMatrixWorld(true);
        if (this.ikEnabled && bone === this.selectedBone) this.solveIk();
        this.refreshActiveRootMatrices();
        this.updateSkeletonOverlay();
        const clip = this.ensureActiveAnimationClip();
        if (clip) {
            const targets = this.ikEnabled && bone === this.selectedBone && this.ikChain.length > 0
                ? [...new Set([bone, ...this.ikChain])]
                : [bone];
            this.autoKeyframeBonePoseTargets(clip, targets);
        }
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    mirrorSelectedBonePose(): { sourceName: string; targetName: string } | null {
        const source = this.selectedBone;
        if (!source) return null;

        const targetName = findMirroredBoneName(source.name, new Set(this.bones.map((bone) => bone.name)));
        if (!targetName) return null;

        const target = this.bones.find((bone) => bone.name === targetName);
        if (!target) return null;

        const mirrored = mirrorBoneLocalTrs(source);
        target.position.fromArray(mirrored.position);
        target.quaternion.fromArray(mirrored.quaternion);
        target.scale.fromArray(mirrored.scale);
        target.updateMatrixWorld(true);
        this.refreshActiveRootMatrices();

        const clip = this.ensureActiveAnimationClip();
        if (clip) this.autoKeyframeBonePoseTargets(clip, [target]);

        this.selectedBone = target;
        this.refreshIkChain();
        this.attachTransformTarget();
        this.updateSkeletonOverlay();
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return {
            sourceName: getBoneDisplayName(source, this.bones.indexOf(source)),
            targetName: getBoneDisplayName(target, this.bones.indexOf(target)),
        };
    }

    resetSelectedBonePose(): boolean {
        const bone = this.selectedBone;
        const rest = bone ? this.boneRestPose.get(bone) : null;
        if (!bone || !rest) return false;

        bone.position.copy(rest.position);
        bone.quaternion.copy(rest.quaternion);
        bone.scale.copy(rest.scale);
        bone.updateMatrixWorld(true);
        if (this.ikEnabled) this.solveIk();
        this.refreshActiveRootMatrices();
        this.updateSkeletonOverlay();
        const clip = this.ensureActiveAnimationClip();
        if (clip) this.autoKeyframeBonePoseTargets(clip, [bone]);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    resetSelectedBoneChainPose(): number {
        const root = this.selectedBone;
        if (!root) return 0;
        const targets = this.bones.filter((bone) => bone === root || this.isBoneDescendantOf(bone, root));
        let changed = 0;
        for (const bone of targets) {
            const rest = this.boneRestPose.get(bone);
            if (!rest) continue;
            bone.position.copy(rest.position);
            bone.quaternion.copy(rest.quaternion);
            bone.scale.copy(rest.scale);
            bone.updateMatrixWorld(true);
            changed += 1;
        }
        if (changed === 0) return 0;
        if (this.ikEnabled) this.solveIk();
        this.refreshActiveRootMatrices();
        this.updateSkeletonOverlay();
        const clip = this.ensureActiveAnimationClip();
        if (clip) this.autoKeyframeBonePoseTargets(clip, targets);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return changed;
    }

    stepSelectedBoneTransform(axis: 'x' | 'y' | 'z', direction: 1 | -1): boolean {
        const bone = this.selectedBone;
        if (!bone) return false;

        if (this.boneTransformMode === 'translate') {
            const bounds = this.getModelBounds();
            const maxDim = bounds ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z) : 1;
            const step = Math.max(maxDim * this.boneTranslationStepRatio, 0.001);
            bone.position[axis] += step * direction;
        } else {
            const euler = new Euler().setFromQuaternion(bone.quaternion, 'XYZ');
            euler[axis] += this.boneRotationStepRadians * direction;
            bone.quaternion.setFromEuler(euler);
        }

        bone.updateMatrixWorld(true);
        if (this.ikEnabled) this.solveIk();
        this.refreshActiveRootMatrices();
        this.updateSkeletonOverlay();
        this.autoKeyframeCurrentBonePose();
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    findBoneIndexByName(name: string): number {
        if (!name) return -1;
        const direct = this.bones.findIndex((bone) => bone.name === name);
        if (direct >= 0) return direct;
        // Tolerate case-insensitive match as fallback.
        const lower = name.toLowerCase();
        return this.bones.findIndex((bone) => bone.name.toLowerCase() === lower);
    }

    getBoneNames(): string[] {
        return this.bones.map((bone) => bone.name);
    }

    seekToNearestKeyframe(direction: 1 | -1): boolean {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip) return false;
        const current = this.activeAction?.time ?? 0;
        const epsilon = 1e-4;
        const times = new Set<number>();
        for (const track of clip.tracks) {
            for (const value of Array.from(track.times as ArrayLike<number>)) {
                times.add(Number(value.toFixed(5)));
            }
        }
        const sorted = [...times].sort((a, b) => a - b);
        if (sorted.length === 0) return false;
        const target = direction > 0
            ? sorted.find((t) => t > current + epsilon)
            : [...sorted].reverse().find((t) => t < current - epsilon);
        if (target === undefined) return false;
        this.seekAnimation(target);
        return true;
    }

    duplicateAnimationClip(index: number, opts: { activate?: boolean } = {}): number {
        const source = this.animClips[index];
        if (!source || !this.mixer) return -1;

        const cloned = source.clone();
        cloned.name = `${source.name || `Clip ${index + 1}`} 副本`;
        this.animClips.push(cloned);

        const root = this.mixerRoot;
        if (root) {
            root.userData = root.userData ?? {};
            root.userData.animations = this.animClips;
        }

        this.refreshAnimationClipMetas();
        const newIndex = this.animClips.length - 1;
        this.onAnimationsChanged(this.getAnimationState());
        if (opts.activate) this.selectAnimationClip(newIndex, { autoPlay: false });
        return newIndex;
    }

    mirrorActiveAnimationClip(): boolean {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip || clip.tracks.length === 0) return false;

        const boneNames = new Set(this.bones.map((bone) => bone.name).filter(Boolean));
        clip.tracks = clip.tracks.map((track) => mirrorAnimationTrack(track, boneNames));
        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    getLazyAnimationClipSource(index = this.activeClipIndex): LazyAnimationClipSource | null {
        const clip = this.animClips[index];
        return clip ? getLazyAnimationClipSource(clip) : null;
    }

    replaceAnimationClip(index: number, clip: AnimationClip, opts: { activate?: boolean; autoPlay?: boolean } = {}): boolean {
        if (index < 0 || index >= this.animClips.length) return false;
        const root = this.mixerRoot ?? this.getActiveRoot();
        if (!root) return false;

        const previous = this.animClips[index];
        const wasActive = this.activeClipIndex === index;
        const shouldActivate = opts.activate ?? wasActive;
        const autoPlay = opts.autoPlay ?? (wasActive && this.animationPlaying);

        if (this.mixer) {
            if (wasActive && this.activeAction) this.activeAction.stop();
            this.mixer.uncacheClip(previous);
        }

        this.animClips[index] = clip;
        this.bindAnimationClipsToRoot(root);
        this.ensureAnimationMixer(root);
        this.refreshAnimationClipMetas();

        if (shouldActivate) {
            this.activeAction = null;
            this.activeClipIndex = -1;
            this.animationPlaying = false;
            this.animationFinished = false;
            this.lastReportedTime = -1;
            this.selectAnimationClip(index, { autoPlay });
        } else {
            this.onAnimationsChanged(this.getAnimationState());
        }

        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    deleteAnimationClip(index: number): boolean {
        const clip = this.animClips[index];
        if (!clip || !this.mixer) return false;

        const wasActive = this.activeClipIndex === index;
        this.mixer.stopAllAction();
        this.mixer.uncacheClip(clip);
        this.animClips.splice(index, 1);

        const root = this.mixerRoot;
        if (root) {
            root.userData = root.userData ?? {};
            root.userData.animations = this.animClips;
        }

        if (this.animClips.length === 0) {
            this.activeAction = null;
            this.activeClipIndex = -1;
            this.animationPlaying = false;
            this.animationFinished = false;
            this.lastReportedTime = -1;
            this.refreshAnimationClipMetas();
            this.onAnimationsChanged(this.getAnimationState());
            this.onSkeletonChanged(this.getSkeletonEditorState());
            return true;
        }

        this.refreshAnimationClipMetas();
        if (wasActive) {
            this.activeAction = null;
            this.activeClipIndex = -1;
            this.animationPlaying = false;
            const nextIndex = Math.min(index, this.animClips.length - 1);
            this.selectAnimationClip(nextIndex, { autoPlay: false });
        } else if (index < this.activeClipIndex) {
            this.activeClipIndex -= 1;
            this.onAnimationsChanged(this.getAnimationState());
        } else {
            this.onAnimationsChanged(this.getAnimationState());
        }
        return true;
    }

    private resolveBone(target: { boneIndex?: number; boneName?: string }): Bone | null {
        if (typeof target.boneIndex === 'number' && this.bones[target.boneIndex]) {
            return this.bones[target.boneIndex];
        }
        if (target.boneName) {
            const idx = this.findBoneIndexByName(target.boneName);
            if (idx >= 0) return this.bones[idx];
        }
        return null;
    }

    renameActiveAnimationClip(name: string): void {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip) return;

        const fallback = `Clip ${this.activeClipIndex + 1}`;
        clip.name = name.trim() || fallback;
        this.refreshAnimationClipMetas();
        this.onAnimationsChanged(this.getAnimationState());
    }

    scaleActiveAnimationTiming(factor: number): void {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip || !Number.isFinite(factor) || factor <= 0) return;

        for (const track of clip.tracks) {
            const times = track.times as unknown as ArrayLike<number> & { [index: number]: number };
            for (let index = 0; index < times.length; index += 1) {
                times[index] *= factor;
            }
        }

        clip.duration *= factor;
        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
    }

    applyAnimationTrackVectorEdit(trackIndex: number, edit: AnimationTrackVectorEdit): void {
        const clip = this.animClips[this.activeClipIndex];
        const track = clip?.tracks[trackIndex];
        if (!clip || !track) return;

        const meta = buildAnimationTrackMeta(track, trackIndex);
        if (!meta.editable) return;

        if (meta.property === 'position') {
            applyPositionTrackOffset(track, edit);
        } else if (meta.property === 'scale') {
            applyScaleTrackFactor(track, edit);
        } else if (meta.property === 'quaternion') {
            applyQuaternionTrackEulerOffset(track, edit);
        }

        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
    }

    applyAnimationTrackEasing(
        trackIndex: number,
        curve: AnimationEasingCurve,
        options: { selectedTimes?: number[]; samples?: number } = {},
    ): boolean {
        const clip = this.animClips[this.activeClipIndex];
        const track = clip?.tracks[trackIndex];
        if (!clip || !track) return false;

        const meta = buildAnimationTrackMeta(track, trackIndex);
        if (!meta.editable || track.times.length < 2) return false;

        const eased = bakeEasingIntoTrack(track, curve, {
            selectedTimes: options.selectedTimes ?? [],
            samples: options.samples ?? 12,
        });
        if (eased === track) return false;

        clip.tracks[trackIndex] = eased;
        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return true;
    }

    applyAnimationEasingToKeyframes(
        curve: AnimationEasingCurve,
        options: { selectedTimes: number[]; samples?: number },
    ): number {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip || options.selectedTimes.length === 0) return 0;

        let changedTracks = 0;
        clip.tracks = clip.tracks.map((track, index) => {
            const meta = buildAnimationTrackMeta(track, index);
            if (!meta.editable || track.times.length < 2) return track;
            const eased = bakeEasingIntoTrack(track, curve, {
                selectedTimes: options.selectedTimes,
                samples: options.samples ?? 12,
            });
            if (eased === track) return track;
            changedTracks += 1;
            return eased;
        });

        if (changedTracks === 0) return 0;
        this.refreshAnimationClipMetas();
        this.refreshActiveAnimationAfterEdit(this.activeClipIndex);
        this.onSkeletonChanged(this.getSkeletonEditorState());
        return changedTracks;
    }

    selectAnimationClip(index: number, opts: { autoPlay?: boolean } = {}): void {
        if (!this.mixer) return;
        if (index < 0 || index >= this.animClips.length) return;
        const autoPlay = opts.autoPlay ?? true;

        if (this.activeClipIndex === index && this.activeAction) {
            if (autoPlay) this.playAnimation();
            return;
        }

        if (this.activeAction) {
            this.activeAction.stop();
        }
        const clip = this.animClips[index];
        const action = this.mixer.clipAction(clip);
        action.reset();
        this.applyLoopToAction(action);
        this.applyBlendModeToAction(action);
        action.timeScale = this.animationSpeed;
        action.paused = !autoPlay;
        action.play();

        this.activeAction = action;
        this.activeClipIndex = index;
        this.animationPlaying = autoPlay;
        this.animationFinished = false;
        this.lastReportedTime = -1;
        this.mixer.update(0);
        this.onAnimationsChanged(this.getAnimationState());
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    playAnimation(): void {
        if (this.animClips.length === 0) return;
        if (!this.activeAction) {
            this.selectAnimationClip(this.activeClipIndex >= 0 ? this.activeClipIndex : 0, { autoPlay: true });
            return;
        }
        if (this.animationFinished) {
            this.activeAction.reset();
            this.applyLoopToAction(this.activeAction);
            this.activeAction.timeScale = this.animationSpeed;
            this.animationFinished = false;
        }
        this.activeAction.paused = false;
        if (!this.activeAction.isRunning()) this.activeAction.play();
        this.animationPlaying = true;
        this.animClock.getDelta();
        this.onAnimationsChanged(this.getAnimationState());
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    pauseAnimation(): void {
        if (!this.activeAction) return;
        this.activeAction.paused = true;
        this.animationPlaying = false;
        this.onAnimationsChanged(this.getAnimationState());
    }

    toggleAnimation(): void {
        if (this.animationPlaying) this.pauseAnimation();
        else this.playAnimation();
    }

    seekAnimation(time: number): void {
        if (!this.activeAction && this.animClips.length > 0) {
            this.selectAnimationClip(this.activeClipIndex >= 0 ? this.activeClipIndex : 0, { autoPlay: false });
        }
        if (!this.mixer || !this.activeAction) return;
        const clip = this.animClips[this.activeClipIndex];
        if (!clip) return;
        const clamped = Math.max(0, Math.min(clip.duration, time));
        this.activeAction.time = clamped;
        this.activeAction.paused = !this.animationPlaying;
        this.animationFinished = false;
        this.mixer.update(0);
        this.lastReportedTime = -1;
        this.onAnimationsChanged(this.getAnimationState());
    }

    setAnimationSpeed(speed: number): void {
        this.animationSpeed = Math.max(0, speed);
        if (this.activeAction) this.activeAction.timeScale = this.animationSpeed;
        this.onAnimationsChanged(this.getAnimationState());
    }

    setAnimationLoop(loop: boolean): void {
        this.animationLoop = loop;
        if (this.activeAction) this.applyLoopToAction(this.activeAction);
        this.onAnimationsChanged(this.getAnimationState());
    }

    setAnimationBlendMode(mode: AnimationBlendMode): void {
        this.animationBlendMode = mode;
        if (this.activeAction) this.applyBlendModeToAction(this.activeAction);
    }

    private applyLoopToAction(action: AnimationAction): void {
        action.setLoop(this.animationLoop ? LoopRepeat : LoopOnce, this.animationLoop ? Infinity : 1);
        action.clampWhenFinished = !this.animationLoop;
    }

    private applyBlendModeToAction(action: AnimationAction): void {
        action.blendMode = this.animationBlendMode === 'additive'
            ? AdditiveAnimationBlendMode
            : NormalAnimationBlendMode;
    }

    private attachAnimations(object: Object3D): void {
        const collected = collectAnimationClips(object);
        if (collected.length === 0) {
            this.disposeAnimations();
            return;
        }

        this.disposeAnimations();
        this.mixer = new AnimationMixer(object);
        this.mixerRoot = object;
        this.animClips = collected;
        this.refreshAnimationClipMetas();
        this.activeAction = null;
        this.activeClipIndex = 0;
        this.animationPlaying = false;
        this.animationFinished = false;
        this.lastReportedTime = -1;
        this.animClock.start();

        this.mixer.addEventListener('finished', () => {
            if (this.animationLoop) return;
            this.animationFinished = true;
            this.animationPlaying = false;
            this.onAnimationsChanged(this.getAnimationState());
        });

        this.onAnimationsChanged(this.getAnimationState());
    }

    private refreshAnimationClipMetas(): void {
        this.animationEditorCache = null;
        this.timelineMarkerCache = null;
        this.animClipMetas = this.animClips.map((clip, index) => {
            const lazy = getLazyAnimationClipSource(clip);
            return {
                index,
                name: clip.name && clip.name.trim() ? clip.name : `Clip ${index + 1}`,
                duration: lazy?.duration ?? clip.duration,
                tracks: lazy?.tracks ?? clip.tracks.length,
                lazy: Boolean(lazy),
            };
        });
    }

    private getCachedAnimationTrackMetas(clip: AnimationClip): AnimationTrackMeta[] {
        const cache = this.animationEditorCache;
        if (
            cache
            && cache.clip === clip
            && cache.index === this.activeClipIndex
            && cache.trackCount === clip.tracks.length
        ) {
            return cache.tracks;
        }

        const tracks = clip.tracks.map((track, index) => buildAnimationTrackMeta(track, index));
        this.animationEditorCache = {
            clip,
            index: this.activeClipIndex,
            trackCount: clip.tracks.length,
            tracks,
        };
        return tracks;
    }

    private refreshActiveAnimationAfterEdit(clipIndex: number): void {
        const clip = this.animClips[clipIndex];
        if (!clip) {
            this.onAnimationsChanged(this.getAnimationState());
            return;
        }

        const wasPlaying = this.animationPlaying;
        const time = Math.min(this.activeAction?.time ?? 0, clip.duration);
        if (this.mixer) {
            this.mixer.stopAllAction();
            this.mixer.uncacheClip(clip);
        }

        this.activeAction = null;
        this.activeClipIndex = -1;
        this.animationPlaying = false;
        this.animationFinished = false;
        this.lastReportedTime = -1;

        this.selectAnimationClip(clipIndex, { autoPlay: wasPlaying });
        this.seekAnimation(time);
        this.onAnimationsChanged(this.getAnimationState());
    }

    private ensureAnimationMixer(root: Object3D): void {
        if (this.mixer) {
            if (!this.mixerRoot) this.mixerRoot = root;
            return;
        }

        this.mixer = new AnimationMixer(root);
        this.mixerRoot = root;
        this.animClock.start();
        this.mixer.addEventListener('finished', () => {
            if (this.animationLoop) return;
            this.animationFinished = true;
            this.animationPlaying = false;
            this.onAnimationsChanged(this.getAnimationState());
        });
    }

    private bindAnimationClipsToRoot(root: Object3D): void {
        root.userData = root.userData ?? {};
        root.userData.animations = this.animClips;
    }

    private applyBindPose(root: Object3D): void {
        root.traverse((node) => {
            const skinned = node as Object3D & { isSkinnedMesh?: boolean; pose?: () => void };
            if (skinned.isSkinnedMesh && typeof skinned.pose === 'function') {
                skinned.pose();
            }
        });
    }

    private uniqueAnimationClipName(name: string): string {
        const base = name.trim() || 'Pose Action';
        const used = new Set(this.animClips.map((clip) => clip.name));
        if (!used.has(base)) return base;

        let suffix = 2;
        while (used.has(`${base} ${suffix}`)) suffix += 1;
        return `${base} ${suffix}`;
    }

    private ensureActiveAnimationClip(): AnimationClip | null {
        if (this.animClips[this.activeClipIndex]) return this.animClips[this.activeClipIndex];
        const root = this.getActiveRoot();
        if (!root) return null;

        const clip = new AnimationClip('Pose Action', 1, []);
        this.animClips.push(clip);
        this.bindAnimationClipsToRoot(root);
        this.ensureAnimationMixer(root);
        this.refreshAnimationClipMetas();
        this.selectAnimationClip(this.animClips.length - 1, { autoPlay: false });
        return clip;
    }

    private attachSkeletonEditor(object: Object3D): void {
        this.disposeSkeletonEditor();
        this.bones = collectBones(object);
        this.boneRestPose = new Map(this.bones.map((bone) => [bone, {
            position: bone.position.clone(),
            quaternion: bone.quaternion.clone(),
            scale: bone.scale.clone(),
        }]));
        this.boneMetaBase = this.bones.map((bone, index) => ({
            index,
            name: getBoneDisplayName(bone, index),
            parentName: bone.parent && (bone.parent as Bone).isBone
                ? getBoneDisplayName(bone.parent as Bone, this.bones.indexOf(bone.parent as Bone))
                : '',
            depth: getBoneDepth(bone),
        }));
        if (this.bones.length === 0) {
            this.onSkeletonChanged(this.getSkeletonEditorState());
            return;
        }

        this.selectedBone = this.bones[0] ?? null;
        this.refreshIkChain();
        this.attachTransformTarget();
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    private refreshActiveRootMatrices(): void {
        this.getActiveRoot()?.updateMatrixWorld(true);
    }

    private disposeSkeletonEditor(): void {
        this.transformControls.detach();
        this.disposeSkeletonOverlay();
        if (this.ikTargetMesh) this.scene.remove(this.ikTargetMesh);
        this.ikTarget = null;
        this.ikTargetMesh = null;
        this.ikChain = [];
        this.bones = [];
        this.boneRestPose.clear();
        this.boneMetaBase = [];
        this.timelineMarkerCache = null;
        this.selectedBone = null;
        this.ikEnabled = false;
        this.onSkeletonChanged(this.getSkeletonEditorState());
    }

    private ensureSkeletonOverlay(): void {
        const root = this.getActiveRoot();
        if (!root || this.bones.length === 0 || this.boneHandles.size > 0) return;

        this.skeletonHelper = new SkeletonHelper(root);
        this.skeletonHelper.visible = false;
        this.skeletonHelper.name = '__skeleton_editor_helper__';
        const skeletonMaterial = this.skeletonHelper.material as Material & { color?: Color };
        skeletonMaterial.depthTest = false;
        skeletonMaterial.transparent = true;
        skeletonMaterial.opacity = 0.72;
        skeletonMaterial.color?.set(0x255f99);
        this.scene.add(this.skeletonHelper);

        for (const bone of this.bones) {
            const handle = new Mesh(this.boneHandleGeometry, this.boneHandleMaterial);
            handle.name = `__bone_handle__${bone.name}`;
            handle.renderOrder = 20;
            handle.visible = this.skeletonVisible;
            handle.userData.__boneHandle = true;
            this.boneHandles.set(bone, handle);
            this.handleToBone.set(handle, bone);
            this.scene.add(handle);

            const segmentCount = getBoneSegmentCount(bone);
            if (segmentCount > 0) {
                const lines: Line[] = [];
                this.boneLines.set(bone, lines);
                for (let index = 0; index < segmentCount; index += 1) {
                    const segmentLine = new Line(
                        new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
                        this.boneLineMaterial,
                    );
                    segmentLine.name = `__bone_line__${bone.name}_${index}`;
                    segmentLine.renderOrder = 18;
                    segmentLine.visible = this.skeletonVisible;
                    segmentLine.userData.__boneLine = true;
                    lines.push(segmentLine);
                    this.lineToBone.set(segmentLine, bone);
                    this.scene.add(segmentLine);
                }
            }
        }

        this.updateSkeletonOverlay();
    }

    private disposeSkeletonOverlay(): void {
        if (this.skeletonHelper) {
            this.scene.remove(this.skeletonHelper);
            (this.skeletonHelper.material as Material).dispose();
            this.skeletonHelper = null;
        }
        for (const handle of this.boneHandles.values()) {
            this.scene.remove(handle);
        }
        for (const lines of this.boneLines.values()) {
            for (const line of lines) {
                this.scene.remove(line);
                line.geometry.dispose();
            }
        }
        this.boneHandles.clear();
        this.boneLines.clear();
    }

    private updateSkeletonOverlay(): void {
        if (this.bones.length === 0) return;
        if (this.boneHandles.size === 0 && this.boneLines.size === 0 && !this.ikTargetMesh) return;
        const scale = this.getBoneHandleScale();
        const start = new Vector3();
        const end = new Vector3();
        for (const bone of this.bones) {
            const handle = this.boneHandles.get(bone);
            bone.getWorldPosition(end);
            if (handle) {
                handle.position.copy(end);
                handle.scale.setScalar(bone === this.selectedBone ? scale * 2.25 : scale * 1.18);
                handle.material = bone === this.selectedBone
                    ? this.selectedBoneHandleMaterial
                    : this.boneHandleMaterial;
                handle.visible = this.skeletonVisible;
            }

            const lines = this.boneLines.get(bone);
            if (!lines || lines.length === 0) continue;
            const children = getBoneChildren(bone);
            bone.getWorldPosition(start);
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                const child = children[index];
                if (child) child.getWorldPosition(end);
                else getLeafBoneTailWorldPosition(bone, end, scale * 2.4);
                const positions = line.geometry.getAttribute('position') as BufferAttribute;
                positions.setXYZ(0, start.x, start.y, start.z);
                positions.setXYZ(1, end.x, end.y, end.z);
                positions.needsUpdate = true;
                line.geometry.computeBoundingSphere();
                line.material = this.getBoneLineMaterial(bone);
                line.visible = this.skeletonVisible;
            }
        }
        if (this.ikTarget && this.ikTargetMesh) {
            this.ikTargetMesh.position.copy(this.ikTarget.position);
            this.ikTargetMesh.scale.setScalar(scale * 1.8);
            this.ikTargetMesh.visible = this.ikEnabled && this.transformControlsVisible;
        }
    }

    private shouldUpdateSkeletonOverlay(): boolean {
        return this.skeletonVisible
            || (this.skeletonEditorActivated && this.transformControlsVisible && Boolean(this.selectedBone))
            || Boolean(this.ikTargetMesh?.visible);
    }

    private getBoneHandleScale(): number {
        const bounds = this.getModelBounds();
        const maxDim = bounds ? Math.max(bounds.size.x, bounds.size.y, bounds.size.z) : 1;
        return Math.max(maxDim * 0.018, 0.025);
    }

    private handleSkeletonPointerDown(event: PointerEvent): void {
        if (!this.skeletonVisible || this.transformDragging) return;
        this.ensureSkeletonOverlay();
        if (this.boneHandles.size === 0) return;
        if (event.button !== 0) return;
        const rect = this.canvas.getBoundingClientRect();
        this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        this.raycaster.params.Line.threshold = Math.max(this.getBoneHandleScale() * 1.8, 0.05);
        const hits = this.raycaster.intersectObjects([
            ...this.boneHandles.values(),
            ...this.getBoneLineObjects(),
        ], false);
        const hit = hits[0]?.object;
        if (!hit) return;

        const bone = this.handleToBone.get(hit) ?? this.lineToBone.get(hit);
        if (!bone) return;
        event.preventDefault();
        event.stopPropagation();
        this.selectBone(this.bones.indexOf(bone));
    }

    private getBoneLineObjects(): Line[] {
        const lines: Line[] = [];
        for (const boneLines of this.boneLines.values()) lines.push(...boneLines);
        return lines;
    }

    private isSelectedBoneDescendant(bone: Bone): boolean {
        if (!this.selectedBone || bone === this.selectedBone) return false;
        return this.isBoneDescendantOf(bone, this.selectedBone);
    }

    private isBoneDescendantOf(bone: Bone, ancestor: Bone): boolean {
        let current = bone.parent;
        while (current) {
            if (current === ancestor) return true;
            current = current.parent;
        }
        return false;
    }

    private getBoneLineMaterial(bone: Bone): LineBasicMaterial {
        if (bone === this.selectedBone) return this.selectedBoneLineMaterial;
        if (this.ikEnabled && this.ikChain.includes(bone)) return this.ikChainLineMaterial;
        if (!this.ikEnabled && this.isSelectedBoneDescendant(bone)) return this.fkChildLineMaterial;
        return this.boneLineMaterial;
    }

    private attachTransformTarget(): void {
        this.transformControls.detach();
        if (!this.skeletonEditorActivated || !this.transformControlsVisible) {
            this.transformControls.visible = false;
            if (this.ikTargetMesh) this.ikTargetMesh.visible = false;
            return;
        }

        if (this.ikEnabled && this.selectedBone) {
            this.ensureIkTarget();
            this.transformControls.setMode('translate');
            this.transformControls.setSpace(this.boneTransformSpace);
            if (this.ikTarget) this.transformControls.attach(this.ikTarget);
        } else if (this.selectedBone) {
            this.transformControls.setMode(this.boneTransformMode);
            this.transformControls.setSpace(this.boneTransformSpace);
            this.transformControls.attach(this.selectedBone);
        }

        this.transformControls.visible = Boolean(this.selectedBone || this.ikTarget);
        if (this.ikTargetMesh) this.ikTargetMesh.visible = this.ikEnabled && this.transformControlsVisible;
    }

    private ensureIkTarget(): void {
        if (!this.selectedBone) return;
        if (!this.ikTarget) {
            this.ikTarget = new Object3D();
            this.scene.add(this.ikTarget);
        }
        if (!this.ikTargetMesh) {
            this.ikTargetMesh = new Mesh(this.boneHandleGeometry, this.ikTargetMaterial);
            this.ikTargetMesh.name = '__ik_target__';
            this.ikTargetMesh.renderOrder = 25;
            this.scene.add(this.ikTargetMesh);
        }
        this.selectedBone.getWorldPosition(this.ikTarget.position);
        this.ikTargetMesh.position.copy(this.ikTarget.position);
        this.ikTargetMesh.visible = this.ikEnabled && this.transformControlsVisible;
    }

    private refreshIkChain(): void {
        this.ikChain = [];
        if (!this.selectedBone) return;
        let current: Object3D | null = this.selectedBone.parent;
        while (current && this.ikChain.length < this.ikChainMaxLength) {
            if ((current as Bone).isBone) this.ikChain.push(current as Bone);
            current = current.parent;
        }
        if (this.ikEnabled) this.ensureIkTarget();
    }

    private solveIk(): void {
        if (!this.ikEnabled || !this.selectedBone || !this.ikTarget || this.ikChain.length === 0) return;

        const targetWorld = new Vector3();
        const effectorWorld = new Vector3();
        const linkWorld = new Vector3();
        const toEffector = new Vector3();
        const toTarget = new Vector3();
        const delta = new Quaternion();
        const linkWorldQuat = new Quaternion();
        const parentWorldQuat = new Quaternion();

        this.ikTarget.getWorldPosition(targetWorld);
        for (let iteration = 0; iteration < 10; iteration += 1) {
            this.selectedBone.getWorldPosition(effectorWorld);
            if (effectorWorld.distanceToSquared(targetWorld) < 1e-6) break;

            for (const link of this.ikChain) {
                link.getWorldPosition(linkWorld);
                this.selectedBone.getWorldPosition(effectorWorld);
                toEffector.copy(effectorWorld).sub(linkWorld);
                toTarget.copy(targetWorld).sub(linkWorld);
                if (toEffector.lengthSq() < 1e-8 || toTarget.lengthSq() < 1e-8) continue;

                toEffector.normalize();
                toTarget.normalize();
                delta.setFromUnitVectors(toEffector, toTarget);
                link.getWorldQuaternion(linkWorldQuat);
                const nextWorld = delta.multiply(linkWorldQuat);
                if (link.parent) {
                    link.parent.getWorldQuaternion(parentWorldQuat).invert();
                    link.quaternion.copy(parentWorldQuat.multiply(nextWorld));
                } else {
                    link.quaternion.copy(nextWorld);
                }
                link.updateMatrixWorld(true);
            }
        }
    }

    private getTimelineMarkers(): AnimationTimelineMarker[] {
        const clip = this.animClips[this.activeClipIndex];
        if (!clip) return [];
        const cache = this.timelineMarkerCache;
        if (
            cache
            && cache.clip === clip
            && cache.selectedBone === this.selectedBone
            && cache.trackCount === clip.tracks.length
        ) {
            return cache.markers;
        }

        const selectedTrackNames = this.selectedBone
            ? new Set([
                getBoneTrackName(this.selectedBone, 'position'),
                getBoneTrackName(this.selectedBone, 'quaternion'),
                getBoneTrackName(this.selectedBone, 'scale'),
            ])
            : new Set<string>();
        const times = new Map<string, AnimationTimelineMarker>();

        for (const track of clip.tracks) {
            const selectedBone = selectedTrackNames.has(track.name);
            for (const rawTime of Array.from(track.times as ArrayLike<number>)) {
                const key = rawTime.toFixed(4);
                const existing = times.get(key);
                if (existing) existing.selectedBone ||= selectedBone;
                else times.set(key, { time: rawTime, selectedBone });
            }
        }

        const markers = [...times.values()].sort((a, b) => a.time - b.time);
        this.timelineMarkerCache = {
            clip,
            selectedBone: this.selectedBone,
            trackCount: clip.tracks.length,
            markers,
        };
        return markers;
    }

    private disposeAnimations(): void {
        if (this.mixer) {
            this.mixer.stopAllAction();
            if (this.mixerRoot) this.mixer.uncacheRoot(this.mixerRoot);
        }
        this.mixer = null;
        this.mixerRoot = null;
        this.activeAction = null;
        this.activeClipIndex = -1;
        const hadClips = this.animClips.length > 0;
        this.animClips = [];
        this.animClipMetas = [];
        this.animationPlaying = false;
        this.animationFinished = false;
        this.lastReportedTime = -1;
        if (hadClips) this.onAnimationsChanged(this.getAnimationState());
    }

    collectStats(): { vertices: number; triangles: number; edges: number; meshes: number } {
        return this.collectStatsFor(this.modelGroup);
    }

    collectStatsFor(root: Object3D): { vertices: number; triangles: number; edges: number; meshes: number } {
        let vertices = 0;
        let triangles = 0;
        let meshes = 0;

        root.traverse((node: Object3D) => {
            const mesh = node as Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            meshes++;
            const pos = mesh.geometry.getAttribute('position');
            vertices += pos ? pos.count : 0;
            const idx = mesh.geometry.getIndex();
            if (idx) triangles += idx.count / 3;
            else if (pos) triangles += pos.count / 3;
        });

        const edges = Math.round(triangles * 3);
        return { vertices, triangles: Math.round(triangles), edges, meshes };
    }

    private forEachRenderable(callback: (node: Object3D) => void): void {
        this.modelGroup.traverse((node: Object3D) => {
            const object = node as Mesh & { isPoints?: boolean; isLine?: boolean };
            if (!object.isMesh && !object.isPoints && !object.isLine) return;
            callback(node);
        });
    }
}

function collectAnimationClips(root: Object3D): AnimationClip[] {
    const seen = new Set<AnimationClip>();
    const result: AnimationClip[] = [];

    const consume = (value: unknown) => {
        if (!Array.isArray(value)) return;
        for (const item of value) {
            if (!item || seen.has(item as AnimationClip)) continue;
            const candidate = item as { isAnimationClip?: boolean; tracks?: unknown };
            if (candidate.isAnimationClip || Array.isArray(candidate.tracks)) {
                seen.add(item as AnimationClip);
                result.push(item as AnimationClip);
            }
        }
    };

    consume(root.userData?.animations);
    consume((root as Object3D & { animations?: AnimationClip[] }).animations);
    if (result.length > 0) return result;

    root.traverse((node: Object3D) => {
        consume(node.userData?.animations);
        consume((node as Object3D & { animations?: AnimationClip[] }).animations);
    });

    return result;
}

function getLazyAnimationClipSource(clip: AnimationClip): LazyAnimationClipSource | null {
    const userData = (clip as AnimationClip & {
        userData?: { __meshscopeLazyGlbAnimation?: Partial<LazyAnimationClipSource> };
    }).userData;
    const source = userData?.__meshscopeLazyGlbAnimation;
    if (source?.type !== 'large-glb-animation') return null;
    if (!source.path || typeof source.index !== 'number') return null;
    return {
        type: 'large-glb-animation',
        path: source.path,
        index: source.index,
        name: source.name || clip.name || `Animation ${source.index + 1}`,
        duration: typeof source.duration === 'number' ? source.duration : clip.duration,
        tracks: typeof source.tracks === 'number' ? source.tracks : clip.tracks.length,
    };
}

function collectBones(root: Object3D): Bone[] {
    const bones: Bone[] = [];
    root.traverse((node) => {
        if ((node as Bone).isBone) bones.push(node as Bone);
    });
    return bones;
}

function getBoneChildren(bone: Bone): Bone[] {
    return bone.children.filter((child): child is Bone => (child as Bone).isBone);
}

function getBoneDepth(bone: Bone): number {
    let depth = 0;
    let current = bone.parent;
    while (current) {
        if ((current as Bone).isBone) depth += 1;
        current = current.parent;
    }
    return depth;
}

function getBoneSegmentCount(bone: Bone): number {
    const childCount = getBoneChildren(bone).length;
    if (childCount > 0) return childCount;
    return bone.parent && (bone.parent as Bone).isBone ? 1 : 0;
}

function getLeafBoneTailWorldPosition(bone: Bone, target: Vector3, fallbackLength: number): Vector3 {
    const head = bone.getWorldPosition(new Vector3());
    if (bone.parent && (bone.parent as Bone).isBone) {
        const parent = bone.parent.getWorldPosition(new Vector3());
        const direction = head.clone().sub(parent);
        if (direction.lengthSq() > 1e-10) {
            return target.copy(head).add(direction.normalize().multiplyScalar(Math.max(direction.length() * 0.7, fallbackLength)));
        }
    }
    return target.copy(head).add(new Vector3(0, fallbackLength, 0));
}

function getBoneDisplayName(bone: Bone, index: number): string {
    return bone.name && bone.name.trim() ? bone.name : `Bone ${index + 1}`;
}

function getBoneTrackName(bone: Bone, property: 'position' | 'quaternion' | 'scale'): string {
    return `${bone.name && bone.name.trim() ? bone.name : bone.uuid}.${property}`;
}

function upsertBoneKeyframe(
    clip: AnimationClip,
    bone: Bone,
    property: 'position' | 'quaternion' | 'scale',
    time: number,
): void {
    const value = getBonePropertyValue(bone, property);
    const existingIndex = clip.tracks.findIndex((track) => trackTargetsBoneProperty(track, bone, property));
    if (existingIndex < 0) {
        const trackName = getBoneTrackName(bone, property);
        const track = property === 'quaternion'
            ? new QuaternionKeyframeTrack(trackName, [time], value)
            : new VectorKeyframeTrack(trackName, [time], value);
        clip.tracks.push(track);
        return;
    }

    const track = clip.tracks[existingIndex];
    const valueSize = track.getValueSize();
    const times = Array.from(track.times as ArrayLike<number>);
    const values = Array.from(track.values as ArrayLike<number>);
    let insertIndex = times.findIndex((item) => nearlyEqualTime(item, time));

    if (insertIndex >= 0) {
        values.splice(insertIndex * valueSize, valueSize, ...value);
    } else {
        insertIndex = times.findIndex((item) => item > time);
        if (insertIndex < 0) insertIndex = times.length;
        times.splice(insertIndex, 0, time);
        values.splice(insertIndex * valueSize, 0, ...value);
    }

    clip.tracks[existingIndex] = cloneTrackWithData(track, times, values);
}

function removeKeyframeNearTime(track: KeyframeTrack, bone: Bone | null, time: number): KeyframeTrack | null {
    if (bone) {
        const property = parseAnimationTrackName(track.name).property;
        if (property !== 'position' && property !== 'quaternion' && property !== 'scale') return track;
        if (!trackTargetsBoneProperty(track, bone, property)) return track;
    }

    const times = Array.from(track.times as ArrayLike<number>);
    const valueSize = track.getValueSize();
    const values = Array.from(track.values as ArrayLike<number>);
    let removeIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < times.length; index += 1) {
        const distance = Math.abs(times[index] - time);
        if (distance < bestDistance) {
            removeIndex = index;
            bestDistance = distance;
        }
    }

    if (removeIndex < 0 || bestDistance > 1 / 24) return track;
    times.splice(removeIndex, 1);
    values.splice(removeIndex * valueSize, valueSize);
    if (times.length === 0) return null;
    return cloneTrackWithData(track, times, values);
}

function moveKeyframesNearTimes(
    track: KeyframeTrack,
    bone: Bone | null,
    moves: Array<{ from: number; to: number }>,
): KeyframeTrack {
    if (bone) {
        const property = parseAnimationTrackName(track.name).property;
        if (property !== 'position' && property !== 'quaternion' && property !== 'scale') return track;
        if (!trackTargetsBoneProperty(track, bone, property)) return track;
    }

    const valueSize = track.getValueSize();
    if (valueSize <= 0) return track;
    const trackValues = Array.from(track.values as ArrayLike<number>);
    const rows = Array.from(track.times as ArrayLike<number>).map((time, index) => ({
        time,
        values: trackValues.slice(index * valueSize, index * valueSize + valueSize),
        moved: false,
    }));
    let changed = false;

    for (const move of moves) {
        let moveIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < rows.length; index += 1) {
            if (rows[index].moved) continue;
            const distance = Math.abs(rows[index].time - move.from);
            if (distance < bestDistance) {
                bestDistance = distance;
                moveIndex = index;
            }
        }
        if (moveIndex < 0 || bestDistance > 1e-3) continue;
        rows[moveIndex].time = Math.max(0, move.to);
        rows[moveIndex].moved = true;
        changed = true;
    }

    if (!changed) return track;

    const merged = new Map<string, { time: number; values: number[] }>();
    for (const row of rows) {
        merged.set(row.time.toFixed(4), {
            time: row.time,
            values: row.values,
        });
    }

    const sorted = [...merged.values()].sort((a, b) => a.time - b.time);
    return cloneTrackWithData(
        track,
        sorted.map((row) => row.time),
        sorted.flatMap((row) => row.values),
    );
}

function cloneTrackWithData(track: KeyframeTrack, times: number[], values: number[]): KeyframeTrack {
    return cloneTrackWithNamedData(track, track.name, times, values);
}

function upsertTrackKeyframes(track: KeyframeTrack, incomingTimes: number[], incomingValues: number[]): KeyframeTrack {
    const valueSize = track.getValueSize();
    if (valueSize <= 0 || incomingValues.length !== incomingTimes.length * valueSize) return track;

    const times = Array.from(track.times as ArrayLike<number>);
    const values = Array.from(track.values as ArrayLike<number>);
    for (let row = 0; row < incomingTimes.length; row += 1) {
        const time = incomingTimes[row];
        const rowValues = incomingValues.slice(row * valueSize, row * valueSize + valueSize);
        let index = times.findIndex((item) => nearlyEqualTime(item, time));
        if (index >= 0) {
            values.splice(index * valueSize, valueSize, ...rowValues);
            continue;
        }

        index = times.findIndex((item) => item > time);
        if (index < 0) index = times.length;
        times.splice(index, 0, time);
        values.splice(index * valueSize, 0, ...rowValues);
    }

    return cloneTrackWithData(track, times, values);
}

function cloneTrackWithNamedData(track: KeyframeTrack, name: string, times: number[], values: number[]): KeyframeTrack {
    const property = parseAnimationTrackName(name).property;
    const next = property === 'quaternion'
        ? new QuaternionKeyframeTrack(name, times, values)
        : property === 'position' || property === 'scale'
            ? new VectorKeyframeTrack(name, times, values)
            : new NumberKeyframeTrack(name, times, values);
    const interpolation = (track as unknown as { getInterpolation?: () => number }).getInterpolation?.();
    if (typeof interpolation === 'number') {
        (next as unknown as { setInterpolation?: (value: number) => void }).setInterpolation?.(interpolation);
    }
    return next;
}

function bakeEasingIntoTrack(
    track: KeyframeTrack,
    curve: AnimationEasingCurve,
    options: { selectedTimes: number[]; samples: number },
): KeyframeTrack {
    const times = Array.from(track.times as ArrayLike<number>);
    const values = Array.from(track.values as ArrayLike<number>);
    const valueSize = track.getValueSize();
    if (times.length < 2 || valueSize <= 0) return track;

    const selectedTimes = options.selectedTimes
        .map((time) => Number(time.toFixed(4)))
        .filter(Number.isFinite);
    const selected = new Set(selectedTimes.map((time) => time.toFixed(4)));
    const applyAll = selected.size === 0;
    const samples = Math.max(4, Math.min(32, Math.round(options.samples)));
    const property = parseAnimationTrackName(track.name).property;

    let changed = false;
    const nextTimes: number[] = [times[0]];
    const nextValues: number[] = values.slice(0, valueSize);

    for (let index = 0; index < times.length - 1; index += 1) {
        const t0 = times[index];
        const t1 = times[index + 1];
        const v0 = values.slice(index * valueSize, index * valueSize + valueSize);
        const v1 = values.slice((index + 1) * valueSize, (index + 1) * valueSize + valueSize);
        const shouldEase = applyAll
            || selected.has(Number(t0.toFixed(4)).toFixed(4))
            || selected.has(Number(t1.toFixed(4)).toFixed(4));

        if (shouldEase && t1 > t0 + 1e-5) {
            changed = true;
            for (let sample = 1; sample < samples; sample += 1) {
                const x = sample / samples;
                const alpha = cubicBezierYForX(x, curve);
                nextTimes.push(t0 + (t1 - t0) * x);
                nextValues.push(...interpolateTrackValue(property, v0, v1, alpha));
            }
        }

        nextTimes.push(t1);
        nextValues.push(...v1);
    }

    if (!changed) return track;
    return cloneTrackWithData(track, nextTimes, nextValues);
}

function interpolateTrackValue(
    property: AnimationTrackProperty,
    from: number[],
    to: number[],
    alpha: number,
): number[] {
    if (property === 'quaternion' && from.length >= 4 && to.length >= 4) {
        const q0 = new Quaternion(from[0], from[1], from[2], from[3]);
        const q1 = new Quaternion(to[0], to[1], to[2], to[3]);
        q0.slerp(q1, alpha);
        return [q0.x, q0.y, q0.z, q0.w];
    }
    return from.map((value, index) => value + ((to[index] ?? value) - value) * alpha);
}

function cubicBezierYForX(x: number, curve: AnimationEasingCurve): number {
    const [x1, y1, x2, y2] = curve.map((value) => Math.max(0, Math.min(1, value))) as AnimationEasingCurve;
    let low = 0;
    let high = 1;
    let t = x;
    for (let index = 0; index < 16; index += 1) {
        t = (low + high) / 2;
        const estimate = cubicBezier(t, 0, x1, x2, 1);
        if (estimate < x) low = t;
        else high = t;
    }
    return cubicBezier(t, 0, y1, y2, 1);
}

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const inv = 1 - t;
    return inv * inv * inv * p0
        + 3 * inv * inv * t * p1
        + 3 * inv * t * t * p2
        + t * t * t * p3;
}

function createTrackFromSnapshot(name: string, times: number[], values: number[]): KeyframeTrack {
    const property = parseAnimationTrackName(name).property;
    if (property === 'quaternion') return new QuaternionKeyframeTrack(name, times, values);
    if (property === 'position' || property === 'scale') return new VectorKeyframeTrack(name, times, values);
    return new NumberKeyframeTrack(name, times, values);
}

function trackTargetsBoneProperty(
    track: KeyframeTrack,
    bone: Bone,
    property: 'position' | 'quaternion' | 'scale',
): boolean {
    const parsed = parseAnimationTrackName(track.name);
    if (parsed.property !== property) return false;
    const boneNames = new Set([
        bone.name,
        bone.uuid,
        getBoneDisplayName(bone, -1),
    ].filter(Boolean));
    return boneNames.has(parsed.target) || track.name === getBoneTrackName(bone, property);
}

function getBonePropertyValue(
    bone: Bone,
    property: 'position' | 'quaternion' | 'scale',
): number[] {
    if (property === 'quaternion') return [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
    const vector = property === 'position' ? bone.position : bone.scale;
    return [vector.x, vector.y, vector.z];
}

function mirrorBoneLocalTrs(bone: Bone): {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
} {
    return {
        position: [-bone.position.x, bone.position.y, bone.position.z],
        quaternion: [bone.quaternion.x, -bone.quaternion.y, -bone.quaternion.z, bone.quaternion.w],
        scale: [bone.scale.x, bone.scale.y, bone.scale.z],
    };
}

function mirrorAnimationTrack(track: KeyframeTrack, boneNames: Set<string>): KeyframeTrack {
    const parsed = parseAnimationTrackName(track.name);
    const times = Array.from(track.times as ArrayLike<number>);
    const values = Array.from(track.values as ArrayLike<number>);
    if (parsed.property !== 'position' && parsed.property !== 'quaternion' && parsed.property !== 'scale') {
        return cloneTrackWithNamedData(track, track.name, times, values);
    }

    const mirroredTarget = findMirroredBoneName(parsed.target, boneNames) ?? parsed.target;
    const mirroredName = `${mirroredTarget}.${parsed.property}`;
    const mirroredValues = mirrorTrackValues(parsed.property, values, track.getValueSize());
    return cloneTrackWithNamedData(track, mirroredName, times, mirroredValues);
}

function mirrorTrackValues(property: AnimationTrackProperty, values: number[], valueSize: number): number[] {
    const next = values.slice();
    if (property === 'position' && valueSize >= 3) {
        for (let index = 0; index < next.length; index += valueSize) next[index] = -next[index];
    } else if (property === 'quaternion' && valueSize >= 4) {
        for (let index = 0; index < next.length; index += valueSize) {
            next[index + 1] = -next[index + 1];
            next[index + 2] = -next[index + 2];
        }
    }
    return next;
}

function findMirroredBoneName(name: string, names: Set<string>): string | null {
    if (!name) return null;
    const replacements: Array<[RegExp, string]> = [
        [/\.L$/i, '.R'], [/\.R$/i, '.L'],
        [/_L$/i, '_R'],  [/_R$/i, '_L'],
        [/-L$/i, '-R'],  [/-R$/i, '-L'],
        [/_l$/i, '_r'],  [/_r$/i, '_l'],
        [/\bL$/i, 'R'],  [/\bR$/i, 'L'],
        [/^L_/i, 'R_'],  [/^R_/i, 'L_'],
        [/^l_/i, 'r_'],  [/^r_/i, 'l_'],
        [/^Left/i, 'Right'], [/^Right/i, 'Left'],
        [/Left/g, 'Right'],  [/Right/g, 'Left'],
        [/left/g, 'right'],  [/right/g, 'left'],
    ];
    for (const [pattern, replacement] of replacements) {
        if (!pattern.test(name)) continue;
        const candidate = name.replace(pattern, replacement);
        if (candidate !== name && names.has(candidate)) return candidate;
    }
    return null;
}

function nearlyEqualTime(a: number, b: number): boolean {
    return Math.abs(a - b) < 1e-4;
}

function normalizeKeyframeTimes(times: number[]): number[] {
    return [...new Set(
        times
            .filter(Number.isFinite)
            .map((time) => Number(time.toFixed(4))),
    )].sort((a, b) => a - b);
}

function buildAnimationTrackMeta(track: KeyframeTrack, index: number): AnimationTrackMeta {
    const parsed = parseAnimationTrackName(track.name);
    const valueSize = track.getValueSize();
    const propertyLabel = ANIMATION_TRACK_PROPERTY_LABELS[parsed.property];
    return {
        index,
        name: track.name,
        target: parsed.target,
        property: parsed.property,
        propertyLabel,
        valueSize,
        keyframes: track.times.length,
        editable: parsed.property === 'position'
            ? valueSize >= 3
            : parsed.property === 'scale'
                ? valueSize >= 3
                : parsed.property === 'quaternion' && valueSize >= 4,
    };
}

function parseAnimationTrackName(name: string): {
    target: string;
    property: AnimationTrackProperty;
} {
    for (const property of EDITABLE_ANIMATION_PROPERTIES) {
        const suffix = `.${property}`;
        if (name.endsWith(suffix)) {
            return {
                target: normalizeAnimationTargetName(name.slice(0, -suffix.length)),
                property,
            };
        }
    }

    const dotIndex = name.lastIndexOf('.');
    return {
        target: normalizeAnimationTargetName(dotIndex > 0 ? name.slice(0, dotIndex) : name),
        property: 'other',
    };
}

function normalizeAnimationTargetName(value: string): string {
    const cleaned = value
        .replace(/^\./u, '')
        .replace(/^bones\[/u, '')
        .replace(/\]$/u, '')
        .replace(/^\["/u, '')
        .replace(/"\]$/u, '')
        .trim();
    return cleaned || '根节点';
}

function cloneNumericArrayLike(source: unknown, values: number[]): unknown {
    const ctor = (source as { constructor?: new (items: ArrayLike<number>) => unknown } | null)?.constructor;
    if (typeof ctor === 'function') {
        try {
            return new ctor(values);
        } catch {
            // Fall back to a regular array if the original storage cannot be reconstructed.
        }
    }
    return values.slice();
}

function applyPositionTrackOffset(track: KeyframeTrack, edit: AnimationTrackVectorEdit): void {
    const values = track.values as unknown as ArrayLike<number> & { [index: number]: number };
    const stride = track.getValueSize();
    for (let index = 0; index + 2 < values.length; index += stride) {
        values[index] += edit.x;
        values[index + 1] += edit.y;
        values[index + 2] += edit.z;
    }
}

function applyScaleTrackFactor(track: KeyframeTrack, edit: AnimationTrackVectorEdit): void {
    const values = track.values as unknown as ArrayLike<number> & { [index: number]: number };
    const stride = track.getValueSize();
    const x = normalizeScaleFactor(edit.x);
    const y = normalizeScaleFactor(edit.y);
    const z = normalizeScaleFactor(edit.z);
    for (let index = 0; index + 2 < values.length; index += stride) {
        values[index] *= x;
        values[index + 1] *= y;
        values[index + 2] *= z;
    }
}

function applyQuaternionTrackEulerOffset(track: KeyframeTrack, edit: AnimationTrackVectorEdit): void {
    const values = track.values as unknown as ArrayLike<number> & { [index: number]: number };
    const stride = track.getValueSize();
    const delta = new Quaternion().setFromEuler(new Euler(
        degreesToRadians(edit.x),
        degreesToRadians(edit.y),
        degreesToRadians(edit.z),
        'XYZ',
    ));
    const current = new Quaternion();

    for (let index = 0; index + 3 < values.length; index += stride) {
        current
            .set(values[index], values[index + 1], values[index + 2], values[index + 3])
            .multiply(delta)
            .normalize();
        values[index] = current.x;
        values[index + 1] = current.y;
        values[index + 2] = current.z;
        values[index + 3] = current.w;
    }
}

function normalizeScaleFactor(value: number): number {
    return Number.isFinite(value) && Math.abs(value) > 1e-6 ? value : 1;
}

function degreesToRadians(value: number): number {
    return (value * Math.PI) / 180;
}

function cloneMaterialSet(material: Material | Material[]): Material | Material[] {
    if (Array.isArray(material)) return material.map(cloneMaterialDeep);
    return cloneMaterialDeep(material);
}

function cloneMaterialEditSnapshot(snapshot: MaterialEditSnapshot): MaterialEditSnapshot {
    return {
        ...snapshot,
        textureTransforms: Object.fromEntries(
            Object.entries(snapshot.textureTransforms).map(([slot, transform]) => [
                slot,
                transform ? { ...transform } : transform,
            ]),
        ) as Partial<Record<TextureSlotId, TextureTransform>>,
    };
}

function cloneMaterialDeep(material: Material): Material {
    const cloned = material.clone();
    const source = material as unknown as Record<string, unknown>;
    const target = cloned as unknown as Record<string, unknown>;

    for (const key of Object.keys(source)) {
        const value = source[key];
        if (value && typeof value === 'object' && 'isTexture' in value && (value as any).isTexture) {
            target[key] = (value as Texture).clone();
        }
    }

    return cloned;
}

function disposeMaterialSet(
    material: Material | Material[] | null | undefined,
    options: { closeImages?: boolean; closedImages?: Set<ImageBitmap> } = {},
): void {
    if (!material) return;
    if (Array.isArray(material)) {
        material.forEach((item) => disposeMaterial(item, options));
        return;
    }
    disposeMaterial(material, options);
}

function disposeMaterial(
    material: Material,
    options: { closeImages?: boolean; closedImages?: Set<ImageBitmap> } = {},
): void {
    const maybeMaterial = material as unknown as Record<string, unknown>;
    for (const key of Object.keys(maybeMaterial)) {
        const value = maybeMaterial[key];
        if (value && typeof value === 'object' && 'isTexture' in (value as object) && (value as any).isTexture) {
            disposeTexture(value as Texture, options);
        }
    }
    material.dispose();
}

function disposeTexture(
    texture: Texture,
    options: { closeImages?: boolean; closedImages?: Set<ImageBitmap> } = {},
): void {
    if (options.closeImages) {
        const image = getTextureImage(texture);
        if (isImageBitmapLike(image) && !options.closedImages?.has(image)) {
            image.close();
            options.closedImages?.add(image);
        }
    }
    texture.dispose();
}

function isImageBitmapLike(value: unknown): value is ImageBitmap {
    return Boolean(value)
        && typeof ImageBitmap !== 'undefined'
        && value instanceof ImageBitmap
        && typeof value.close === 'function';
}

function revokeModelObjectUrls(root: Object3D): void {
    root.traverse((node) => {
        const urls = node.userData?.__assetObjectUrls;
        if (!Array.isArray(urls)) return;
        for (const url of urls) {
            if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
        }
        delete node.userData.__assetObjectUrls;
    });
}

function extractMaterialScalar(
    material: Record<string, any> | null,
    key: 'roughness' | 'metalness',
    fallback: number,
): number {
    return typeof material?.[key] === 'number' ? material[key] : fallback;
}

function extractMaterialOpacity(material: Record<string, any> | null): number {
    return typeof material?.opacity === 'number' ? material.opacity : 1;
}

function extractMaterialColor(material: Record<string, any> | null): string {
    if (material?.color?.isColor && material.color.getHexString) {
        return `#${material.color.getHexString()}`;
    }
    return '#aab3c0';
}

function extractDoubleSided(material: Record<string, any> | null): boolean {
    return material?.side === DoubleSide;
}

function stripMaterialTextures(material: Record<string, any>): void {
    const textureKeys = [
        'map',
        'alphaMap',
        'aoMap',
        'bumpMap',
        'displacementMap',
        'emissiveMap',
        'envMap',
        'lightMap',
        'metalnessMap',
        'normalMap',
        'roughnessMap',
        'specularMap',
        'clearcoatMap',
        'clearcoatNormalMap',
        'clearcoatRoughnessMap',
        'sheenColorMap',
        'sheenRoughnessMap',
        'thicknessMap',
        'transmissionMap',
    ];

    for (const key of textureKeys) {
        if (key in material) material[key] = null;
    }
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function defaultTextureTransform(): TextureTransform {
    return {
        offsetX: 0,
        offsetY: 0,
        repeatX: 1,
        repeatY: 1,
        rotation: 0,
    };
}

function textureTransformOf(texture: Texture): TextureTransform {
    return {
        offsetX: texture.offset.x,
        offsetY: texture.offset.y,
        repeatX: texture.repeat.x,
        repeatY: texture.repeat.y,
        rotation: (texture.rotation * 180) / Math.PI,
    };
}

function getTextureSlot(material: Record<string, any>, slot: TextureSlotId): Texture | null {
    const texture = material?.[slot];
    return texture && typeof texture === 'object' && texture.isTexture ? texture as Texture : null;
}

function applyTextureTransformsToMaterial(
    material: Record<string, any>,
    sourceMaterial: Record<string, any>,
    transforms: Partial<Record<TextureSlotId, TextureTransform>>,
): void {
    for (const slot of TEXTURE_SLOT_ORDER) {
        const texture = getTextureSlot(material, slot);
        const sourceTexture = getTextureSlot(sourceMaterial, slot);
        if (!texture || !sourceTexture) continue;

        const transform = transforms[slot] ?? textureTransformOf(sourceTexture);
        texture.offset.set(transform.offsetX, transform.offsetY);
        texture.repeat.set(transform.repeatX, transform.repeatY);
        texture.center.set(0.5, 0.5);
        texture.rotation = (transform.rotation * Math.PI) / 180;

        const original = textureTransformOf(sourceTexture);
        const changed = !areTextureTransformsEqual(transform, original);
        if (changed) {
            texture.wrapS = RepeatWrapping;
            texture.wrapT = RepeatWrapping;
        } else {
            texture.wrapS = sourceTexture.wrapS;
            texture.wrapT = sourceTexture.wrapT;
        }
        texture.needsUpdate = true;
    }
}

function areTextureTransformsEqual(a: TextureTransform, b: TextureTransform): boolean {
    return nearlyEqual(a.offsetX, b.offsetX)
        && nearlyEqual(a.offsetY, b.offsetY)
        && nearlyEqual(a.repeatX, b.repeatX)
        && nearlyEqual(a.repeatY, b.repeatY)
        && nearlyEqual(a.rotation, b.rotation);
}

function nearlyEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < 1e-4;
}

function getTextureWidth(texture: Texture | null): number | null {
    const image = getTextureImage(texture);
    if (!image) return null;
    if ('width' in image && typeof image.width === 'number') return image.width;
    return null;
}

function getTextureHeight(texture: Texture | null): number | null {
    const image = getTextureImage(texture);
    if (!image) return null;
    if ('height' in image && typeof image.height === 'number') return image.height;
    return null;
}

function extractTextureSourceName(texture: Texture | null): string {
    if (!texture) return '';
    if (texture.name) return texture.name;

    const image = getTextureImage(texture);
    if (image && 'src' in image && typeof image.src === 'string' && image.src) {
        const normalized = image.src.replaceAll('\\', '/');
        const index = normalized.lastIndexOf('/');
        return index >= 0 ? normalized.slice(index + 1) : normalized;
    }

    return '内嵌贴图';
}

function buildTexturePreview(texture: Texture): string | null {
    const image = getTextureImage(texture);
    if (!image || typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#f4f7fa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (typeof ImageData !== 'undefined' && image instanceof ImageData) {
        const temp = document.createElement('canvas');
        temp.width = image.width;
        temp.height = image.height;
        const tempCtx = temp.getContext('2d');
        if (!tempCtx) return null;
        tempCtx.putImageData(image, 0, 0);
        ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
    }

    if (
        image instanceof HTMLImageElement ||
        image instanceof HTMLCanvasElement ||
        image instanceof ImageBitmap
    ) {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
    }

    return null;
}

function buildTextureDrawableSource(texture: Texture): CanvasImageSource | null {
    const image = getTextureImage(texture);
    if (!image || typeof document === 'undefined') return null;

    if (
        image instanceof HTMLImageElement ||
        image instanceof HTMLCanvasElement ||
        image instanceof ImageBitmap
    ) {
        return image;
    }

    if (typeof ImageData !== 'undefined' && image instanceof ImageData) {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.putImageData(image, 0, 0);
        return canvas;
    }

    return null;
}

function getTextureImage(texture: Texture | null): CanvasImageSource | ImageData | null {
    if (!texture) return null;
    return (texture.source?.data as CanvasImageSource | ImageData | undefined) ?? null;
}

function buildUvEditorCache(root: Object3D): UvEditorCache {
    const points: UvPointState[] = [];
    const triangles: UvTriangleState[] = [];
    const refs: UvPointRef[] = [];
    const pointKeyToId = new Map<string, number>();
    let meshIndex = 0;

    root.traverse((node: Object3D) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;

        const uv = mesh.geometry.getAttribute('uv');
        if (!uv || uv.itemSize < 2) {
            meshIndex += 1;
            return;
        }

        const uvAttribute = uv as BufferAttribute;
        const index = mesh.geometry.getIndex();
        const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(uvAttribute.count / 3);

        const getPointId = (uvIndex: number): number => {
            const key = `${meshIndex}:${uvIndex}`;
            const existing = pointKeyToId.get(key);
            if (existing !== undefined) return existing;

            const id = points.length;
            pointKeyToId.set(key, id);
            points.push({
                id,
                x: uvAttribute.getX(uvIndex),
                y: uvAttribute.getY(uvIndex),
                islandId: -1,
            });
            refs.push({
                attribute: uvAttribute,
                uvIndex,
            });
            return id;
        };

        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
            const base = triangle * 3;
            const aIndex = index ? index.getX(base) : base;
            const bIndex = index ? index.getX(base + 1) : base + 1;
            const cIndex = index ? index.getX(base + 2) : base + 2;
            triangles.push({
                a: getPointId(aIndex),
                b: getPointId(bIndex),
                c: getPointId(cIndex),
                islandId: -1,
            });
        }

        meshIndex += 1;
    });

    const islandPointIds = assignUvIslands(points, triangles);
    const segments = buildUvSegmentsFromTriangles(triangles, points);
    return {
        points,
        triangles,
        segments,
        refs,
        islandPointIds,
    };
}

function assignUvIslands(points: UvPointState[], triangles: UvTriangleState[]): number[][] {
    const adjacency = Array.from({ length: points.length }, () => new Set<number>());

    for (const triangle of triangles) {
        adjacency[triangle.a]?.add(triangle.b);
        adjacency[triangle.a]?.add(triangle.c);
        adjacency[triangle.b]?.add(triangle.a);
        adjacency[triangle.b]?.add(triangle.c);
        adjacency[triangle.c]?.add(triangle.a);
        adjacency[triangle.c]?.add(triangle.b);
    }

    const visited = new Array(points.length).fill(false);
    const islandPointIds: number[][] = [];

    for (let pointId = 0; pointId < points.length; pointId += 1) {
        if (visited[pointId]) continue;

        const islandId = islandPointIds.length;
        const stack = [pointId];
        const ids: number[] = [];
        visited[pointId] = true;

        while (stack.length > 0) {
            const current = stack.pop()!;
            ids.push(current);
            points[current].islandId = islandId;

            for (const next of adjacency[current]) {
                if (visited[next]) continue;
                visited[next] = true;
                stack.push(next);
            }
        }

        islandPointIds.push(ids);
    }

    for (const triangle of triangles) {
        triangle.islandId = points[triangle.a]?.islandId ?? -1;
    }

    return islandPointIds;
}

function buildUvSegmentsFromTriangles(
    triangles: UvTriangleState[],
    points: UvPointState[],
): Float32Array {
    const values: number[] = [];
    const dedupe = new Set<string>();

    const addEdge = (a: number, b: number) => {
        const first = points[a];
        const second = points[b];
        if (!first || !second) return;
        if (nearlyEqual(first.x, second.x) && nearlyEqual(first.y, second.y)) return;

        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (dedupe.has(key)) return;
        dedupe.add(key);
        values.push(first.x, first.y, second.x, second.y);
    };

    for (const triangle of triangles) {
        addEdge(triangle.a, triangle.b);
        addEdge(triangle.b, triangle.c);
        addEdge(triangle.c, triangle.a);
    }

    return new Float32Array(values);
}

const TEXTURE_SLOT_LABELS: Record<TextureSlotId, string> = {
    map: '基础色',
    normalMap: '法线',
    roughnessMap: '粗糙度',
    metalnessMap: '金属度',
    emissiveMap: '自发光',
    alphaMap: '透明',
    aoMap: 'AO',
    bumpMap: '凹凸',
};

const TEXTURE_SLOT_ORDER: TextureSlotId[] = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'emissiveMap',
    'alphaMap',
    'aoMap',
    'bumpMap',
];

const EDITABLE_ANIMATION_PROPERTIES: AnimationTrackProperty[] = [
    'position',
    'quaternion',
    'scale',
];

const ANIMATION_TRACK_PROPERTY_LABELS: Record<AnimationTrackProperty, string> = {
    position: '平移',
    quaternion: '旋转',
    scale: '缩放',
    other: '其他',
};
