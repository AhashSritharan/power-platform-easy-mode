// Flow Expression Validator (native).
// Validates Power Automate flow expressions: finds references to actions,
// triggers, variables and parameters that don't exist in the definition, with
// "did you mean" suggestions. Pulls the definition from Dataverse (workflows
// clientdata) or accepts pasted JSON as a fallback.

import * as ui from '../core/ui.js';
import * as commands from '../core/commands.js';
import {
    clearOrgUrlCache,
    describeLookupFailure,
    flowContextFromUrl,
    parseFlowDefinitionJson,
    resolveFlowDefinition,
    resolveOrgUrl,
} from './shared/flow-source.js';

const STYLE = `
    .fev-stats { display: flex; gap: 24px; padding: 14px 20px; background: var(--bg2); border-radius: 6px; margin-bottom: 18px; }
    .fev-stat { display: flex; flex-direction: column; align-items: center; }
    .fev-stat .v { font-size: 24px; font-weight: 600; color: var(--accent); }
    .fev-stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .fev-issue { border: 1px solid #F1BBBC; border-left: 4px solid #D13438; border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
    .fev-issue-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; background: #FDE7E9; }
    .fev-issue-badge { background: #D13438; color: #fff; font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
    .fev-issue-fn { font-family: Consolas, monospace; font-size: 13px; color: #A4262C; font-weight: 600; }
    .fev-issue-body { padding: 12px 14px; }
    .fev-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; font-size: 12px; }
    .fev-row .l { color: var(--muted); min-width: 120px; }
    .fev-code { font-family: Consolas, monospace; font-size: 12px; background: var(--bg2); padding: 2px 6px; border-radius: 3px; }
    .fev-suggestion { background: #DFF6DD; color: #107C10; font-size: 12px; padding: 2px 8px; border-radius: 3px; font-weight: 500; }
    .fev-ok { text-align: center; padding: 32px; background: #DFF6DD; border: 1px solid #A7E3A5; border-radius: 8px; color: #107C10; }
    @media (prefers-color-scheme: dark) {
        .fev-issue { border-color: #6b2a2e; }
        .fev-issue-head { background: #3a1416; }
        .fev-issue-fn { color: #F1707B; }
        .fev-suggestion { background: #10380f; color: #6CCB5F; }
        .fev-ok { background: #10380f; border-color: #1f5c1d; color: #6CCB5F; }
    }
    .fev-count { background: #FDE7E9; color: #D13438; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 12px; margin-left: 10px; vertical-align: middle; }
    .fev-names { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px; background: var(--bg2); border-radius: 4px; margin-top: 8px; }
    .fev-names code { font-family: Consolas, monospace; font-size: 11px; background: var(--bg); border: 1px solid var(--border); padding: 2px 6px; border-radius: 3px; }
    .fev-details summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--accent); padding: 8px 0; }
    .fev-json {
        width: 100%; height: 280px; padding: 12px; box-sizing: border-box;
        font-family: Consolas, monospace; font-size: 12px; resize: vertical;
        border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text);
    }
    .fev-steps { margin: 0 0 12px; padding-left: 20px; color: var(--muted); font-size: 13px; line-height: 1.6; }
`;

// ── Expression analysis (framework-free, ported intact) ───────────────────
const REFERENCE_FUNCTIONS = [
    'outputs', 'body', 'items', 'iterationIndexes', 'triggerOutputs', 'triggerBody',
    'actionOutputs', 'actionBody', 'actions', 'result', 'variables', 'parameters',
];

function extractAllActionNames(definition) {
    const actions = new Set();
    const visited = new WeakSet();

    function walk(obj, path = '') {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        if (obj.actions && typeof obj.actions === 'object') {
            for (const [name, action] of Object.entries(obj.actions)) {
                actions.add(name);
                walk(action, `${path}/${name}`);
            }
        }
        if (obj.runAfter && typeof obj.runAfter === 'object') {
            for (const name of Object.keys(obj.runAfter)) actions.add(name);
        }
        if (obj.else?.actions) walk({ actions: obj.else.actions }, path + '/else');
        if (obj.cases && typeof obj.cases === 'object') {
            for (const [caseName, caseObj] of Object.entries(obj.cases)) {
                if (caseObj?.actions) walk({ actions: caseObj.actions }, `${path}/cases/${caseName}`);
            }
        }
        if (obj.default?.actions) walk({ actions: obj.default.actions }, path + '/default');
    }

    if (definition.actions) {
        for (const [name, action] of Object.entries(definition.actions)) {
            actions.add(name);
            walk(action, name);
        }
    }
    return actions;
}

