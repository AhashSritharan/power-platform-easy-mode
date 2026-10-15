/**
 * Turned-Off Highlighter — which status labels mean "off". The maker portal
 * writes the status in the browser's language, so English alone missed every
 * other user. The pairs below were read from the live portal (2026-10-15) in
 * each language, for one turned-on and one turned-off component of the same
 * solution — on the left what "On" reads as, on the right "Off".
 * Run: node --test tests/unit/off-status-highlighter.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
globalThis.chrome = { runtime: { id: 'test' } };
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };
const { isOffLabel } = await import(pathToFileURL(join(ROOT, 'extension/src/tools/off-status-highlighter.js')));

const LIVE = {
    'en-US': ['On', 'Off'], 'de-DE': ['Ein', 'Aus'], 'fr-FR': ['Activé', 'Désactivé'], 'es-ES': ['Activado', 'Desactivado'],
    'it-IT': ['Attivato', 'Disattivato'], 'nl-NL': ['Aan', 'Uit'], 'pt-BR': ['Ativado', 'Desativado'], 'pt-PT': ['Ativado', 'Desativado'],
    'da-DK': ['Til', 'Fra'], 'sv-SE': ['På', 'Av'], 'nb-NO': ['Aktivert', 'Deaktivert'], 'fi-FI': ['Käytössä', 'Ei käytössä'],
    'pl-PL': ['Włączone', 'Wyłączone'], 'cs-CZ': ['Zapnuto', 'Vypnuto'], 'hu-HU': ['Be', 'Ki'], 'tr-TR': ['Açık', 'Kapalı'],
    'ru-RU': ['Вкл.', 'Выкл.'], 'ja-JP': ['オン', 'オフ'], 'zh-CN': ['打开', '关闭'], 'zh-TW': ['開啟', '關閉'],
    'ko-KR': ['설정', '해제'], 'el-GR': ['Ενεργό', 'Ανενεργό'], 'ro-RO': ['Activat', 'Dezactivat'], 'sk-SK': ['Zapnuté', 'Vypnuté'],
    'sl-SI': ['Vklopljeno', 'Izklopljeno'], 'hr-HR': ['Uključeno', 'Isključeno'], 'bg-BG': ['Вкл.', 'Изключено'], 'uk-UA': ['Увімкн.', 'Вимкн.'],
    'et-EE': ['Sees', 'Väljas'], 'lv-LV': ['Ieslēgts', 'Izslēgts'], 'lt-LT': ['Įjungta', 'Išjungta'], 'ca-ES': ['Activat', 'Desactivat'],
    'eu-ES': ['Aktibatuta', 'Desaktibatuta'], 'gl-ES': ['Activado', 'Desactivado'], 'th-TH': ['เปิด', 'ปิด'], 'vi-VN': ['Bật', 'Tắt'],
    'id-ID': ['Aktif', 'Nonaktif'], 'ms-MY': ['Hidup', 'Mati'], 'he-IL': ['‏‏פועל', '‏‏כבוי'], 'ar-SA': ['تشغيل', 'إيقاف'],
    'hi-IN': ['चालू', 'बंद'], 'kk-KZ': ['Қосулы', 'Өшірулі'], 'sr-Latn-RS': ['Uključeno', 'Isključeno'], 'sr-Cyrl-RS': ['Укључено', 'Искључено'],
};

test('"Off" is recognised in every language the portal renders', () => {
    for (const [locale, [, off]] of Object.entries(LIVE)) assert.equal(isOffLabel(off), true, `${locale}: "${off}"`);
});

test('"On" is never mistaken for "Off", in any language', () => {
    for (const [locale, [on]] of Object.entries(LIVE)) assert.equal(isOffLabel(on), false, `${locale}: "${on}"`);
});

test('the cell\'s whitespace and an empty status do not count', () => {
    assert.equal(isOffLabel('  Aus \n'), true);
    assert.equal(isOffLabel(''), false);
    assert.equal(isOffLabel(undefined), false);
});
