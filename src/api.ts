// 强强 API 精简封装 — 只暴露本应用用到的命令
import { invoke, on } from './ipc';

export const win = {
    setTitle:       (title: string) => invoke<boolean>('window.setTitle', { title }),
    minimize:       () => invoke<boolean>('window.minimize'),
    maximize:       () => invoke<boolean>('window.maximize'),
    restore:        () => invoke<boolean>('window.restore'),
    close:          () => invoke<boolean>('window.close'),
    isMaximized:    () => invoke<boolean>('window.isMaximized'),
    startDrag:      () => invoke<boolean>('window.startDrag'),
    startResize:    (edge: string) => invoke<boolean>('window.startResize', { edge }),
    isFrameless:    () => invoke<boolean>('window.isFrameless'),
    onResized:      (h: (d: { w: number; h: number }) => void) => on('window.resized', h),
    onFileDrop:     (h: (d: { files: string[]; x: number; y: number }) => void) => on('window.fileDrop', h),
};

export const dialog = {
    openFile: (opts?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }) =>
        invoke<string | string[] | null>('dialog.openFile', opts ?? {}),
    saveFile: (opts?: { filters?: { name: string; extensions: string[] }[]; defaultName?: string }) =>
        invoke<string | null>('dialog.saveFile', opts ?? {}),
    message: (title: string, message: string, type: 'info' | 'warning' | 'error' = 'info') =>
        invoke<boolean>('dialog.message', { title, message, type }),
};

export const fs = {
    readTextFile:   (path: string) => invoke<string>('fs.readTextFile', { path }),
    createGlbPreview: (path: string, minBytes = 512 * 1024 * 1024) =>
        invoke<{
            used: boolean;
            url?: string;
            path?: string;
            reason?: string;
            originalBytes?: number;
            previewBytes?: number;
            animationsRemoved?: number;
            accessorsKept?: number;
            bufferViewsKept?: number;
        }>('fs.createGlbPreview', {
            path,
            minBytes,
            protocol: typeof window !== 'undefined' ? window.location.protocol : 'http:',
        }),
    localFileUrl:   (path: string) => invoke<string>('fs.localFileUrl', {
        path,
        protocol: typeof window !== 'undefined' ? window.location.protocol : 'http:',
    }),
    readBase64File: (path: string) => invoke<string>('fs.readBase64File', { path }),
    writeTextFile:  (path: string, content: string) => invoke<boolean>('fs.writeTextFile', { path, content }),
    writeBase64File: (path: string, content: string) =>
        invoke<boolean>('fs.writeBase64File', { path, content }),
};

export const app = {
    exit:                     (code = 0) => invoke<boolean>('app.exit', { code }),
    dataDir:                  () => invoke<string>('app.dataDir'),
    consumeLaunchFiles:       () => invoke<string[]>('app.consumeLaunchFiles'),
    consumeLaunchUrls:        () => invoke<string[]>('app.consumeLaunchUrls'),
    registerFileAssociations: (extensions: string[]) =>
        invoke<boolean>('app.registerFileAssociations', { extensions }),
    onOpenFiles:              (h: (d: { files: string[] }) => void) => on('app.openFiles', h),
    onOpenUrls:               (h: (d: { urls: string[] }) => void) => on('app.openUrls', h),
};
