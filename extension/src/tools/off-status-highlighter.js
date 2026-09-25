// Off-Status Highlighter (native).
// Tints solution-view rows whose status is "Off" in the Power Apps and
// Power Automate maker portals.

import { pageStyle } from '../core/ui.js';

const ROW_SELECTOR = '[data-automationid="DetailsRow"], [data-automationid="ListCell"]';

function scan() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
        // ListCell wrapping a DetailsRow is handled via the inner row
        if (row.dataset.automationid === 'ListCell' && row.querySelector('[data-automationid="DetailsRow"]')) {
            row.classList.remove('ppt-off-row');
            continue;
        }
        const status = row.querySelector('[data-automation-key="status"]');
        row.classList.toggle('ppt-off-row', status?.textContent.trim() === 'Off');
    }
}

export default {
    init() {
        pageStyle('ppt-off-status-style', `
            .ppt-off-row { background-color: #ffcccc !important; }
            @media (prefers-color-scheme: dark) {
                .ppt-off-row { background-color: #5c2626 !important; }
            }
        `);

        // Rescan on DOM changes, coalesced to one scan per frame.
        let queued = false;
        const observer = new MutationObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; scan(); });
        });

        const start = () => {
            scan();
            observer.observe(document.body, { childList: true, subtree: true });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
        else start();
    },
};
