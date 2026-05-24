import { BoxGeometry, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import {
    type AnimationBlendMode,
    type AnimationClipSnapshot,
    type AnimationEasingCurve,
    type AnimationEditorState,
    type AnimationLibrarySnapshot,
    type AnimationPlaybackState,
    type AnimationTrackMeta,
    type BonePoseSnapshot,
    type BoneTransformMode,
    type BoneTransformSpace,
    type MaterialEditMode,
    type MaterialEditSnapshot,
    type SkeletonEditorState,
    type TextureSlotId,
    type TextureSlotState,
    type TextureTransform,
    type UvEditorState,
    Viewer,
} from './viewer';
import { ACCEPT_EXTS, extOf, isSupported, loadFromFiles, loadFromPath, loadGLBAnimationClipFromPath } from './loaders';
import { app, dialog, fs, win } from './api';
import { inNative } from './ipc';
import { extractModelPathsFromUrls } from './launch';

type InspectorTab = 'overview' | 'properties' | 'animation' | 'textures';
type ContentMode = 'model' | 'uv';
type AnimationExportScope = 'all' | 'current';
type SaveDestination = 'overwrite' | 'save-as';
type SaveChoice = {
    destination: SaveDestination;
    animationScope: AnimationExportScope;
};
type AnimationEasingName = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'custom';
type UvSelectionMode = 'vertex' | 'edge' | 'face';
type UvEdgeState = {
    id: string;
    a: number;
    b: number;
    islandId: number;
};

type UvScreenTransform = {
    width: number;
    height: number;
    axisScale: {
        x: number;
        y: number;
        min: number;
    };
};

type UvTexturePatternMode = 'repeat' | 'no-repeat';

type TextureTransformSnapshot = {
    slot: TextureSlotId;
    transform: TextureTransform;
};

type UvPointSnapshot = {
    pointId: number;
    x: number;
    y: number;
};

type UvSelectionSnapshot = {
    mode: UvSelectionMode;
    pointIds: number[];
    edgeIds: string[];
    faceIds: number[];
};

type UndoEntry =
    | {
        kind: 'material';
        label: string;
        snapshot: MaterialEditSnapshot;
    }
    | {
        kind: 'texture';
        label: string;
        snapshot: TextureTransformSnapshot;
    }
    | {
        kind: 'uv';
        label: string;
        snapshot: UvPointSnapshot[];
        selection: UvSelectionSnapshot;
    }
    | {
        kind: 'uv-selection';
        label: string;
        selection: UvSelectionSnapshot;
    }
    | {
        kind: 'animation';
        label: string;
        snapshot: AnimationClipSnapshot;
    }
    | {
        kind: 'animation-library';
        label: string;
        snapshot: AnimationLibrarySnapshot;
    }
    | {
        kind: 'bone-pose';
        label: string;
        snapshot: BonePoseSnapshot;
    };

type DocumentSession = {
    id: string;
    name: string;
    root: Object3D;
    kind: 'sample' | 'model';
    sourcePath?: string;
    dirty: boolean;
    undoStack: UndoEntry[];
    redoStack: UndoEntry[];
};

type ThemeMode = 'light' | 'dark' | 'auto';

type LayoutState = {
    inspectorWidth: number;
    leftSidebarWidth: number;
    activeTab: InspectorTab;
    contentMode: ContentMode;
    theme: ThemeMode;
    groups: Record<string, boolean>;
};

const LAYOUT_KEY = 'portable-3d-viewer.layout.v9';
const MAX_UNDO_STEPS = 80;
const INSPECTOR_MIN_WIDTH = 280;
const LEFT_SIDEBAR_MIN_WIDTH = 220;
const DEFAULT_LAYOUT: LayoutState = {
    inspectorWidth: 336,
    leftSidebarWidth: 260,
    activeTab: 'overview',
    contentMode: 'model',
    theme: 'auto',
    groups: {
        runtime: true,
        stats: true,
        document: true,
        camera: true,
        material: true,
        textures: true,
        'uv-mapping': true,
        animation: true,
    },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;

const root = document.documentElement;
const viewport = $('viewport');
const uvWorkspace = $('uv-workspace');
const canvas = $<HTMLCanvasElement>('canvas');
const fileInput = $<HTMLInputElement>('file-input');
const loading = $('loading');
const loadingText = $('loading-text');
const toast = $('toast');
const documentTabs = $('document-tabs');
const rightResizer = $('right-resizer');
const leftResizer = $('left-resizer');
const leftSidebar = $('left-sidebar');
const leftSidebarMeta = $('left-sidebar-meta');
const viewPresets = $('view-presets');
const btnThemeToggle = $<HTMLButtonElement>('btn-theme-toggle');
const statusFrame = $('status-frame');
const statusFrameValue = $('status-frame-value');
const statusBone = $('status-bone');
const statusBoneValue = $('status-bone-value');
const statusKeys = $('status-keys');
const statusKeysValue = $('status-keys-value');

const btnOpen = $<HTMLButtonElement>('btn-open');
const btnSave = $<HTMLButtonElement>('btn-save');
const btnSaveAs = $<HTMLButtonElement>('btn-save-as');
const btnReset = $<HTMLButtonElement>('btn-reset');
const btnClear = $<HTMLButtonElement>('btn-clear');
const btnUndo = $<HTMLButtonElement>('btn-undo');
const btnRedo = $<HTMLButtonElement>('btn-redo');
const btnResetLayout = $<HTMLButtonElement>('btn-reset-layout');
const btnModeModel = $<HTMLButtonElement>('btn-mode-model');
const btnModeUv = $<HTMLButtonElement>('btn-mode-uv');
const btnOpenUvWorkspace = $<HTMLButtonElement>('btn-open-uv-workspace');
const btnOpenUvTab = $<HTMLButtonElement>('btn-open-uv-tab');

const togWire = $<HTMLInputElement>('tog-wire');
const togGrid = $<HTMLInputElement>('tog-grid');
const togAxes = $<HTMLInputElement>('tog-axes');
const togBg = $<HTMLInputElement>('tog-bg');

const toolbarSceneState = $('toolbar-scene-state');
const toolbarFps = $('toolbar-fps');
const toolbarModelName = $('toolbar-model-name');

const sceneState = $('scene-state');
const fpsEl = $('fps');
const modelName = $('model-name');

const statVerts = $('stat-verts');
const statFaces = $('stat-faces');
const statEdges = $('stat-edges');
const statMeshes = $('stat-meshes');

const propDocName = $('prop-doc-name');
const propDocState = $('prop-doc-state');
const propDocCount = $('prop-doc-count');
const propBounds = $('prop-bounds');
const propCenter = $('prop-center');
const propCameraPos = $('prop-camera-pos');
const propCameraTarget = $('prop-camera-target');

const cameraFovRange = $<HTMLInputElement>('camera-fov-range');
const cameraFovInput = $<HTMLInputElement>('camera-fov-input');
const cameraExposureRange = $<HTMLInputElement>('camera-exposure-range');
const cameraExposureInput = $<HTMLInputElement>('camera-exposure-input');

const matVisible = $<HTMLInputElement>('mat-visible');
const matMode = $<HTMLSelectElement>('mat-mode');
const matOpacityRange = $<HTMLInputElement>('mat-opacity-range');
const matOpacityInput = $<HTMLInputElement>('mat-opacity-input');
const matColorInput = $<HTMLInputElement>('mat-color-input');
const matRoughnessRange = $<HTMLInputElement>('mat-roughness-range');
const matRoughnessInput = $<HTMLInputElement>('mat-roughness-input');
const matMetalnessRange = $<HTMLInputElement>('mat-metalness-range');
const matMetalnessInput = $<HTMLInputElement>('mat-metalness-input');
const matFlat = $<HTMLInputElement>('mat-flat');
const matDoubleSided = $<HTMLInputElement>('mat-double-sided');
const btnResetMaterial = $<HTMLButtonElement>('btn-reset-material');

const textureEmpty = $('texture-empty');
const textureBrowser = $('texture-browser');
const textureList = $('texture-list');
const uvEditorFrame = $('uv-editor-frame');
const uvEditorCanvas = $<HTMLCanvasElement>('uv-editor-canvas');
const uvEditorEmpty = $('uv-editor-empty');
const uvEditorStatus = $('uv-editor-status');
const uvSelectVertex = $<HTMLButtonElement>('uv-select-vertex');
const uvSelectEdge = $<HTMLButtonElement>('uv-select-edge');
const uvSelectFace = $<HTMLButtonElement>('uv-select-face');
const uvSnapEnabledInput = $<HTMLInputElement>('uv-snap-enabled');
const uvSnapStrengthRange = $<HTMLInputElement>('uv-snap-strength-range');
const uvSnapStrengthInput = $<HTMLInputElement>('uv-snap-strength-input');
const texSlotName = $('tex-slot-name');
const texDimensions = $('tex-dimensions');
const texSourceName = $('tex-source-name');
const texOffsetXRange = $<HTMLInputElement>('tex-offset-x-range');
const texOffsetXInput = $<HTMLInputElement>('tex-offset-x-input');
const texOffsetYRange = $<HTMLInputElement>('tex-offset-y-range');
const texOffsetYInput = $<HTMLInputElement>('tex-offset-y-input');
const texRepeatXRange = $<HTMLInputElement>('tex-repeat-x-range');
const texRepeatXInput = $<HTMLInputElement>('tex-repeat-x-input');
const texRepeatYRange = $<HTMLInputElement>('tex-repeat-y-range');
const texRepeatYInput = $<HTMLInputElement>('tex-repeat-y-input');
const texRotationRange = $<HTMLInputElement>('tex-rotation-range');
const texRotationInput = $<HTMLInputElement>('tex-rotation-input');
const btnResetTextureTransform = $<HTMLButtonElement>('btn-reset-texture-transform');

const animBar = $('anim-bar');
const animPlayBtn = $<HTMLButtonElement>('anim-play');
const animStopBtn = $<HTMLButtonElement>('anim-stop');
const animClipSearch = $<HTMLInputElement>('anim-clip-search');
const btnNewTposeClip = $<HTMLButtonElement>('btn-new-tpose-clip');
const btnNewCurrentPoseClip = $<HTMLButtonElement>('btn-new-current-pose-clip');
const btnCopyClipKeys = $<HTMLButtonElement>('btn-copy-clip-keys');
const btnPasteClipKeys = $<HTMLButtonElement>('btn-paste-clip-keys');
const animClipList = $('anim-clip-list');
const animEditOpenBtn = $<HTMLButtonElement>('anim-edit-open');
const animTimeRange = $<HTMLInputElement>('anim-time');
const animTimeLabel = $('anim-time-label');
const animLoopInput = $<HTMLInputElement>('anim-loop');
const animSpeedInput = $<HTMLInputElement>('anim-speed');
const animSummary = $('anim-summary');
const animEditorEmpty = $('anim-editor-empty');
const animEditor = $('anim-editor');
const animShowSkeletonInput = $<HTMLInputElement>('anim-show-skeleton');
const animShowTransformInput = $<HTMLInputElement>('anim-show-transform');
const animBoneSearch = $<HTMLInputElement>('anim-bone-search');
const animBoneList = $('anim-bone-list');
const animSelectedBone = $('anim-selected-bone');
const animModeTranslate = $<HTMLButtonElement>('anim-mode-translate');
const animModeRotate = $<HTMLButtonElement>('anim-mode-rotate');
const animSpaceLocal = $<HTMLButtonElement>('anim-space-local');
const animSpaceWorld = $<HTMLButtonElement>('anim-space-world');
const animFkMode = $<HTMLButtonElement>('anim-fk-mode');
const animIkMode = $<HTMLButtonElement>('anim-ik-mode');
const animAutoKeyframeInput = $<HTMLInputElement>('anim-auto-keyframe');
const animIkChainLengthInput = $<HTMLInputElement>('anim-ik-chain-length');
const animIkIterationsInput = $<HTMLInputElement>('anim-ik-iterations');
const animRotationStepInput = $<HTMLInputElement>('anim-rotation-step');
const animTranslationStepInput = $<HTMLInputElement>('anim-translation-step');
const animTimelineScroll = $('anim-timeline-scroll');
const animKeyframeStrip = $('anim-keyframe-strip');
const btnInsertKeyframe = $<HTMLButtonElement>('btn-insert-keyframe');
const btnInsertChainKeyframe = $<HTMLButtonElement>('btn-insert-chain-keyframe');
const btnDeleteKeyframe = $<HTMLButtonElement>('btn-delete-keyframe');
const btnResetBonePose = $<HTMLButtonElement>('btn-reset-bone-pose');
const btnResetBoneChainPose = $<HTMLButtonElement>('btn-reset-bone-chain-pose');
const btnCopyBonePose = $<HTMLButtonElement>('btn-copy-bone-pose');
const btnPasteBonePose = $<HTMLButtonElement>('btn-paste-bone-pose');
const btnCopyBoneChainPose = $<HTMLButtonElement>('btn-copy-bone-chain-pose');
const btnPasteBoneChainPose = $<HTMLButtonElement>('btn-paste-bone-chain-pose');
const btnMirrorBonePose = $<HTMLButtonElement>('btn-mirror-bone-pose');
const btnMirrorBoneChainPose = $<HTMLButtonElement>('btn-mirror-bone-chain-pose');
const btnMirrorAnimation = $<HTMLButtonElement>('btn-mirror-animation');
const btnAnimHistoryUndo = $<HTMLButtonElement>('btn-anim-history-undo');
const btnAnimHistoryRedo = $<HTMLButtonElement>('btn-anim-history-redo');
const animHistoryList = $('anim-history-list');
const animKeyframeSelection = $('anim-keyframe-selection');
const btnTimelineSelectAll = $<HTMLButtonElement>('btn-timeline-select-all');
const btnTimelineClearSelection = $<HTMLButtonElement>('btn-timeline-clear-selection');
const btnTimelineCopyKeys = $<HTMLButtonElement>('btn-timeline-copy-keys');
const btnTimelinePasteKeys = $<HTMLButtonElement>('btn-timeline-paste-keys');
const animTimelineSnapInput = $<HTMLInputElement>('anim-timeline-snap');
const animTimelineSelectedBoneOnlyInput = $<HTMLInputElement>('anim-timeline-selected-bone-only');
const animTimelineFpsInput = $<HTMLInputElement>('anim-timeline-fps');
const animTimelineZoomInput = $<HTMLInputElement>('anim-timeline-zoom');
const animTimelineZoomLabel = $('anim-timeline-zoom-label');
const animClipNameInput = $<HTMLInputElement>('anim-clip-name');
const animClipDuration = $('anim-clip-duration');
const animTrackCount = $('anim-track-count');
const animTrackSelect = $<HTMLSelectElement>('anim-track-select');
const animTrackType = $('anim-track-type');
const animTrackKeys = $('anim-track-keys');
const animCurvePanel = $('anim-curve-panel');
const animBlendModeSelect = $<HTMLSelectElement>('anim-blend-mode');
const animEasingSelect = $<HTMLSelectElement>('anim-easing');
const animEasingCanvas = $<HTMLCanvasElement>('anim-easing-canvas');
const animEasingPresetSelect = $<HTMLSelectElement>('anim-easing-preset');
const btnApplyAnimEasing = $<HTMLButtonElement>('btn-apply-anim-easing');
const animTransformControls = $('anim-transform-controls');
const animEditXLabel = $('anim-edit-x-label');
const animEditYLabel = $('anim-edit-y-label');
const animEditZLabel = $('anim-edit-z-label');
const animEditXInput = $<HTMLInputElement>('anim-edit-x');
const animEditYInput = $<HTMLInputElement>('anim-edit-y');
const animEditZInput = $<HTMLInputElement>('anim-edit-z');
const btnApplyAnimTransform = $<HTMLButtonElement>('btn-apply-anim-transform');
const animTimeScaleRange = $<HTMLInputElement>('anim-time-scale-range');
const animTimeScaleInput = $<HTMLInputElement>('anim-time-scale-input');
const btnApplyAnimTimeScale = $<HTMLButtonElement>('btn-apply-anim-time-scale');

type BonePoseClipboardItem = {
    boneName: string;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
};

type BonePoseClipboard = {
    mode: 'single' | 'chain';
    sourceBoneName: string;
    items: BonePoseClipboardItem[];
};

const ANIMATION_EASING_CURVES: Record<Exclude<AnimationEasingName, 'custom'>, AnimationEasingCurve> = {
    linear: [0, 0, 1, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
};

let bonePoseClipboard: BonePoseClipboard | null = null;

const inspectorTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.inspector-tab'));
const inspectorViews = Array.from(document.querySelectorAll<HTMLElement>('.inspector-view'));
const inspectorGroups = Array.from(document.querySelectorAll<HTMLDetailsElement>('.inspector-group'));

const sceneStateEls = [toolbarSceneState, sceneState];
const fpsEls = [toolbarFps, fpsEl];
const modelNameEls = [toolbarModelName, modelName];

let animTimeRangeSyncing = false;
let selectedAnimationTrackIndex = -1;
let selectedKeyframeTimes: number[] = [];
let animationClipboard: AnimationClipSnapshot | null = null;
let keyframeClipboard: AnimationClipSnapshot | null = null;
const lazyAnimationLoads = new Map<string, Promise<boolean>>();
let animationClipListRenderKey = '';
let lastScrolledBoneIndex = -1;
let timelineZoom = 1;
let timelineSnapEnabled = true;
let timelineSelectedBoneOnly = false;
let timelineFps = 30;
let timelineRetimePreviewDelta = 0;
let statsRefreshRaf = 0;
let animationEasingCurve: AnimationEasingCurve = [...ANIMATION_EASING_CURVES['ease-in-out']];
let animationEasingDragHandle: 1 | 2 | null = null;

const timelineDragState: {
    active: boolean;
    mode: 'idle' | 'box-select' | 'retime';
    pointerId: number | null;
    startClientX: number;
    currentClientX: number;
    moved: boolean;
    markerTime: number;
    startTimes: number[];
} = {
    active: false,
    mode: 'idle',
    pointerId: null,
    startClientX: 0,
    currentClientX: 0,
    moved: false,
    markerTime: 0,
    startTimes: [],
};

const viewer = new Viewer(canvas);

let layoutState = loadLayout();
let documents: DocumentSession[] = [createSampleDocument()];
let activeDocumentId = documents[0].id;
let toastTimer = 0;
let loadingMessage = '';
let loadingCount = 0;
let lastPropertySyncTs = 0;
let nativeOpenQueue = Promise.resolve();
let selectedTextureSlot: TextureSlotId | null = null;
let currentTextureSlotState: TextureSlotState | null = null;
let currentUvEditorState: UvEditorState | null = null;
let currentUvEdges: UvEdgeState[] = [];
const currentUvEdgeMap = new Map<string, UvEdgeState>();
let suppressUndoRecording = false;
let uvSelectionMode: UvSelectionMode = 'vertex';
let uvSnapEnabled = true;
let uvSnapStrength = 1;
let materialEditFrame = 0;
const pendingMaterialEdit: {
    opacity?: number;
    roughness?: number;
    metalness?: number;
    color?: string;
} = {};
const selectedUvPointIds = new Set<number>();
const selectedUvEdgeIds = new Set<string>();
const selectedUvFaceIds = new Set<number>();
const previewUvPointIds = new Set<number>();
const previewUvEdgeIds = new Set<string>();
const previewUvFaceIds = new Set<number>();

const uvView = {
    centerX: 0.5,
    centerY: 0.5,
    zoom: 1,
};

let uvTexturePatternSource: CanvasImageSource | null = null;
let uvTexturePattern: CanvasPattern | null = null;
let uvTexturePatternMode: UvTexturePatternMode = 'no-repeat';

const materialUndoDraft: {
    snapshot: MaterialEditSnapshot | null;
    label: string;
} = {
    snapshot: null,
    label: '',
};

const textureUndoDraft: {
    snapshot: TextureTransformSnapshot | null;
    label: string;
} = {
    snapshot: null,
    label: '',
};

const uvWheelUndoDraft: {
    snapshot: UvPointSnapshot[] | null;
    selection: UvSelectionSnapshot | null;
    label: string;
    timer: number;
} = {
    snapshot: null,
    selection: null,
    label: '',
    timer: 0,
};

const animationPoseUndoDraft: {
    snapshot: BonePoseSnapshot | null;
    animationSnapshot: AnimationClipSnapshot | null;
    label: string;
} = {
    snapshot: null,
    animationSnapshot: null,
    label: '',
};

const uvDragState: {
    mode: 'idle' | 'pan' | 'move-selection' | 'box-select' | 'scale-selection' | 'rotate-selection';
    pointerId: number | null;
    startClientX: number;
    startClientY: number;
    startCenterX: number;
    startCenterY: number;
    startUvX: number;
    startUvY: number;
    startSelection: Array<{ pointId: number; x: number; y: number }>;
    additive: boolean;
    subtractive: boolean;
    moved: boolean;
    boxStartX: number;
    boxStartY: number;
    boxCurrentX: number;
    boxCurrentY: number;
    transformPivotX: number;
    transformPivotY: number;
    transformStartAngle: number;
    transformHandle: SelectionHandleType | null;
} = {
    mode: 'idle',
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startCenterX: 0.5,
    startCenterY: 0.5,
    startUvX: 0,
    startUvY: 0,
    startSelection: [],
    additive: false,
    subtractive: false,
    moved: false,
    boxStartX: 0,
    boxStartY: 0,
    boxCurrentX: 0,
    boxCurrentY: 0,
    transformPivotX: 0,
    transformPivotY: 0,
    transformStartAngle: 0,
    transformHandle: null,
};

type SelectionHandleType =
    | 'scale-nw'
    | 'scale-ne'
    | 'scale-se'
    | 'scale-sw'
    | 'rotate';

viewer.onFps = (fps) => {
    setText(fpsEls, fps.toFixed(0));
};

viewer.onRender = () => {
    if (layoutState.activeTab !== 'properties') return;
    const now = performance.now();
    if (now - lastPropertySyncTs < 120) return;
    lastPropertySyncTs = now;
    syncPropertyPanelCamera();
};

viewer.onAnimationsChanged = (state) => {
    try {
        refreshAnimationBar(state);
        if (layoutState.activeTab === 'animation') syncAnimationEditor();
        updateStatusChips();
    } catch (error) {
        console.warn('onAnimationsChanged failed', error);
    }
};

viewer.onSkeletonChanged = () => {
    try {
        if (layoutState.activeTab === 'animation') syncAnimationEditor();
        updateStatusChips();
    } catch (error) {
        console.warn('onSkeletonChanged failed', error);
    }
};

viewer.onBonePoseEditStarted = () => {
    beginBonePoseUndoTransaction();
};

viewer.onBonePoseEdited = () => {
    commitBonePoseUndoTransaction();
    syncAnimationEditor();
};

viewer.onAnimationTick = (state) => {
    syncAnimationProgress(state);
    updateTimelinePlayhead(state);
};

function showErrorBanner(message: string): void {
    let banner = document.getElementById('__error_banner__') as HTMLDivElement | null;
    if (!banner) {
        banner = document.createElement('div');
        banner.id = '__error_banner__';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b74f5c;color:#fff;padding:8px 14px;font:12px/1.4 monospace;white-space:pre-wrap;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(banner);
    }
    banner.textContent = message;
}

window.addEventListener('error', (event) => {
    const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : '';
    showErrorBanner(`JS Error: ${event.message}${where}`);
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack ?? ''}` : String(event.reason);
    showErrorBanner(`Unhandled: ${reason}`);
});

async function bootstrap(): Promise<void> {
    if (!inNative) document.body.classList.add('browser');
    applyTheme();
    setupLayoutControls();
    setupContentModeControls();
    setupInspector();
    setupDocumentTabs();
    setupFileInput();
    setupViewportDrop();
    setupDisplayToggles();
    setupPropertyControls();
    setupTextureControls();
    setupUvEditor();
    setupUndoShortcuts();
    setupAnimationControls();
    setupNativeLaunchOpen();
    setupThemeToggle();
    setupViewPresets();
    setupKeyboardShortcuts();

    viewer.setWireframe(togWire.checked);
    viewer.setGridVisible(togGrid.checked);
    viewer.setAxesVisible(togAxes.checked);
    viewer.setLightBackground(togBg.checked);
    loading.hidden = true;

    activateDocument(activeDocumentId, { fit: false });

    if (inNative) {
        void app.registerFileAssociations(ACCEPT_EXTS).catch((error) => {
            console.error('registerFileAssociations failed', error);
        });

        const launchFiles = await app.consumeLaunchFiles().catch(() => [] as string[]);
        if (launchFiles.length > 0) {
            await enqueueNativePathLoad(launchFiles);
        }

        const launchUrls = await app.consumeLaunchUrls().catch(() => [] as string[]);
        if (launchUrls.length > 0) {
            await handleOpenUrls(launchUrls);
        }
    }

    requestAnimationFrame(() => document.body.classList.add('ready'));

    window.addEventListener('beforeunload', () => viewer.dispose());
}

type SidebarSide = 'left' | 'right';

type SidebarSpec = {
    side: SidebarSide;
    element: HTMLElement;
    getWidth: () => number;
    setWidth: (next: number) => void;
    clamp: (value: number) => number;
    defaultWidth: number;
    minWidth: number;
    maxWidth: () => number;
};

function setupLayoutControls(): void {
    const specs: SidebarSpec[] = [
        {
            side: 'left',
            element: leftResizer,
            getWidth: () => layoutState.leftSidebarWidth,
            setWidth: (next) => { layoutState.leftSidebarWidth = next; },
            clamp: clampLeftSidebarWidth,
            defaultWidth: DEFAULT_LAYOUT.leftSidebarWidth,
            minWidth: LEFT_SIDEBAR_MIN_WIDTH,
            maxWidth: getMaxLeftSidebarWidth,
        },
        {
            side: 'right',
            element: rightResizer,
            getWidth: () => layoutState.inspectorWidth,
            setWidth: (next) => { layoutState.inspectorWidth = next; },
            clamp: clampInspectorWidth,
            defaultWidth: DEFAULT_LAYOUT.inspectorWidth,
            minWidth: INSPECTOR_MIN_WIDTH,
            maxWidth: getMaxInspectorWidth,
        },
    ];

    btnResetLayout.addEventListener('click', () => {
        layoutState.inspectorWidth = DEFAULT_LAYOUT.inspectorWidth;
        layoutState.leftSidebarWidth = DEFAULT_LAYOUT.leftSidebarWidth;
        applyLayout();
        persistLayout();
        showToast('侧边栏宽度已重置', 'success');
    });

    for (const spec of specs) {
        spec.element.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();

            const startX = event.clientX;
            const startWidth = spec.getWidth();
            document.body.classList.add('resizing-sidebar');
            spec.element.classList.add('active');

            const onMove = (moveEvent: MouseEvent) => {
                const delta = spec.side === 'right'
                    ? startX - moveEvent.clientX
                    : moveEvent.clientX - startX;
                spec.setWidth(spec.clamp(startWidth + delta));
                applyLayout();
            };

            const onUp = () => {
                document.body.classList.remove('resizing-sidebar');
                spec.element.classList.remove('active');
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                persistLayout();
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        spec.element.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? 32 : 12;
            // Inward = grow this sidebar; outward = shrink.
            const inwardKey = spec.side === 'right' ? 'ArrowLeft' : 'ArrowRight';
            const outwardKey = spec.side === 'right' ? 'ArrowRight' : 'ArrowLeft';

            if (event.key === inwardKey) {
                event.preventDefault();
                spec.setWidth(spec.clamp(spec.getWidth() + step));
            } else if (event.key === outwardKey) {
                event.preventDefault();
                spec.setWidth(spec.clamp(spec.getWidth() - step));
            } else if (event.key === 'Home') {
                event.preventDefault();
                spec.setWidth(spec.clamp(spec.maxWidth()));
            } else if (event.key === 'End') {
                event.preventDefault();
                spec.setWidth(spec.clamp(spec.minWidth));
            } else {
                return;
            }
            applyLayout();
            persistLayout();
        });

        spec.element.addEventListener('dblclick', () => {
            spec.setWidth(spec.defaultWidth);
            applyLayout();
            persistLayout();
        });
    }

    window.addEventListener('resize', () => {
        const nextInspector = clampInspectorWidth(layoutState.inspectorWidth);
        const nextLeft = clampLeftSidebarWidth(layoutState.leftSidebarWidth);
        if (nextInspector === layoutState.inspectorWidth && nextLeft === layoutState.leftSidebarWidth) return;
        layoutState.inspectorWidth = nextInspector;
        layoutState.leftSidebarWidth = nextLeft;
        applyLayout();
        persistLayout();
    });
}

function setupContentModeControls(): void {
    btnModeModel.addEventListener('click', () => {
        setContentMode('model');
    });

    btnModeUv.addEventListener('click', () => {
        setContentMode('uv');
    });

    btnOpenUvWorkspace.addEventListener('click', () => {
        setContentMode('uv');
    });

    btnOpenUvTab.addEventListener('click', () => {
        layoutState.activeTab = 'textures';
        applyInspectorState();
        syncActiveInspectorControls();
        persistLayout();
    });
}

function setupInspector(): void {
    inspectorTabs.forEach((button) => {
        button.addEventListener('click', () => {
            const tab = button.dataset.inspectorTab;
            if (!isInspectorTab(tab)) return;
            layoutState.activeTab = tab;
            applyInspectorState();
            if (tab === 'animation') viewer.setSkeletonVisible(true);
            syncActiveInspectorControls();
            persistLayout();
        });

        button.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = inspectorTabs.indexOf(button);
            const lastIndex = inspectorTabs.length - 1;
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                    ? lastIndex
                    : event.key === 'ArrowLeft'
                        ? (index <= 0 ? lastIndex : index - 1)
                        : (index >= lastIndex ? 0 : index + 1);
            const nextButton = inspectorTabs[nextIndex];
            const tab = nextButton?.dataset.inspectorTab;
            if (!nextButton || !isInspectorTab(tab)) return;
            layoutState.activeTab = tab;
            applyInspectorState();
            if (tab === 'animation') viewer.setSkeletonVisible(true);
            syncActiveInspectorControls();
            persistLayout();
            nextButton.focus();
        });
    });

    inspectorGroups.forEach((group) => {
        group.addEventListener('toggle', () => {
            const id = group.dataset.groupId;
            if (!id) return;
            layoutState.groups[id] = group.open;
            persistLayout();
        });
    });

    applyInspectorState();
}

function setupDocumentTabs(): void {
    documentTabs.addEventListener('click', (event) => {
        const closeButton = (event.target as HTMLElement).closest<HTMLButtonElement>('.document-tab-close');
        const mainButton = (event.target as HTMLElement).closest<HTMLButtonElement>('.document-tab-main');
        const id = closeButton?.dataset.documentId ?? mainButton?.dataset.documentId;
        if (!id) return;

        if (closeButton) {
            closeDocument(id);
            return;
        }

        if (id !== activeDocumentId) activateDocument(id, { fit: true });
    });
}

function setupFileInput(): void {
    const openPicker = async () => {
        if (inNative) {
            const selection = await dialog.openFile({
                filters: [{ name: '3D 模型', extensions: ACCEPT_EXTS }],
                multiple: true,
            }).catch(() => null);
            const paths = typeof selection === 'string'
                ? [selection]
                : Array.isArray(selection)
                    ? selection
                    : [];
            if (paths.length > 0) await enqueueNativePathLoad(paths);
            return;
        }

        fileInput.value = '';
        fileInput.click();
    };

    btnOpen.addEventListener('click', () => {
        void openPicker();
    });

    btnSave.addEventListener('click', () => {
        void saveActiveDocumentWithChoice({ forceSaveAs: false });
    });

    btnSaveAs.addEventListener('click', () => {
        void saveActiveDocumentWithChoice({ forceSaveAs: true });
    });

    fileInput.addEventListener('change', async () => {
        const files = fileInput.files ? Array.from(fileInput.files) : [];
        if (files.length > 0) await loadFiles(files);
    });

    btnReset.addEventListener('click', () => {
        viewer.resetView();
        syncPropertyPanelCamera();
        showToast('视图已重置', 'success');
    });

    btnClear.addEventListener('click', () => {
        clearActiveDocument();
    });

    btnUndo.addEventListener('click', () => {
        undoLastEdit();
    });

    btnRedo.addEventListener('click', () => {
        redoLastEdit();
    });
}

function setupNativeLaunchOpen(): void {
    if (!inNative) return;
    app.onOpenFiles(({ files }) => {
        void enqueueNativePathLoad(files);
    });
    app.onOpenUrls(({ urls }) => {
        void handleOpenUrls(urls);
    });
}

// ----- Theme -----------------------------------------------------------------

const mediaPrefersDark = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function applyTheme(): void {
    const mode = layoutState.theme;
    root.setAttribute('data-theme-mode', mode);
    const resolved = mode === 'auto'
        ? (mediaPrefersDark?.matches ? 'dark' : 'light')
        : mode;
    root.setAttribute('data-theme', resolved);
}

function cycleTheme(): void {
    const order: ThemeMode[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(layoutState.theme) + 1) % order.length];
    layoutState.theme = next;
    applyTheme();
    persistLayout();
    const label = next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统';
    showToast(`主题：${label}`, 'info');
}

function setupThemeToggle(): void {
    btnThemeToggle.addEventListener('click', cycleTheme);
    mediaPrefersDark?.addEventListener?.('change', () => {
        if (layoutState.theme === 'auto') applyTheme();
    });
}

// ----- View presets ----------------------------------------------------------

function setupViewPresets(): void {
    viewPresets.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
        if (!button) return;
        const preset = button.dataset.preset;
        if (!preset) return;
        applyViewPreset(preset);
    });
}

function applyViewPreset(preset: string): void {
    if (preset === 'frame') {
        viewer.resetView();
    } else if (
        preset === 'front' || preset === 'back' || preset === 'left' ||
        preset === 'right' || preset === 'top' || preset === 'bottom' || preset === 'iso'
    ) {
        viewer.setViewPreset(preset);
    } else {
        return;
    }
    syncPropertyPanelCamera();
}

// ----- Bone pose clipboard ---------------------------------------------------

function copySelectedBonePose(): void {
    const trs = viewer.getSelectedBoneLocalTrs();
    if (!trs) {
        showToast('未选中骨骼', 'info');
        return;
    }
    bonePoseClipboard = {
        mode: 'single',
        sourceBoneName: trs.boneName,
        items: [{
            boneName: trs.boneName,
            position: trs.position,
            quaternion: trs.quaternion,
            scale: trs.scale,
        }],
    };
    syncAnimationEditor();
    showToast(`已复制 ${trs.boneName || '骨骼'} 姿态`, 'success');
}

function copySelectedBoneChainPose(): void {
    const items = viewer.getSelectedBoneChainLocalTrs();
    if (items.length === 0) {
        showToast('未选中骨骼子链', 'info');
        return;
    }
    bonePoseClipboard = {
        mode: 'chain',
        sourceBoneName: items[0]?.boneName ?? '',
        items,
    };
    syncAnimationEditor();
    showToast(`已复制 ${items.length} 根骨骼姿态`, 'success');
}

function pasteBonePose(opts: { mirror: boolean }): void {
    if (!bonePoseClipboard) {
        showToast('剪贴板里没有骨骼姿态', 'info');
        return;
    }
    const selected = viewer.getSelectedBoneLocalTrs();
    if (!selected) {
        showToast('未选中骨骼', 'info');
        return;
    }

    const source = bonePoseClipboard.items[0];
    if (!source) {
        showToast('剪贴板里没有骨骼姿态', 'info');
        return;
    }

    const target = opts.mirror ? findMirroredBoneName(selected.boneName) : selected.boneName;
    const targetIndex = target ? viewer.findBoneIndexByName(target) : selected.boneIndex;
    if (targetIndex < 0) {
        showToast(opts.mirror ? '没找到对称骨骼' : '骨骼未找到', 'error');
        return;
    }

    runAnimationEdit(opts.mirror ? '镜像粘贴骨骼姿态' : '粘贴骨骼姿态', () => {
        const trs = opts.mirror
            ? {
                position: [-source.position[0], source.position[1], source.position[2]] as [number, number, number],
                quaternion: [source.quaternion[0], -source.quaternion[1], -source.quaternion[2], source.quaternion[3]] as [number, number, number, number],
                scale: source.scale,
            }
            : source;
        viewer.applyLocalTrsToBone({ boneIndex: targetIndex }, trs);
    });
    showToast(opts.mirror ? `已镜像到 ${target}` : '已粘贴骨骼姿态', 'success');
}

function pasteBoneChainPose(opts: { mirror: boolean }): void {
    if (!bonePoseClipboard || bonePoseClipboard.items.length === 0) {
        showToast('剪贴板里没有骨骼姿态', 'info');
        return;
    }

    const targets = bonePoseClipboard.items.map((item) => {
        const targetName = opts.mirror ? findMirroredBoneName(item.boneName) : item.boneName;
        if (!targetName) return null;
        return {
            boneName: targetName,
            position: opts.mirror
                ? [-item.position[0], item.position[1], item.position[2]] as [number, number, number]
                : item.position,
            quaternion: opts.mirror
                ? [item.quaternion[0], -item.quaternion[1], -item.quaternion[2], item.quaternion[3]] as [number, number, number, number]
                : item.quaternion,
            scale: item.scale,
        };
    }).filter((item): item is BonePoseClipboardItem => Boolean(item));

    let count = 0;
    runAnimationEdit(opts.mirror ? '镜像粘贴骨骼子链姿态' : '粘贴骨骼子链姿态', () => {
        count = viewer.applyLocalTrsToBones(targets);
    });
    showToast(count > 0 ? `已粘贴 ${count} 根骨骼姿态` : '没有匹配的骨骼可粘贴', count > 0 ? 'success' : 'info');
}

function mirrorSelectedBoneChainPose(): void {
    const items = viewer.getSelectedBoneChainLocalTrs();
    if (items.length === 0) {
        showToast('请先选中一个骨骼子链', 'info');
        return;
    }

    const targets = items.map((item) => {
        const targetName = findMirroredBoneName(item.boneName);
        if (!targetName) return null;
        return {
            boneName: targetName,
            position: [-item.position[0], item.position[1], item.position[2]] as [number, number, number],
            quaternion: [item.quaternion[0], -item.quaternion[1], -item.quaternion[2], item.quaternion[3]] as [number, number, number, number],
            scale: item.scale,
        };
    }).filter((item): item is BonePoseClipboardItem => Boolean(item));

    let count = 0;
    runAnimationEdit('镜像骨骼子链姿态', () => {
        count = viewer.applyLocalTrsToBones(targets);
    });
    showToast(count > 0 ? `已镜像 ${count} 根骨骼` : '没找到可镜像的子链骨骼', count > 0 ? 'success' : 'info');
}

function findMirroredBoneName(name: string): string | null {
    if (!name) return null;
    const replacements: Array<[RegExp, string]> = [
        [/\.L$/i, '.R'], [/\.R$/i, '.L'],
        [/_L$/i, '_R'],  [/_R$/i, '_L'],
        [/^L_/i, 'R_'],  [/^R_/i, 'L_'],
        [/^Left/i, 'Right'], [/^Right/i, 'Left'],
        [/Left/g, 'Right'],  [/Right/g, 'Left'],
        [/\bL\b/, 'R'], [/\bR\b/, 'L'],
    ];
    const names = new Set(viewer.getBoneNames());
    for (const [pattern, replacement] of replacements) {
        if (!pattern.test(name)) continue;
        const candidate = name.replace(pattern, replacement);
        if (candidate !== name && names.has(candidate)) return candidate;
    }
    return null;
}

// ----- Keyboard shortcuts ----------------------------------------------------

function setupKeyboardShortcuts(): void {
    window.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        if (isEditableTarget(event.target)) return;

        const key = event.key;
        const code = event.code;
        const lowerKey = key.toLowerCase();
        const noMods = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        const ctrlOnly = (event.ctrlKey || event.metaKey) && !event.altKey;

        if (ctrlOnly && !event.shiftKey && lowerKey === 'c' && selectedKeyframeTimes.length > 0) {
            event.preventDefault();
            copySelectedTimelineKeyframes();
            return;
        }
        if (ctrlOnly && !event.shiftKey && lowerKey === 'v' && keyframeClipboard) {
            event.preventDefault();
            pasteTimelineKeyframesAtPlayhead();
            return;
        }
        if (ctrlOnly && !event.shiftKey && lowerKey === 'a' && !animEditor.hidden) {
            const state = viewer.getAnimationState();
            if (state.hasAnimations && state.activeIndex >= 0) {
                event.preventDefault();
                const markers = getTimelineVisibleMarkers(viewer.getSkeletonEditorState());
                setSelectedKeyframeTimes(markers.map((marker) => marker.time));
                renderAnimationTimeline(viewer.getSkeletonEditorState(), state);
                return;
            }
        }

        // Ctrl+C / Ctrl+Shift+C / Ctrl+V / Ctrl+Shift+V — bone pose clipboard.
        // Only when the skeleton overlay is visible (clear "rigging mode" signal),
        // so we don't steal default browser copy/paste outside that mode.
        const skeletonActive = viewer.getSkeletonEditorState({ includeKeyframes: false }).skeletonVisible
            && Boolean(viewer.getSelectedBoneLocalTrs());
        if (ctrlOnly && skeletonActive && lowerKey === 'c') {
            event.preventDefault();
            if (event.shiftKey) copySelectedBoneChainPose();
            else copySelectedBonePose();
            return;
        }
        if (ctrlOnly && skeletonActive && lowerKey === 'v' && !event.shiftKey) {
            if (bonePoseClipboard) {
                event.preventDefault();
                pasteBonePose({ mirror: false });
                return;
            }
        }
        if (ctrlOnly && skeletonActive && lowerKey === 'v' && event.shiftKey) {
            if (bonePoseClipboard) {
                event.preventDefault();
                pasteBonePose({ mirror: true });
                return;
            }
        }

        // Ctrl+1/3/7 — opposite view presets.
        if (ctrlOnly && !event.shiftKey) {
            const ctrlViewKeys: Record<string, string> = {
                '1': 'back',
                '3': 'right',
                '7': 'bottom',
            };
            if (ctrlViewKeys[key]) {
                event.preventDefault();
                applyViewPreset(ctrlViewKeys[key]);
                return;
            }
        }

        if (event.altKey && !event.ctrlKey && !event.metaKey && lowerKey === 'r') {
            event.preventDefault();
            if (event.shiftKey) {
                let count = 0;
                runAnimationEdit('重置骨骼子链姿态', () => {
                    count = viewer.resetSelectedBoneChainPose();
                });
                if (count > 0) showToast(`已重置 ${count} 根骨骼`, 'success');
            } else {
                let changed = false;
                runAnimationEdit('重置骨骼姿态', () => {
                    changed = viewer.resetSelectedBonePose();
                });
                if (changed) showToast('已重置当前骨骼姿态', 'success');
            }
            return;
        }

        if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
            event.preventDefault();
            nudgeSelectedTimelineKeyframes(key === 'ArrowRight' ? 1 : -1);
            return;
        }

        if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
            const changed = key === 'ArrowUp'
                ? viewer.selectParentBone()
                : viewer.selectFirstChildBone();
            if (changed) {
                event.preventDefault();
                syncAnimationEditor();
            }
            return;
        }

        if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && lowerKey === 'k') {
            if (viewer.getSelectedBoneLocalTrs()) {
                event.preventDefault();
                let count = 0;
                runAnimationEdit('插入子链关键帧', () => {
                    count = viewer.insertSelectedBoneChainKeyframe();
                });
                showToast(count > 0 ? `已给 ${count} 根骨骼插入关键帧` : '没有可插入的子链关键帧', count > 0 ? 'success' : 'info');
            }
            return;
        }

        if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && key === 'Insert') {
            if (viewer.getSelectedBoneLocalTrs()) {
                event.preventDefault();
                let count = 0;
                runAnimationEdit('插入子链关键帧', () => {
                    count = viewer.insertSelectedBoneChainKeyframe();
                });
                showToast(count > 0 ? `已给 ${count} 根骨骼插入关键帧` : '没有可插入的子链关键帧', count > 0 ? 'success' : 'info');
            }
            return;
        }

        if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && lowerKey === 'm') {
            if (viewer.getSelectedBoneLocalTrs()) {
                event.preventDefault();
                mirrorSelectedBoneChainPose();
            }
            return;
        }

        if (!noMods) return;

        const state = viewer.getAnimationState();

        if (key === 'Escape' && selectedKeyframeTimes.length > 0) {
            event.preventDefault();
            selectedKeyframeTimes = [];
            renderAnimationTimeline(viewer.getSkeletonEditorState(), state);
            return;
        }

        if (key === 'Delete' || key === 'Backspace') {
            if (selectedKeyframeTimes.length > 0) {
                event.preventDefault();
                const count = selectedKeyframeTimes.length;
                runAnimationEdit('删除选中关键帧', () => {
                    deleteTimelineKeyframesAtTimes(selectedKeyframeTimes);
                });
                selectedKeyframeTimes = [];
                renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
                showToast(`已删除 ${count} 个选中关键帧`, 'success');
                return;
            }
            if (viewer.getSelectedBoneLocalTrs()) {
                event.preventDefault();
                runAnimationEdit('删除关键帧', () => {
                    viewer.deleteSelectedBoneKeyframe();
                });
                showToast('已删除当前附近关键帧', 'success');
                return;
            }
        }

        // Insert — insert selected-bone keyframe.
        if (key === 'Insert') {
            if (viewer.getSelectedBoneLocalTrs()) {
                event.preventDefault();
                runAnimationEdit('插入关键帧', () => viewer.insertSelectedBoneKeyframe());
                showToast('已插入关键帧', 'success');
            }
            return;
        }

        // Arrow Left / Right — selected timeline keyframe previous / next.
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            if (selectAdjacentTimelineKeyframe(key === 'ArrowRight' ? 1 : -1)) {
                event.preventDefault();
            }
            return;
        }

        // Arrow Up / Down — selected bone previous / next.
        if (key === 'ArrowUp' || key === 'ArrowDown') {
            if (selectAdjacentBone(key === 'ArrowDown' ? 1 : -1)) {
                event.preventDefault();
            }
            return;
        }

        // U/I/O and J/K/L — positive/negative X/Y/Z transform steps.
        const axisStepKeys: Record<string, { axis: 'x' | 'y' | 'z'; direction: 1 | -1 }> = {
            u: { axis: 'x', direction: 1 },
            i: { axis: 'y', direction: 1 },
            o: { axis: 'z', direction: 1 },
            j: { axis: 'x', direction: -1 },
            k: { axis: 'y', direction: -1 },
            l: { axis: 'z', direction: -1 },
        };
        const axisStep = axisStepKeys[lowerKey];
        if (axisStep && viewer.getSelectedBoneLocalTrs()) {
            event.preventDefault();
            stepSelectedBoneTransform(axisStep.axis, axisStep.direction);
            return;
        }

        if (lowerKey === 'm' && viewer.getSelectedBoneLocalTrs()) {
            event.preventDefault();
            mirrorSelectedBonePose();
            return;
        }

        // W / E — transform gizmo mode.
        if (lowerKey === 'w') {
            event.preventDefault();
            setBoneTransformMode('translate');
            return;
        }
        if (lowerKey === 'e') {
            event.preventDefault();
            setBoneTransformMode('rotate');
            return;
        }

        // Q — toggle IK.
        if (lowerKey === 'q') {
            event.preventDefault();
            setBoneSolverMode(!viewer.getSkeletonEditorState({ includeKeyframes: false }).ikEnabled);
            return;
        }

        // G — toggle local/global transform space.
        if (lowerKey === 'g') {
            event.preventDefault();
            const skeleton = viewer.getSkeletonEditorState({ includeKeyframes: false });
            setBoneTransformSpace(skeleton.transformSpace === 'local' ? 'world' : 'local');
            return;
        }

        // , / .  — previous / next keyframe.
        if (key === ',' || key === '.') {
            if (!state.hasAnimations) return;
            event.preventDefault();
            const direction = key === '.' ? 1 : -1;
            viewer.seekToNearestKeyframe(direction);
            return;
        }

        // Home / End — jump to clip start/end.
        if (key === 'Home') {
            if (!state.hasAnimations) return;
            event.preventDefault();
            viewer.seekAnimation(0);
            return;
        }
        if (key === 'End') {
            if (!state.hasAnimations) return;
            event.preventDefault();
            viewer.seekAnimation(state.duration);
            return;
        }

        // F — frame model.
        if (lowerKey === 'f') {
            event.preventDefault();
            applyViewPreset('frame');
            return;
        }

        // 1-7, 0 — view presets.
        const viewKeys: Record<string, string> = {
            '1': 'front',
            '3': 'left',
            '7': 'top',
            '0': 'iso',
        };
        if (code in { Digit1: 1, Digit3: 1, Digit7: 1, Digit0: 1 } && viewKeys[key]) {
            event.preventDefault();
            applyViewPreset(viewKeys[key]);
            return;
        }
    });
}

function selectAdjacentTimelineKeyframe(direction: 1 | -1): boolean {
    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.duration <= 0) return false;

    const markers = [...new Set(getTimelineVisibleMarkers(viewer.getSkeletonEditorState()).map((marker) => Number(marker.time.toFixed(4))))]
        .sort((a, b) => a - b);
    if (markers.length === 0) return false;

    const hasSelection = selectedKeyframeTimes.length > 0;
    const anchor = hasSelection
        ? (direction > 0 ? Math.max(...selectedKeyframeTimes) : Math.min(...selectedKeyframeTimes))
        : state.time;
    const target = direction > 0
        ? markers.find((time) => time > anchor + 1e-4)
        : [...markers].reverse().find((time) => time < anchor - 1e-4);
    if (target === undefined) return true;

    setSelectedKeyframeTimes([target]);
    viewer.seekAnimation(target);
    renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    return true;
}

function nudgeSelectedTimelineKeyframes(direction: 1 | -1): boolean {
    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.duration <= 0 || selectedKeyframeTimes.length === 0) return false;

    const step = timelineSnapEnabled ? 1 / timelineFps : Math.max(state.duration / 1000, 0.001);
    const fromTimes = [...selectedKeyframeTimes];
    const toTimes = fromTimes.map((time) => snapTimelineTime(time + step * direction, state.duration));
    if (fromTimes.every((time, index) => nearlyEqualTimeForUi(time, toTimes[index] ?? time))) return false;

    runAnimationEdit(direction > 0 ? '右移关键帧' : '左移关键帧', () => {
        moveTimelineKeyframesAtTimes(fromTimes, toTimes);
    });
    setSelectedKeyframeTimes(toTimes);
    viewer.seekAnimation(direction > 0 ? Math.max(...toTimes) : Math.min(...toTimes));
    renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    const label = timelineSnapEnabled
        ? `${direction > 0 ? '+1' : '-1'} 帧`
        : `${direction > 0 ? '+' : '-'}${step.toFixed(3)}s`;
    showToast(`已移动 ${toTimes.length} 个关键帧 · ${label}`, 'success');
    return true;
}

function selectAdjacentBone(direction: 1 | -1): boolean {
    const state = viewer.getSkeletonEditorState({ includeKeyframes: false });
    if (!state.hasSkeleton || state.bones.length === 0) return false;
    if (state.selectedBoneIndex < 0) {
        viewer.selectBone(direction > 0 ? 0 : state.bones.length - 1);
        return true;
    }

    const nextIndex = clamp(state.selectedBoneIndex + direction, 0, state.bones.length - 1);
    if (nextIndex === state.selectedBoneIndex) return true;
    viewer.selectBone(nextIndex);
    return true;
}

function stepSelectedBoneTransform(axis: 'x' | 'y' | 'z', direction: 1 | -1): void {
    beginBonePoseUndoTransaction();
    const changed = viewer.stepSelectedBoneTransform(axis, direction);
    commitBonePoseUndoTransaction();
    if (!changed) return;
    syncAnimationEditor();
}

// ----- Status chips ----------------------------------------------------------

function updateStatusFrameChip(animState = viewer.getAnimationState()): void {
    if (!statusFrame || !statusFrameValue) return;
    if (animState.hasAnimations) {
        statusFrame.hidden = false;
        const currentFrame = Math.round(animState.time * timelineFps);
        const totalFrame = Math.round(animState.duration * timelineFps);
        statusFrameValue.textContent = `${currentFrame} / ${totalFrame}`;
    } else {
        statusFrame.hidden = true;
    }
}

function updateStatusChips(
    animState = viewer.getAnimationState(),
    skel = viewer.getSkeletonEditorState({ includeKeyframes: false }),
): void {
    if (!statusFrame || !statusFrameValue || !statusBone || !statusBoneValue || !statusKeys || !statusKeysValue) {
        return;
    }
    try {
        updateStatusFrameChip(animState);

        if (skel.hasSkeleton && skel.selectedBoneName) {
            statusBone.hidden = false;
            statusBoneValue.textContent = skel.selectedBoneName;
        } else {
            statusBone.hidden = true;
        }

        if (selectedKeyframeTimes.length > 0) {
            statusKeys.hidden = false;
            statusKeysValue.textContent = String(selectedKeyframeTimes.length);
        } else {
            statusKeys.hidden = true;
        }
    } catch (error) {
        console.warn('updateStatusChips failed', error);
    }
}

function setupUndoShortcuts(): void {
    window.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (isEditableTarget(event.target)) return;

        const key = event.key.toLowerCase();
        const wantsUndo = key === 'z' && !event.shiftKey;
        const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
        if (!wantsUndo && !wantsRedo) return;

        event.preventDefault();
        if (wantsRedo) redoLastEdit();
        else undoLastEdit();
    });
}

function setupAnimationControls(): void {
    animPlayBtn.addEventListener('click', () => {
        void toggleAnimationWithLazyLoad();
    });

    animStopBtn.addEventListener('click', () => {
        viewer.seekAnimation(0);
        viewer.pauseAnimation();
    });

    animClipSearch.addEventListener('input', () => {
        renderAnimationClipList(viewer.getAnimationState());
    });

    animClipSearch.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const first = animClipList.querySelector<HTMLElement>('[data-clip-index]');
        if (!first) return;
        const index = Number(first.dataset.clipIndex);
        if (!Number.isFinite(index)) return;
        event.preventDefault();
        void activateAnimationClip(index, viewer.getAnimationState().playing);
    });

    animClipList.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const action = target.closest<HTMLButtonElement>('.anim-clip-action');
        if (action) {
            event.stopPropagation();
            const item = action.closest<HTMLElement>('[data-clip-index]');
            const index = Number(item?.dataset.clipIndex);
            if (!Number.isFinite(index)) return;
            if (action.dataset.action === 'copy-keyframes') {
                void ensureAnimationClipLoaded(index, { autoPlay: false }).then((loaded) => {
                    if (loaded) copyClipKeyframesAt(index);
                });
            } else if (action.dataset.action === 'duplicate') {
                void ensureAnimationClipLoaded(index, { autoPlay: false }).then((loaded) => {
                    if (loaded) duplicateClipAt(index);
                });
            }
            else if (action.dataset.action === 'delete') deleteClipAt(index);
            return;
        }

        const item = target.closest<HTMLElement>('[data-clip-index]');
        if (!item) return;
        const index = Number(item.dataset.clipIndex);
        if (!Number.isFinite(index)) return;
        const wasPlaying = viewer.getAnimationState().playing;
        selectedKeyframeTimes = [];
        void activateAnimationClip(index, wasPlaying);
    });

    btnNewTposeClip.addEventListener('click', () => {
        createRestPoseClip();
    });

    btnNewCurrentPoseClip.addEventListener('click', () => {
        createCurrentPoseClip();
    });

    btnCopyClipKeys.addEventListener('click', () => {
        copyClipKeyframesAt(viewer.getAnimationState().activeIndex);
    });

    btnPasteClipKeys.addEventListener('click', () => {
        pasteClipKeyframesToActiveClip();
    });

    animEditOpenBtn.addEventListener('click', () => {
        openAnimationInspector();
    });

    animShowSkeletonInput.addEventListener('change', () => {
        viewer.setSkeletonVisible(animShowSkeletonInput.checked);
    });

    animShowTransformInput.addEventListener('change', () => {
        viewer.setTransformControlsVisible(animShowTransformInput.checked);
    });

    animBoneSearch.addEventListener('input', () => {
        renderSkeletonControls(viewer.getSkeletonEditorState(), { preserveSearch: true });
    });

    animBoneSearch.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const first = animBoneList.querySelector<HTMLButtonElement>('[data-bone-index]');
        if (!first) return;
        const index = Number(first.dataset.boneIndex);
        if (!Number.isFinite(index)) return;
        event.preventDefault();
        viewer.selectBone(index);
    });

    animBoneList.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-bone-index]');
        if (!button) return;
        const index = Number(button.dataset.boneIndex);
        if (!Number.isFinite(index)) return;
        viewer.selectBone(index);
    });

    animModeRotate.addEventListener('click', () => {
        setBoneTransformMode('rotate');
    });

    animModeTranslate.addEventListener('click', () => {
        setBoneTransformMode('translate');
    });

    animSpaceLocal.addEventListener('click', () => {
        setBoneTransformSpace('local');
    });

    animSpaceWorld.addEventListener('click', () => {
        setBoneTransformSpace('world');
    });

    animFkMode.addEventListener('click', () => {
        setBoneSolverMode(false);
    });

    animIkMode.addEventListener('click', () => {
        setBoneSolverMode(true);
    });

    animAutoKeyframeInput.addEventListener('change', () => {
        viewer.setAutoKeyframeEnabled(animAutoKeyframeInput.checked);
        syncAnimationEditor();
    });

    animIkChainLengthInput.addEventListener('change', () => {
        const value = Number(animIkChainLengthInput.value);
        const length = Number.isFinite(value) ? clamp(value, 1, 12) : 4;
        viewer.setIkChainLength(length);
        syncAnimationEditor();
    });

    animIkIterationsInput.addEventListener('change', () => {
        const value = Number(animIkIterationsInput.value);
        const iterations = Number.isFinite(value) ? clamp(value, 1, 64) : 10;
        viewer.setIkIterations(iterations);
        syncAnimationEditor();
    });

    const applyBoneStepSettings = () => {
        const rotationDegrees = Number(animRotationStepInput.value);
        const translationPercent = Number(animTranslationStepInput.value);
        viewer.setBoneStepSettings({
            rotationDegrees: Number.isFinite(rotationDegrees) ? rotationDegrees : undefined,
            translationPercent: Number.isFinite(translationPercent) ? translationPercent : undefined,
        });
    };
    animRotationStepInput.addEventListener('change', applyBoneStepSettings);
    animTranslationStepInput.addEventListener('change', applyBoneStepSettings);

    btnInsertKeyframe.addEventListener('click', () => {
        runAnimationEdit('插入关键帧', () => {
            viewer.insertSelectedBoneKeyframe();
        });
        showToast('已插入骨骼关键帧', 'success');
    });

    btnInsertChainKeyframe.addEventListener('click', () => {
        let count = 0;
        runAnimationEdit('插入子链关键帧', () => {
            count = viewer.insertSelectedBoneChainKeyframe();
        });
        showToast(count > 0 ? `已给 ${count} 根骨骼插入关键帧` : '没有可插入的子链关键帧', count > 0 ? 'success' : 'info');
    });

    btnDeleteKeyframe.addEventListener('click', () => {
        if (selectedKeyframeTimes.length > 0) {
            const count = selectedKeyframeTimes.length;
            runAnimationEdit('删除选中关键帧', () => {
                deleteTimelineKeyframesAtTimes(selectedKeyframeTimes);
            });
            selectedKeyframeTimes = [];
            showToast(`已删除 ${count} 个选中关键帧`, 'success');
        } else {
            runAnimationEdit('删除关键帧', () => {
                viewer.deleteSelectedBoneKeyframe();
            });
            showToast('已删除当前附近关键帧', 'success');
        }
    });

    btnResetBonePose.addEventListener('click', () => {
        let changed = false;
        runAnimationEdit('重置骨骼姿态', () => {
            changed = viewer.resetSelectedBonePose();
        });
        showToast(changed ? '已重置当前骨骼姿态' : '没有可重置的骨骼', changed ? 'success' : 'info');
    });

    btnResetBoneChainPose.addEventListener('click', () => {
        let count = 0;
        runAnimationEdit('重置骨骼子链姿态', () => {
            count = viewer.resetSelectedBoneChainPose();
        });
        showToast(count > 0 ? `已重置 ${count} 根骨骼` : '没有可重置的骨骼子链', count > 0 ? 'success' : 'info');
    });

    btnCopyBonePose.addEventListener('click', copySelectedBonePose);
    btnPasteBonePose.addEventListener('click', () => pasteBonePose({ mirror: false }));
    btnCopyBoneChainPose.addEventListener('click', copySelectedBoneChainPose);
    btnPasteBoneChainPose.addEventListener('click', () => pasteBoneChainPose({ mirror: false }));

    btnMirrorBonePose.addEventListener('click', () => {
        mirrorSelectedBonePose();
    });

    btnMirrorBoneChainPose.addEventListener('click', () => {
        mirrorSelectedBoneChainPose();
    });

    btnMirrorAnimation.addEventListener('click', () => {
        void mirrorActiveAnimationClip();
    });

    btnAnimHistoryUndo.addEventListener('click', () => {
        undoLastEdit();
    });

    btnAnimHistoryRedo.addEventListener('click', () => {
        redoLastEdit();
    });

    btnTimelineSelectAll.addEventListener('click', () => {
        const markers = getTimelineVisibleMarkers(viewer.getSkeletonEditorState());
        setSelectedKeyframeTimes(markers.map((marker) => marker.time));
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    });

    btnTimelineClearSelection.addEventListener('click', () => {
        selectedKeyframeTimes = [];
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    });

    btnTimelineCopyKeys.addEventListener('click', () => {
        copySelectedTimelineKeyframes();
    });

    btnTimelinePasteKeys.addEventListener('click', () => {
        pasteTimelineKeyframesAtPlayhead();
    });

    animTimelineSnapInput.addEventListener('change', () => {
        timelineSnapEnabled = animTimelineSnapInput.checked;
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    });

    animTimelineSelectedBoneOnlyInput.addEventListener('change', () => {
        timelineSelectedBoneOnly = animTimelineSelectedBoneOnlyInput.checked;
        selectedKeyframeTimes = [];
        timelineStripRenderKey = '';
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    });

    animTimelineFpsInput.addEventListener('change', () => {
        const value = Number(animTimelineFpsInput.value);
        timelineFps = Number.isFinite(value) ? Math.round(clamp(value, 1, 240)) : 30;
        animTimelineFpsInput.value = String(timelineFps);
        syncAnimationProgress(viewer.getAnimationState());
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    });

    animTimelineZoomInput.addEventListener('input', () => {
        const value = Number(animTimelineZoomInput.value);
        timelineZoom = Number.isFinite(value) ? clamp(value, 0.25, 12) : 1;
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    });

    animTimelineScroll.addEventListener('wheel', handleTimelineWheel, { passive: false });
    animKeyframeStrip.addEventListener('click', handleTimelineClick);
    animKeyframeStrip.addEventListener('pointerdown', handleTimelinePointerDown);
    animKeyframeStrip.addEventListener('pointermove', handleTimelinePointerMove);
    animKeyframeStrip.addEventListener('pointerup', handleTimelinePointerUp);
    animKeyframeStrip.addEventListener('pointercancel', cancelTimelineSelection);

    animClipNameInput.addEventListener('change', () => {
        const name = animClipNameInput.value;
        runAnimationEdit('动画重命名', () => {
            viewer.renameActiveAnimationClip(name);
        });
    });

    animTrackSelect.addEventListener('change', () => {
        selectedAnimationTrackIndex = Number(animTrackSelect.value);
        syncAnimationTrackControls(viewer.getAnimationEditorState(), { resetInputs: true });
    });

    animBlendModeSelect.addEventListener('change', () => {
        viewer.setAnimationBlendMode(animBlendModeSelect.value as AnimationBlendMode);
    });

    animEasingSelect.addEventListener('change', () => {
        setAnimationEasingByName(animEasingSelect.value as AnimationEasingName);
    });

    animEasingPresetSelect.addEventListener('change', () => {
        setAnimationEasingByName(animEasingPresetSelect.value as AnimationEasingName);
    });

    animEasingCanvas.addEventListener('pointerdown', handleAnimationCurvePointerDown);
    animEasingCanvas.addEventListener('pointermove', handleAnimationCurvePointerMove);
    animEasingCanvas.addEventListener('pointerup', finishAnimationCurveDrag);
    animEasingCanvas.addEventListener('pointercancel', finishAnimationCurveDrag);

    animLoopInput.addEventListener('change', () => {
        viewer.setAnimationLoop(animLoopInput.checked);
    });

    animSpeedInput.addEventListener('change', () => {
        const value = parseFloat(animSpeedInput.value);
        if (!Number.isFinite(value)) return;
        viewer.setAnimationSpeed(Math.max(0, value));
    });

    let resumeAfterScrub = false;

    animTimeRange.addEventListener('pointerdown', () => {
        if (viewer.getAnimationState().playing) {
            resumeAfterScrub = true;
            viewer.pauseAnimation();
        }
    });

    animTimeRange.addEventListener('input', () => {
        if (animTimeRangeSyncing) return;
        const time = snapTimelineTime(parseFloat(animTimeRange.value), viewer.getAnimationState().duration);
        if (!Number.isFinite(time)) return;
        viewer.seekAnimation(time);
    });

    const finishScrub = () => {
        if (resumeAfterScrub) {
            resumeAfterScrub = false;
            viewer.playAnimation();
        }
    };

    animTimeRange.addEventListener('pointerup', finishScrub);
    animTimeRange.addEventListener('pointercancel', finishScrub);
    animTimeRange.addEventListener('blur', finishScrub);

    btnApplyAnimTransform.addEventListener('click', () => {
        applySelectedAnimationTrackEdit();
    });

    btnApplyAnimEasing.addEventListener('click', () => {
        applySelectedAnimationEasing();
    });

    bindNumericPair(animTimeScaleRange, animTimeScaleInput, () => undefined);

    btnApplyAnimTimeScale.addEventListener('click', () => {
        const factor = Number(animTimeScaleInput.value);
        if (!Number.isFinite(factor) || factor <= 0) return;
        if (nearlyEqual(factor, 1)) {
            showToast('时长倍率未变化', 'info');
            return;
        }
        runAnimationEdit('动画时长', () => {
            viewer.scaleActiveAnimationTiming(factor);
        });
        setNumericPairValue(animTimeScaleRange, animTimeScaleInput, 1);
        showToast('动画时长已更新', 'success');
    });

    window.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        if (event.code !== 'Space') return;
        if (isEditableTarget(event.target)) return;
        if (!viewer.getAnimationState().hasAnimations) return;
        event.preventDefault();
        void toggleAnimationWithLazyLoad();
    });

    refreshAnimationBar(viewer.getAnimationState());
}

function refreshAnimationBar(state: AnimationPlaybackState): void {
    if (!state.hasAnimations) {
        animBar.hidden = true;
        animBar.classList.remove('is-playing');
        animationClipListRenderKey = '';
        timelineStripRenderKey = '';
        animClipList.innerHTML = '';
        animTimeRange.value = '0';
        animTimeRange.max = '0';
        animTimeLabel.textContent = '—';
        animSummary.textContent = '';
        selectedKeyframeTimes = [];
        leftSidebar.classList.add('is-empty');
        leftSidebarMeta.textContent = '无动画';
        syncAnimationClipTools(state);
        renderAnimationTimeline(viewer.getSkeletonEditorState(), state);
        return;
    }

    animBar.hidden = false;
    leftSidebar.classList.remove('is-empty');
    leftSidebarMeta.textContent = state.clips.length > 1
        ? `${state.activeIndex + 1} / ${state.clips.length}`
        : `${state.clips.length}`;
    renderAnimationClipList(state);

    animBar.classList.toggle('is-playing', state.playing);
    animPlayBtn.title = state.playing ? '暂停 (Space)' : '播放 (Space)';
    if (animLoopInput.checked !== state.loop) {
        animLoopInput.checked = state.loop;
    }
    if (parseFloat(animSpeedInput.value) !== state.speed) {
        animSpeedInput.value = String(state.speed);
    }

    animSummary.textContent = state.clips.length > 1
        ? `${state.activeIndex + 1} / ${state.clips.length}`
        : '';

    syncAnimationClipTools(state);
    syncAnimationProgress(state);
    renderAnimationTimeline(viewer.getSkeletonEditorState(), state);
}

function renderAnimationClipList(state: AnimationPlaybackState): void {
    const query = normalizeSearchText(animClipSearch.value);
    const clips = state.clips.filter((clip) => normalizeSearchText(clip.name).includes(query));
    const renderKey = [
        query,
        state.activeIndex,
        state.clips.map((clip) => [
            clip.index,
            clip.name,
            clip.duration.toFixed(4),
            clip.tracks,
            clip.lazy ? 1 : 0,
        ].join(':')).join('|'),
    ].join('||');
    if (renderKey === animationClipListRenderKey) return;
    animationClipListRenderKey = renderKey;

    animClipList.innerHTML = clips.length > 0
        ? clips.map((clip) => {
            const active = clip.index === state.activeIndex;
            const selected = active ? ' aria-selected="true"' : ' aria-selected="false"';
            const className = `anim-clip-item${active ? ' active' : ''}`;
            const meta = clip.lazy
                ? `${clip.duration.toFixed(2)}s · ${clip.tracks} · 按需`
                : `${clip.duration.toFixed(2)}s · ${clip.tracks}`;
            return `
                <button class="${className}" type="button" role="option" data-clip-index="${clip.index}"${selected}>
                    <span class="anim-clip-name">${escapeHtml(clip.name)}</span>
                    <span class="anim-clip-meta">${escapeHtml(meta)}</span>
                    <span class="anim-clip-actions" aria-hidden="true">
                        <span class="anim-clip-action" role="button" tabindex="0" data-action="copy-keyframes" title="复制关键帧">
                            <svg viewBox="0 0 24 24"><path d="M9 4h6l1 2h3v14H5V6h3z"/><path d="M9 11h6M9 15h5"/></svg>
                        </span>
                        <span class="anim-clip-action" role="button" tabindex="0" data-action="duplicate" title="复制为新动画">
                            <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                        </span>
                        <span class="anim-clip-action danger" role="button" tabindex="0" data-action="delete" title="删除动画">
                            <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7.5 7l.9 12a1 1 0 0 0 1 .9h5.2a1 1 0 0 0 1-.9L16.5 7"/></svg>
                        </span>
                    </span>
                </button>
            `;
        }).join('')
        : '<div class="anim-list-empty">没有匹配动画</div>';
}

function syncAnimationClipTools(state: AnimationPlaybackState): void {
    const skeleton = viewer.getSkeletonEditorState({ includeKeyframes: false });
    const hasSkeleton = skeleton.hasSkeleton;
    btnNewTposeClip.disabled = !hasSkeleton;
    btnNewCurrentPoseClip.disabled = !hasSkeleton;
    btnCopyClipKeys.disabled = !state.hasAnimations || state.activeIndex < 0;
    btnPasteClipKeys.disabled = !animationClipboard;
    btnResetBonePose.disabled = !hasSkeleton || skeleton.selectedBoneIndex < 0;
    btnResetBoneChainPose.disabled = !hasSkeleton || skeleton.selectedBoneIndex < 0;
    btnMirrorBonePose.disabled = !hasSkeleton || skeleton.selectedBoneIndex < 0;
    btnMirrorBoneChainPose.disabled = !hasSkeleton || skeleton.selectedBoneIndex < 0;
    btnMirrorAnimation.disabled = !hasSkeleton || !state.hasAnimations || state.activeIndex < 0;
}

async function toggleAnimationWithLazyLoad(): Promise<void> {
    const state = viewer.getAnimationState();
    if (!state.hasAnimations) return;
    const index = state.activeIndex >= 0 ? state.activeIndex : 0;
    if (viewer.getLazyAnimationClipSource(index)) {
        await ensureAnimationClipLoaded(index, { autoPlay: true });
        return;
    }
    viewer.toggleAnimation();
}

async function activateAnimationClip(index: number, autoPlay: boolean): Promise<void> {
    if (!Number.isFinite(index)) return;
    if (viewer.getLazyAnimationClipSource(index)) {
        await ensureAnimationClipLoaded(index, { autoPlay });
        return;
    }
    viewer.selectAnimationClip(index, { autoPlay });
}

async function ensureAnimationClipLoaded(
    index: number,
    opts: { autoPlay?: boolean; activate?: boolean; quiet?: boolean } = {},
): Promise<boolean> {
    const source = viewer.getLazyAnimationClipSource(index);
    if (!source) return true;

    const key = `${source.path}\0${source.index}`;
    const existing = lazyAnimationLoads.get(key);
    if (existing) return existing;

    const task = (async () => {
        const label = source.name || `Animation ${source.index + 1}`;
        if (!opts.quiet) showLoading(`正在载入动画 ${label} …`);
        try {
            const clip = await loadGLBAnimationClipFromPath(source.path, source.index);
            if (!clip.name || !clip.name.trim()) clip.name = label;
            const replaced = viewer.replaceAnimationClip(index, clip, {
                activate: opts.activate ?? true,
                autoPlay: opts.autoPlay ?? false,
            });
            if (!replaced) {
                if (!opts.quiet) showToast('动画载入后绑定失败', 'error');
                return false;
            }
            selectedKeyframeTimes = [];
            if (!opts.quiet) {
                refreshAnimationBar(viewer.getAnimationState());
                syncAnimationEditor();
            }
            if (!opts.quiet) showToast(`已载入动画 ${label}`, 'success');
            return true;
        } catch (error) {
            console.error(error);
            const message = error instanceof Error ? error.message : String(error);
            if (!opts.quiet) showToast(`动画载入失败: ${message}`, 'error');
            return false;
        } finally {
            if (!opts.quiet) hideLoading();
            lazyAnimationLoads.delete(key);
        }
    })();

    lazyAnimationLoads.set(key, task);
    return task;
}

function createRestPoseClip(): void {
    let index = -1;
    runAnimationLibraryEdit('新建 T-Pose 动画', () => {
        index = viewer.createRestPoseAnimationClip('T-Pose Action');
    });
    if (index < 0) {
        showToast('当前模型没有可创建动画的骨骼', 'error');
        return;
    }

    selectedKeyframeTimes = [];
    openAnimationInspector();
    refreshAnimationBar(viewer.getAnimationState());
    syncAnimationEditor();
    showToast('已从默认 T-Pose 创建新动画', 'success');
}

function createCurrentPoseClip(): void {
    let index = -1;
    runAnimationLibraryEdit('新建当前姿态动画', () => {
        index = viewer.createCurrentPoseAnimationClip('Current Pose Action');
    });
    if (index < 0) {
        showToast('当前模型没有可创建动画的骨骼', 'error');
        return;
    }

    selectedKeyframeTimes = [];
    openAnimationInspector();
    refreshAnimationBar(viewer.getAnimationState());
    syncAnimationEditor();
    showToast('已从当前姿态创建新动画', 'success');
}

function mirrorSelectedBonePose(): void {
    if (!viewer.getSelectedBoneLocalTrs()) {
        showToast('请先选中一个骨骼', 'info');
        return;
    }

    const resultBox: { value: { sourceName: string; targetName: string } | null } = { value: null };
    runAnimationEdit('镜像骨骼姿态', () => {
        resultBox.value = viewer.mirrorSelectedBonePose();
    });
    const result = resultBox.value;

    if (!result) {
        showToast('没找到对称骨骼', 'error');
        return;
    }

    selectedKeyframeTimes = [];
    syncAnimationEditor();
    showToast(`已镜像 ${result.sourceName} -> ${result.targetName}`, 'success');
}

async function mirrorActiveAnimationClip(): Promise<void> {
    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.activeIndex < 0) {
        showToast('没有可镜像的动画', 'info');
        return;
    }

    const loaded = await ensureAnimationClipLoaded(state.activeIndex, { autoPlay: false });
    if (!loaded) return;

    let changed = false;
    runAnimationEdit('镜像动画', () => {
        changed = viewer.mirrorActiveAnimationClip();
    });

    if (!changed) {
        showToast('镜像动画失败', 'error');
        return;
    }

    selectedKeyframeTimes = [];
    syncAnimationEditor();
    showToast('当前动画已左右镜像', 'success');
}

function copyClipKeyframesAt(index: number): void {
    if (!Number.isFinite(index) || index < 0) {
        showToast('没有可复制的动画', 'error');
        return;
    }

    const snapshot = viewer.captureAnimationSnapshot(index);
    if (!snapshot) {
        showToast('复制动画关键帧失败', 'error');
        return;
    }

    animationClipboard = snapshot;
    syncAnimationClipTools(viewer.getAnimationState());
    showToast(`已复制 "${snapshot.clipName || `Clip ${index + 1}`}" 的关键帧`, 'success');
}

function pasteClipKeyframesToActiveClip(): void {
    if (!animationClipboard) {
        showToast('剪贴板里没有动画关键帧', 'error');
        return;
    }

    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.activeIndex < 0) {
        const created = viewer.createRestPoseAnimationClip(`${animationClipboard.clipName || 'Pasted Action'} 编辑`);
        if (created < 0) {
            showToast('当前模型没有可粘贴动画的骨骼', 'error');
            return;
        }
        markActiveDocumentDirty();
    }

    const clipName = animationClipboard.clipName || '动画';
    runAnimationEdit('粘贴动画关键帧', () => {
        if (!animationClipboard) return;
        viewer.replaceActiveAnimationTracksFromSnapshot(animationClipboard);
    });
    selectedKeyframeTimes = [];
    syncAnimationClipTools(viewer.getAnimationState());
    showToast(`已粘贴 "${clipName}" 的关键帧`, 'success');
}

function copySelectedTimelineKeyframes(): void {
    if (selectedKeyframeTimes.length === 0) {
        showToast('先在时间轴选择关键帧', 'info');
        return;
    }

    const snapshot = timelineSelectedBoneOnly
        ? viewer.captureSelectedBoneKeyframesAtTimes(selectedKeyframeTimes)
        : viewer.captureKeyframesAtTimes(selectedKeyframeTimes);
    if (!snapshot) {
        showToast('没有可复制的关键帧', 'info');
        return;
    }

    keyframeClipboard = snapshot;
    updateTimelineSelectionSummary();
    showToast(`已复制 ${selectedKeyframeTimes.length} 个时间点 · ${snapshot.tracks.length} 条轨道`, 'success');
}

function pasteTimelineKeyframesAtPlayhead(): void {
    const clipboard = keyframeClipboard;
    if (!clipboard) {
        showToast('剪贴板里没有时间轴关键帧', 'info');
        return;
    }

    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.activeIndex < 0) {
        showToast('需要先有一个动画片段', 'info');
        return;
    }

    const pasteTime = state.time;
    let changed = false;
    runAnimationEdit('粘贴时间轴关键帧', () => {
        changed = viewer.pasteKeyframesFromSnapshot(clipboard, pasteTime);
    });
    if (!changed) {
        showToast('没有可粘贴的关键帧', 'info');
        return;
    }

    selectedKeyframeTimes = [
        ...new Set(clipboard.tracks.flatMap((track) => (
            track.times.map((time) => Number((pasteTime + time).toFixed(4)))
        ))),
    ].sort((a, b) => a - b);
    syncAnimationEditor();
    showToast(`已粘贴到 ${formatFrameTime(pasteTime)}`, 'success');
}

function duplicateClipAt(index: number): void {
    let newIndex = -1;
    runAnimationLibraryEdit('复制动画片段', () => {
        newIndex = viewer.duplicateAnimationClip(index, { activate: true });
    });
    if (newIndex < 0) {
        showToast('复制失败', 'error');
        return;
    }
    showToast('动画已复制', 'success');
}

function deleteClipAt(index: number): void {
    const state = viewer.getAnimationState();
    const clip = state.clips[index];
    if (!clip) return;
    if (!window.confirm(`确定删除动画"${clip.name}"？删除后可从操作历史撤回。`)) return;
    let deleted = false;
    runAnimationLibraryEdit('删除动画片段', () => {
        deleted = viewer.deleteAnimationClip(index);
    });
    if (!deleted) {
        showToast('删除失败', 'error');
        return;
    }
    showToast('动画已删除', 'success');
}

function syncAnimationProgress(state: AnimationPlaybackState): void {
    const duration = state.duration;
    const time = Math.min(state.time, duration);

    animTimeRangeSyncing = true;
    animTimeRange.max = duration > 0 ? String(duration) : '0';
    animTimeRange.step = duration > 0
        ? String(timelineSnapEnabled ? 1 / timelineFps : Math.max(duration / 1000, 0.001))
        : '0.001';
    animTimeRange.value = duration > 0 ? String(time) : '0';
    animTimeRangeSyncing = false;

    animTimeLabel.textContent = formatAnimationTime(time, duration);
    updateStatusChips();
}

function formatAnimationTime(time: number, duration: number): string {
    if (duration <= 0) return '—';
    return `${time.toFixed(2)} / ${duration.toFixed(2)}s`;
}

function openAnimationInspector(): void {
    layoutState.activeTab = 'animation';
    applyInspectorState();
    persistLayout();
    viewer.setSkeletonVisible(true);
    syncActiveInspectorControls();
}

function setBoneTransformMode(mode: BoneTransformMode): void {
    viewer.setBoneTransformMode(mode);
    syncAnimationEditor();
}

function setBoneTransformSpace(space: BoneTransformSpace): void {
    viewer.setBoneTransformSpace(space);
    syncAnimationEditor();
}

function setBoneSolverMode(ikEnabled: boolean): void {
    viewer.setIkEnabled(ikEnabled);
    syncAnimationEditor();
}

function syncAnimationEditor(): void {
    const state = viewer.getAnimationEditorState();
    const skeletonState = viewer.getSkeletonEditorState();
    if (!state.hasAnimations && !skeletonState.hasSkeleton) {
        animEditorEmpty.hidden = false;
        animEditor.hidden = true;
        selectedAnimationTrackIndex = -1;
        animClipNameInput.value = '';
        renderAnimationHistory();
        syncAnimationClipTools(viewer.getAnimationState());
        return;
    }

    animEditorEmpty.hidden = true;
    animEditor.hidden = false;
    renderSkeletonControls(skeletonState);
    animClipNameInput.value = state.clipName || 'Pose Action';
    animClipDuration.textContent = state.duration > 0 ? `${state.duration.toFixed(2)}s` : '—';
    animTrackCount.textContent = String(state.tracks.length);
    renderAnimationTimeline(skeletonState, viewer.getAnimationState());
    renderAnimationHistory();
    syncAnimationClipTools(viewer.getAnimationState());

    const previousValue = animTrackSelect.value;
    animTrackSelect.innerHTML = state.tracks.map((track) => {
        const label = `${track.target} · ${track.propertyLabel} · ${track.keyframes}`;
        const disabled = track.editable ? '' : ' disabled';
        return `<option value="${track.index}"${disabled}>${escapeHtml(label)}</option>`;
    }).join('');

    if (state.tracks.length === 0) {
        selectedAnimationTrackIndex = -1;
        animTrackType.textContent = '—';
        animTrackKeys.textContent = '—';
        animTransformControls.hidden = true;
        btnApplyAnimTransform.disabled = true;
        return;
    }

    const previousIndex = Number(previousValue);
    let shouldResetInputs = false;
    const selectedStillAvailable = state.tracks.some((track) => track.index === selectedAnimationTrackIndex && track.editable);
    if (!selectedStillAvailable) {
        const fromPrevious = state.tracks.find((track) => track.index === previousIndex && track.editable);
        const firstEditable = state.tracks.find((track) => track.editable);
        selectedAnimationTrackIndex = (fromPrevious ?? firstEditable ?? state.tracks[0]).index;
        shouldResetInputs = true;
    }

    animTrackSelect.value = String(selectedAnimationTrackIndex);
    syncAnimationTrackControls(state, { resetInputs: shouldResetInputs });
}

function renderSkeletonControls(
    state: SkeletonEditorState,
    options: { preserveSearch?: boolean } = {},
): void {
    animShowSkeletonInput.checked = state.skeletonVisible;
    animShowSkeletonInput.disabled = !state.hasSkeleton;
    animShowTransformInput.checked = state.transformControlsVisible;
    animShowTransformInput.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animBoneSearch.disabled = !state.hasSkeleton;
    animModeRotate.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animModeTranslate.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animSpaceLocal.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animSpaceWorld.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animFkMode.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animIkMode.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animAutoKeyframeInput.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animAutoKeyframeInput.checked = state.autoKeyframeEnabled;
    animIkChainLengthInput.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0 || !state.ikEnabled;
    animIkIterationsInput.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0 || !state.ikEnabled;
    animRotationStepInput.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animTranslationStepInput.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    if (Number(animIkChainLengthInput.value) !== state.ikChainLength) {
        animIkChainLengthInput.value = String(state.ikChainLength);
    }
    if (Number(animIkIterationsInput.value) !== state.ikIterations) {
        animIkIterationsInput.value = String(state.ikIterations);
    }
    btnInsertKeyframe.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    btnInsertChainKeyframe.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    btnDeleteKeyframe.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    btnCopyBonePose.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    btnPasteBonePose.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0 || !bonePoseClipboard;
    btnCopyBoneChainPose.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    btnPasteBoneChainPose.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0 || !bonePoseClipboard;
    btnMirrorBoneChainPose.disabled = !state.hasSkeleton || state.selectedBoneIndex < 0;
    animSelectedBone.textContent = state.selectedBoneName || '—';
    syncBoneSolverModeButtons(state.ikEnabled);
    syncTransformModeButtons(state.transformMode);
    syncTransformSpaceButtons(state.transformSpace);

    const query = normalizeSearchText(animBoneSearch.value);
    let bones = state.bones.filter((bone) => {
        const text = normalizeSearchText(`${bone.name} ${bone.parentName}`);
        return text.includes(query);
    });
    if (!options.preserveSearch && state.selectedBoneIndex >= 0 && !bones.some((bone) => bone.index === state.selectedBoneIndex)) {
        animBoneSearch.value = '';
        bones = state.bones;
    }
    animBoneList.innerHTML = bones.length > 0
        ? bones.map((bone) => {
            const active = bone.selected ? ' active' : '';
            const depth = clamp(bone.depth, 0, 12);
            return `
                <button class="animation-bone-item${active}" type="button" role="option" data-bone-index="${bone.index}" aria-selected="${bone.selected}" style="--bone-depth:${depth}">
                    <span class="animation-bone-name">${escapeHtml(bone.name)}</span>
                    <span class="animation-bone-parent">${escapeHtml(bone.parentName || '根')}</span>
                </button>
            `;
        }).join('')
        : '<div class="animation-list-empty">没有匹配骨骼</div>';
    scrollSelectedBoneIntoView(state.selectedBoneIndex);
}

function scrollSelectedBoneIntoView(index: number): void {
    if (index < 0 || index === lastScrolledBoneIndex) return;
    lastScrolledBoneIndex = index;
    requestAnimationFrame(() => {
        const selected = animBoneList.querySelector<HTMLElement>(`[data-bone-index="${index}"]`);
        selected?.scrollIntoView({ block: 'center' });
    });
}

function syncTransformModeButtons(mode: BoneTransformMode): void {
    const rotateActive = mode === 'rotate';
    animModeRotate.classList.toggle('active', rotateActive);
    animModeRotate.setAttribute('aria-pressed', String(rotateActive));
    animModeTranslate.classList.toggle('active', !rotateActive);
    animModeTranslate.setAttribute('aria-pressed', String(!rotateActive));
}

function syncTransformSpaceButtons(space: BoneTransformSpace): void {
    const localActive = space === 'local';
    animSpaceLocal.classList.toggle('active', localActive);
    animSpaceLocal.setAttribute('aria-pressed', String(localActive));
    animSpaceWorld.classList.toggle('active', !localActive);
    animSpaceWorld.setAttribute('aria-pressed', String(!localActive));
}

function syncBoneSolverModeButtons(ikEnabled: boolean): void {
    animFkMode.classList.toggle('active', !ikEnabled);
    animFkMode.setAttribute('aria-pressed', String(!ikEnabled));
    animIkMode.classList.toggle('active', ikEnabled);
    animIkMode.setAttribute('aria-pressed', String(ikEnabled));
}

let timelineRenderRaf = 0;
let timelineStripRenderKey = '';

function renderAnimationTimeline(
    skeletonState: SkeletonEditorState,
    playbackState: AnimationPlaybackState,
): void {
    // Playhead tracks the cursor every call — no rAF gating.
    updateTimelinePlayhead(playbackState);
    const renderKey = getTimelineStripRenderKey(skeletonState, playbackState);
    if (renderKey === timelineStripRenderKey) return;
    // The expensive strip rebuild is coalesced to one per frame. retime
    // drag fires this on every pointer-move; without coalescing 500-keyframe
    // clips stutter.
    if (timelineRenderRaf) return;
    timelineRenderRaf = requestAnimationFrame(() => {
        timelineRenderRaf = 0;
        const nextSkeletonState = viewer.getSkeletonEditorState();
        const nextPlaybackState = viewer.getAnimationState();
        const nextRenderKey = getTimelineStripRenderKey(nextSkeletonState, nextPlaybackState);
        if (nextRenderKey === timelineStripRenderKey) return;
        timelineStripRenderKey = nextRenderKey;
        renderAnimationTimelineNow(
            nextSkeletonState,
            nextPlaybackState,
        );
    });
}

function getTimelineStripRenderKey(
    skeletonState: SkeletonEditorState,
    playbackState: AnimationPlaybackState,
): string {
    const keyframes = getTimelineVisibleMarkers(skeletonState)
        .map((marker) => `${marker.time.toFixed(4)}${marker.selectedBone ? 'b' : ''}`)
        .join(',');
    const selection = selectedKeyframeTimes
        .map((time) => time.toFixed(4))
        .join(',');
    return [
        playbackState.duration.toFixed(4),
        timelineZoom.toFixed(3),
        timelineFps,
        timelineSnapEnabled ? 1 : 0,
        timelineSelectedBoneOnly ? 1 : 0,
        timelineRetimePreviewDelta.toFixed(4),
        selection,
        keyframes,
    ].join('|');
}

function renderAnimationTimelineNow(
    skeletonState: SkeletonEditorState,
    playbackState: AnimationPlaybackState,
): void {
    const duration = playbackState.duration;
    const width = getTimelineContentWidth(duration);
    animKeyframeStrip.style.setProperty('--timeline-width', `${width}px`);
    updateTimelinePlayhead(playbackState);
    updateTimelineSelectionSummary();
    if (duration <= 0) {
        animKeyframeStrip.innerHTML = '';
        selectedKeyframeTimes = [];
        updateTimelineSelectionSummary();
        return;
    }
    const visibleMarkers = getTimelineVisibleMarkers(skeletonState);
    const markerTimes = visibleMarkers.map((marker) => marker.time);
    selectedKeyframeTimes = selectedKeyframeTimes.filter((time) => markerTimes.some((markerTime) => nearlyEqualTimeForUi(time, markerTime)));
    updateTimelineSelectionSummary();

    const ticks = buildTimelineTicks(duration, width).map((tick) => {
        const left = clamp((tick.time / duration) * 100, 0, 100);
        return `
            <span class="animation-time-tick ${tick.major ? 'major' : 'minor'}" style="left:${left}%">
                ${tick.major ? `<span>${escapeHtml(tick.label)}</span>` : ''}
            </span>
        `;
    }).join('');

    const markers = visibleMarkers.map((marker) => {
            const selected = isKeyframeTimeSelected(marker.time);
            const displayTime = selected
                ? clamp(marker.time + timelineRetimePreviewDelta, 0, duration)
                : marker.time;
            const left = clamp((displayTime / duration) * 100, 0, 100);
            const classes = [
                'animation-keyframe-marker',
                marker.selectedBone ? 'selected-bone' : '',
                selected ? 'selected' : '',
            ].filter(Boolean).join(' ');
            return `
                <button
                    class="${classes}"
                    type="button"
                    data-keyframe-time="${marker.time}"
                    style="left:${left}%"
                    aria-label="关键帧 ${formatFrameTime(marker.time)}"
                    aria-pressed="${selected}"
                ></button>
            `;
        }).join('');

    animKeyframeStrip.innerHTML = `
        <div class="animation-time-ruler">${ticks}</div>
        <div class="animation-keyframe-lane">${markers}</div>
        <span class="animation-selection-box" aria-hidden="true"></span>
    `;
    updateTimelineSelectionBox();
}

function updateTimelinePlayhead(state: AnimationPlaybackState): void {
    const playhead = state.duration > 0 ? clamp((state.time / state.duration) * 100, 0, 100) : 0;
    animKeyframeStrip.style.setProperty('--playhead', `${playhead}%`);
    updateTimelineSelectionSummary(state, { updateStatus: false });
    updateStatusFrameChip(state);
}

function updateTimelineSelectionSummary(
    state = viewer.getAnimationState(),
    options: { updateStatus?: boolean } = {},
): void {
    const count = selectedKeyframeTimes.length;
    const frame = state.duration > 0
        ? Math.round((state.time ?? 0) * timelineFps)
        : 0;
    animKeyframeSelection.textContent = count > 0
        ? `${count} 关键帧 · F${frame}`
        : `0 关键帧 · F${frame}`;
    const hasAnimations = state.hasAnimations && state.activeIndex >= 0;
    btnTimelineSelectAll.disabled = !hasAnimations;
    btnTimelineClearSelection.disabled = count === 0;
    btnTimelineCopyKeys.disabled = count === 0;
    btnTimelinePasteKeys.disabled = !keyframeClipboard || !hasAnimations;
    animTimelineSelectedBoneOnlyInput.disabled = !hasAnimations;
    animTimelineSelectedBoneOnlyInput.checked = timelineSelectedBoneOnly;
    btnDeleteKeyframe.textContent = count > 0 ? `删除选中 ${count}` : '删除当前帧';
    animTimelineZoomLabel.textContent = `${Math.round(timelineZoom * 100)}%`;
    if (options.updateStatus ?? true) updateStatusChips(state);
}

function getTimelineContentWidth(duration: number): number {
    if (duration <= 0) return 1600;
    return Math.max(1600, Math.ceil(duration * 220 * timelineZoom));
}

function getTimelineVisibleMarkers(skeletonState: SkeletonEditorState): SkeletonEditorState['keyframes'] {
    return timelineSelectedBoneOnly
        ? skeletonState.keyframes.filter((marker) => marker.selectedBone)
        : skeletonState.keyframes;
}

function moveTimelineKeyframesAtTimes(fromTimes: number[], toTimes: number[]): void {
    if (timelineSelectedBoneOnly) viewer.moveSelectedBoneKeyframesAtTimes(fromTimes, toTimes);
    else viewer.moveKeyframesAtTimes(fromTimes, toTimes);
}

function deleteTimelineKeyframesAtTimes(times: number[]): void {
    if (timelineSelectedBoneOnly) viewer.deleteSelectedBoneKeyframesAtTimes(times);
    else viewer.deleteKeyframesAtTimes(times);
}

function handleTimelineWheel(event: WheelEvent): void {
    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.duration <= 0) return;

    if (event.ctrlKey) {
        event.preventDefault();
        const oldWidth = getTimelineContentWidth(state.duration);
        const rect = animTimelineScroll.getBoundingClientRect();
        const anchor = clamp(event.clientX - rect.left, 0, rect.width);
        const anchorRatio = oldWidth > 0
            ? clamp((animTimelineScroll.scrollLeft + anchor) / oldWidth, 0, 1)
            : 0;
        const nextZoom = clamp(timelineZoom * Math.exp(-event.deltaY * 0.0015), 0.25, 12);
        if (nearlyEqual(nextZoom, timelineZoom)) return;
        timelineZoom = nextZoom;
        animTimelineZoomInput.value = String(Number(timelineZoom.toFixed(2)));
        renderAnimationTimeline(viewer.getSkeletonEditorState(), state);
        requestAnimationFrame(() => {
            const nextWidth = getTimelineContentWidth(state.duration);
            animTimelineScroll.scrollLeft = Math.max(0, nextWidth * anchorRatio - anchor);
        });
        return;
    }

    if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        animTimelineScroll.scrollLeft += event.deltaY;
    }
}

function buildTimelineTicks(duration: number, width: number): Array<{ time: number; label: string; major: boolean }> {
    const ticks: Array<{ time: number; label: string; major: boolean }> = [];
    const majorStep = pickTimelineMajorStep(duration, width);
    const minorStep = majorStep / 4;
    for (let time = 0; time <= duration + minorStep * 0.5; time += minorStep) {
        const clampedTime = Math.min(time, duration);
        const major = nearlyEqual((Math.round(clampedTime / majorStep) * majorStep), clampedTime)
            || nearlyEqual(clampedTime, 0)
            || nearlyEqual(clampedTime, duration);
        ticks.push({
            time: clampedTime,
            label: formatTimelineTickLabel(clampedTime, majorStep),
            major,
        });
    }
    return ticks;
}

function pickTimelineMajorStep(duration: number, width: number): number {
    const pxPerSecond = duration > 0 ? width / duration : 120;
    const steps = [1 / timelineFps, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    return steps.find((step) => step * pxPerSecond >= 82) ?? 60;
}

function formatTimelineTickLabel(time: number, step: number): string {
    if (step < 1) return `${time.toFixed(2)}s`;
    if (timelineSnapEnabled) return `F${Math.round(time * timelineFps)}`;
    return `${time.toFixed(0)}s`;
}

function formatFrameTime(time: number): string {
    return `${time.toFixed(3)} 秒 / F${Math.round(time * timelineFps)}`;
}

function handleTimelineClick(event: MouseEvent): void {
    const marker = (event.target as HTMLElement).closest<HTMLElement>('[data-keyframe-time]');
    if (!marker) return;

    event.preventDefault();
    event.stopPropagation();
    const time = Number(marker.dataset.keyframeTime);
    if (!Number.isFinite(time)) return;

    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.duration <= 0) return;

    if (event.shiftKey && selectedKeyframeTimes.length > 0) {
        const anchor = selectedKeyframeTimes[selectedKeyframeTimes.length - 1];
        selectKeyframeTimeRange(Math.min(anchor, time), Math.max(anchor, time));
    } else if (event.ctrlKey || event.metaKey) {
        toggleSelectedKeyframeTime(time);
    } else {
        setSelectedKeyframeTimes([time]);
    }

    viewer.seekAnimation(time);
    renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
}

function handleTimelinePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const state = viewer.getAnimationState();
    if (!state.hasAnimations || state.duration <= 0) return;
    const marker = (event.target as HTMLElement).closest<HTMLElement>('[data-keyframe-time]');

    if (marker) {
        if (event.shiftKey || event.ctrlKey || event.metaKey) return;
        const time = Number(marker.dataset.keyframeTime);
        if (!Number.isFinite(time)) return;
        if (!isKeyframeTimeSelected(time)) {
            setSelectedKeyframeTimes([time]);
            renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
        }
        timelineDragState.mode = 'retime';
        timelineDragState.markerTime = time;
        timelineDragState.startTimes = [...selectedKeyframeTimes];
    } else {
        timelineDragState.mode = 'box-select';
        timelineDragState.markerTime = 0;
        timelineDragState.startTimes = [];
    }

    timelineDragState.active = true;
    timelineDragState.pointerId = event.pointerId;
    timelineDragState.startClientX = event.clientX;
    timelineDragState.currentClientX = event.clientX;
    timelineDragState.moved = false;
    animKeyframeStrip.setPointerCapture(event.pointerId);
    animKeyframeStrip.classList.add(timelineDragState.mode === 'retime' ? 'retiming' : 'selecting');
    updateTimelineSelectionBox();
    event.preventDefault();
}

function handleTimelinePointerMove(event: PointerEvent): void {
    if (!timelineDragState.active || timelineDragState.pointerId !== event.pointerId) return;
    timelineDragState.currentClientX = event.clientX;
    if (Math.abs(timelineDragState.currentClientX - timelineDragState.startClientX) > 4) {
        timelineDragState.moved = true;
    }

    if (timelineDragState.mode === 'retime' && timelineDragState.moved) {
        const duration = viewer.getAnimationState().duration;
        const start = getTimelineTimeAtClientX(timelineDragState.startClientX, duration, { snap: false });
        const current = getTimelineTimeAtClientX(timelineDragState.currentClientX, duration, { snap: false });
        timelineRetimePreviewDelta = current - start;
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
        event.preventDefault();
        return;
    }

    updateTimelineSelectionBox();
    event.preventDefault();
}

function handleTimelinePointerUp(event: PointerEvent): void {
    if (!timelineDragState.active || timelineDragState.pointerId !== event.pointerId) return;
    const duration = viewer.getAnimationState().duration;
    const moved = timelineDragState.moved;
    const mode = timelineDragState.mode;
    const startTimes = [...timelineDragState.startTimes];
    const start = getTimelineTimeAtClientX(timelineDragState.startClientX, duration);
    const end = getTimelineTimeAtClientX(event.clientX, duration);
    const rawStart = getTimelineTimeAtClientX(timelineDragState.startClientX, duration, { snap: false });
    const rawEnd = getTimelineTimeAtClientX(event.clientX, duration, { snap: false });
    const markerTime = timelineDragState.markerTime;

    cancelTimelineSelection();

    if (duration <= 0) return;

    if (mode === 'retime') {
        if (moved && startTimes.length > 0) {
            const delta = rawEnd - rawStart;
            const targetTimes = startTimes.map((time) => snapTimelineTime(time + delta, duration));
            runAnimationEdit('移动关键帧', () => {
                moveTimelineKeyframesAtTimes(startTimes, targetTimes);
            });
            setSelectedKeyframeTimes(targetTimes);
            if (selectedKeyframeTimes.length > 0) viewer.seekAnimation(selectedKeyframeTimes[0]);
            showToast(`已移动 ${selectedKeyframeTimes.length} 个关键帧`, 'success');
        } else {
            setSelectedKeyframeTimes([markerTime]);
            viewer.seekAnimation(markerTime);
        }
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
        return;
    }

    if (moved) {
        selectKeyframeTimeRange(Math.min(start, end), Math.max(start, end));
        if (selectedKeyframeTimes.length > 0) viewer.seekAnimation(selectedKeyframeTimes[0]);
        renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
        return;
    }

    selectedKeyframeTimes = [];
    viewer.seekAnimation(end);
    renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
}

function cancelTimelineSelection(): void {
    if (timelineDragState.pointerId !== null) {
        try {
            animKeyframeStrip.releasePointerCapture(timelineDragState.pointerId);
        } catch {
            // Pointer capture may already be gone after a browser cancel event.
        }
    }
    timelineDragState.active = false;
    timelineDragState.mode = 'idle';
    timelineDragState.pointerId = null;
    timelineDragState.moved = false;
    timelineDragState.markerTime = 0;
    timelineDragState.startTimes = [];
    timelineRetimePreviewDelta = 0;
    animKeyframeStrip.classList.remove('selecting', 'retiming');
    updateTimelineSelectionBox();
}

function updateTimelineSelectionBox(): void {
    const selectionBox = animKeyframeStrip.querySelector<HTMLElement>('.animation-selection-box');
    if (!selectionBox) return;
    if (!timelineDragState.active || !timelineDragState.moved || timelineDragState.mode !== 'box-select') {
        selectionBox.hidden = true;
        return;
    }

    const rect = animKeyframeStrip.getBoundingClientRect();
    const start = clamp(timelineDragState.startClientX - rect.left, 0, rect.width);
    const current = clamp(timelineDragState.currentClientX - rect.left, 0, rect.width);
    selectionBox.hidden = false;
    selectionBox.style.left = `${Math.min(start, current)}px`;
    selectionBox.style.width = `${Math.abs(current - start)}px`;
}

function getTimelineTimeAtClientX(
    clientX: number,
    duration: number,
    options: { snap?: boolean } = {},
): number {
    if (duration <= 0) return 0;
    const rect = animKeyframeStrip.getBoundingClientRect();
    const ratio = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    const time = duration * ratio;
    return options.snap === false ? time : snapTimelineTime(time, duration);
}

function snapTimelineTime(time: number, duration: number): number {
    const clamped = clamp(time, 0, Math.max(0, duration));
    if (!timelineSnapEnabled) return clamped;
    const frame = Math.round(clamped * timelineFps);
    return clamp(frame / timelineFps, 0, Math.max(0, duration));
}

function selectKeyframeTimeRange(start: number, end: number): void {
    const markers = getTimelineVisibleMarkers(viewer.getSkeletonEditorState())
        .map((marker) => marker.time)
        .filter((time) => time >= start - 1e-4 && time <= end + 1e-4);
    setSelectedKeyframeTimes(markers);
}

function setSelectedKeyframeTimes(times: number[]): void {
    const values = [...new Set(times.map((time) => Number(time.toFixed(4))))];
    selectedKeyframeTimes = values.sort((a, b) => a - b);
    updateStatusChips();
}

function toggleSelectedKeyframeTime(time: number): void {
    const rounded = Number(time.toFixed(4));
    if (selectedKeyframeTimes.some((item) => nearlyEqualTimeForUi(item, rounded))) {
        selectedKeyframeTimes = selectedKeyframeTimes.filter((item) => !nearlyEqualTimeForUi(item, rounded));
    } else {
        setSelectedKeyframeTimes([...selectedKeyframeTimes, rounded]);
    }
}

function isKeyframeTimeSelected(time: number): boolean {
    return selectedKeyframeTimes.some((item) => nearlyEqualTimeForUi(item, time));
}

function nearlyEqualTimeForUi(a: number, b: number): boolean {
    return Math.abs(a - b) < 1e-4;
}

function renderAnimationHistory(): void {
    const active = getActiveDocument();
    const pendingLabel = animationPoseUndoDraft.snapshot
        ? (animationPoseUndoDraft.label || '骨骼姿态')
        : '';
    const undoItems = active ? active.undoStack.slice(-10).reverse() : [];
    const redoItems = active ? active.redoStack.slice(-6) : [];
    const rows: string[] = [];

    if (pendingLabel) {
        rows.push(renderHistoryItem({
            kind: 'bone-pose',
            label: pendingLabel,
            state: '正在编辑',
            className: 'pending',
        }));
    }

    undoItems.forEach((entry, index) => {
        rows.push(renderHistoryItem({
            kind: entry.kind,
            label: entry.label,
            state: index === 0 ? '下一步撤回' : '可撤回',
            className: index === 0 ? 'next' : '',
        }));
    });

    redoItems.forEach((entry, index) => {
        rows.push(renderHistoryItem({
            kind: entry.kind,
            label: entry.label,
            state: index === 0 ? '下一步重做' : '可重做',
            className: 'redo',
        }));
    });

    animHistoryList.innerHTML = rows.length > 0
        ? rows.join('')
        : '<li class="animation-history-empty">暂无操作历史</li>';
}

function renderHistoryItem(item: {
    kind: UndoEntry['kind'];
    label: string;
    state: string;
    className: string;
}): string {
    const className = `animation-history-item${item.className ? ` ${item.className}` : ''}`;
    return `
        <li class="${className}">
            <span class="animation-history-kind">${escapeHtml(getUndoKindLabel(item.kind))}</span>
            <span class="animation-history-label">${escapeHtml(item.label)}</span>
            <span class="animation-history-state">${escapeHtml(item.state)}</span>
        </li>
    `;
}

function getUndoKindLabel(kind: UndoEntry['kind']): string {
    if (kind === 'animation') return '动画';
    if (kind === 'animation-library') return '动画库';
    if (kind === 'bone-pose') return '姿态';
    if (kind === 'material') return '材质';
    if (kind === 'texture') return '贴图';
    if (kind === 'uv' || kind === 'uv-selection') return 'UV';
    return '编辑';
}

function syncAnimationTrackControls(
    state: AnimationEditorState,
    options: { resetInputs?: boolean } = {},
): void {
    const track = state.tracks.find((item) => item.index === selectedAnimationTrackIndex) ?? null;
    if (!track) {
        animTrackType.textContent = '—';
        animTrackKeys.textContent = '—';
        animCurvePanel.hidden = true;
        btnApplyAnimEasing.disabled = true;
        animTransformControls.hidden = true;
        btnApplyAnimTransform.disabled = true;
        renderAnimationCurveEditor();
        return;
    }

    animTrackType.textContent = `${track.target} / ${track.propertyLabel}`;
    animTrackKeys.textContent = String(track.keyframes);
    animCurvePanel.hidden = false;
    btnApplyAnimEasing.disabled = !track.editable || track.keyframes < 2;
    animTransformControls.hidden = !track.editable;
    btnApplyAnimTransform.disabled = !track.editable;
    renderAnimationCurveEditor();
    if (options.resetInputs) resetAnimationTrackEditInputs(track);
}

function resetAnimationTrackEditInputs(track: AnimationTrackMeta): void {
    const isScale = track.property === 'scale';
    const isRotation = track.property === 'quaternion';
    const value = isScale ? 1 : 0;
    const step = isRotation ? '1' : '0.01';

    animEditXLabel.textContent = 'X';
    animEditYLabel.textContent = 'Y';
    animEditZLabel.textContent = 'Z';

    for (const input of [animEditXInput, animEditYInput, animEditZInput]) {
        input.step = step;
        input.value = String(value);
    }
}

function applySelectedAnimationTrackEdit(): void {
    const state = viewer.getAnimationEditorState();
    const track = state.tracks.find((item) => item.index === selectedAnimationTrackIndex);
    if (!track?.editable) return;

    const x = Number(animEditXInput.value);
    const y = Number(animEditYInput.value);
    const z = Number(animEditZInput.value);
    if (![x, y, z].every(Number.isFinite)) return;

    const edit = track.property === 'scale'
        ? {
            x: normalizeAnimationScaleInput(x),
            y: normalizeAnimationScaleInput(y),
            z: normalizeAnimationScaleInput(z),
        }
        : { x, y, z };
    const unchanged = track.property === 'scale'
        ? nearlyEqual(edit.x, 1) && nearlyEqual(edit.y, 1) && nearlyEqual(edit.z, 1)
        : nearlyEqual(edit.x, 0) && nearlyEqual(edit.y, 0) && nearlyEqual(edit.z, 0);
    if (unchanged) {
        showToast('轨道数值未变化', 'info');
        return;
    }

    runAnimationEdit(`骨骼${track.propertyLabel}`, () => {
        viewer.applyAnimationTrackVectorEdit(track.index, edit);
    });
    resetAnimationTrackEditInputs(track);
    showToast('骨骼动画轨道已更新', 'success');
}

function setAnimationEasingByName(name: AnimationEasingName): void {
    if (name !== 'custom') {
        animationEasingCurve = [...ANIMATION_EASING_CURVES[name]];
    }
    animEasingSelect.value = name;
    animEasingPresetSelect.value = name;
    renderAnimationCurveEditor();
}

function markAnimationEasingCustom(): void {
    animEasingSelect.value = 'custom';
    animEasingPresetSelect.value = 'custom';
}

function applySelectedAnimationEasing(): void {
    const state = viewer.getAnimationEditorState();
    const track = state.tracks.find((item) => item.index === selectedAnimationTrackIndex);
    if (!track?.editable || track.keyframes < 2) {
        showToast('需要选择至少 2 个关键帧的可编辑轨道', 'info');
        return;
    }

    const selectedTimes = selectedKeyframeTimes.length > 0 ? selectedKeyframeTimes : [];
    let changed = false;
    let changedTracks = 0;
    runAnimationEdit('动画缓动曲线', () => {
        if (selectedTimes.length > 0) {
            changedTracks = viewer.applyAnimationEasingToKeyframes(animationEasingCurve, { selectedTimes });
            changed = changedTracks > 0;
        } else {
            changed = viewer.applyAnimationTrackEasing(track.index, animationEasingCurve, { selectedTimes });
        }
    });
    syncAnimationTrackControls(viewer.getAnimationEditorState());
    renderAnimationTimeline(viewer.getSkeletonEditorState(), viewer.getAnimationState());
    showToast(
        changed
            ? (selectedTimes.length > 0 ? `已应用到选中关键帧区间 · ${changedTracks} 条轨道` : '已应用到当前轨道')
            : '没有可应用的关键帧区间',
        changed ? 'success' : 'info',
    );
}

function renderAnimationCurveEditor(): void {
    const canvas = animEasingCanvas;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(220, Math.round(rect.width || canvas.clientWidth || 260));
    const cssHeight = Math.max(130, Math.round(rect.height || 150));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
        canvas.width = Math.round(cssWidth * dpr);
        canvas.height = Math.round(cssHeight * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const pad = 14;
    const plotW = cssWidth - pad * 2;
    const plotH = cssHeight - pad * 2;
    const toPoint = (x: number, y: number) => ({
        x: pad + x * plotW,
        y: pad + (1 - y) * plotH,
    });

    ctx.strokeStyle = 'rgba(94, 109, 126, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i += 1) {
        const p = pad + (i / 6) * plotW;
        ctx.beginPath();
        ctx.moveTo(p, pad);
        ctx.lineTo(p, pad + plotH);
        ctx.stroke();
        const y = pad + (i / 6) * plotH;
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(pad + plotW, y);
        ctx.stroke();
    }

    const p0 = toPoint(0, 0);
    const p1 = toPoint(animationEasingCurve[0], animationEasingCurve[1]);
    const p2 = toPoint(animationEasingCurve[2], animationEasingCurve[3]);
    const p3 = toPoint(1, 1);

    ctx.strokeStyle = 'rgba(47, 111, 179, 0.26)';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.strokeStyle = '#3a86ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.stroke();

    for (const point of [p0, p3]) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#3a86ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    for (const point of [p1, p2]) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#7fb2ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
}

function handleAnimationCurvePointerDown(event: PointerEvent): void {
    const handle = getAnimationCurveHandleAt(event.clientX, event.clientY);
    if (!handle) return;
    animationEasingDragHandle = handle;
    animEasingCanvas.setPointerCapture(event.pointerId);
    updateAnimationCurveHandle(event);
    event.preventDefault();
}

function handleAnimationCurvePointerMove(event: PointerEvent): void {
    if (!animationEasingDragHandle) return;
    updateAnimationCurveHandle(event);
    event.preventDefault();
}

function finishAnimationCurveDrag(event: PointerEvent): void {
    if (!animationEasingDragHandle) return;
    animationEasingDragHandle = null;
    if (animEasingCanvas.hasPointerCapture(event.pointerId)) {
        animEasingCanvas.releasePointerCapture(event.pointerId);
    }
}

function getAnimationCurveHandleAt(clientX: number, clientY: number): 1 | 2 | null {
    const points = getAnimationCurveCanvasPoints();
    const d1 = Math.hypot(clientX - points.p1.x, clientY - points.p1.y);
    const d2 = Math.hypot(clientX - points.p2.x, clientY - points.p2.y);
    const radius = 16;
    if (d1 <= radius || d2 <= radius) return d1 <= d2 ? 1 : 2;
    return null;
}

function updateAnimationCurveHandle(event: PointerEvent): void {
    if (!animationEasingDragHandle) return;
    const rect = animEasingCanvas.getBoundingClientRect();
    const pad = 14;
    const plotW = Math.max(1, rect.width - pad * 2);
    const plotH = Math.max(1, rect.height - pad * 2);
    const x = clamp((event.clientX - rect.left - pad) / plotW, 0, 1);
    const y = clamp(1 - ((event.clientY - rect.top - pad) / plotH), 0, 1);
    if (animationEasingDragHandle === 1) {
        animationEasingCurve = [x, y, animationEasingCurve[2], animationEasingCurve[3]];
    } else {
        animationEasingCurve = [animationEasingCurve[0], animationEasingCurve[1], x, y];
    }
    markAnimationEasingCustom();
    renderAnimationCurveEditor();
}

function getAnimationCurveCanvasPoints(): {
    p1: { x: number; y: number };
    p2: { x: number; y: number };
} {
    const rect = animEasingCanvas.getBoundingClientRect();
    const pad = 14;
    const plotW = Math.max(1, rect.width - pad * 2);
    const plotH = Math.max(1, rect.height - pad * 2);
    const toPoint = (x: number, y: number) => ({
        x: rect.left + pad + x * plotW,
        y: rect.top + pad + (1 - y) * plotH,
    });
    return {
        p1: toPoint(animationEasingCurve[0], animationEasingCurve[1]),
        p2: toPoint(animationEasingCurve[2], animationEasingCurve[3]),
    };
}

function normalizeAnimationScaleInput(value: number): number {
    return Number.isFinite(value) && Math.abs(value) > 1e-6 ? value : 1;
}

function setupViewportDrop(): void {
    viewport.addEventListener('dragover', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        viewport.classList.add('drag-over');
    });

    viewport.addEventListener('dragleave', (event) => {
        if (!isFileDrag(event)) return;
        if (event.target === viewport || event.target === canvas) {
            viewport.classList.remove('drag-over');
        }
    });

    viewport.addEventListener('drop', async (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        viewport.classList.remove('drag-over');
        const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
        if (files.length > 0) await loadFiles(files);
    });

    window.addEventListener('dragover', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
    });

    window.addEventListener('drop', (event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
    });

    if (inNative) {
        win.onFileDrop(() => {
            showToast('请把文件拖到 3D 视口里，不要拖到窗口边框', 'error');
        });
    }
}

function setupDisplayToggles(): void {
    togWire.addEventListener('change', () => {
        viewer.setWireframe(togWire.checked);
    });
    togGrid.addEventListener('change', () => {
        viewer.setGridVisible(togGrid.checked);
    });
    togAxes.addEventListener('change', () => {
        viewer.setAxesVisible(togAxes.checked);
    });
    togBg.addEventListener('change', () => {
        viewer.setLightBackground(togBg.checked);
    });
}

function setupPropertyControls(): void {
    bindNumericPair(cameraFovRange, cameraFovInput, (value) => {
        viewer.setCameraFov(value);
        syncPropertyPanelCamera();
    });

    bindNumericPair(cameraExposureRange, cameraExposureInput, (value) => {
        viewer.setExposure(value);
        syncPropertyPanelCamera();
    });

    matVisible.addEventListener('change', () => {
        runMaterialEdit('材质显示', () => {
            viewer.setModelVisible(matVisible.checked);
        });
        syncMaterialControls();
    });

    matMode.addEventListener('change', () => {
        const nextMode = matMode.value;
        if (!isMaterialEditMode(nextMode)) return;
        runMaterialEdit('材质模式', () => {
            viewer.setMaterialMode(nextMode);
        });
        syncMaterialControls();
    });

    bindNumericPair(matOpacityRange, matOpacityInput, (value) => {
        scheduleMaterialEdit({ opacity: value });
    }, {
        onBegin: () => beginMaterialUndoTransaction('材质透明度'),
        onCommit: () => commitMaterialUndoTransaction(),
    });

    bindNumericPair(matRoughnessRange, matRoughnessInput, (value) => {
        scheduleMaterialEdit({ roughness: value });
    }, {
        onBegin: () => beginMaterialUndoTransaction('材质粗糙度'),
        onCommit: () => commitMaterialUndoTransaction(),
    });

    bindNumericPair(matMetalnessRange, matMetalnessInput, (value) => {
        scheduleMaterialEdit({ metalness: value });
    }, {
        onBegin: () => beginMaterialUndoTransaction('材质金属度'),
        onCommit: () => commitMaterialUndoTransaction(),
    });

    const beginColorEdit = () => beginMaterialUndoTransaction('材质颜色');
    matColorInput.addEventListener('pointerdown', beginColorEdit);
    matColorInput.addEventListener('focus', beginColorEdit);
    matColorInput.addEventListener('input', () => {
        scheduleMaterialEdit({ color: matColorInput.value });
    });
    matColorInput.addEventListener('change', () => {
        commitMaterialUndoTransaction();
        syncMaterialControls();
    });
    matColorInput.addEventListener('blur', () => {
        commitMaterialUndoTransaction();
    });

    matFlat.addEventListener('change', () => {
        runMaterialEdit('平面着色', () => {
            viewer.setFlatShading(matFlat.checked);
        });
        syncMaterialControls();
    });

    matDoubleSided.addEventListener('change', () => {
        runMaterialEdit('双面显示', () => {
            viewer.setDoubleSided(matDoubleSided.checked);
        });
        syncMaterialControls();
    });

    btnResetMaterial.addEventListener('click', () => {
        runMaterialEdit('材质重置', () => {
            viewer.resetMaterialEdits();
        });
        syncMaterialControls();
        showToast('材质已恢复原始状态', 'success');
    });
}

function setupTextureControls(): void {
    textureList.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.texture-slot');
        const slot = button?.dataset.textureSlot;
        if (!isTextureSlotId(slot)) return;
        selectedTextureSlot = slot;
        syncTextureInspector();
    });

    bindNumericPair(texOffsetXRange, texOffsetXInput, (value) => {
        applyTextureTransform({ offsetX: value });
    }, {
        onBegin: () => beginTextureUndoTransaction('贴图偏移 X'),
        onCommit: () => commitTextureUndoTransaction(),
    });
    bindNumericPair(texOffsetYRange, texOffsetYInput, (value) => {
        applyTextureTransform({ offsetY: value });
    }, {
        onBegin: () => beginTextureUndoTransaction('贴图偏移 Y'),
        onCommit: () => commitTextureUndoTransaction(),
    });
    bindNumericPair(texRepeatXRange, texRepeatXInput, (value) => {
        applyTextureTransform({ repeatX: value });
    }, {
        onBegin: () => beginTextureUndoTransaction('贴图平铺 X'),
        onCommit: () => commitTextureUndoTransaction(),
    });
    bindNumericPair(texRepeatYRange, texRepeatYInput, (value) => {
        applyTextureTransform({ repeatY: value });
    }, {
        onBegin: () => beginTextureUndoTransaction('贴图平铺 Y'),
        onCommit: () => commitTextureUndoTransaction(),
    });
    bindNumericPair(texRotationRange, texRotationInput, (value) => {
        applyTextureTransform({ rotation: value });
    }, {
        onBegin: () => beginTextureUndoTransaction('贴图旋转'),
        onCommit: () => commitTextureUndoTransaction(),
    });

    btnResetTextureTransform.addEventListener('click', () => {
        const slot = selectedTextureSlot;
        if (!slot) return;
        runTextureEdit('贴图映射重置', () => {
            viewer.resetTextureTransform(slot);
        });
        syncTextureInspector();
        showToast('UV 映射已重置', 'success');
    });
}

function setupUvEditor(): void {
    const modeButtons = [uvSelectVertex, uvSelectEdge, uvSelectFace];
    for (const button of modeButtons) {
        button.addEventListener('click', () => {
            const mode = button.dataset.uvSelectMode;
            if (!isUvSelectionMode(mode)) return;
            setUvSelectionMode(mode);
        });
    }

    uvSnapEnabledInput.addEventListener('change', () => {
        uvSnapEnabled = uvSnapEnabledInput.checked;
        syncUvEditorControls();
        setUvEditorIdleStatus();
        renderUvEditor(currentTextureSlotState);
    });

    bindNumericPair(uvSnapStrengthRange, uvSnapStrengthInput, (value) => {
        uvSnapStrength = clamp(value, 0.25, 3);
        syncUvEditorControls();
        setUvEditorIdleStatus();
        renderUvEditor(currentTextureSlotState);
    });

    syncUvEditorControls();

    const resizeObserver = new ResizeObserver(() => {
        renderUvEditor(currentTextureSlotState);
    });
    resizeObserver.observe(uvEditorFrame);

    uvEditorCanvas.addEventListener('contextmenu', (event) => {
        event.preventDefault();
    });

    uvEditorCanvas.addEventListener('wheel', (event) => {
        if (!currentTextureSlotState) return;
        event.preventDefault();

        if (selectedUvPointIds.size > 0 && (event.ctrlKey || event.altKey)) {
            if (event.altKey) {
                rotateSelectedUvPoints(-event.deltaY * 0.35);
            } else {
                scaleSelectedUvPoints(Math.exp(-event.deltaY * 0.0018));
            }
            return;
        }

        const rect = uvEditorCanvas.getBoundingClientRect();
        const before = screenToUv(event.clientX - rect.left, event.clientY - rect.top);
        const factor = Math.exp(-event.deltaY * 0.0012);
        uvView.zoom = clamp(uvView.zoom * factor, 0.35, 24);
        const after = screenToUv(event.clientX - rect.left, event.clientY - rect.top);
        uvView.centerX += before.x - after.x;
        uvView.centerY += before.y - after.y;
        renderUvEditor(currentTextureSlotState);
    }, { passive: false });

    uvEditorCanvas.addEventListener('pointerdown', (event) => {
        if (!currentTextureSlotState || !currentUvEditorState) return;

        const wantsPan = event.button === 1 || event.button === 2 || event.altKey;
        const rect = uvEditorCanvas.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        const screenTransform = getUvScreenTransform();
        const uvPoint = screenToUv(localX, localY, screenTransform);
        const handle = wantsPan ? null : hitSelectionHandle(localX, localY, screenTransform);
        const nearestPointId = uvSelectionMode === 'vertex'
            ? findNearestUvPoint(currentUvEditorState, localX, localY, screenTransform)
            : null;
        const nearestEdge = uvSelectionMode === 'edge'
            ? findNearestUvEdge(localX, localY, screenTransform)
            : null;
        const hitFaceId = uvSelectionMode === 'face'
            ? findTriangleIndexAtUv(currentUvEditorState, uvPoint.x, uvPoint.y)
            : null;
        const additive = event.shiftKey || event.metaKey;
        const subtractive = event.ctrlKey;

        uvDragState.pointerId = event.pointerId;
        uvDragState.startClientX = event.clientX;
        uvDragState.startClientY = event.clientY;
        uvDragState.startCenterX = uvView.centerX;
        uvDragState.startCenterY = uvView.centerY;
        uvDragState.startUvX = uvPoint.x;
        uvDragState.startUvY = uvPoint.y;
        uvDragState.startSelection = [];
        uvDragState.additive = additive;
        uvDragState.subtractive = subtractive;
        uvDragState.moved = false;
        uvDragState.boxStartX = localX;
        uvDragState.boxStartY = localY;
        uvDragState.boxCurrentX = localX;
        uvDragState.boxCurrentY = localY;
        uvDragState.transformPivotX = 0;
        uvDragState.transformPivotY = 0;
        uvDragState.transformStartAngle = 0;
        uvDragState.transformHandle = handle;
        clearUvPreviewSelection();

        if (wantsPan) {
            uvDragState.mode = 'pan';
            uvEditorCanvas.setPointerCapture(event.pointerId);
            uvEditorFrame.classList.add('is-panning');
            uvEditorStatus.textContent = '正在平移 UV 视图…';
            event.preventDefault();
            return;
        }

        if (handle && selectedUvPointIds.size > 0) {
            const bounds = getSelectedUvBounds();
            if (!bounds) return;

            uvDragState.startSelection = getSelectedPointSnapshot();
            uvDragState.transformPivotX = bounds.centerX;
            uvDragState.transformPivotY = bounds.centerY;
            uvDragState.transformStartAngle = Math.atan2(
                uvPoint.y - bounds.centerY,
                uvPoint.x - bounds.centerX,
            );
            uvDragState.mode = handle === 'rotate' ? 'rotate-selection' : 'scale-selection';
            uvEditorCanvas.setPointerCapture(event.pointerId);
            uvEditorFrame.classList.add('is-offset-drag');
            uvEditorStatus.textContent = handle === 'rotate'
                ? `正在旋转 ${selectedUvPointIds.size} 个 UV 点…`
                : `正在缩放 ${selectedUvPointIds.size} 个 UV 点…`;
            event.preventDefault();
            return;
        }

        if (nearestPointId !== null) {
            if (subtractive) {
                runUvSelectionEdit('UV 选择', () => {
                    selectedUvPointIds.delete(nearestPointId);
                    selectedUvEdgeIds.clear();
                    selectedUvFaceIds.clear();
                });
                uvDragState.mode = 'idle';
                uvDragState.pointerId = null;
                uvEditorStatus.textContent = `已选择 ${formatUvSelectionCount(selectedUvPointIds.size, 'vertex')}`;
                renderUvEditor(currentTextureSlotState);
                event.preventDefault();
                return;
            }

            if (additive) {
                runUvSelectionEdit('UV 选择', () => {
                    toggleUvPointSelection(nearestPointId);
                });
                uvDragState.mode = 'idle';
                uvDragState.pointerId = null;
                uvEditorStatus.textContent = `已选择 ${formatUvSelectionCount(selectedUvPointIds.size, 'vertex')}`;
                renderUvEditor(currentTextureSlotState);
                event.preventDefault();
                return;
            } else if (!selectedUvPointIds.has(nearestPointId)) {
                runUvSelectionEdit('UV 选择', () => {
                    setSelectedUvPoints([nearestPointId]);
                });
            }

            uvDragState.mode = 'move-selection';
            uvEditorCanvas.setPointerCapture(event.pointerId);
            uvDragState.startSelection = getSelectedPointSnapshot();
            uvEditorFrame.classList.add('is-offset-drag');
            uvEditorStatus.textContent = `正在拖动 ${formatUvSelectionCount(selectedUvPointIds.size, 'vertex')}…`;
            renderUvEditor(currentTextureSlotState);
            event.preventDefault();
            return;
        }

        if (nearestEdge) {
            if (subtractive) {
                runUvSelectionEdit('UV 选择', () => {
                    selectedUvEdgeIds.delete(nearestEdge.id);
                    syncUvDerivedPointSelection();
                });
                uvDragState.mode = 'idle';
                uvDragState.pointerId = null;
                uvEditorStatus.textContent = `已选择 ${formatUvSelectionCount(selectedUvEdgeIds.size, 'edge')}`;
                renderUvEditor(currentTextureSlotState);
                event.preventDefault();
                return;
            }

            if (additive) {
                runUvSelectionEdit('UV 选择', () => {
                    toggleUvEdgeSelection(nearestEdge.id);
                });
                uvDragState.mode = 'idle';
                uvDragState.pointerId = null;
                uvEditorStatus.textContent = `已选择 ${formatUvSelectionCount(selectedUvEdgeIds.size, 'edge')}`;
                renderUvEditor(currentTextureSlotState);
                event.preventDefault();
                return;
            }
            else if (!selectedUvEdgeIds.has(nearestEdge.id)) {
                runUvSelectionEdit('UV 选择', () => {
                    setSelectedUvEdges([nearestEdge.id]);
                });
            }

            uvDragState.mode = 'move-selection';
            uvEditorCanvas.setPointerCapture(event.pointerId);
            uvDragState.startSelection = getSelectedPointSnapshot();
            uvEditorFrame.classList.add('is-offset-drag');
            uvEditorStatus.textContent = `正在拖动 ${formatUvSelectionCount(selectedUvEdgeIds.size, 'edge')}，影响 ${selectedUvPointIds.size} 个 UV 点…`;
            renderUvEditor(currentTextureSlotState);
            event.preventDefault();
            return;
        }

        if (hitFaceId !== null) {
            if (subtractive) {
                runUvSelectionEdit('UV 选择', () => {
                    selectedUvFaceIds.delete(hitFaceId);
                    syncUvDerivedPointSelection();
                });
                uvDragState.mode = 'idle';
                uvDragState.pointerId = null;
                uvEditorStatus.textContent = `已选择 ${formatUvSelectionCount(selectedUvFaceIds.size, 'face')}`;
                renderUvEditor(currentTextureSlotState);
                event.preventDefault();
                return;
            }

            if (additive) {
                runUvSelectionEdit('UV 选择', () => {
                    toggleUvFaceSelection(hitFaceId);
                });
                uvDragState.mode = 'idle';
                uvDragState.pointerId = null;
                uvEditorStatus.textContent = `已选择 ${formatUvSelectionCount(selectedUvFaceIds.size, 'face')}`;
                renderUvEditor(currentTextureSlotState);
                event.preventDefault();
                return;
            } else if (!selectedUvFaceIds.has(hitFaceId)) {
                runUvSelectionEdit('UV 选择', () => {
                    setSelectedUvFaces([hitFaceId]);
                });
            }

            uvDragState.mode = 'move-selection';
            uvEditorCanvas.setPointerCapture(event.pointerId);
            uvDragState.startSelection = getSelectedPointSnapshot();
            uvEditorFrame.classList.add('is-offset-drag');
            uvEditorStatus.textContent = `正在拖动 ${formatUvSelectionCount(selectedUvFaceIds.size, 'face')}，影响 ${selectedUvPointIds.size} 个 UV 点…`;
            renderUvEditor(currentTextureSlotState);
            event.preventDefault();
            return;
        }

        uvDragState.mode = 'box-select';
        uvEditorCanvas.setPointerCapture(event.pointerId);
        uvEditorFrame.classList.add('is-box-selecting');
        updateUvBoxPreview();
        uvEditorStatus.textContent = `正在框选 ${getUvSelectionModeLabel()}…`;
        renderUvEditor(currentTextureSlotState);
        event.preventDefault();
    });

    uvEditorCanvas.addEventListener('pointermove', (event) => {
        if (uvDragState.pointerId !== event.pointerId || uvDragState.mode === 'idle' || !currentTextureSlotState) {
            return;
        }

        const dx = event.clientX - uvDragState.startClientX;
        const dy = event.clientY - uvDragState.startClientY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) uvDragState.moved = true;

        if (uvDragState.mode === 'pan') {
            const axisScale = getUvAxisScale();
            uvView.centerX = uvDragState.startCenterX - dx / axisScale.x;
            uvView.centerY = uvDragState.startCenterY + dy / axisScale.y;
            renderUvEditor(currentTextureSlotState);
            return;
        }

        const rect = uvEditorCanvas.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;

        if (uvDragState.mode === 'box-select') {
            uvDragState.boxCurrentX = localX;
            uvDragState.boxCurrentY = localY;
            updateUvBoxPreview();
            uvEditorStatus.textContent = describeUvBoxPreview();
            renderUvEditor(currentTextureSlotState);
            return;
        }

        const currentUv = screenToUv(localX, localY, getUvScreenTransform());

        if (uvDragState.mode === 'rotate-selection') {
            const angle = Math.atan2(
                currentUv.y - uvDragState.transformPivotY,
                currentUv.x - uvDragState.transformPivotX,
            );
            const deltaAngle = angle - uvDragState.transformStartAngle;
            applyUvTransformToSelection({
                rotateDeg: (deltaAngle * 180) / Math.PI,
                snap: true,
            });
            return;
        }

        if (uvDragState.mode === 'scale-selection') {
            const startVectorX = uvDragState.startUvX - uvDragState.transformPivotX;
            const startVectorY = uvDragState.startUvY - uvDragState.transformPivotY;
            const currentVectorX = currentUv.x - uvDragState.transformPivotX;
            const currentVectorY = currentUv.y - uvDragState.transformPivotY;
            const scaleX = Math.abs(startVectorX) > 1e-6 ? currentVectorX / startVectorX : 1;
            const scaleY = Math.abs(startVectorY) > 1e-6 ? currentVectorY / startVectorY : 1;
            applyUvTransformToSelection({
                scaleX: clampScaleFactor(scaleX),
                scaleY: clampScaleFactor(scaleY),
                snap: true,
            });
            return;
        }

        const deltaX = currentUv.x - uvDragState.startUvX;
        const deltaY = currentUv.y - uvDragState.startUvY;
        applyUvPointUpdates(
            uvDragState.startSelection.map((point) => ({
                pointId: point.pointId,
                x: point.x + deltaX,
                y: point.y + deltaY,
            })),
            { snap: true },
        );
    });

    const stopDrag = (event: PointerEvent) => {
        if (uvDragState.pointerId !== event.pointerId) return;
        finishActiveUvInteraction({ commit: true });
    };

    uvEditorCanvas.addEventListener('pointerup', stopDrag);
    uvEditorCanvas.addEventListener('pointercancel', stopDrag);
    uvEditorCanvas.addEventListener('lostpointercapture', stopDrag);
    window.addEventListener('blur', () => {
        finishActiveUvInteraction({ commit: true });
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) finishActiveUvInteraction({ commit: true });
    });
    uvEditorCanvas.addEventListener('dblclick', () => {
        resetUvView();
        renderUvEditor(currentTextureSlotState);
    });
}

function finishActiveUvInteraction(options: { commit: boolean }): void {
    if (uvDragState.mode === 'idle') return;

    const completedMode = uvDragState.mode;
    const completedSelection = uvDragState.startSelection.map((point) => ({ ...point }));
    const shouldRecordUvUndo = options.commit
        && uvDragState.moved
        && (completedMode === 'move-selection'
            || completedMode === 'scale-selection'
            || completedMode === 'rotate-selection');

    if (options.commit && completedMode === 'box-select') {
        runUvSelectionEdit('UV 选择', () => {
            commitUvBoxSelection();
            if (!uvDragState.moved && !uvDragState.additive && !uvDragState.subtractive) {
                clearUvSelection();
            }
        });
    }

    if (shouldRecordUvUndo) {
        pushUvUndoEntry(completedSelection, getUvUndoLabelForDragMode(completedMode));
    }

    const pointerId = uvDragState.pointerId;
    uvDragState.mode = 'idle';
    uvDragState.pointerId = null;
    uvDragState.startSelection = [];
    uvDragState.transformHandle = null;

    if (pointerId !== null && uvEditorCanvas.hasPointerCapture?.(pointerId)) {
        try {
            uvEditorCanvas.releasePointerCapture(pointerId);
        } catch {
            // Pointer capture may already be released by the browser during document switches.
        }
    }

    uvEditorFrame.classList.remove('is-panning', 'is-offset-drag', 'is-box-selecting');
    clearUvPreviewSelection();
    setUvEditorIdleStatus();
    renderUvEditor(currentTextureSlotState);
}

function syncUvEditorControls(): void {
    const buttons: Array<[UvSelectionMode, HTMLButtonElement]> = [
        ['vertex', uvSelectVertex],
        ['edge', uvSelectEdge],
        ['face', uvSelectFace],
    ];

    for (const [mode, button] of buttons) {
        const active = uvSelectionMode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    }

    uvSnapEnabledInput.checked = uvSnapEnabled;
    setNumericPairValue(uvSnapStrengthRange, uvSnapStrengthInput, uvSnapStrength);
}

function setUvSelectionMode(mode: UvSelectionMode): void {
    if (uvSelectionMode === mode) return;
    runUvSelectionEdit('UV 选择模式', () => {
        uvSelectionMode = mode;
        clearUvSelection();
        clearUvPreviewSelection();
    });
    syncUvEditorControls();
    setUvEditorIdleStatus();
    renderUvEditor(currentTextureSlotState);
}

function getUvSelectionModeLabel(mode: UvSelectionMode = uvSelectionMode): string {
    if (mode === 'vertex') return '顶点';
    if (mode === 'edge') return '边';
    return '面';
}

function getUvUndoLabelForDragMode(
    mode: typeof uvDragState.mode,
): string {
    if (mode === 'scale-selection') return 'UV 缩放';
    if (mode === 'rotate-selection') return 'UV 旋转';
    return 'UV 移动';
}

function formatUvSelectionCount(count: number, mode: UvSelectionMode = uvSelectionMode): string {
    if (mode === 'vertex') return `${count} 个顶点`;
    if (mode === 'edge') return `${count} 条边`;
    return `${count} 个面`;
}

function getDefaultUvStatusText(): string {
    const snapText = uvSnapEnabled
        ? `吸附×${uvSnapStrength.toFixed(2)}`
        : '吸附关闭';
    return `${getUvSelectionModeLabel()}模式 | Shift加选 Ctrl减选 | Alt/中键平移 | 滚轮缩放 | Ctrl缩放选区 Alt旋转选区 | ${snapText}`;
}

function setUvEditorIdleStatus(): void {
    uvEditorStatus.textContent = currentTextureSlotState
        ? getDefaultUvStatusText()
        : '当前材质没有 UV 贴图';
}

function clearUvSelection(): void {
    selectedUvPointIds.clear();
    selectedUvEdgeIds.clear();
    selectedUvFaceIds.clear();
}

function clearUvPreviewSelection(): void {
    previewUvPointIds.clear();
    previewUvEdgeIds.clear();
    previewUvFaceIds.clear();
}

function resetUvEditorSelectionState(): void {
    clearUvSelection();
    clearUvPreviewSelection();
}

function runUvSelectionEdit(label: string, apply: () => void): void {
    if (!currentUvEditorState || suppressUndoRecording) {
        apply();
        return;
    }

    const before = captureUvSelectionSnapshot();
    apply();
    if (areUvSelectionSnapshotsEqual(before, captureUvSelectionSnapshot())) return;

    pushUndoEntry({
        kind: 'uv-selection',
        label,
        selection: before,
    });
}

function resetUvTexturePatternCache(): void {
    uvTexturePatternSource = null;
    uvTexturePattern = null;
    uvTexturePatternMode = 'no-repeat';
}

function rebuildUvEdgeCache(): void {
    currentUvEdges = [];
    currentUvEdgeMap.clear();
    if (!currentUvEditorState) return;

    const dedupe = new Set<string>();
    for (const triangle of currentUvEditorState.triangles) {
        addUvEdge(triangle.a, triangle.b, triangle.islandId, dedupe);
        addUvEdge(triangle.b, triangle.c, triangle.islandId, dedupe);
        addUvEdge(triangle.c, triangle.a, triangle.islandId, dedupe);
    }
}

function addUvEdge(a: number, b: number, islandId: number, dedupe: Set<string>): void {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    const edge: UvEdgeState = { id: key, a, b, islandId };
    currentUvEdges.push(edge);
    currentUvEdgeMap.set(key, edge);
}

function syncUvDerivedPointSelection(): void {
    if (!currentUvEditorState) {
        selectedUvPointIds.clear();
        return;
    }

    if (uvSelectionMode === 'vertex') {
        selectedUvEdgeIds.clear();
        selectedUvFaceIds.clear();
        for (const pointId of [...selectedUvPointIds]) {
            if (!currentUvEditorState.points[pointId]) selectedUvPointIds.delete(pointId);
        }
        return;
    }

    selectedUvPointIds.clear();

    if (uvSelectionMode === 'edge') {
        for (const edgeId of [...selectedUvEdgeIds]) {
            const edge = currentUvEdgeMap.get(edgeId);
            if (!edge) {
                selectedUvEdgeIds.delete(edgeId);
                continue;
            }
            selectedUvPointIds.add(edge.a);
            selectedUvPointIds.add(edge.b);
        }
        selectedUvFaceIds.clear();
        return;
    }

    for (const faceId of [...selectedUvFaceIds]) {
        const face = currentUvEditorState.triangles[faceId];
        if (!face) {
            selectedUvFaceIds.delete(faceId);
            continue;
        }
        selectedUvPointIds.add(face.a);
        selectedUvPointIds.add(face.b);
        selectedUvPointIds.add(face.c);
    }
    selectedUvEdgeIds.clear();
}

function syncUvPreviewPointSelection(): void {
    previewUvPointIds.clear();
    if (!currentUvEditorState) return;

    if (uvSelectionMode === 'vertex') {
        return;
    }

    if (uvSelectionMode === 'edge') {
        for (const edgeId of previewUvEdgeIds) {
            const edge = currentUvEdgeMap.get(edgeId);
            if (!edge) continue;
            previewUvPointIds.add(edge.a);
            previewUvPointIds.add(edge.b);
        }
        return;
    }

    for (const faceId of previewUvFaceIds) {
        const face = currentUvEditorState.triangles[faceId];
        if (!face) continue;
        previewUvPointIds.add(face.a);
        previewUvPointIds.add(face.b);
        previewUvPointIds.add(face.c);
    }
}

function setSelectedUvPoints(pointIds: number[]): void {
    clearUvSelection();
    pointIds.forEach((pointId) => {
        if (currentUvEditorState?.points[pointId]) selectedUvPointIds.add(pointId);
    });
}

function setSelectedUvEdges(edgeIds: string[]): void {
    clearUvSelection();
    for (const edgeId of edgeIds) {
        if (currentUvEdgeMap.has(edgeId)) selectedUvEdgeIds.add(edgeId);
    }
    syncUvDerivedPointSelection();
}

function setSelectedUvFaces(faceIds: number[]): void {
    clearUvSelection();
    for (const faceId of faceIds) {
        if (currentUvEditorState?.triangles[faceId]) selectedUvFaceIds.add(faceId);
    }
    syncUvDerivedPointSelection();
}

function toggleUvEdgeSelection(edgeId: string): void {
    if (!currentUvEdgeMap.has(edgeId)) return;
    selectedUvPointIds.clear();
    selectedUvFaceIds.clear();
    if (selectedUvEdgeIds.has(edgeId)) selectedUvEdgeIds.delete(edgeId);
    else selectedUvEdgeIds.add(edgeId);
    syncUvDerivedPointSelection();
}

function toggleUvFaceSelection(faceId: number): void {
    if (!currentUvEditorState?.triangles[faceId]) return;
    selectedUvPointIds.clear();
    selectedUvEdgeIds.clear();
    if (selectedUvFaceIds.has(faceId)) selectedUvFaceIds.delete(faceId);
    else selectedUvFaceIds.add(faceId);
    syncUvDerivedPointSelection();
}

function getSelectedUvElementCount(): number {
    if (uvSelectionMode === 'vertex') return selectedUvPointIds.size;
    if (uvSelectionMode === 'edge') return selectedUvEdgeIds.size;
    return selectedUvFaceIds.size;
}

function getPreviewUvElementCount(): number {
    if (uvSelectionMode === 'vertex') return previewUvPointIds.size;
    if (uvSelectionMode === 'edge') return previewUvEdgeIds.size;
    return previewUvFaceIds.size;
}

function describeUvBoxPreview(): string {
    const count = getPreviewUvElementCount();
    const verb = uvDragState.subtractive
        ? '框选减选预览'
        : uvDragState.additive
            ? '框选加选预览'
            : '框选预选';
    return `${verb} ${formatUvSelectionCount(count)}`;
}

function updateUvBoxPreview(): void {
    clearUvPreviewSelection();
    if (!currentUvEditorState) return;

    const transform = getUvScreenTransform();
    if (uvSelectionMode === 'vertex') {
        collectPointsInSelectionRect(transform).forEach((pointId) => previewUvPointIds.add(pointId));
        return;
    }

    if (uvSelectionMode === 'edge') {
        collectEdgesInSelectionRect(transform).forEach((edgeId) => previewUvEdgeIds.add(edgeId));
        syncUvPreviewPointSelection();
        return;
    }

    collectFacesInSelectionRect(transform).forEach((faceId) => previewUvFaceIds.add(faceId));
    syncUvPreviewPointSelection();
}

function commitUvBoxSelection(): void {
    if (uvSelectionMode === 'vertex') {
        if (uvDragState.subtractive) {
            previewUvPointIds.forEach((pointId) => selectedUvPointIds.delete(pointId));
        } else if (uvDragState.additive) {
            previewUvPointIds.forEach((pointId) => selectedUvPointIds.add(pointId));
        } else {
            setSelectedUvPoints([...previewUvPointIds]);
        }
        selectedUvEdgeIds.clear();
        selectedUvFaceIds.clear();
        return;
    }

    if (uvSelectionMode === 'edge') {
        if (uvDragState.subtractive) {
            previewUvEdgeIds.forEach((edgeId) => selectedUvEdgeIds.delete(edgeId));
        } else if (uvDragState.additive) {
            previewUvEdgeIds.forEach((edgeId) => selectedUvEdgeIds.add(edgeId));
        } else {
            setSelectedUvEdges([...previewUvEdgeIds]);
            return;
        }
        syncUvDerivedPointSelection();
        return;
    }

    if (uvDragState.subtractive) {
        previewUvFaceIds.forEach((faceId) => selectedUvFaceIds.delete(faceId));
    } else if (uvDragState.additive) {
        previewUvFaceIds.forEach((faceId) => selectedUvFaceIds.add(faceId));
    } else {
        setSelectedUvFaces([...previewUvFaceIds]);
        return;
    }
    syncUvDerivedPointSelection();
}

function createSampleDocument(): DocumentSession {
    return {
        id: `doc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        name: '内置示例',
        root: createSampleModel(),
        kind: 'sample',
        dirty: false,
        undoStack: [],
        redoStack: [],
    };
}

function getActiveDocument(): DocumentSession | null {
    return documents.find((item) => item.id === activeDocumentId) ?? null;
}

function scheduleMaterialEdit(edit: Partial<typeof pendingMaterialEdit>): void {
    Object.assign(pendingMaterialEdit, edit);
    if (materialEditFrame) return;
    materialEditFrame = window.requestAnimationFrame(() => {
        materialEditFrame = 0;
        flushPendingMaterialFrame();
    });
}

function flushPendingMaterialFrame(): void {
    if (materialEditFrame) {
        window.cancelAnimationFrame(materialEditFrame);
        materialEditFrame = 0;
    }

    const { opacity, roughness, metalness, color } = pendingMaterialEdit;
    if (
        opacity === undefined
        && roughness === undefined
        && metalness === undefined
        && color === undefined
    ) {
        return;
    }

    pendingMaterialEdit.opacity = undefined;
    pendingMaterialEdit.roughness = undefined;
    pendingMaterialEdit.metalness = undefined;
    pendingMaterialEdit.color = undefined;

    if (opacity !== undefined) viewer.setModelOpacity(opacity);
    if (roughness !== undefined) viewer.setMaterialRoughness(roughness);
    if (metalness !== undefined) viewer.setMaterialMetalness(metalness);
    if (color !== undefined) viewer.setModelColor(color);
    syncMaterialControls();
}

function resetUndoDrafts(): void {
    flushPendingMaterialFrame();
    materialUndoDraft.snapshot = null;
    materialUndoDraft.label = '';
    textureUndoDraft.snapshot = null;
    textureUndoDraft.label = '';
    if (uvWheelUndoDraft.timer) {
        window.clearTimeout(uvWheelUndoDraft.timer);
        uvWheelUndoDraft.timer = 0;
    }
    uvWheelUndoDraft.snapshot = null;
    uvWheelUndoDraft.selection = null;
    uvWheelUndoDraft.label = '';
    animationPoseUndoDraft.snapshot = null;
    animationPoseUndoDraft.animationSnapshot = null;
    animationPoseUndoDraft.label = '';
    refreshButtons();
}

function pushUndoEntry(entry: UndoEntry): void {
    if (suppressUndoRecording) return;
    const active = getActiveDocument();
    if (!active) return;
    active.dirty = true;
    active.undoStack.push(entry);
    active.redoStack = [];
    if (active.undoStack.length > MAX_UNDO_STEPS) {
        active.undoStack.splice(0, active.undoStack.length - MAX_UNDO_STEPS);
    }
    syncDocumentState();
    refreshButtons();
}

function pushRedoEntry(entry: UndoEntry): void {
    const active = getActiveDocument();
    if (!active) return;
    active.redoStack.push(entry);
    if (active.redoStack.length > MAX_UNDO_STEPS) {
        active.redoStack.splice(0, active.redoStack.length - MAX_UNDO_STEPS);
    }
    refreshButtons();
}

function pushUndoEntryWithoutClearingRedo(entry: UndoEntry): void {
    const active = getActiveDocument();
    if (!active) return;
    active.undoStack.push(entry);
    if (active.undoStack.length > MAX_UNDO_STEPS) {
        active.undoStack.splice(0, active.undoStack.length - MAX_UNDO_STEPS);
    }
    refreshButtons();
}

function markActiveDocumentDirty(): void {
    const active = getActiveDocument();
    if (!active) return;
    active.dirty = true;
    syncDocumentState();
    refreshButtons();
}

function flushPendingUndoTransactions(): void {
    commitMaterialUndoTransaction();
    commitTextureUndoTransaction();
    commitUvWheelUndoTransaction();
    commitBonePoseUndoTransaction();
    refreshButtons();
}

function beginMaterialUndoTransaction(label: string): void {
    if (suppressUndoRecording || materialUndoDraft.snapshot) return;
    materialUndoDraft.snapshot = viewer.getMaterialEditSnapshot();
    materialUndoDraft.label = label;
    refreshButtons();
}

function commitMaterialUndoTransaction(): void {
    flushPendingMaterialFrame();
    if (!materialUndoDraft.snapshot) return;
    commitMaterialUndo(materialUndoDraft.snapshot, materialUndoDraft.label);
    materialUndoDraft.snapshot = null;
    materialUndoDraft.label = '';
    refreshButtons();
}

function commitMaterialUndo(snapshot: MaterialEditSnapshot | null, label: string): void {
    if (!snapshot) return;
    const current = viewer.getMaterialEditSnapshot();
    if (!current || areMaterialSnapshotsEqual(snapshot, current)) return;
    pushUndoEntry({
        kind: 'material',
        label,
        snapshot,
    });
}

function runMaterialEdit(label: string, apply: () => void): void {
    flushPendingMaterialFrame();
    const snapshot = viewer.getMaterialEditSnapshot();
    apply();
    commitMaterialUndo(snapshot, label);
}

function beginTextureUndoTransaction(label: string): void {
    if (suppressUndoRecording || textureUndoDraft.snapshot || !selectedTextureSlot) return;
    textureUndoDraft.snapshot = captureTextureTransformSnapshot(selectedTextureSlot);
    textureUndoDraft.label = label;
    refreshButtons();
}

function commitTextureUndoTransaction(): void {
    if (!textureUndoDraft.snapshot) return;
    commitTextureUndo(textureUndoDraft.snapshot, textureUndoDraft.label);
    textureUndoDraft.snapshot = null;
    textureUndoDraft.label = '';
    refreshButtons();
}

function commitTextureUndo(snapshot: TextureTransformSnapshot | null, label: string): void {
    if (!snapshot) return;
    const current = captureTextureTransformSnapshot(snapshot.slot);
    if (!current || areTextureTransformSnapshotsEqual(snapshot, current)) return;
    pushUndoEntry({
        kind: 'texture',
        label,
        snapshot,
    });
}

function runTextureEdit(label: string, apply: () => void): void {
    const snapshot = selectedTextureSlot
        ? captureTextureTransformSnapshot(selectedTextureSlot)
        : null;
    apply();
    commitTextureUndo(snapshot, label);
}

function runAnimationEdit(label: string, apply: () => void): void {
    const snapshot = viewer.captureAnimationSnapshot();
    apply();
    const current = viewer.captureAnimationSnapshot();
    if (snapshot && current && !areAnimationSnapshotsEqual(snapshot, current)) {
        pushUndoEntry({
            kind: 'animation',
            label,
            snapshot,
        });
    } else if (!snapshot && current) {
        markActiveDocumentDirty();
    }
    refreshAnimationBar(viewer.getAnimationState());
    syncAnimationEditor();
}

function runAnimationLibraryEdit(label: string, apply: () => void): void {
    const snapshot = viewer.captureAnimationLibrarySnapshot();
    apply();
    const current = viewer.captureAnimationLibrarySnapshot();
    if (!areAnimationLibrarySnapshotsEqual(snapshot, current)) {
        pushUndoEntry({
            kind: 'animation-library',
            label,
            snapshot,
        });
    }
    refreshAnimationBar(viewer.getAnimationState());
    syncAnimationEditor();
}

function beginBonePoseUndoTransaction(): void {
    if (suppressUndoRecording || animationPoseUndoDraft.snapshot) return;
    const snapshot = viewer.captureBonePoseSnapshot();
    if (!snapshot) return;
    animationPoseUndoDraft.snapshot = snapshot;
    animationPoseUndoDraft.animationSnapshot = viewer.captureAnimationSnapshot();
    animationPoseUndoDraft.label = getBonePoseEditLabel();
    refreshButtons();
}

function commitBonePoseUndoTransaction(): void {
    if (!animationPoseUndoDraft.snapshot) return;
    const label = animationPoseUndoDraft.label || '骨骼姿态';
    const animationSnapshot = animationPoseUndoDraft.animationSnapshot;
    const currentAnimation = viewer.captureAnimationSnapshot();
    let committedAnimationUndo = false;
    if (animationSnapshot && currentAnimation && !areAnimationSnapshotsEqual(animationSnapshot, currentAnimation)) {
        pushUndoEntry({
            kind: 'animation',
            label,
            snapshot: animationSnapshot,
        });
        committedAnimationUndo = true;
    } else if (!animationSnapshot && currentAnimation) {
        markActiveDocumentDirty();
    }
    if (!committedAnimationUndo) {
        commitBonePoseUndo(animationPoseUndoDraft.snapshot, label);
    }
    animationPoseUndoDraft.snapshot = null;
    animationPoseUndoDraft.animationSnapshot = null;
    animationPoseUndoDraft.label = '';
    refreshButtons();
}

function commitBonePoseUndo(snapshot: BonePoseSnapshot | null, label: string): void {
    if (!snapshot) return;
    const current = viewer.captureBonePoseSnapshot();
    if (!current || areBonePoseSnapshotsEqual(snapshot, current)) return;
    pushUndoEntry({
        kind: 'bone-pose',
        label,
        snapshot,
    });
}

function getBonePoseEditLabel(): string {
    const state = viewer.getSkeletonEditorState({ includeKeyframes: false });
    const action = state.ikEnabled
        ? 'IK 调整'
        : state.transformMode === 'translate'
            ? '骨骼移动'
            : '骨骼旋转';
    return state.selectedBoneName ? `${action} · ${state.selectedBoneName}` : action;
}

function pushUvUndoEntry(
    snapshot: UvPointSnapshot[],
    label: string,
    selection = captureUvSelectionSnapshot(),
): void {
    if (suppressUndoRecording || snapshot.length === 0) return;
    const current = snapshotCurrentUvPoints(snapshot);
    if (current.length === 0 || areUvSnapshotsEqual(snapshot, current)) return;
    pushUndoEntry({
        kind: 'uv',
        label,
        snapshot,
        selection,
    });
}

function beginUvWheelUndoTransaction(label: string): void {
    if (suppressUndoRecording) return;
    if (!uvWheelUndoDraft.snapshot) {
        uvWheelUndoDraft.snapshot = getSelectedPointSnapshot();
        uvWheelUndoDraft.selection = captureUvSelectionSnapshot();
    }
    uvWheelUndoDraft.label = label;
    if (uvWheelUndoDraft.timer) window.clearTimeout(uvWheelUndoDraft.timer);
    uvWheelUndoDraft.timer = window.setTimeout(() => {
        commitUvWheelUndoTransaction();
    }, 260);
    refreshButtons();
}

function commitUvWheelUndoTransaction(): void {
    if (uvWheelUndoDraft.timer) {
        window.clearTimeout(uvWheelUndoDraft.timer);
        uvWheelUndoDraft.timer = 0;
    }
    if (!uvWheelUndoDraft.snapshot) return;
    pushUvUndoEntry(
        uvWheelUndoDraft.snapshot,
        uvWheelUndoDraft.label || 'UV 编辑',
        uvWheelUndoDraft.selection ?? captureUvSelectionSnapshot(),
    );
    uvWheelUndoDraft.snapshot = null;
    uvWheelUndoDraft.selection = null;
    uvWheelUndoDraft.label = '';
    refreshButtons();
}

function undoLastEdit(): void {
    flushPendingUndoTransactions();
    const active = getActiveDocument();
    if (!active || active.undoStack.length === 0) {
        showToast('没有可撤回的编辑', 'info');
        refreshButtons();
        return;
    }

    const entry = active.undoStack.pop()!;
    resetUndoDrafts();
    const redoEntry = captureCurrentUndoEntry(entry);

    suppressUndoRecording = true;
    try {
        applyUndoEntry(entry);
    } finally {
        suppressUndoRecording = false;
    }

    if (redoEntry) pushRedoEntry(redoEntry);
    active.dirty = true;
    syncDocumentState();
    refreshButtons();
    showToast(`已撤回${entry.label}`, 'success');
}

function redoLastEdit(): void {
    flushPendingUndoTransactions();
    const active = getActiveDocument();
    if (!active || active.redoStack.length === 0) {
        showToast('没有可重做的编辑', 'info');
        refreshButtons();
        return;
    }

    const entry = active.redoStack.pop()!;
    resetUndoDrafts();
    const undoEntry = captureCurrentUndoEntry(entry);

    suppressUndoRecording = true;
    try {
        applyUndoEntry(entry);
    } finally {
        suppressUndoRecording = false;
    }

    if (undoEntry) pushUndoEntryWithoutClearingRedo(undoEntry);
    active.dirty = true;
    syncDocumentState();
    refreshButtons();
    showToast(`已重做${entry.label}`, 'success');
}

function captureCurrentUndoEntry(template: UndoEntry): UndoEntry | null {
    if (template.kind === 'material') {
        const snapshot = viewer.getMaterialEditSnapshot();
        return snapshot ? { kind: 'material', label: template.label, snapshot } : null;
    }

    if (template.kind === 'texture') {
        const snapshot = captureTextureTransformSnapshot(template.snapshot.slot);
        return snapshot ? { kind: 'texture', label: template.label, snapshot } : null;
    }

    if (template.kind === 'uv-selection') {
        return {
            kind: 'uv-selection',
            label: template.label,
            selection: captureUvSelectionSnapshot(),
        };
    }

    if (template.kind === 'animation') {
        const snapshot = viewer.captureAnimationSnapshot();
        return snapshot ? { kind: 'animation', label: template.label, snapshot } : null;
    }

    if (template.kind === 'animation-library') {
        return {
            kind: 'animation-library',
            label: template.label,
            snapshot: viewer.captureAnimationLibrarySnapshot(),
        };
    }

    if (template.kind === 'bone-pose') {
        const snapshot = viewer.captureBonePoseSnapshot();
        return snapshot ? { kind: 'bone-pose', label: template.label, snapshot } : null;
    }

    const snapshot = snapshotCurrentUvPoints(template.snapshot);
    if (snapshot.length === 0) return null;
    return {
        kind: 'uv',
        label: template.label,
        snapshot,
        selection: captureUvSelectionSnapshot(),
    };
}

function applyUndoEntry(entry: UndoEntry): void {
    if (entry.kind === 'material') {
        viewer.setMaterialEditSnapshot(entry.snapshot);
        syncMaterialControls();
        return;
    }

    if (entry.kind === 'texture') {
        selectedTextureSlot = entry.snapshot.slot;
        viewer.setTextureTransform(entry.snapshot.slot, entry.snapshot.transform);
        refreshActiveTextureState();
        return;
    }

    if (entry.kind === 'uv-selection') {
        restoreUvSelection(entry.selection);
        clearUvPreviewSelection();
        setUvEditorIdleStatus();
        renderUvEditor(currentTextureSlotState);
        return;
    }

    if (entry.kind === 'animation') {
        viewer.restoreAnimationSnapshot(entry.snapshot);
        refreshAnimationBar(viewer.getAnimationState());
        syncAnimationEditor();
        return;
    }

    if (entry.kind === 'animation-library') {
        viewer.restoreAnimationLibrarySnapshot(entry.snapshot);
        selectedKeyframeTimes = [];
        refreshAnimationBar(viewer.getAnimationState());
        syncAnimationEditor();
        return;
    }

    if (entry.kind === 'bone-pose') {
        viewer.restoreBonePoseSnapshot(entry.snapshot);
        syncAnimationEditor();
        return;
    }

    applyUvSnapshot(entry.snapshot, entry.selection);
}

function captureTextureTransformSnapshot(slot: TextureSlotId): TextureTransformSnapshot | null {
    const state = viewer.getTextureState();
    const current = state.slots.find((item) => item.slot === slot);
    if (!current) return null;
    return {
        slot,
        transform: {
            offsetX: current.offsetX,
            offsetY: current.offsetY,
            repeatX: current.repeatX,
            repeatY: current.repeatY,
            rotation: current.rotation,
        },
    };
}

function snapshotCurrentUvPoints(snapshot: UvPointSnapshot[]): UvPointSnapshot[] {
    if (!currentUvEditorState) return [];
    return snapshot
        .map((point) => currentUvEditorState?.points[point.pointId])
        .filter((point): point is NonNullable<typeof point> => Boolean(point))
        .map((point) => ({
            pointId: point.id,
            x: point.x,
            y: point.y,
        }));
}

function captureUvSelectionSnapshot(): UvSelectionSnapshot {
    return {
        mode: uvSelectionMode,
        pointIds: [...selectedUvPointIds],
        edgeIds: [...selectedUvEdgeIds],
        faceIds: [...selectedUvFaceIds],
    };
}

function restoreUvSelection(snapshot: UvSelectionSnapshot): void {
    uvSelectionMode = snapshot.mode;
    syncUvEditorControls();
    if (snapshot.mode === 'vertex') {
        setSelectedUvPoints(snapshot.pointIds);
        return;
    }
    if (snapshot.mode === 'edge') {
        setSelectedUvEdges(snapshot.edgeIds);
        return;
    }
    setSelectedUvFaces(snapshot.faceIds);
}

function applyUvSnapshot(
    snapshot: UvPointSnapshot[],
    selection: UvSelectionSnapshot,
): void {
    if (snapshot.length === 0) return;
    viewer.setUvPointPositions(snapshot);
    currentUvEditorState = viewer.getUvEditorState();
    rebuildUvEdgeCache();
    restoreUvSelection(selection);
    clearUvPreviewSelection();
    setUvEditorIdleStatus();
    renderUvEditor(currentTextureSlotState);
}

function areMaterialSnapshotsEqual(a: MaterialEditSnapshot, b: MaterialEditSnapshot): boolean {
    return a.mode === b.mode
        && a.visible === b.visible
        && nearlyEqual(a.opacity, b.opacity)
        && a.color === b.color
        && a.flatShading === b.flatShading
        && a.doubleSided === b.doubleSided
        && nearlyEqual(a.roughness, b.roughness)
        && nearlyEqual(a.metalness, b.metalness)
        && a.colorOverride === b.colorOverride
        && a.flatOverride === b.flatOverride
        && a.doubleSidedOverride === b.doubleSidedOverride
        && a.roughnessOverride === b.roughnessOverride
        && a.metalnessOverride === b.metalnessOverride
        && areTextureTransformMapsEqual(a.textureTransforms, b.textureTransforms);
}

function areTextureTransformMapsEqual(
    a: Partial<Record<TextureSlotId, TextureTransform>>,
    b: Partial<Record<TextureSlotId, TextureTransform>>,
): boolean {
    const slots = new Set<TextureSlotId>([
        ...Object.keys(a),
        ...Object.keys(b),
    ] as TextureSlotId[]);

    for (const slot of slots) {
        if (!areTextureTransformsEqual(a[slot], b[slot])) return false;
    }
    return true;
}

function areTextureTransformSnapshotsEqual(
    a: TextureTransformSnapshot,
    b: TextureTransformSnapshot,
): boolean {
    return a.slot === b.slot && areTextureTransformsEqual(a.transform, b.transform);
}

function areAnimationSnapshotsEqual(a: AnimationClipSnapshot, b: AnimationClipSnapshot): boolean {
    if (a.clipIndex !== b.clipIndex) return false;
    if (a.clipName !== b.clipName) return false;
    if (!nearlyEqual(a.duration, b.duration)) return false;
    if (!areLazyAnimationSourcesEqual(a.lazy, b.lazy)) return false;
    if (a.tracks.length !== b.tracks.length) return false;

    for (let index = 0; index < a.tracks.length; index += 1) {
        const first = a.tracks[index];
        const second = b.tracks[index];
        if (!second) return false;
        if (first.index !== second.index || first.name !== second.name) return false;
        if (!areNumberArraysNearlyEqual(first.times, second.times)) return false;
        if (!areNumberArraysNearlyEqual(first.values, second.values)) return false;
    }

    return true;
}

function areLazyAnimationSourcesEqual(
    a: AnimationClipSnapshot['lazy'],
    b: AnimationClipSnapshot['lazy'],
): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.type === b.type
        && a.path === b.path
        && a.index === b.index
        && a.name === b.name
        && nearlyEqual(a.duration, b.duration)
        && a.tracks === b.tracks;
}

function areAnimationLibrarySnapshotsEqual(a: AnimationLibrarySnapshot, b: AnimationLibrarySnapshot): boolean {
    if (a.activeIndex !== b.activeIndex) return false;
    if (a.clips.length !== b.clips.length) return false;
    return a.clips.every((clip, index) => areAnimationSnapshotsEqual(clip, b.clips[index]));
}

function areBonePoseSnapshotsEqual(a: BonePoseSnapshot, b: BonePoseSnapshot): boolean {
    if (a.selectedBoneIndex !== b.selectedBoneIndex) return false;
    if (a.ikEnabled !== b.ikEnabled) return false;
    if (a.transformMode !== b.transformMode) return false;
    if (a.transformSpace !== b.transformSpace) return false;
    if (!areNullableNumberTuplesNearlyEqual(a.ikTargetPosition, b.ikTargetPosition)) return false;
    if (a.bones.length !== b.bones.length) return false;

    for (let index = 0; index < a.bones.length; index += 1) {
        const first = a.bones[index];
        const second = b.bones[index];
        if (!second) return false;
        if (first.uuid !== second.uuid || first.index !== second.index) return false;
        if (!areNumberArraysNearlyEqual(first.position, second.position)) return false;
        if (!areNumberArraysNearlyEqual(first.quaternion, second.quaternion)) return false;
        if (!areNumberArraysNearlyEqual(first.scale, second.scale)) return false;
    }

    return true;
}

function areNullableNumberTuplesNearlyEqual(
    a: number[] | null,
    b: number[] | null,
): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return areNumberArraysNearlyEqual(a, b);
}

