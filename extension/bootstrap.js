// Classic content script whose only job is to pull in the ES-module engine.
// (Static content scripts can't be modules; dynamic import can.)
(async () => {
    try {
        await import(chrome.runtime.getURL('src/main.js'));
    } catch (e) {
        console.error('[Power Platform Easy Mode] failed to start:', e);
    }
})();
