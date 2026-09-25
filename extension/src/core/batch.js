// OData $batch change sets for the Dataverse Web API.
//
// A change set is the only way to write a record graph in ONE request and have
// it roll back as a unit: Dataverse runs the operations in the order given, and
// any failure undoes the whole set. That ordering is also what makes references
// work — an operation may point at a record an EARLIER operation created, never
// a later one (a forward reference is a hard 400, "Content-ID Reference '$1'
// does not exist in the batch context"), so callers must add operations in
// dependency order.
//
// Deep insert can also write a graph atomically, but only a tree: every nested
// object is an unconditional create, so a record referenced twice is created
// twice, and it cannot update anything. Change sets have neither limit.
//
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api

import { request } from './http.js';

// Dataverse caps a batch at 1000 operations. Past that the caller has to split,
// which costs the single-request and single-transaction properties both — so
// this is surfaced as an error rather than silently chunked.
export const MAX_BATCH_OPERATIONS = 1000;

// The HTTP spec requires CRLF between multipart headers; Dataverse fails
// deserialization ("Stream was not readable") on bare newlines.
const CRLF = '\r\n';

const uniqueId = () => Math.random().toString(36).slice(2, 10);

/**
 * An ordered, atomic group of writes. `create` returns a `$N` content-ID
 * reference usable as an @odata.bind value (or as the target of a later
 * update) by any operation added AFTER it.
 */
export class ChangeSet {
    constructor() {
        /** @type {{method: string, url: string, body: ?object, contentId: number}[]} */
        this.operations = [];
    }

    get length() { return this.operations.length; }

    #add(method, url, body) {
        const contentId = this.operations.length + 1;
        this.operations.push({ method, url, body, contentId });
        return `$${contentId}`;
    }

    /** @returns {string} the `$N` reference for this new record */
    create(entitySet, record) { return this.#add('POST', `/${entitySet}`, record); }

    /** `idOrRef` may be a GUID or a `$N` reference returned by an earlier create. */
    update(entitySet, idOrRef, record) {
        return this.#add('PATCH', this.#target(entitySet, idOrRef), record);
    }

    delete(entitySet, idOrRef) {
        return this.#add('DELETE', this.#target(entitySet, idOrRef), null);
    }

    // A $N reference already IS the record's URI, so it replaces the whole
    // "/set(id)" path rather than sitting inside it.
    #target(entitySet, idOrRef) {
        return String(idOrRef).startsWith('$') ? String(idOrRef) : `/${entitySet}(${idOrRef})`;
    }

    /**
     * Serializes to the multipart body of a single change set.
     *
     * `extraHeaders` is repeated on every operation because headers set on the
     * $batch request itself do NOT reach the operations inside it — each item
     * carries its own. Impersonation would silently do nothing otherwise.
     */
    render(base, boundary, extraHeaders = {}) {
        const parts = [];
        for (const { method, url, body, contentId } of this.operations) {
            const absolute = url.startsWith('$') ? url : base + url;
            const headers = [
                `--${boundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                `Content-ID: ${contentId}`,
                '',
                `${method} ${absolute} HTTP/1.1`,
                'OData-MaxVersion: 4.0',
                'OData-Version: 4.0',
                'Accept: application/json',
                ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
            ];
            if (body != null) headers.push('Content-Type: application/json; type=entry');
            parts.push(headers.join(CRLF) + CRLF + CRLF + (body != null ? JSON.stringify(body) : ''));
        }
        return parts.join(CRLF) + CRLF + `--${boundary}--`;
    }
}

/** The first error in a batch response body, unwrapped from its JSON envelope. */
function extractError(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    try {
        const parsed = JSON.parse(text.slice(start));
        return parsed?.error?.message ?? null;
    } catch { return null; }
}

/**
 * Per-item results, in request order. Dataverse answers a failed change set
 * with a single error part rather than one part per operation, so a rejected
 * set yields one failing entry — which is the whole story anyway, since the
 * rest rolled back.
 */
function parseBatchResponse(text) {
    const results = [];
    // Each part restates the inner HTTP status line; that is the only marker
    // that reliably separates results across nested multipart boundaries.
    const pattern = /^HTTP\/1\.1 (\d{3})([^\r\n]*)$/gm;
    const matches = [...text.matchAll(pattern)];

    for (const [index, match] of matches.entries()) {
        const bodyStart = match.index + match[0].length;
        const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
        const part = text.slice(bodyStart, bodyEnd);
        const status = Number(match[1]);
        results.push({
            status,
            ok: status >= 200 && status < 300,
            entityId: part.match(/^OData-EntityId:\s*(\S+)/mi)?.[1] ?? null,
            error: status >= 400 ? (extractError(part) ?? match[2].trim() ?? `HTTP ${status}`) : null,
        });
    }
    return results;
}

export class BatchError extends Error {
    constructor(message, results) {
        super(message);
        this.results = results;
    }
}

/**
 * Sends one or more change sets as a single $batch request.
 *
 * @param {{base: string}} client  a Dataverse client (its `base` is the service root)
 * @param {ChangeSet[]} changeSets
 * @returns {Promise<object[]>} per-operation results, in order
 * @throws {BatchError} if any operation failed — the change set has rolled back
 */
export async function sendBatch(client, changeSets) {
    const total = changeSets.reduce((sum, set) => sum + set.length, 0);
    if (!total) return [];
    if (total > MAX_BATCH_OPERATIONS) {
        throw new Error(`A batch cannot exceed ${MAX_BATCH_OPERATIONS} operations (this one needs ${total}).`);
    }

    const batchBoundary = `batch_${uniqueId()}`;
    const perOperation = client.defaultHeaders ?? {};
    const sections = changeSets.filter((set) => set.length).map((set) => {
        const changeSetBoundary = `changeset_${uniqueId()}`;
        return [
            `--${batchBoundary}`,
            `Content-Type: multipart/mixed; boundary=${changeSetBoundary}`,
            '',
            set.render(client.base, changeSetBoundary, perOperation),
        ].join(CRLF);
    });
    const body = sections.join(CRLF) + CRLF + `--${batchBoundary}--` + CRLF;

    let text;
    try {
        ({ text } = await request({
            url: `${client.base}/$batch`,
            method: 'POST',
            headers: {
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                'Accept': 'application/json',
                'Content-Type': `multipart/mixed; boundary=${batchBoundary}`,
            },
            body,
            credentials: true,
        }));
    } catch (e) {
        // A batch can fail at the transport level too, and then the only thing
        // that says WHY is the multipart body the HttpError carries. Without
        // this the caller sees a bare "HTTP 400" and the real message — the
        // rejected column, the malformed property — is thrown away.
        const inner = e.body ? parseBatchResponse(e.body).find((result) => !result.ok) : null;
        if (inner?.error) throw new BatchError(inner.error, [inner]);
        throw e;
    }

    // A batch usually answers 200 even when the operations inside it failed,
    // so the parts are the only place the real outcome shows up.
    const results = parseBatchResponse(text);
    const failure = results.find((result) => !result.ok);
    if (failure) throw new BatchError(failure.error ?? `Batch operation failed (HTTP ${failure.status}).`, results);
    return results;
}