function areTextureTransformsEqual(
    a: TextureTransform | undefined,
    b: TextureTransform | undefined,
): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return nearlyEqual(a.offsetX, b.offsetX)
        && nearlyEqual(a.offsetY, b.offsetY)
        && nearlyEqual(a.repeatX, b.repeatX)
        && nearlyEqual(a.repeatY, b.repeatY)
        && nearlyEqual(a.rotation, b.rotation);
}

function areUvSnapshotsEqual(a: UvPointSnapshot[], b: UvPointSnapshot[]): boolean {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        const first = a[index];
        const second = b[index];
        if (!second) return false;
        if (first.pointId !== second.pointId) return false;
        if (!nearlyEqual(first.x, second.x) || !nearlyEqual(first.y, second.y)) return false;
    }
    return true;
}

function areUvSelectionSnapshotsEqual(a: UvSelectionSnapshot, b: UvSelectionSnapshot): boolean {
    return a.mode === b.mode
        && areNumberArraysEqual(a.pointIds, b.pointIds)
        && areStringArraysEqual(a.edgeIds, b.edgeIds)
        && areNumberArraysEqual(a.faceIds, b.faceIds);
}

function areNumberArraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    const values = new Set(a);
    for (const item of b) if (!values.has(item)) return false;
    return true;
}

function areNumberArraysNearlyEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (!nearlyEqual(a[index], b[index])) return false;
    }
    return true;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const values = new Set(a);
    for (const item of b) if (!values.has(item)) return false;
    return true;
}

function nearlyEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < 1e-4;
}

function renderDocumentTabs(): void {
    documentTabs.innerHTML = documents.map((document) => {
        const active = document.id === activeDocumentId;
        const closeButton = documents.length > 1
            ? `<button class="document-tab-close" type="button" data-document-id="${document.id}" aria-label="关闭 ${escapeHtml(document.name)}">×</button>`
            : '';

        return `
            <div class="document-tab${active ? ' active' : ''}">
                <button class="document-tab-main" type="button" data-document-id="${document.id}">
                    ${document.dirty ? '<span class="document-tab-dot"></span>' : ''}
                    <span class="document-tab-name">${escapeHtml(document.name)}</span>
                </button>
                ${closeButton}
            </div>
        `;
    }).join('');
}

function activateDocument(id: string, options: { fit?: boolean } = {}): void {
    const target = documents.find((item) => item.id === id);
    if (!target) return;

    finishActiveUvInteraction({ commit: true });
    flushPendingUndoTransactions();
    activeDocumentId = id;
    resetUndoDrafts();
    selectedKeyframeTimes = [];
    lastScrolledBoneIndex = -1;
    currentUvEditorState = null;
    currentUvEdges = [];
    currentUvEdgeMap.clear();
    resetUvEditorSelectionState();
    viewer.setActiveModel(target.root, { fit: options.fit ?? true });
    resetUvView();
    syncDocumentState();
    scheduleRefreshStats();
    refreshButtons();
    syncActiveInspectorControls();
}

