// Minimal Dataverse Web API client.
//
// Works against the current org (same-origin) or any other environment the
// user is signed in to (cross-origin, relayed via the service worker with the
// user's own cookies). One shared client instead of each tool hand-rolling
// its OData plumbing.

import { request } from './http.js';
import { ChangeSet, sendBatch } from './batch.js';

const API = '/api/data/v9.2';

const ODATA_HEADERS = {
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    'Accept': 'application/json',
};

export class Dataverse {
    /** @param {string} [orgUrl] e.g. "https://myorg.crm.dynamics.com"; defaults to current origin */
    constructor(orgUrl) {
        this.base = (orgUrl ?? location.origin).replace(/\/+$/, '') + API;
        /**
         * Headers added to every request this client makes. Impersonation
         * (MSCRMCallerID) lives here so it cannot be forgotten at one call
         * site out of several — the client, not each caller, decides who the
         * requests are made as.
         */
        this.defaultHeaders = {};
    }

    /** Acts as the given user for every subsequent request; empty clears it. */
    impersonate(userId) {
        if (userId) this.defaultHeaders.MSCRMCallerID = String(userId).replace(/[{}]/g, '').toLowerCase();
        else delete this.defaultHeaders.MSCRMCallerID;
        return this;
    }

    /** GET an API path (or a full URL, e.g. an @odata.nextLink). */
    async get(path, headers = {}) {
        const response = await request({
            url: path.startsWith('http') ? path : this.base + path,
            headers: { ...ODATA_HEADERS, ...this.defaultHeaders, ...headers },
            credentials: true,
        });
        return response.json();
    }

    async send(method, path, body) {
        const response = await request({
            url: this.base + path,
            method,
            headers: { ...ODATA_HEADERS, 'Content-Type': 'application/json', ...this.defaultHeaders },
            body: body != null ? JSON.stringify(body) : null,
            credentials: true,
        });
        return response.status === 204 ? null : response.json();
    }

    create(entitySet, record) { return this.send('POST', `/${entitySet}`, record); }
    update(entitySet, id, record) { return this.send('PATCH', `/${entitySet}(${id})`, record); }
    delete(entitySet, id) { return this.send('DELETE', `/${entitySet}(${id})`); }

    /** An empty change set to fill and hand back to {@link batch}. */
    changeSet() { return new ChangeSet(); }

    /** Runs change sets as one atomic $batch request. See core/batch.js. */
    batch(changeSets) { return sendBatch(this, [].concat(changeSets)); }

    /**
     * Current org details, incl. the BAP EnvironmentId — replaces the old
     * MAIN-world dependency on Xrm.Utility.getGlobalContext().
     */
    async retrieveCurrentOrganization() {
        const data = await this.get(`/RetrieveCurrentOrganization(AccessType='Default')`);
        return data?.Detail ?? null;
    }
}