function extractAllVariableNames(definition) {
    const variables = new Set();
    const visited = new WeakSet();

    function walk(obj) {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        if (obj.type === 'InitializeVariable' && obj.inputs?.variables) {
            for (const v of obj.inputs.variables) if (v.name) variables.add(v.name);
        }
        for (const container of [obj.actions, obj.else?.actions, obj.default?.actions]) {
            if (container) for (const action of Object.values(container)) walk(action);
        }
        if (obj.cases) {
            for (const caseObj of Object.values(obj.cases)) {
                if (caseObj?.actions) for (const action of Object.values(caseObj.actions)) walk(action);
            }
        }
    }

    if (definition.actions) for (const action of Object.values(definition.actions)) walk(action);
    return variables;
}

function findExpressionsInValue(value, path, actionName, visited = new WeakSet()) {
    const expressions = [];
    if (typeof value === 'string') {
        const pattern = /@\{([^}]+)\}|@([a-zA-Z_][a-zA-Z0-9_]*\([^)]*\))/g;
        let match;
        while ((match = pattern.exec(value)) !== null) {
            expressions.push({ expression: match[1] || match[2], location: path, actionName });
        }
        if (/\b(outputs|body|variables|items|triggerOutputs|triggerBody|actions|parameters)\(/.test(value)) {
            expressions.push({ expression: value, location: path, actionName });
        }
    } else if (Array.isArray(value)) {
        value.forEach((item, idx) => {
            if (item && typeof item === 'object') {
                if (visited.has(item)) return;
                visited.add(item);
            }
            expressions.push(...findExpressionsInValue(item, `${path}[${idx}]`, actionName, visited));
        });
    } else if (value && typeof value === 'object') {
        if (visited.has(value)) return expressions;
        visited.add(value);
        for (const [key, val] of Object.entries(value)) {
            expressions.push(...findExpressionsInValue(val, `${path}.${key}`, actionName, visited));
        }
    }
    return expressions;
}

function findAllExpressionsInDefinition(definition) {
    const all = [];
    const visited = new WeakSet();

    function walkAction(action, actionName, path) {
        if (!action || typeof action !== 'object' || visited.has(action)) return;
        visited.add(action);
        for (const prop of ['inputs', 'expression', 'foreach']) {
            if (action[prop]) all.push(...findExpressionsInValue(action[prop], `${path}/${prop}`, actionName));
        }
        const walkContainer = (container, subPath) => {
            if (!container) return;
            for (const [name, nested] of Object.entries(container)) {
                walkAction(nested, name, `${path}/${subPath}/${name}`);
            }
        };
        walkContainer(action.actions, 'actions');
        walkContainer(action.else?.actions, 'else/actions');
        if (action.cases) {
            for (const [caseName, caseObj] of Object.entries(action.cases)) {
                walkContainer(caseObj?.actions, `cases/${caseName}/actions`);
            }
        }
        walkContainer(action.default?.actions, 'default/actions');
    }

    if (definition.triggers) {
        for (const [name, trigger] of Object.entries(definition.triggers)) {
            if (trigger?.inputs) {
                all.push(...findExpressionsInValue(trigger.inputs, `triggers/${name}/inputs`, `[Trigger: ${name}]`));
            }
        }
    }
    if (definition.actions) {
        for (const [name, action] of Object.entries(definition.actions)) walkAction(action, name, `actions/${name}`);
    }
    return all;
}

function levenshtein(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i - 1] === a[j - 1]
                ? matrix[i - 1][j - 1]
                : Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
        }
    }
    return matrix[b.length][a.length];
}

function findSimilarNames(name, validNames) {
    const suggestions = [];
    const lower = name.toLowerCase();
    for (const valid of validNames) {
        const lowerValid = valid.toLowerCase();
        if (lower === lowerValid && name !== valid) suggestions.push({ name: valid, reason: 'case mismatch' });
        else if (lowerValid.includes(lower) || lower.includes(lowerValid)) suggestions.push({ name: valid, reason: 'partial match' });
        else {
            const distance = levenshtein(lower, lowerValid);
            if (distance <= 3 && distance < lower.length / 2) suggestions.push({ name: valid, reason: 'similar spelling' });
        }
    }
    return suggestions.slice(0, 3);
}