function closeDocument(id: string): void {
    const index = documents.findIndex((item) => item.id === id);
    if (index < 0) return;

    const closing = documents[index];
    const wasActive = closing.id === activeDocumentId;
    if (wasActive) {
        finishActiveUvInteraction({ commit: true });
        flushPendingUndoTransactions();
    }

    documents.splice(index, 1);

    if (wasActive) {
        if (documents.length === 0) {
            documents = [createSampleDocument()];
        }
        const fallback = documents[Math.max(0, index - 1)] ?? documents[0];
        activeDocumentId = fallback.id;
    }

    if (wasActive) activateDocument(activeDocumentId, { fit: false });
    else {
        syncDocumentState();
        scheduleRefreshStats();
        refreshButtons();
        syncActiveInspectorControls();
    }

    if (closing.root) viewer.disposeModel(closing.root);
}

function clearActiveDocument(): void {
    const active = getActiveDocument();
    if (!active) return;
    finishActiveUvInteraction({ commit: false });
    flushPendingUndoTransactions();

    const rootToDispose = active.root;
    active.root = createSampleModel();
    active.kind = 'sample';
    active.name = '内置示例';
    active.sourcePath = undefined;
    active.dirty = false;
    active.undoStack = [];
    active.redoStack = [];

    resetUndoDrafts();
    selectedKeyframeTimes = [];
    lastScrolledBoneIndex = -1;
    currentUvEditorState = null;
    currentUvEdges = [];
    currentUvEdgeMap.clear();
    resetUvEditorSelectionState();
    viewer.setActiveModel(active.root, { fit: true });
    viewer.disposeModel(rootToDispose);
    syncDocumentState();
    scheduleRefreshStats();
    refreshButtons();
    syncActiveInspectorControls();
    showToast('已恢复内置示例', 'success');
}

