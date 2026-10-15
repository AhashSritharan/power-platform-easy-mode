// Turned-Off Highlighter (native).
// Tints solution-view rows whose status is "Off" in the Power Apps and
// Power Automate maker portals.

import { pageStyle } from '../core/ui.js';

const ROW_SELECTOR = '[data-automationid="DetailsRow"], [data-automationid="ListCell"]';

// The status is written in the browser's language and the cell holds nothing
// else to go by, so "off" is matched in every language the portal renders.
// Read from the live portal (2026-10-15), one browser locale at a time, off
// the same turned-off component — see tests/unit/off-status-highlighter.test.mjs.
const OFF_LABELS = new Set([
    'Off', 'Aus', 'Désactivé', 'Desactivado', 'Disattivato', 'Uit', 'Desativado', 'Fra', 'Av', 'Deaktivert',
    'Ei käytössä', 'Wyłączone', 'Vypnuto', 'Ki', 'Kapalı', 'Выкл.', 'オフ', '关闭', '關閉', '해제', 'Ανενεργό',
    'Dezactivat', 'Vypnuté', 'Izklopljeno', 'Isključeno', 'Изключено', 'Вимкн.', 'Väljas', 'Izslēgts',
    'Išjungta', 'Desactivat', 'Desaktibatuta', 'ปิด', 'Tắt', 'Nonaktif', 'Mati', 'כבוי', 'إيقاف', 'बंद',
    'Өшірулі', 'Искључено',
]);

/** Whether a status cell's text means "off". Hebrew wraps it in right-to-left marks. */
export const isOffLabel = (text) => OFF_LABELS.has(String(text ?? '').replace(/[‎‏]/g, '').trim());

function scan() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
        // ListCell wrapping a DetailsRow is handled via the inner row
        if (row.dataset.automationid === 'ListCell' && row.querySelector('[data-automationid="DetailsRow"]')) {
            row.classList.remove('ppt-off-row');
            continue;
        }
        const status = row.querySelector('[data-automation-key="status"]');
        row.classList.toggle('ppt-off-row', isOffLabel(status?.textContent));
    }
}

export default {
    init() {
        pageStyle('ppt-off-status-style', `
            /* Translucent overlay on the row's own background, so text stays
               readable whether the portal is light or dark, regardless of
               the OS theme. Keeps hover/selection colors underneath. */
            .ppt-off-row {
                background-image: linear-gradient(rgba(220, 38, 38, 0.18), rgba(220, 38, 38, 0.18)) !important;
                box-shadow: inset 3px 0 0 rgb(220, 38, 38);
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
