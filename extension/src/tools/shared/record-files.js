// File and image columns, shared by the Record Editor and the Record Browser.
//
// Neither holds its content on the record. Read with the record, a file
// column gives the file's id and `<column>_name` its name; an image column
// gives a ~144px thumbnail as base64. The content itself is at
// /<entityset>(<id>)/<column>/$value — `?size=full` for the full image — and
// comes back as bytes, which core/http.js (text only) cannot carry. These are
// fetched here directly; both tools run on the org's own pages, so it is a
// same-origin request on the user's own session.
//
// Microsoft documents 16 MB as the most one GET returns and Range requests
// (206 + x-ms-file-size) for anything larger. A 2026 org still sent a 20 MB
// file whole, but ranges work at every size, so every download goes in 4 MB
// ranges: a small file simply arrives in one piece. Checked against 10.5 MB
// and 20 MB files on a live org, byte for byte.

import { HttpError } from '../../core/http.js';
import * as ui from '../../core/ui.js';

const API = '/api/data/v9.2';
const CHUNK = 4 * 1024 * 1024;

const valueUrl = (entitySetName, recordId, column, query = '') =>
    `${location.origin}${API}/${entitySetName}(${recordId})/${column}/$value${query}`;

async function getBytes(url, range) {
    const response = await fetch(url, {
        credentials: 'include',
        headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', ...(range ? { Range: range } : {}) },
    });
    if (!response.ok) throw new HttpError(response.status, response.statusText, await response.text());
    return response;
}

/** A file column's content as { blob, name }, fetched in 4 MB chunks. */
export async function fetchFileColumn(entitySetName, recordId, column) {
    const url = valueUrl(entitySetName, recordId, column);
    const parts = [];
    let offset = 0;
    let total = null;
    let name = null;
    let type = '';
    for (;;) {
        const response = await getBytes(url, `bytes=${offset}-${offset + CHUNK - 1}`);
        name ??= response.headers.get('x-ms-file-name');
        type ||= response.headers.get('content-type') ?? '';
        const chunk = await response.arrayBuffer();
        parts.push(chunk);
        offset += chunk.byteLength;
        // 200 is the whole file at once; only a 206 has more to come.
        if (response.status !== 206 || !chunk.byteLength) break;
        total ??= Number(response.headers.get('x-ms-file-size'))
            || Number(response.headers.get('content-range')?.split('/')[1]) || null;
        if (total != null ? offset >= total : chunk.byteLength < CHUNK) break;
    }
    return { blob: new Blob(parts, type ? { type } : {}), name };
}

/**
 * The full-size image; an image column that keeps no full size (CanStoreFullImage
 * off, as on the standard entityimage) gives its thumbnail. Such a column
 * answers `?size=full` with 204 and no body, not with an error.
 */
export async function fetchImageColumn(entitySetName, recordId, column) {
    let response = null;
    try {
        response = await getBytes(valueUrl(entitySetName, recordId, column, '?size=full'));
    } catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
    }
    let blob = response?.status === 200 ? await response.blob() : null;
    if (!blob?.size) {
        response = await getBytes(valueUrl(entitySetName, recordId, column));
        blob = await response.blob();
    }
    return { blob, name: response.headers.get('x-ms-file-name') };
}

export function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = ui.el('a', { href: url, download: fileName || 'download' });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function failed(what, e) {
    let message = e.message;
    try { message = JSON.parse(e.body)?.error?.message ?? message; } catch { /* not json */ }
    ui.toast(`⚠️ Could not ${what}: ${message}`, 6000);
}

export async function downloadFile({ entitySetName, recordId, column, fileName }) {
    ui.toast(`⬇ Downloading ${fileName || 'file'}…`, 2000);
    try {
        const { blob, name } = await fetchFileColumn(entitySetName, recordId, column);
        saveBlob(blob, name || fileName);
    } catch (e) {
        failed('download the file', e);
    }
}

/** The full image in a dialog, with a download button. */
export function showImage({ entitySetName, recordId, column, title }) {
    let objectUrl = null;
    let loaded = null;
    ui.modal({
        title,
        width: '860px',
        onClose: () => { if (objectUrl) URL.revokeObjectURL(objectUrl); },
        render: (body, close) => {
            body.append(ui.el('div', { className: 'ppt-note', textContent: 'Loading image…' }));
            const footer = ui.el('div', { className: 'ppt-dialog-footer' });
            const download = ui.el('button', {
                className: 'ppt-btn', textContent: '⬇ Download', disabled: true,
                onclick: () => saveBlob(loaded.blob, loaded.name || `${column}.jpg`),
            });
            footer.append(download, ui.el('button', { className: 'ppt-btn primary', textContent: 'Close', onclick: close }));
            body.after(footer);
            fetchImageColumn(entitySetName, recordId, column).then((image) => {
                loaded = image;
                objectUrl = URL.createObjectURL(image.blob);
                body.replaceChildren(ui.el('img', {
                    src: objectUrl, alt: title,
                    style: 'display:block;max-width:100%;max-height:70vh;margin:0 auto;object-fit:contain',
                }));
                download.disabled = false;
            }).catch((e) => {
                close();
                failed('load the image', e);
            });
        },
    });
}

/** A file column's value as a download link; null when the column is empty. */
export function fileLink({ entitySetName, recordId, column, fileName, hasFile }) {
    if (!hasFile) return null;
    return ui.el('span', {
        className: 'ppt-file-link', textContent: `⬇ ${fileName || 'Download file'}`, title: 'Download this file',
        style: 'color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px',
        onclick: (e) => { e.stopPropagation(); downloadFile({ entitySetName, recordId, column, fileName }); },
    });
}

/** An image column's thumbnail that opens the full image; null when empty. */
export function imageThumb({ entitySetName, recordId, column, thumbnail, title, size = 32 }) {
    if (!thumbnail) return null;
    return ui.el('img', {
        src: `data:image/jpeg;base64,${thumbnail}`, alt: title, title: 'Show the full image',
        style: `height:${size}px;max-width:${size * 3}px;object-fit:contain;border-radius:3px;cursor:zoom-in;vertical-align:middle;background:#fff`,
        onclick: (e) => { e.stopPropagation(); showImage({ entitySetName, recordId, column, title }); },
    });
}