async function loadFiles(files: File[]): Promise<void> {
    const supported = files.filter((file) => isSupported(file.name));
    if (supported.length === 0) {
        showToast(`不支持的格式，请使用 ${ACCEPT_EXTS.join(' / ').toUpperCase()}`, 'error');
        return;
    }

    const mainFile = supported[0];
    showLoading(`正在加载 ${mainFile.name} …`);

    try {
        const model = await loadFromFiles(files);
        const sourcePath = typeof (mainFile as File & { path?: unknown }).path === 'string'
            ? (mainFile as File & { path: string }).path
            : undefined;
        openDocumentWithModel(mainFile.name, model, sourcePath);
        showModelLoadNotice(model);
        showToast(`已加载 ${mainFile.name}`, 'success');
    } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : String(error);
        showToast(`加载失败: ${message}`, 'error');
    } finally {
        hideLoading();
    }
}

async function loadNativePaths(paths: string[]): Promise<void> {
    const supported = [...new Set(paths)].filter((path) => isSupported(path));
    if (supported.length === 0) {
        showToast(`不支持的格式，请使用 ${ACCEPT_EXTS.join(' / ').toUpperCase()}`, 'error');
        return;
    }

    let loadedCount = 0;
    let lastLoadedName = '';

    for (const path of supported) {
        const name = fileNameOfPath(path);
        showLoading(`正在加载 ${name} …`);
        try {
            const model = await loadFromPath(path);
            openDocumentWithModel(name, model, path);
            showModelLoadNotice(model);
            loadedCount += 1;
            lastLoadedName = name;
        } catch (error) {
            console.error(error);
            const message = error instanceof Error ? error.message : String(error);
            showToast(`加载失败: ${message}`, 'error');
        } finally {
            hideLoading();
        }
    }

    if (loadedCount > 0) {
        showToast(loadedCount === 1 ? `已加载 ${lastLoadedName}` : `已加载 ${loadedCount} 个模型`, 'success');
    }
}

