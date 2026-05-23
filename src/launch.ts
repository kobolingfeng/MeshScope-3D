import { isSupported } from './loaders';

export function extractModelPathsFromUrls(urls: string[]): string[] {
    return urls.flatMap(extractModelPathsFromUrl);
}

function extractModelPathsFromUrl(value: string): string[] {
    try {
        const url = new URL(value);
        const values = [
            ...url.searchParams.getAll('file'),
            ...url.searchParams.getAll('path'),
            ...url.searchParams.getAll('model'),
        ];
        if (url.protocol === 'file:') values.push(fileUrlToPath(url));

        return values
            .map(normalizeUrlPathValue)
            .filter((path) => path && isSupported(path));
    } catch {
        return [];
    }
}

function fileUrlToPath(url: URL): string {
    const path = decodeUriPath(url.pathname);
    if (url.hostname) {
        return `\\\\${url.hostname}${path.replace(/\//g, '\\')}`;
    }
    return path;
}

function normalizeUrlPathValue(value: string): string {
    let next = value.trim();
    if (!next) return '';
    if (next.startsWith('/') && /^[A-Za-z]:/.test(next.slice(1))) {
        next = next.slice(1);
    }
    return next.replace(/\//g, '\\');
}

function decodeUriPath(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