export function validateExpressions(definition) {
    const actionNames = extractAllActionNames(definition);
    const triggerNames = new Set(Object.keys(definition.triggers ?? {}));
    const variableNames = extractAllVariableNames(definition);
    const parameterNames = new Set(Object.keys(definition.parameters ?? {}));

    const allExpressions = findAllExpressionsInDefinition(definition);
    const referenceRegex = new RegExp(`(${REFERENCE_FUNCTIONS.join('|')})\\s*\\(\\s*['"](.*?)['"]`, 'gi');
    const issues = [];

    for (const exprInfo of allExpressions) {
        let match;
        referenceRegex.lastIndex = 0;
        while ((match = referenceRegex.exec(exprInfo.expression)) !== null) {
            const functionName = match[1].toLowerCase();
            const referencedName = match[2];
            let isValid = false;
            let expectedType = '';

            switch (functionName) {
                case 'outputs': case 'body': case 'actionoutputs': case 'actionbody':
                case 'actions': case 'result':
                    isValid = actionNames.has(referencedName); expectedType = 'action'; break;
                case 'items': case 'iterationindexes':
                    isValid = actionNames.has(referencedName); expectedType = 'ForEach loop'; break;
                case 'triggeroutputs': case 'triggerbody':
                    isValid = triggerNames.has(referencedName) || referencedName === ''; expectedType = 'trigger'; break;
                case 'variables':
                    isValid = variableNames.has(referencedName); expectedType = 'variable'; break;
                case 'parameters':
                    isValid = parameterNames.has(referencedName); expectedType = 'parameter'; break;
            }

            if (!isValid && referencedName) {
                issues.push({
                    functionName, referencedName, expectedType,
                    location: exprInfo.location,
                    actionName: exprInfo.actionName,
                    suggestion: findSimilarNames(referencedName,
                        expectedType === 'variable' ? variableNames
                            : expectedType === 'parameter' ? parameterNames : actionNames),
                });
            }
        }
    }

    return {
        issues,
        stats: {
            actionCount: actionNames.size,
            triggerCount: triggerNames.size,
            variableCount: variableNames.size,
            expressionCount: allExpressions.length,
            actions: [...actionNames],
            variables: [...variableNames],
        },
    };
}