function enqueueNativePathLoad(paths: string[]): Promise<void> {
    nativeOpenQueue = nativeOpenQueue
        .catch(() => undefined)
        .then(() => loadNativePaths(paths));
    return nativeOpenQueue.catch((error) => {
        console.error(error);
    });
}

function showModelLoadNotice(model: Object3D): void {
    const notice = model.userData?.__meshscopeLoadNotice as {
        type?: string;
        originalBytes?: number;
        previewBytes?: number;
        animationsRemoved?: number;
        animationsAvailable?: number;
    } | undefined;
    if (notice?.type !== 'large-glb-preview') return;
    showToast(
        `超大 GLB 已快速预览：${formatBytes(notice.originalBytes ?? 0)} -> ${formatBytes(notice.previewBytes ?? 0)}，${notice.animationsAvailable ?? 0} 个动画将按需载入`,
        'info',
    );
}

async function handleOpenUrls(urls: string[]): Promise<void> {
    const paths = extractModelPathsFromUrls(urls);
    if (paths.length > 0) {
        await enqueueNativePathLoad(paths);
        return;
    }

    const count = new Set(urls).size;
    if (count > 0) showToast(`已接收 ${count} 个应用链接`, 'info');
}

function canSaveActiveDocument(): boolean {
    const active = getActiveDocument();
    return Boolean(
        inNative
        && active
        && active.kind === 'model'
        && active.sourcePath
        && isDirectSavePath(active.sourcePath),
    );
}

async function saveActiveDocumentWithChoice(options: { forceSaveAs: boolean }): Promise<void> {
    const active = getActiveDocument();
    if (!active) return;

    const choice = chooseSaveChoice(options.forceSaveAs);
    if (!choice) return;
    await saveActiveDocument(choice);
}

function chooseSaveChoice(forceSaveAs: boolean): SaveChoice | null {
    const canOverwrite = !forceSaveAs && canSaveActiveDocument();
    const animationState = viewer.getAnimationState();
    const hasCurrentAnimation = animationState.hasAnimations && animationState.activeIndex >= 0;
    const choices: Array<{ key: string; label: string; choice: SaveChoice }> = [];

    if (canOverwrite) {
        choices.push({
            key: String(choices.length + 1),
            label: '覆盖原文件（模型 + 全部动画）',
            choice: { destination: 'overwrite', animationScope: 'all' },
        });
    }

    if (hasCurrentAnimation) {
        choices.push({
            key: String(choices.length + 1),
            label: '另存新 GLB（模型 + 当前动画）',
            choice: { destination: 'save-as', animationScope: 'current' },
        });
    }

    choices.push({
        key: String(choices.length + 1),
        label: '另存新文件（模型 + 全部动画）',
        choice: { destination: 'save-as', animationScope: 'all' },
    });

    if (choices.length === 1) return choices[0].choice;

    const answer = window.prompt(
        `选择保存方式：\n${choices.map((item) => `${item.key}. ${item.label}`).join('\n')}\n\n输入编号确认。`,
        choices[0].key,
    );
    if (answer === null) return null;

    const selected = choices.find((item) => item.key === answer.trim());
    if (!selected) {
        showToast('保存已取消：没有匹配的编号', 'info');
        return null;
    }
    return selected.choice;
}

async function saveActiveDocument(choice: SaveChoice): Promise<void> {
    const active = getActiveDocument();
    if (!active) return;

    finishActiveUvInteraction({ commit: true });
    flushPendingUndoTransactions();

    const directPath = choice.destination === 'overwrite' && canSaveActiveDocument() ? active.sourcePath : undefined;
    let targetPath = directPath;
    let downloadName = defaultExportName(active.name, choice.animationScope);

    if (!targetPath) {
        if (inNative) {
            const filters = choice.animationScope === 'current'
                ? [{ name: 'glTF 二进制', extensions: ['glb'] }]
                : [
                    { name: 'glTF 二进制', extensions: ['glb'] },
                    { name: 'glTF JSON', extensions: ['gltf'] },
                ];
            const selection = await dialog.saveFile({
                filters,
                defaultName: downloadName,
            }).catch(() => null);
            if (!selection) return;
            targetPath = ensureExportExtension(selection, choice.animationScope);
        } else {
            targetPath = downloadName;
        }
    }

    const binary = choice.animationScope === 'current' || extOf(targetPath) !== 'gltf';
    const actionLabel = choice.animationScope === 'current' ? '导出当前动画' : '保存';
    const prepared = await ensureAnimationsLoadedForExport(choice.animationScope);
    if (!prepared) return;
    showLoading(`正在${actionLabel} ${fileNameOfPath(targetPath)} …`);

    try {
        const exported = await exportActiveDocument(active, {
            binary,
            animationScope: choice.animationScope,
        });
        if (inNative) {
            await writeExportToPath(targetPath, exported, binary);
            if (choice.animationScope === 'all') {
                active.sourcePath = targetPath;
                active.name = fileNameOfPath(targetPath);
            }
        } else {
            downloadName = fileNameOfPath(targetPath);
            downloadExport(downloadName, exported, binary);
        }

        if (choice.animationScope === 'all') {
            active.kind = 'model';
            active.dirty = false;
        }
        syncDocumentState();
        syncPropertyPanel();
        refreshButtons();
        showToast(choice.animationScope === 'current'
            ? `已导出当前动画 ${fileNameOfPath(targetPath)}`
            : `已保存 ${active.name}`, 'success');
    } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : String(error);
        showToast(`保存失败: ${message}`, 'error');
    } finally {
        hideLoading();
    }
}

async function ensureAnimationsLoadedForExport(scope: AnimationExportScope): Promise<boolean> {
    const state = viewer.getAnimationState();
    const activeIndex = state.activeIndex;
    const indices = scope === 'current'
        ? (activeIndex >= 0 ? [activeIndex] : [])
        : state.clips
            .filter((clip) => clip.lazy)
            .map((clip) => clip.index);
    if (indices.length === 0) return true;

    showLoading(`正在准备导出动画 1 / ${indices.length} …`);
    try {
        for (let offset = 0; offset < indices.length; offset += 1) {
            const index = indices[offset];
            showLoading(`正在准备导出动画 ${offset + 1} / ${indices.length} …`);
            const loaded = await ensureAnimationClipLoaded(index, {
                autoPlay: false,
                activate: scope === 'current',
                quiet: true,
            });
            if (!loaded) {
                showToast('导出取消：有按需动画载入失败', 'error');
                return false;
            }
        }
    } finally {
        hideLoading();
    }

    if (scope === 'all' && activeIndex >= 0) {
        viewer.selectAnimationClip(activeIndex, { autoPlay: false });
    }
    refreshAnimationBar(viewer.getAnimationState());
    syncAnimationEditor();
    return true;
}

async function exportActiveDocument(
    document: DocumentSession,
    options: { binary: boolean; animationScope: AnimationExportScope },
): Promise<ArrayBuffer | Record<string, unknown>> {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const animations = viewer.getAnimationClipsForExport({ scope: options.animationScope });
    if (options.animationScope === 'current' && animations.length === 0) {
        throw new Error('当前没有可导出的动画');
    }

    return withCleanExportUserData(document.root, () => new Promise<ArrayBuffer | Record<string, unknown>>((resolve, reject) => {
        (exporter as unknown as {
            parse: (
                input: Object3D,
                onDone: (result: ArrayBuffer | Record<string, unknown>) => void,
                onError: (error: Error) => void,
                options: Record<string, unknown>,
            ) => void;
        }).parse(document.root, resolve, reject, {
            binary: options.binary,
            onlyVisible: false,
            trs: true,
            animations,
        });
    }));
}

async function withCleanExportUserData<T>(rootModel: Object3D, run: () => Promise<T>): Promise<T> {
    const patches: Array<{
        object: Object3D;
        key: string;
        value: unknown;
    }> = [];
    const internalKeys = ['animations', '__assetObjectUrls'];

    rootModel.traverse((object) => {
        for (const key of internalKeys) {
            if (!Object.prototype.hasOwnProperty.call(object.userData, key)) continue;
            patches.push({ object, key, value: object.userData[key] });
            delete object.userData[key];
        }
    });

    try {
        return await run();
    } finally {
        for (const patch of patches) {
            patch.object.userData[patch.key] = patch.value;
        }
    }
}

async function writeExportToPath(
    path: string,
    exported: ArrayBuffer | Record<string, unknown>,
    binary: boolean,
): Promise<void> {
    if (binary) {
        if (!(exported instanceof ArrayBuffer)) throw new Error('导出结果不是 GLB 二进制');
        await fs.writeBase64File(path, arrayBufferToBase64(exported));
        return;
    }

    await fs.writeTextFile(path, JSON.stringify(exported, null, 2));
}