// ── Dialogs ───────────────────────────────────────────────────────────────
function showManualInputDialog({ orgUrl, error } = {}) {
    const { flowId } = flowContextFromUrl();
    const textarea = ui.el('textarea', {
        className: 'fev-json',
        placeholder: 'Paste flow definition JSON here…\n\nAccepts: full export with properties.definition, a direct definition with triggers/actions, or the clientdata string from an API response.',
    });
    ui.modal({
        title: '🔍 Paste Flow Definition JSON',
        width: 'min(700px, 92vw)',
        render: (body) => {
            body.append(
                ui.el('div', { className: 'ppt-note', textContent: orgUrl
                    ? `${describeLookupFailure(orgUrl, error)} Export the solution and open Workflows/*.json, or copy clientdata from a DevTools network response.`
                    : 'Could not auto-detect the flow definition. Export the solution and open Workflows/*.json, or copy clientdata from a DevTools network response.' }),
                ...(flowId ? [ui.el('div', { className: 'ppt-note', textContent: `Detected flow ID: ${flowId}` })] : []),
                textarea,
            );
            setTimeout(() => textarea.focus(), 0);
        },
        buttons: [
            { label: 'Cancel', onClick: (close) => close() },
            {
                label: 'Validate', primary: true,
                onClick: (close) => {
                    try {
                        const definition = parseFlowDefinitionJson(textarea.value);
                        close();
                        showResultsDialog(validateExpressions(definition));
                    } catch (e) {
                        ui.toast(`❌ ${e.message}`, 4500);
                    }
                },
            },
        ],
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

function showResultsDialog(results) {
    const { issues, stats } = results;
    ui.modal({
        title: 'Expression Validation Results',
        width: 'min(800px, 92vw)',
        render: (body) => {
            // Modal titles are plain text; add the issue-count badge to the heading here.
            if (issues.length) {
                body.closest('.ppt-dialog').querySelector('h2').append(
                    ui.el('span', { className: 'fev-count', textContent: `${issues.length} issue${issues.length > 1 ? 's' : ''}` }),
                );
            }

            const statsBar = ui.el('div', { className: 'fev-stats' },
                [['Actions', stats.actionCount], ['Triggers', stats.triggerCount], ['Variables', stats.variableCount], ['Expressions', stats.expressionCount]]
                    .map(([labelText, value]) => ui.el('div', { className: 'fev-stat' }, [
                        ui.el('span', { className: 'v', textContent: String(value) }),
                        ui.el('span', { className: 'l', textContent: labelText }),
                    ])));
            body.append(statsBar);

            if (!issues.length) {
                body.append(ui.el('div', { className: 'fev-ok', innerHTML: '<div style="font-size:32px;margin-bottom:8px">✅</div><div style="font-size:16px;font-weight:600">No issues found!</div><div style="font-size:13px;margin-top:4px">All expression references appear to be valid.</div>' }));
            } else {
                issues.forEach((issue, idx) => {
                    const card = ui.el('div', { className: 'fev-issue' });
                    card.innerHTML = `
                        <div class="fev-issue-head">
                            <span class="fev-issue-badge">Issue #${idx + 1}</span>
                            <span class="fev-issue-fn">${escapeHtml(issue.functionName)}('${escapeHtml(issue.referencedName)}')</span>
                        </div>
                        <div class="fev-issue-body">
                            <div class="fev-row"><span class="l">Referenced ${escapeHtml(issue.expectedType)}:</span>
                                <code class="fev-code">${escapeHtml(issue.referencedName)}</code>
                                <span style="color:#D13438;font-weight:600">← Does not exist!</span></div>
                            <div class="fev-row"><span class="l">Found in action:</span><code class="fev-code">${escapeHtml(issue.actionName)}</code></div>
                            <div class="fev-row"><span class="l">Location:</span><span style="font-size:11px;color:var(--muted)">${escapeHtml(issue.location)}</span></div>
                            ${issue.suggestion.length ? `<div class="fev-row"><span class="l">Did you mean:</span>${issue.suggestion.map((s) => `<span class="fev-suggestion">${escapeHtml(s.name)} <small>(${s.reason})</small></span>`).join(' ')}</div>` : ''}
                        </div>`;
                    body.append(card);
                });
            }

            const namesSection = (summaryText, names) => {
                const details = ui.el('details', { className: 'fev-details' });
                details.append(
                    ui.el('summary', { textContent: summaryText }),
                    ui.el('div', { className: 'fev-names' }, names.map((n) => ui.el('code', { textContent: n }))),
                );
                return details;
            };
            body.append(namesSection(`View all action names (${stats.actionCount})`, stats.actions));
            if (stats.variableCount) body.append(namesSection(`View all variables (${stats.variableCount})`, stats.variables));
        },
        buttons: [
            { label: 'Close', onClick: (close) => close() },
            {
                label: 'Copy Report', primary: true,
                onClick: () => {
                    navigator.clipboard.writeText(generateTextReport(results))
                        .then(() => ui.toast('📋 Report copied'));
                },
            },
        ],
    });
}

function generateTextReport({ issues, stats }) {
    let report = '=== POWER AUTOMATE EXPRESSION VALIDATION REPORT ===\n\n';
    report += `Actions: ${stats.actionCount}\nTriggers: ${stats.triggerCount}\nVariables: ${stats.variableCount}\n`;
    report += `Expressions scanned: ${stats.expressionCount}\nIssues found: ${issues.length}\n\n`;
    if (issues.length) {
        report += '=== ISSUES ===\n\n';
        issues.forEach((issue, idx) => {
            report += `[Issue #${idx + 1}]\n  Function: ${issue.functionName}('${issue.referencedName}')\n`;
            report += `  Problem: Referenced ${issue.expectedType} does not exist\n`;
            report += `  In action: ${issue.actionName}\n  Location: ${issue.location}\n`;
            if (issue.suggestion.length) report += `  Suggestions: ${issue.suggestion.map((s) => s.name).join(', ')}\n`;
            report += '\n';
        });
    }
    report += '=== ALL ACTIONS ===\n' + stats.actions.join('\n');
    if (stats.variables.length) report += '\n\n=== ALL VARIABLES ===\n' + stats.variables.join('\n');
    return report;
}

// ── Entry point ───────────────────────────────────────────────────────────
async function runValidator() {
    const { flowId, envId } = flowContextFromUrl();
    if (!flowId) { showManualInputDialog(); return; }

    const orgUrl = await resolveOrgUrl(envId, { detail: `Flow ID: ${flowId}` });
    if (!orgUrl) { showManualInputDialog(); return; }

    ui.toast('Fetching flow definition…');
    try {
        const found = await resolveFlowDefinition(orgUrl, { flowId });
        if (found) showResultsDialog(validateExpressions(found.definition));
        else showManualInputDialog({ orgUrl });
    } catch (e) {
        console.warn('[Expression Validator] fetch failed:', e);
        showManualInputDialog({ orgUrl, error: e });
    }
}

export default {
    init() {
        ui.addStyle('fev', STYLE);
        commands.register({ toolId: 'flow-expression-validator', title: 'Validate Flow Expressions', icon: '🔍', run: runValidator });
        commands.register({
            toolId: 'flow-expression-validator',
            title: 'Clear Dynamics URL cache',
            icon: '🗑️',
            run: async () => { await clearOrgUrlCache(); ui.toast('Dynamics URL cache cleared.'); },
        });
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'V') { e.preventDefault(); runValidator(); }
        });
    },
};