function downloadExport(
    fileName: string,
    exported: ArrayBuffer | Record<string, unknown>,
    binary: boolean,
): void {
    const blob = binary
        ? new Blob([exported as ArrayBuffer], { type: 'model/gltf-binary' })
        : new Blob([JSON.stringify(exported, null, 2)], { type: 'model/gltf+json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}

function isDirectSavePath(path: string): boolean {
    const ext = extOf(path);
    return ext === 'glb' || ext === 'gltf';
}

function ensureExportExtension(path: string, animationScope: AnimationExportScope = 'all'): string {
    const ext = extOf(path);
    if (animationScope === 'current') {
        if (ext === 'glb') return path;
        if (ext === 'gltf') return `${path.slice(0, -5)}glb`;
        return `${path}.glb`;
    }
    if (ext === 'glb' || ext === 'gltf') return path;
    return `${path}.glb`;
}

function defaultExportName(name: string, animationScope: AnimationExportScope = 'all'): string {
    const trimmed = name.trim() || 'model';
    const dot = trimmed.lastIndexOf('.');
    const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
    if (animationScope === 'current') {
        const state = viewer.getAnimationState();
        const activeClip = state.clips.find((clip) => clip.index === state.activeIndex);
        const clipName = sanitizeFileNamePart(activeClip?.name || 'animation');
        return `${sanitizeFileNamePart(base)}_${clipName}.glb`;
    }
    return `${base}.glb`;
}

function sanitizeFileNamePart(value: string): string {
    const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_').replace(/\s+/g, '_');
    return cleaned || 'model';
}

function openDocumentWithModel(name: string, rootModel: Object3D, sourcePath?: string): void {
    finishActiveUvInteraction({ commit: true });
    flushPendingUndoTransactions();
    const active = getActiveDocument();
    if (active && active.kind === 'sample' && documents.length === 1) {
        const previousRoot = active.root;
        active.name = name;
        active.root = rootModel;
        active.kind = 'model';
        active.sourcePath = sourcePath;
        active.dirty = false;
        active.undoStack = [];
        active.redoStack = [];
        activateDocument(active.id, { fit: true });
        viewer.disposeModel(previousRoot);
        return;
    }

    const next: DocumentSession = {
        id: `doc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        name,
        root: rootModel,
        kind: 'model',
        sourcePath,
        dirty: false,
        undoStack: [],
        redoStack: [],
    };
    documents.push(next);
    activateDocument(next.id, { fit: true });
}

function syncDocumentState(): void {
    const active = getActiveDocument();
    if (!active) return;

    const stateLabel = loadingMessage
        ? loadingMessage
        : active.kind === 'sample'
            ? '内置示例已载入'
            : active.dirty
                ? '有未保存修改'
                : active.sourcePath
                    ? '已保存'
                    : '已载入模型';

    setText(sceneStateEls, stateLabel);
    setText(modelNameEls, active.name);
    renderDocumentTabs();
    updateWindowTitle(active.name);
    updateStatusChips();
}

function scheduleRefreshStats(): void {
    if (statsRefreshRaf) cancelAnimationFrame(statsRefreshRaf);
    statVerts.textContent = '…';
    statFaces.textContent = '…';
    statEdges.textContent = '…';
    statMeshes.textContent = '…';
    statsRefreshRaf = requestAnimationFrame(() => {
        statsRefreshRaf = 0;
        refreshStats();
    });
}

function refreshStats(): void {
    const stats = viewer.collectStats();
    statVerts.textContent = stats.vertices.toLocaleString();
    statFaces.textContent = stats.triangles.toLocaleString();
    statEdges.textContent = stats.edges.toLocaleString();
    statMeshes.textContent = stats.meshes.toLocaleString();
}

function refreshButtons(): void {
    const active = getActiveDocument();
    const hasPendingUndo = hasPendingUndoTransaction();
    btnClear.disabled = false;
    btnSave.disabled = !active;
    btnSaveAs.disabled = !active;
    btnUndo.disabled = !active || (active.undoStack.length === 0 && !hasPendingUndo);
    btnRedo.disabled = !active || hasPendingUndo || active.redoStack.length === 0;
    btnAnimHistoryUndo.disabled = btnUndo.disabled;
    btnAnimHistoryRedo.disabled = btnRedo.disabled;
    renderAnimationHistory();
}

function hasPendingUndoTransaction(): boolean {
    return Boolean(
        materialUndoDraft.snapshot
        || textureUndoDraft.snapshot
        || uvWheelUndoDraft.snapshot
        || animationPoseUndoDraft.snapshot,
    );
}

function syncPropertyPanel(): void {
    const active = getActiveDocument();
    if (!active) return;

    const bounds = viewer.getBoundsFor(active.root);
    propDocName.textContent = active.name;
    propDocState.textContent = active.kind === 'sample'
        ? '内置示例'
        : active.dirty
            ? '已修改'
            : active.sourcePath
                ? '已保存'
                : '已载入';
    propDocCount.textContent = String(documents.length);
    propBounds.textContent = bounds ? formatVector(bounds.size) : '—';
    propCenter.textContent = bounds ? formatVector(bounds.center) : '—';
}

function syncPropertyPanelCamera(): void {
    const camera = viewer.getCameraState();
    cameraFovRange.value = camera.fov.toFixed(0);
    cameraFovInput.value = camera.fov.toFixed(0);
    cameraExposureRange.value = camera.exposure.toFixed(2);
    cameraExposureInput.value = camera.exposure.toFixed(2);
    propCameraPos.textContent = formatVector(camera.position);
    propCameraTarget.textContent = formatVector(camera.target);
}

function syncMaterialControls(options: { syncTextures?: boolean } = {}): void {
    const state = viewer.getMaterialState();
    const disabled = !state.hasMaterial;

    matVisible.checked = state.visible;
    matMode.value = state.mode;
    setNumericPairValue(matOpacityRange, matOpacityInput, state.opacity);
    matColorInput.value = state.color;
    setNumericPairValue(matRoughnessRange, matRoughnessInput, state.roughness);
    setNumericPairValue(matMetalnessRange, matMetalnessInput, state.metalness);
    matFlat.checked = state.flatShading;
    matDoubleSided.checked = state.doubleSided;

    [
        matVisible,
        matMode,
        matOpacityRange,
        matOpacityInput,
        matColorInput,
        matRoughnessRange,
        matRoughnessInput,
        matMetalnessRange,
        matMetalnessInput,
        matFlat,
        matDoubleSided,
        btnResetMaterial,
    ].forEach((input) => {
        input.disabled = disabled;
    });

    if (options.syncTextures ?? true) syncTextureInspector();
}

function syncTextureInspector(): void {
    const state = viewer.getTextureState();

    textureEmpty.hidden = state.hasTextures;
    textureBrowser.hidden = !state.hasTextures;

    if (!state.hasTextures) {
        selectedTextureSlot = null;
        currentTextureSlotState = null;
        currentUvEditorState = null;
        currentUvEdges = [];
        currentUvEdgeMap.clear();
        resetUvEditorSelectionState();
        resetUvTexturePatternCache();
        textureList.innerHTML = '';
        texSlotName.textContent = '—';
        texDimensions.textContent = '—';
        texSourceName.textContent = '—';
        uvEditorEmpty.hidden = false;
        uvEditorEmpty.textContent = '当前材质没有 UV 贴图';
        uvEditorStatus.textContent = '当前材质没有 UV 贴图';
        setTextureControlsDisabled(true);
        setTextureTransformValues(null);
        renderUvEditor(null);
        return;
    }

    if (!selectedTextureSlot || !state.slots.some((slot) => slot.slot === selectedTextureSlot)) {
        selectedTextureSlot = state.slots[0]?.slot ?? null;
    }

    textureList.innerHTML = state.slots.map((slot) => `
        <button
            class="texture-slot${slot.slot === selectedTextureSlot ? ' active' : ''}"
            type="button"
            data-texture-slot="${slot.slot}"
            title="${escapeHtml(getTextureSlotDisplayName(slot))}"
            aria-label="${escapeHtml(getTextureSlotDisplayName(slot))}"
        >
            <strong class="texture-slot-title">${escapeHtml(slot.label)}</strong>
            <span class="texture-slot-meta">${escapeHtml(formatTextureSlotMeta(slot))}</span>
        </button>
    `).join('');

    const active = state.slots.find((slot) => slot.slot === selectedTextureSlot) ?? state.slots[0];
    if (!active) {
        setTextureControlsDisabled(true);
        return;
    }

    selectedTextureSlot = active.slot;
    currentTextureSlotState = active;
    if (uvTexturePatternSource !== active.imageSource) resetUvTexturePatternCache();
    currentUvEditorState = viewer.getUvEditorState();
    rebuildUvEdgeCache();
    pruneUvSelection();
    syncTextureDetail(active);
    setTextureControlsDisabled(false);
    setTextureTransformValues(active);
    renderUvEditor(active);
}

function syncTextureDetail(slot: TextureSlotState): void {
    texSlotName.textContent = getTextureSlotDisplayName(slot);
    texDimensions.textContent = slot.width && slot.height ? `${slot.width} × ${slot.height}` : '—';
    texSourceName.textContent = slot.sourceName || '内嵌贴图';
    setUvEditorIdleStatus();
}

function getTextureSlotDisplayName(slot: TextureSlotState): string {
    return slot.textureCount > 1 ? `${slot.label} (${slot.textureCount})` : slot.label;
}

function formatTextureSlotMeta(slot: TextureSlotState): string {
    const source = slot.sourceName || '内嵌贴图';
    return slot.textureCount > 1 ? `${slot.textureCount} 张 · ${source}` : source;
}

function setTextureTransformValues(slot: TextureSlotState | null): void {
    const values = slot ?? {
        offsetX: 0,
        offsetY: 0,
        repeatX: 1,
        repeatY: 1,
        rotation: 0,
    };

    setNumericPairValue(texOffsetXRange, texOffsetXInput, values.offsetX);
    setNumericPairValue(texOffsetYRange, texOffsetYInput, values.offsetY);
    setNumericPairValue(texRepeatXRange, texRepeatXInput, values.repeatX);
    setNumericPairValue(texRepeatYRange, texRepeatYInput, values.repeatY);
    setNumericPairValue(texRotationRange, texRotationInput, values.rotation);
}

function setTextureControlsDisabled(disabled: boolean): void {
    [
        texOffsetXRange,
        texOffsetXInput,
        texOffsetYRange,
        texOffsetYInput,
        texRepeatXRange,
        texRepeatXInput,
        texRepeatYRange,
        texRepeatYInput,
        texRotationRange,
        texRotationInput,
        btnResetTextureTransform,
    ].forEach((input) => {
        input.disabled = disabled;
    });
}

function applyTextureTransform(partial: {
    offsetX?: number;
    offsetY?: number;
    repeatX?: number;
    repeatY?: number;
    rotation?: number;
}): void {
    if (!selectedTextureSlot) return;
    viewer.setTextureTransform(selectedTextureSlot, partial);
    refreshActiveTextureState();
}

function getSelectedUvBounds(): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    centerX: number;
    centerY: number;
} | null {
    const snapshot = getSelectedPointSnapshot();
    if (snapshot.length === 0) return null;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const point of snapshot) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }

    return {
        minX,
        minY,
        maxX,
        maxY,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
    };
}

function getSelectionHandleAnchors() {
    const bounds = getSelectedUvBounds();
    if (!bounds) return null;

    const minSizeUv = 20 / getUvPixelsPerUnit();
    const halfWidth = Math.max((bounds.maxX - bounds.minX) / 2, minSizeUv / 2);
    const halfHeight = Math.max((bounds.maxY - bounds.minY) / 2, minSizeUv / 2);
    const minX = bounds.centerX - halfWidth;
    const maxX = bounds.centerX + halfWidth;
    const minY = bounds.centerY - halfHeight;
    const maxY = bounds.centerY + halfHeight;

    return {
        bounds: {
            minX,
            minY,
            maxX,
            maxY,
            centerX: bounds.centerX,
            centerY: bounds.centerY,
        },
        handles: {
            'scale-nw': { x: minX, y: maxY },
            'scale-ne': { x: maxX, y: maxY },
            'scale-se': { x: maxX, y: minY },
            'scale-sw': { x: minX, y: minY },
            rotate: { x: bounds.centerX, y: maxY + 26 / getUvPixelsPerUnit() },
        } satisfies Record<SelectionHandleType, { x: number; y: number }>,
    };
}

function hitSelectionHandle(
    screenX: number,
    screenY: number,
    transform = getUvScreenTransform(),
): SelectionHandleType | null {
    const anchors = getSelectionHandleAnchors();
    if (!anchors) return null;

    const thresholdPx = 10;
    let best: { type: SelectionHandleType; distance: number } | null = null;

    for (const [type, position] of Object.entries(anchors.handles) as Array<[SelectionHandleType, { x: number; y: number }]>) {
        const screen = uvToScreen(position.x, position.y, transform);
        const dx = screen.x - screenX;
        const dy = screen.y - screenY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > thresholdPx) continue;
        if (!best || distance < best.distance) {
            best = { type, distance };
        }
    }

    return best?.type ?? null;
}

function pruneUvSelection(): void {
    if (!currentUvEditorState) {
        resetUvEditorSelectionState();
        return;
    }

    const points = currentUvEditorState.points;
    for (const pointId of [...selectedUvPointIds]) {
        if (!points[pointId]) selectedUvPointIds.delete(pointId);
    }

    for (const edgeId of [...selectedUvEdgeIds]) {
        if (!currentUvEdgeMap.has(edgeId)) selectedUvEdgeIds.delete(edgeId);
    }

    for (const faceId of [...selectedUvFaceIds]) {
        if (!currentUvEditorState.triangles[faceId]) selectedUvFaceIds.delete(faceId);
    }

    syncUvDerivedPointSelection();
    clearUvPreviewSelection();
}

function toggleUvPointSelection(pointId: number): void {
    if (!currentUvEditorState?.points[pointId]) return;
    selectedUvEdgeIds.clear();
    selectedUvFaceIds.clear();
    if (selectedUvPointIds.has(pointId)) selectedUvPointIds.delete(pointId);
    else selectedUvPointIds.add(pointId);
}

function getSelectedPointSnapshot(): Array<{ pointId: number; x: number; y: number }> {
    if (!currentUvEditorState) return [];
    return [...selectedUvPointIds]
        .map((pointId) => currentUvEditorState?.points[pointId])
        .filter((point): point is NonNullable<typeof point> => Boolean(point))
        .map((point) => ({
            pointId: point.id,
            x: point.x,
            y: point.y,
        }));
}

function findNearestUvPoint(
    state: UvEditorState,
    screenX: number,
    screenY: number,
    transform = getUvScreenTransform(),
): number | null {
    const radiusSq = 8 * 8;
    let best: { pointId: number; distance: number } | null = null;

    for (const point of state.points) {
        const screen = uvToScreen(point.x, point.y, transform);
        const dx = screen.x - screenX;
        const dy = screen.y - screenY;
        const distance = dx * dx + dy * dy;
        if (distance > radiusSq) continue;
        if (!best || distance < best.distance) {
            best = { pointId: point.id, distance };
        }
    }

    return best?.pointId ?? null;
}

function findNearestUvEdge(
    screenX: number,
    screenY: number,
    transform = getUvScreenTransform(),
): UvEdgeState | null {
    if (!currentUvEditorState) return null;

    const thresholdSq = 10 * 10;
    let best: { edge: UvEdgeState; distance: number } | null = null;

    for (const edge of currentUvEdges) {
        const a = currentUvEditorState.points[edge.a];
        const b = currentUvEditorState.points[edge.b];
        if (!a || !b) continue;
        const start = uvToScreen(a.x, a.y, transform);
        const end = uvToScreen(b.x, b.y, transform);
        const distance = distanceToSegmentSquared(screenX, screenY, start.x, start.y, end.x, end.y);
        if (distance > thresholdSq) continue;
        if (!best || distance < best.distance) {
            best = { edge, distance };
        }
    }

    return best?.edge ?? null;
}

function findTriangleIndexAtUv(
    state: UvEditorState,
    uvX: number,
    uvY: number,
): number | null {
    for (let faceId = 0; faceId < state.triangles.length; faceId += 1) {
        const triangle = state.triangles[faceId];
        const a = state.points[triangle.a];
        const b = state.points[triangle.b];
        const c = state.points[triangle.c];
        if (!a || !b || !c) continue;
        if (pointInTriangle(uvX, uvY, a.x, a.y, b.x, b.y, c.x, c.y)) return faceId;
    }
    return null;
}

function pointInTriangle(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
): boolean {
    const area = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
        (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);

    const triangleArea = area(ax, ay, bx, by, cx, cy);
    if (Math.abs(triangleArea) < 1e-8) return false;

    const d1 = area(px, py, ax, ay, bx, by);
    const d2 = area(px, py, bx, by, cx, cy);
    const d3 = area(px, py, cx, cy, ax, ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

function getUvSelectionRect(): {
    left: number;
    right: number;
    top: number;
    bottom: number;
} {
    return {
        left: Math.min(uvDragState.boxStartX, uvDragState.boxCurrentX),
        right: Math.max(uvDragState.boxStartX, uvDragState.boxCurrentX),
        top: Math.min(uvDragState.boxStartY, uvDragState.boxCurrentY),
        bottom: Math.max(uvDragState.boxStartY, uvDragState.boxCurrentY),
    };
}

function collectPointsInSelectionRect(transform = getUvScreenTransform()): number[] {
    if (!currentUvEditorState) return [];

    const rect = getUvSelectionRect();

    return currentUvEditorState.points
        .filter((point) => {
            const screen = uvToScreen(point.x, point.y, transform);
            return pointInRect(screen.x, screen.y, rect);
        })
        .map((point) => point.id);
}

function collectEdgesInSelectionRect(transform = getUvScreenTransform()): string[] {
    const state = currentUvEditorState;
    if (!state) return [];
    const rect = getUvSelectionRect();

    return currentUvEdges
        .filter((edge) => {
            const a = state.points[edge.a];
            const b = state.points[edge.b];
            if (!a || !b) return false;
            const start = uvToScreen(a.x, a.y, transform);
            const end = uvToScreen(b.x, b.y, transform);
            return segmentIntersectsRect(start.x, start.y, end.x, end.y, rect);
        })
        .map((edge) => edge.id);
}

function collectFacesInSelectionRect(transform = getUvScreenTransform()): number[] {
    const state = currentUvEditorState;
    if (!state) return [];
    const rect = getUvSelectionRect();
    const rectCorners = [
        { x: rect.left, y: rect.top },
        { x: rect.right, y: rect.top },
        { x: rect.right, y: rect.bottom },
        { x: rect.left, y: rect.bottom },
    ];

    return state.triangles.flatMap((triangle, faceId) => {
        const a = state.points[triangle.a];
        const b = state.points[triangle.b];
        const c = state.points[triangle.c];
        if (!a || !b || !c) return [];

        const sa = uvToScreen(a.x, a.y, transform);
        const sb = uvToScreen(b.x, b.y, transform);
        const sc = uvToScreen(c.x, c.y, transform);

        const vertexInside = pointInRect(sa.x, sa.y, rect) || pointInRect(sb.x, sb.y, rect) || pointInRect(sc.x, sc.y, rect);
        const cornerInside = rectCorners.some((corner) =>
            pointInTriangle(corner.x, corner.y, sa.x, sa.y, sb.x, sb.y, sc.x, sc.y),
        );
        const edgeInside =
            segmentIntersectsRect(sa.x, sa.y, sb.x, sb.y, rect) ||
            segmentIntersectsRect(sb.x, sb.y, sc.x, sc.y, rect) ||
            segmentIntersectsRect(sc.x, sc.y, sa.x, sa.y, rect);

        return vertexInside || cornerInside || edgeInside ? [faceId] : [];
    });
}

function pointInRect(
    x: number,
    y: number,
    rect: { left: number; right: number; top: number; bottom: number },
): boolean {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function segmentIntersectsRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    rect: { left: number; right: number; top: number; bottom: number },
): boolean {
    if (pointInRect(x1, y1, rect) || pointInRect(x2, y2, rect)) return true;

    return (
        segmentsIntersect(x1, y1, x2, y2, rect.left, rect.top, rect.right, rect.top) ||
        segmentsIntersect(x1, y1, x2, y2, rect.right, rect.top, rect.right, rect.bottom) ||
        segmentsIntersect(x1, y1, x2, y2, rect.right, rect.bottom, rect.left, rect.bottom) ||
        segmentsIntersect(x1, y1, x2, y2, rect.left, rect.bottom, rect.left, rect.top)
    );
}

function segmentsIntersect(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
): boolean {
    const o1 = orientation(ax, ay, bx, by, cx, cy);
    const o2 = orientation(ax, ay, bx, by, dx, dy);
    const o3 = orientation(cx, cy, dx, dy, ax, ay);
    const o4 = orientation(cx, cy, dx, dy, bx, by);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && pointOnSegment(cx, cy, ax, ay, bx, by)) return true;
    if (o2 === 0 && pointOnSegment(dx, dy, ax, ay, bx, by)) return true;
    if (o3 === 0 && pointOnSegment(ax, ay, cx, cy, dx, dy)) return true;
    if (o4 === 0 && pointOnSegment(bx, by, cx, cy, dx, dy)) return true;
    return false;
}

function orientation(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
): number {
    const value = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
    if (Math.abs(value) < 1e-7) return 0;
    return value > 0 ? 1 : 2;
}

function pointOnSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): boolean {
    return px >= Math.min(ax, bx) - 1e-7
        && px <= Math.max(ax, bx) + 1e-7
        && py >= Math.min(ay, by) - 1e-7
        && py <= Math.max(ay, by) + 1e-7;
}

function distanceToSegmentSquared(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) {
        const ox = px - ax;
        const oy = py - ay;
        return ox * ox + oy * oy;
    }

    const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    const closestX = ax + dx * t;
    const closestY = ay + dy * t;
    const ox = px - closestX;
    const oy = py - closestY;
    return ox * ox + oy * oy;
}

function applyUvPointUpdates(
    updates: Array<{ pointId: number; x: number; y: number }>,
    options: {
        snap?: boolean;
    } = {},
): void {
    applyUvPointUpdatesInternal(updates, options);
}

function applyUvPointUpdatesInternal(
    updates: Array<{ pointId: number; x: number; y: number }>,
    options: {
        snap?: boolean;
    } = {},
): void {
    if (!currentUvEditorState || updates.length === 0) return;

    const nextUpdates = options.snap
        ? applyUvSnapping(updates)
        : updates;

    viewer.setUvPointPositions(nextUpdates);

    for (const update of nextUpdates) {
        const point = currentUvEditorState.points[update.pointId];
        if (!point) continue;
        point.x = update.x;
        point.y = update.y;
    }

    currentUvEditorState.segments = buildUvSegmentsFromState(currentUvEditorState);
    renderUvEditor(currentTextureSlotState);
}

function applyUvTransformToSelection(options: {
    scaleX?: number;
    scaleY?: number;
    rotateDeg?: number;
    snap?: boolean;
}): void {
    if (!currentUvEditorState || uvDragState.startSelection.length === 0) return;

    const pivotX = uvDragState.transformPivotX;
    const pivotY = uvDragState.transformPivotY;
    const scaleX = options.scaleX ?? 1;
    const scaleY = options.scaleY ?? 1;
    const radians = ((options.rotateDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    applyUvPointUpdatesInternal(uvDragState.startSelection.map((point) => {
        const scaledX = (point.x - pivotX) * scaleX;
        const scaledY = (point.y - pivotY) * scaleY;
        const rotatedX = scaledX * cos - scaledY * sin;
        const rotatedY = scaledX * sin + scaledY * cos;
        return {
            pointId: point.pointId,
            x: pivotX + rotatedX,
            y: pivotY + rotatedY,
        };
    }), {
        snap: options.snap,
    });
}

function applyUvSnapping(
    updates: Array<{ pointId: number; x: number; y: number }>,
): Array<{ pointId: number; x: number; y: number }> {
    if (!currentUvEditorState || updates.length === 0 || !uvSnapEnabled) return updates;

    const offset = getUvPointSnapOffset(updates) ?? getUvGridSnapOffset(updates);
    if (!offset || (Math.abs(offset.x) < 1e-8 && Math.abs(offset.y) < 1e-8)) return updates;

    return updates.map((update) => ({
        pointId: update.pointId,
        x: update.x + offset.x,
        y: update.y + offset.y,
    }));
}

function getUvPointSnapOffset(
    updates: Array<{ pointId: number; x: number; y: number }>,
): { x: number; y: number } | null {
    if (!currentUvEditorState) return null;

    const selectedIds = new Set(updates.map((update) => update.pointId));
    const threshold = 10 * uvSnapStrength;
    const thresholdSq = threshold ** 2;
    const transform = getUvScreenTransform();
    const cellSize = Math.max(threshold, 1);
    const snapGrid = buildUvPointSnapGrid(selectedIds, transform, cellSize);
    let best: { x: number; y: number; distance: number } | null = null;

    for (const update of updates) {
        const updateScreen = uvToScreen(update.x, update.y, transform);
        const cellX = Math.floor(updateScreen.x / cellSize);
        const cellY = Math.floor(updateScreen.y / cellSize);
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                const bucket = snapGrid.get(`${cellX + offsetX}:${cellY + offsetY}`);
                if (!bucket) continue;

                for (const point of bucket) {
                    const screenDx = point.screenX - updateScreen.x;
                    const screenDy = point.screenY - updateScreen.y;
                    const distance = screenDx * screenDx + screenDy * screenDy;
                    if (distance > thresholdSq) continue;
                    const dx = point.x - update.x;
                    const dy = point.y - update.y;
                    if (!best || distance < best.distance) {
                        best = { x: dx, y: dy, distance };
                    }
                }
            }
        }
    }

    return best ? { x: best.x, y: best.y } : null;
}

function buildUvPointSnapGrid(
    excludedIds: Set<number>,
    transform: UvScreenTransform,
    cellSize: number,
): Map<string, Array<{ x: number; y: number; screenX: number; screenY: number }>> {
    const grid = new Map<string, Array<{ x: number; y: number; screenX: number; screenY: number }>>();
    if (!currentUvEditorState) return grid;

    for (const point of currentUvEditorState.points) {
        if (excludedIds.has(point.id)) continue;
        const screen = uvToScreen(point.x, point.y, transform);
        const key = `${Math.floor(screen.x / cellSize)}:${Math.floor(screen.y / cellSize)}`;
        const bucket = grid.get(key);
        const candidate = {
            x: point.x,
            y: point.y,
            screenX: screen.x,
            screenY: screen.y,
        };
        if (bucket) {
            bucket.push(candidate);
        } else {
            grid.set(key, [candidate]);
        }
    }

    return grid;
}

function getUvGridSnapOffset(
    updates: Array<{ pointId: number; x: number; y: number }>,
): { x: number; y: number } | null {
    const step = getUvGridStep();
    const threshold = (6 * uvSnapStrength) / getUvPixelsPerUnit();
    let bestX: number | null = null;
    let bestY: number | null = null;

    for (const update of updates) {
        const targetX = Math.round(update.x / step) * step;
        const targetY = Math.round(update.y / step) * step;
        const diffX = targetX - update.x;
        const diffY = targetY - update.y;

        if (Math.abs(diffX) <= threshold && (bestX === null || Math.abs(diffX) < Math.abs(bestX))) {
            bestX = diffX;
        }
        if (Math.abs(diffY) <= threshold && (bestY === null || Math.abs(diffY) < Math.abs(bestY))) {
            bestY = diffY;
        }
    }

    if (bestX === null && bestY === null) return null;
    return {
        x: bestX ?? 0,
        y: bestY ?? 0,
    };
}

function getUvGridStep(): number {
    const pixelsPerUnit = getUvPixelsPerUnit();
    if (pixelsPerUnit > 520) return 0.025;
    if (pixelsPerUnit > 320) return 0.05;
    if (pixelsPerUnit > 180) return 0.1;
    return 0.25;
}

function clampScaleFactor(value: number): number {
    if (!Number.isFinite(value)) return 1;
    const magnitude = clamp(Math.abs(value), 0.08, 12);
    return value < 0 ? -magnitude : magnitude;
}

function scaleSelectedUvPoints(factor: number): void {
    if (!currentUvEditorState || selectedUvPointIds.size === 0) return;
    const before = getSelectedPointSnapshot();
    if (before.length === 0) return;
    beginUvWheelUndoTransaction('UV 缩放');
    const pivot = getSelectedUvPivot();
    const clamped = clamp(factor, 0.4, 2.5);
    applyUvPointUpdates(before.map((point) => ({
        pointId: point.pointId,
        x: pivot.x + (point.x - pivot.x) * clamped,
        y: pivot.y + (point.y - pivot.y) * clamped,
    })), { snap: true });
    uvEditorStatus.textContent = `已缩放选区，影响 ${selectedUvPointIds.size} 个 UV 点`;
}

function rotateSelectedUvPoints(angleDeg: number): void {
    if (!currentUvEditorState || selectedUvPointIds.size === 0) return;
    const before = getSelectedPointSnapshot();
    if (before.length === 0) return;
    beginUvWheelUndoTransaction('UV 旋转');
    const pivot = getSelectedUvPivot();
    const radians = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    applyUvPointUpdates(before.map((point) => {
        const dx = point.x - pivot.x;
        const dy = point.y - pivot.y;
        return {
            pointId: point.pointId,
            x: pivot.x + dx * cos - dy * sin,
            y: pivot.y + dx * sin + dy * cos,
        };
    }), { snap: true });
    uvEditorStatus.textContent = `已旋转选区，影响 ${selectedUvPointIds.size} 个 UV 点`;
}

function getSelectedUvPivot(): { x: number; y: number } {
    const snapshot = getSelectedPointSnapshot();
    if (snapshot.length === 0) return { x: 0.5, y: 0.5 };

    const sum = snapshot.reduce((acc, point) => ({
        x: acc.x + point.x,
        y: acc.y + point.y,
    }), { x: 0, y: 0 });

    return {
        x: sum.x / snapshot.length,
        y: sum.y / snapshot.length,
    };
}

function shouldSuppressCommittedUvSelection(): boolean {
    return uvDragState.mode === 'box-select' && !uvDragState.additive && !uvDragState.subtractive;
}

function getUvPreviewPalette(): {
    fill: string;
    stroke: string;
    pointFill: string;
    pointStroke: string;
} {
    if (uvDragState.subtractive) {
        return {
            fill: 'rgba(183, 79, 92, 0.16)',
            stroke: 'rgba(183, 79, 92, 0.82)',
            pointFill: 'rgba(183, 79, 92, 0.94)',
            pointStroke: 'rgba(84, 22, 30, 0.95)',
        };
    }

    return {
        fill: 'rgba(47, 111, 179, 0.16)',
        stroke: 'rgba(47, 111, 179, 0.82)',
        pointFill: 'rgba(47, 111, 179, 0.94)',
        pointStroke: 'rgba(14, 38, 62, 0.95)',
    };
}

function drawUvFaceSelection(
    ctx: CanvasRenderingContext2D,
    state: UvEditorState,
    faceIds: Iterable<number>,
    scale: number,
    fillStyle: string,
    strokeStyle: string,
): void {
    let hasFace = false;
    ctx.beginPath();
    for (const faceId of faceIds) {
        const triangle = state.triangles[faceId];
        if (!triangle) continue;
        const a = state.points[triangle.a];
        const b = state.points[triangle.b];
        const c = state.points[triangle.c];
        if (!a || !b || !c) continue;
        hasFace = true;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.closePath();
    }
    if (!hasFace) return;
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.lineWidth = 1.2 / scale;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
}

function drawUvEdgeSelection(
    ctx: CanvasRenderingContext2D,
    state: UvEditorState,
    edgeIds: Iterable<string>,
    scale: number,
    strokeStyle: string,
    lineWidth: number,
): void {
    let hasEdge = false;
    ctx.beginPath();
    for (const edgeId of edgeIds) {
        const edge = currentUvEdgeMap.get(edgeId);
        if (!edge) continue;
        const a = state.points[edge.a];
        const b = state.points[edge.b];
        if (!a || !b) continue;
        hasEdge = true;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
    }
    if (!hasEdge) return;
    ctx.lineWidth = lineWidth / scale;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
}

function drawUvPoints(
    ctx: CanvasRenderingContext2D,
    state: UvEditorState,
    transform = getUvScreenTransform(),
): void {
    const dpr = window.devicePixelRatio || 1;
    const radius = 3.4;
    const previewPalette = getUvPreviewPalette();
    const showCommitted = !shouldSuppressCommittedUvSelection();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const point of state.points) {
        const screen = uvToScreen(point.x, point.y, transform);
        if (
            screen.x < -radius
            || screen.x > transform.width + radius
            || screen.y < -radius
            || screen.y > transform.height + radius
        ) {
            continue;
        }
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);

        const previewed = previewUvPointIds.has(point.id);
        const selected = showCommitted && selectedUvPointIds.has(point.id);

        if (previewed) {
            ctx.fillStyle = previewPalette.pointFill;
            ctx.strokeStyle = previewPalette.pointStroke;
        } else if (selected) {
            ctx.fillStyle = '#2f6fb3';
            ctx.strokeStyle = 'rgba(14, 38, 62, 0.95)';
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.strokeStyle = 'rgba(18, 28, 38, 0.45)';
        }

        ctx.fill();
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    ctx.restore();
}

function drawUvSelectionBounds(
    ctx: CanvasRenderingContext2D,
    transform = getUvScreenTransform(),
): void {
    const anchors = getSelectionHandleAnchors();
    if (!anchors || selectedUvPointIds.size === 0 || shouldSuppressCommittedUvSelection()) return;

    const dpr = window.devicePixelRatio || 1;
    const topLeft = uvToScreen(anchors.bounds.minX, anchors.bounds.maxY, transform);
    const bottomRight = uvToScreen(anchors.bounds.maxX, anchors.bounds.minY, transform);
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(47, 111, 179, 0.92)';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width, height);
    ctx.setLineDash([]);

    const rotateAnchor = uvToScreen(anchors.handles.rotate.x, anchors.handles.rotate.y, transform);
    const topCenter = uvToScreen(anchors.bounds.centerX, anchors.bounds.maxY, transform);
    ctx.beginPath();
    ctx.moveTo(topCenter.x, topCenter.y);
    ctx.lineTo(rotateAnchor.x, rotateAnchor.y);
    ctx.strokeStyle = 'rgba(47, 111, 179, 0.65)';
    ctx.stroke();

    for (const [type, handle] of Object.entries(anchors.handles) as Array<[SelectionHandleType, { x: number; y: number }]>) {
        const screen = uvToScreen(handle.x, handle.y, transform);
        ctx.beginPath();
        if (type === 'rotate') {
            ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
        } else {
            ctx.rect(screen.x - 5, screen.y - 5, 10, 10);
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
        ctx.strokeStyle = 'rgba(47, 111, 179, 0.98)';
        ctx.lineWidth = 1.35;
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}

function drawUvSelectionRect(ctx: CanvasRenderingContext2D): void {
    if (uvDragState.mode !== 'box-select') return;

    const dpr = window.devicePixelRatio || 1;
    const rect = getUvSelectionRect();
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const previewPalette = getUvPreviewPalette();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = previewPalette.fill;
    ctx.strokeStyle = previewPalette.stroke;
    ctx.lineWidth = 1;
    ctx.fillRect(rect.left, rect.top, width, height);
    ctx.strokeRect(rect.left + 0.5, rect.top + 0.5, width, height);
    ctx.restore();
}

function uvToScreen(
    x: number,
    y: number,
    transform = getUvScreenTransform(),
): { x: number; y: number } {
    return {
        x: transform.width / 2 + (x - uvView.centerX) * transform.axisScale.x,
        y: transform.height / 2 - (y - uvView.centerY) * transform.axisScale.y,
    };
}

function buildUvSegmentsFromState(state: UvEditorState): Float32Array {
    const values: number[] = [];
    const dedupe = new Set<string>();

    const add = (aId: number, bId: number) => {
        const a = state.points[aId];
        const b = state.points[bId];
        if (!a || !b) return;
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) return;
        const key = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
        if (dedupe.has(key)) return;
        dedupe.add(key);
        values.push(a.x, a.y, b.x, b.y);
    };

    for (const triangle of state.triangles) {
        add(triangle.a, triangle.b);
        add(triangle.b, triangle.c);
        add(triangle.c, triangle.a);
    }

    return new Float32Array(values);
}

function refreshActiveTextureState(): void {
    const state = viewer.getTextureState();
    const active = selectedTextureSlot
        ? state.slots.find((slot) => slot.slot === selectedTextureSlot) ?? null
        : null;

    if (!active) {
        currentTextureSlotState = null;
        currentUvEditorState = null;
        currentUvEdges = [];
        currentUvEdgeMap.clear();
        resetUvEditorSelectionState();
        resetUvTexturePatternCache();
        setUvEditorIdleStatus();
        renderUvEditor(null);
        return;
    }

    currentTextureSlotState = active;
    if (uvTexturePatternSource !== active.imageSource) resetUvTexturePatternCache();
    currentUvEditorState = viewer.getUvEditorState();
    rebuildUvEdgeCache();
    pruneUvSelection();
    syncTextureDetail(active);
    setTextureTransformValues(active);
    renderUvEditor(active);
}

function renderUvEditor(slot: TextureSlotState | null): void {
    const ctx = ensureUvCanvasContext();
    if (!ctx) return;

    const width = uvEditorCanvas.width;
    const height = uvEditorCanvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f7f9fb';
    ctx.fillRect(0, 0, width, height);

    drawUvBackdrop(ctx, width, height);

    if (!slot || !slot.imageSource) {
        uvEditorEmpty.hidden = false;
        uvEditorEmpty.textContent = '当前贴图不可预览';
        return;
    }

    const uvState = currentUvEditorState;
    if (!uvState?.hasUv) {
        uvEditorEmpty.hidden = false;
        uvEditorEmpty.textContent = '当前模型没有 UV 坐标';
        return;
    }

    uvEditorEmpty.hidden = true;

    const axisScale = getUvAxisScale();
    const scale = axisScale.min;
    const dpr = window.devicePixelRatio || 1;
    const screenMidX = width / 2;
    const screenMidY = height / 2;
    const viewWidth = width / (axisScale.x * dpr);
    const viewHeight = height / (axisScale.y * dpr);
    const viewLeft = uvView.centerX - viewWidth / 2;
    const viewBottom = uvView.centerY - viewHeight / 2;

    ctx.save();
    ctx.setTransform(
        axisScale.x * dpr,
        0,
        0,
        -axisScale.y * dpr,
        screenMidX - uvView.centerX * axisScale.x * dpr,
        screenMidY + uvView.centerY * axisScale.y * dpr,
    );

    drawUvGrid(ctx, viewLeft, viewBottom, viewWidth, viewHeight, scale);
    drawTexturePattern(ctx, slot, viewLeft, viewBottom, viewWidth, viewHeight);
    drawUvBounds(ctx, scale);

    const previewPalette = getUvPreviewPalette();
    const showCommitted = !shouldSuppressCommittedUvSelection();
    if (showCommitted && uvSelectionMode === 'face' && selectedUvFaceIds.size > 0) {
        drawUvFaceSelection(
            ctx,
            uvState,
            selectedUvFaceIds,
            scale,
            'rgba(47, 111, 179, 0.14)',
            'rgba(47, 111, 179, 0.54)',
        );
    }

    if (previewUvFaceIds.size > 0) {
        drawUvFaceSelection(
            ctx,
            uvState,
            previewUvFaceIds,
            scale,
            previewPalette.fill,
            previewPalette.stroke,
        );
    }

    drawUvSegments(ctx, uvState.segments, scale);

    if (showCommitted && uvSelectionMode === 'edge' && selectedUvEdgeIds.size > 0) {
        drawUvEdgeSelection(
            ctx,
            uvState,
            selectedUvEdgeIds,
            scale,
            'rgba(47, 111, 179, 0.96)',
            2.4,
        );
    }

    if (previewUvEdgeIds.size > 0) {
        drawUvEdgeSelection(
            ctx,
            uvState,
            previewUvEdgeIds,
            scale,
            previewPalette.stroke,
            2.8,
        );
    }

    ctx.restore();

    const screenTransform = getUvScreenTransform();
    drawUvPoints(ctx, uvState, screenTransform);
    drawUvSelectionBounds(ctx, screenTransform);
    drawUvSelectionRect(ctx);
}

function drawUvBackdrop(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
): void {
    ctx.fillStyle = '#f4f7fa';
    ctx.fillRect(0, 0, width, height);
}

function drawUvGrid(
    ctx: CanvasRenderingContext2D,
    left: number,
    bottom: number,
    width: number,
    height: number,
    scale: number,
): void {
    const right = left + width;
    const top = bottom + height;
    const xStart = Math.floor(left);
    const xEnd = Math.ceil(right);
    const yStart = Math.floor(bottom);
    const yEnd = Math.ceil(top);

    ctx.beginPath();
    for (let x = xStart; x <= xEnd; x += 1) {
        ctx.moveTo(x, bottom);
        ctx.lineTo(x, top);
    }
    for (let y = yStart; y <= yEnd; y += 1) {
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
    }
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = 'rgba(83, 102, 120, 0.16)';
    ctx.stroke();
}

function drawTexturePattern(
    ctx: CanvasRenderingContext2D,
    slot: TextureSlotState,
    left: number,
    bottom: number,
    width: number,
    height: number,
): void {
    const drawable = slot.imageSource;
    if (!drawable || !slot.width || !slot.height) return;

    const repetition = isDefaultTextureTransform(slot) ? 'no-repeat' : 'repeat';
    if (uvTexturePatternSource !== drawable || uvTexturePatternMode !== repetition || !uvTexturePattern) {
        uvTexturePatternSource = drawable;
        uvTexturePatternMode = repetition;
        uvTexturePattern = ctx.createPattern(drawable, repetition);
    }

    const pattern = uvTexturePattern;
    if (!pattern) return;

    const transform = buildTexturePatternTransform(slot);
    pattern.setTransform(transform);

    ctx.fillStyle = pattern;
    ctx.fillRect(left, bottom, width, height);
}

function drawUvBounds(ctx: CanvasRenderingContext2D, scale: number): void {
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.lineWidth = 1.35 / scale;
    ctx.strokeStyle = 'rgba(47, 111, 179, 0.88)';
    ctx.stroke();
}

function drawUvSegments(
    ctx: CanvasRenderingContext2D,
    segments: Float32Array,
    scale: number,
): void {
    if (segments.length === 0) return;

    ctx.beginPath();
    for (let index = 0; index < segments.length; index += 4) {
        ctx.moveTo(segments[index], segments[index + 1]);
        ctx.lineTo(segments[index + 2], segments[index + 3]);
    }
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = 'rgba(16, 24, 32, 0.82)';
    ctx.stroke();
}

function buildTexturePatternTransform(slot: TextureSlotState): DOMMatrix {
    const rotation = (slot.rotation * Math.PI) / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const repeatX = normalizeTextureRepeat(slot.repeatX);
    const repeatY = normalizeTextureRepeat(slot.repeatY);
    const textureWidth = Math.max(slot.width ?? 1, 1);
    const textureHeight = Math.max(slot.height ?? 1, 1);
    const centerX = 0.5;
    const centerY = 0.5;

    const uvMatrix = new DOMMatrix([
        repeatX * cos,
        -repeatY * sin,
        repeatX * sin,
        repeatY * cos,
        -repeatX * (cos * centerX + sin * centerY) + centerX + slot.offsetX,
        -repeatY * (-sin * centerX + cos * centerY) + centerY + slot.offsetY,
    ]);

    const baseMatrix = new DOMMatrix([
        1 / textureWidth,
        0,
        0,
        -1 / textureHeight,
        0,
        1,
    ]);

    const inverse = uvMatrix.inverse();
    if (!isFiniteDomMatrix(inverse)) return baseMatrix;
    return inverse.multiply(baseMatrix);
}

function isDefaultTextureTransform(slot: TextureTransform): boolean {
    return nearlyEqual(slot.offsetX, 0)
        && nearlyEqual(slot.offsetY, 0)
        && nearlyEqual(slot.repeatX, 1)
        && nearlyEqual(slot.repeatY, 1)
        && nearlyEqual(slot.rotation, 0);
}

function normalizeTextureRepeat(value: number): number {
    return Number.isFinite(value) && Math.abs(value) > 1e-6 ? value : 1;
}

function isFiniteDomMatrix(matrix: DOMMatrix): boolean {
    return Number.isFinite(matrix.a)
        && Number.isFinite(matrix.b)
        && Number.isFinite(matrix.c)
        && Number.isFinite(matrix.d)
        && Number.isFinite(matrix.e)
        && Number.isFinite(matrix.f);
}

function ensureUvCanvasContext(): CanvasRenderingContext2D | null {
    const rect = uvEditorCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.round(rect.width * dpr));
    const nextHeight = Math.max(1, Math.round(rect.height * dpr));

    if (uvEditorCanvas.width !== nextWidth || uvEditorCanvas.height !== nextHeight) {
        uvEditorCanvas.width = nextWidth;
        uvEditorCanvas.height = nextHeight;
    }

    return uvEditorCanvas.getContext('2d');
}

function getUvPixelsPerUnit(): number {
    return getUvAxisScale().min;
}

function getUvAxisScale(): { x: number; y: number; min: number } {
    const rect = uvEditorCanvas.getBoundingClientRect();
    const textureWidth = Math.max(currentTextureSlotState?.width ?? Math.min(rect.width, rect.height), 1);
    const textureHeight = Math.max(currentTextureSlotState?.height ?? Math.min(rect.width, rect.height), 1);
    const scaleX = Math.max(64, textureWidth * uvView.zoom);
    const scaleY = Math.max(64, textureHeight * uvView.zoom);
    return {
        x: scaleX,
        y: scaleY,
        min: Math.max(64, Math.min(scaleX, scaleY)),
    };
}

function getUvScreenTransform(): UvScreenTransform {
    const rect = uvEditorCanvas.getBoundingClientRect();
    return {
        width: rect.width,
        height: rect.height,
        axisScale: getUvAxisScaleForRect(rect),
    };
}

function getUvAxisScaleForRect(rect: DOMRect): UvScreenTransform['axisScale'] {
    const textureWidth = Math.max(currentTextureSlotState?.width ?? Math.min(rect.width, rect.height), 1);
    const textureHeight = Math.max(currentTextureSlotState?.height ?? Math.min(rect.width, rect.height), 1);
    const scaleX = Math.max(64, textureWidth * uvView.zoom);
    const scaleY = Math.max(64, textureHeight * uvView.zoom);
    return {
        x: scaleX,
        y: scaleY,
        min: Math.max(64, Math.min(scaleX, scaleY)),
    };
}

function screenToUv(
    x: number,
    y: number,
    transform = getUvScreenTransform(),
): { x: number; y: number } {
    return {
        x: uvView.centerX + (x - transform.width / 2) / transform.axisScale.x,
        y: uvView.centerY - (y - transform.height / 2) / transform.axisScale.y,
    };
}

function resetUvView(): void {
    uvView.centerX = 0.5;
    uvView.centerY = 0.5;
    uvView.zoom = 1;
}

function bindNumericPair(
    range: HTMLInputElement,
    input: HTMLInputElement,
    onApply: (value: number) => void,
    hooks: {
        onBegin?: () => void;
        onCommit?: () => void;
    } = {},
): void {
    const min = Number(range.min || input.min || 0);
    const max = Number(range.max || input.max || 100);
    let editing = false;

    const normalize = (value: number): number => {
        if (!Number.isFinite(value)) return Number(range.value || input.value || 0);
        return clamp(value, min, max);
    };

    const begin = () => {
        if (editing) return;
        editing = true;
        hooks.onBegin?.();
    };

    const commit = () => {
        if (!editing) return;
        editing = false;
        hooks.onCommit?.();
    };

    const apply = (value: number) => {
        const next = normalize(value);
        const precision = range.step.includes('.') ? range.step.split('.')[1]?.length ?? 2 : 0;
        range.value = next.toFixed(precision);
        input.value = next.toFixed(precision);
        onApply(next);
    };

    range.addEventListener('pointerdown', begin);
    range.addEventListener('focus', begin);
    input.addEventListener('focus', begin);

    range.addEventListener('input', () => {
        begin();
        apply(Number(range.value));
    });
    range.addEventListener('change', () => {
        apply(Number(range.value));
        commit();
    });
    input.addEventListener('change', () => {
        begin();
        apply(Number(input.value));
        commit();
    });
    range.addEventListener('blur', commit);
    input.addEventListener('blur', commit);
}

function setNumericPairValue(
    range: HTMLInputElement,
    input: HTMLInputElement,
    value: number,
): void {
    const precision = range.step.includes('.') ? range.step.split('.')[1]?.length ?? 2 : 0;
    const next = Number.isFinite(value) ? value : Number(range.value || input.value || 0);
    range.value = next.toFixed(precision);
    input.value = next.toFixed(precision);
}

function showLoading(message: string): void {
    loadingCount += 1;
    loadingMessage = message;
    loadingText.textContent = message;
    loading.hidden = false;
    syncDocumentState();
}

function hideLoading(): void {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount > 0) return;
    loadingMessage = '';
    loading.hidden = true;
    syncDocumentState();
}

function showToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    toast.textContent = message;
    toast.className = `toast show ${type}`.trim();
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toast.classList.remove('show', 'success', 'error', 'info');
    }, 2600);
}

function applyLayout(): void {
    layoutState.inspectorWidth = clampInspectorWidth(layoutState.inspectorWidth);
    layoutState.leftSidebarWidth = clampLeftSidebarWidth(layoutState.leftSidebarWidth);

    root.style.setProperty('--inspector-width', `${layoutState.inspectorWidth}px`);
    root.style.setProperty('--left-sidebar-width', `${layoutState.leftSidebarWidth}px`);

    rightResizer.setAttribute('aria-valuemin', String(INSPECTOR_MIN_WIDTH));
    rightResizer.setAttribute('aria-valuemax', String(getMaxInspectorWidth()));
    rightResizer.setAttribute('aria-valuenow', String(layoutState.inspectorWidth));

    leftResizer.setAttribute('aria-valuemin', String(LEFT_SIDEBAR_MIN_WIDTH));
    leftResizer.setAttribute('aria-valuemax', String(getMaxLeftSidebarWidth()));
    leftResizer.setAttribute('aria-valuenow', String(layoutState.leftSidebarWidth));

    applyInspectorState();
    applyContentMode();
}

function setContentMode(mode: ContentMode): void {
    if (layoutState.contentMode === mode) return;
    layoutState.contentMode = mode;
    applyContentMode();
    persistLayout();
}

function applyContentMode(): void {
    const uvActive = layoutState.contentMode === 'uv';

    viewport.classList.toggle('active', !uvActive);
    uvWorkspace.classList.toggle('active', uvActive);

    btnModeModel.classList.toggle('active', !uvActive);
    btnModeModel.setAttribute('aria-pressed', String(!uvActive));
    btnModeUv.classList.toggle('active', uvActive);
    btnModeUv.setAttribute('aria-pressed', String(uvActive));

    requestAnimationFrame(() => {
        if (uvActive) renderUvEditor(currentTextureSlotState);
    });
}

function applyInspectorState(): void {
    inspectorTabs.forEach((button) => {
        const isActive = button.dataset.inspectorTab === layoutState.activeTab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', String(isActive));
        button.tabIndex = isActive ? 0 : -1;
    });

    inspectorViews.forEach((view) => {
        const isActive = view.dataset.inspectorView === layoutState.activeTab;
        view.classList.toggle('active', isActive);
        view.hidden = !isActive;
    });

    inspectorGroups.forEach((group) => {
        const id = group.dataset.groupId;
        if (!id) return;
        group.open = layoutState.groups[id] ?? true;
    });
}

function syncActiveInspectorControls(): void {
    syncPropertyPanel();

    if (layoutState.activeTab === 'animation') {
        syncAnimationEditor();
    } else if (layoutState.activeTab === 'textures') {
        syncTextureInspector();
    } else if (layoutState.activeTab === 'properties') {
        syncPropertyPanelCamera();
        syncMaterialControls({ syncTextures: false });
    }
}

function persistLayout(): void {
    try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutState));
    } catch {
        // Layout persistence is a convenience; editing and viewing should keep working if storage is blocked.
    }
}

function loadLayout(): LayoutState {
    try {
        const raw = localStorage.getItem(LAYOUT_KEY);
        if (!raw) return structuredClone(DEFAULT_LAYOUT);
        const source = JSON.parse(raw) as Partial<LayoutState>;
        return {
            inspectorWidth: typeof source.inspectorWidth === 'number'
                ? clampInspectorWidth(source.inspectorWidth)
                : DEFAULT_LAYOUT.inspectorWidth,
            leftSidebarWidth: typeof source.leftSidebarWidth === 'number'
                ? clampLeftSidebarWidth(source.leftSidebarWidth)
                : DEFAULT_LAYOUT.leftSidebarWidth,
            activeTab: isInspectorTab(source.activeTab) ? source.activeTab : DEFAULT_LAYOUT.activeTab,
            contentMode: isContentMode(source.contentMode) ? source.contentMode : DEFAULT_LAYOUT.contentMode,
            theme: isThemeMode(source.theme) ? source.theme : DEFAULT_LAYOUT.theme,
            groups: {
                ...DEFAULT_LAYOUT.groups,
                ...(typeof source.groups === 'object' && source.groups ? source.groups : {}),
            },
        };
    } catch {
        return structuredClone(DEFAULT_LAYOUT);
    }
}

function clampInspectorWidth(width: number): number {
    return clamp(width, INSPECTOR_MIN_WIDTH, getMaxInspectorWidth());
}

function getMaxInspectorWidth(): number {
    return Math.max(INSPECTOR_MIN_WIDTH, Math.min(520, Math.floor(window.innerWidth * 0.42)));
}

function clampLeftSidebarWidth(width: number): number {
    return clamp(width, LEFT_SIDEBAR_MIN_WIDTH, getMaxLeftSidebarWidth());
}

function getMaxLeftSidebarWidth(): number {
    return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(480, Math.floor(window.innerWidth * 0.38)));
}

function updateWindowTitle(name: string): void {
    if (!inNative) return;
    const title = name ? `MeshScope 3D - ${name}` : 'MeshScope 3D';
    void win.setTitle(title);
}

function setText(elements: HTMLElement[], value: string): void {
    elements.forEach((element) => {
        element.textContent = value;
    });
}

function formatVector(vector: { x: number; y: number; z: number }): string {
    return `${vector.x.toFixed(2)} × ${vector.y.toFixed(2)} × ${vector.z.toFixed(2)}`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement;
}

function isFileDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function isInspectorTab(value: unknown): value is InspectorTab {
    return value === 'overview' || value === 'properties' || value === 'animation' || value === 'textures';
}

function isContentMode(value: unknown): value is ContentMode {
    return value === 'model' || value === 'uv';
}

function isUvSelectionMode(value: unknown): value is UvSelectionMode {
    return value === 'vertex' || value === 'edge' || value === 'face';
}

function isMaterialEditMode(value: unknown): value is MaterialEditMode {
    return value === 'original' || value === 'solid' || value === 'xray';
}

function isThemeMode(value: unknown): value is ThemeMode {
    return value === 'light' || value === 'dark' || value === 'auto';
}

function isTextureSlotId(value: unknown): value is TextureSlotId {
    return value === 'map'
        || value === 'normalMap'
        || value === 'roughnessMap'
        || value === 'metalnessMap'
        || value === 'emissiveMap'
        || value === 'alphaMap'
        || value === 'aoMap'
        || value === 'bumpMap';
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function normalizeSearchText(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function createSampleModel(): Object3D {
    const geometry = new BoxGeometry(1.6, 1.6, 1.6);
    const material = new MeshStandardMaterial({
        color: 0x9bb4cc,
        metalness: 0.02,
        roughness: 0.82,
    });
    const cube = new Mesh(geometry, material);
    cube.name = '内置示例立方体';
    cube.position.y = 0.8;
    return cube;
}

function fileNameOfPath(path: string): string {
    const normalized = path.replaceAll('/', '\\');
    const index = normalized.lastIndexOf('\\');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

// Module bootstrap. Kept at file end so every `const`/`let` (especially
// mediaPrefersDark referenced via applyTheme) is past its TDZ before
// bootstrap runs synchronously.
try {
    applyLayout();
} catch (error) {
    showErrorBanner(`applyLayout: ${(error as Error)?.message ?? String(error)}`);
}
void bootstrap().catch((error) => {
    showErrorBanner(`bootstrap: ${(error as Error)?.message ?? String(error)}\n${(error as Error)?.stack ?? ''}`);
});
