// The single source of truth for every bundled tool.
//
// Each tool is an ES module in src/tools/ built on src/core/, loaded by
// src/main.js in the isolated world when its match patterns fit the page
// and the tool is enabled in the options.
//
// Tools are on by default. `defaultEnabled: false` marks a tool as opt-in —
// used for integrations with third-party services that only matter to people
// who actually use that service (Clockify, Jira).

export const TOOLS = [
    {
        id: 'environment-indicator',
        name: 'Environment Indicator',
        description: 'Colored DEV/TEST/PROD badge in the navbar, with one-click environment switching',
        version: '2.0',
        category: 'Power Platform',
        area: 'environment',
        file: 'src/tools/environment-indicator.js',
        matches: [
            'https://*.dynamics.com/*',
            'https://*.powerapps.com/*',
            'https://make.powerautomate.com/*',
            'https://*.make.powerautomate.com/*',
        ],
    },
    {
        id: 'off-status-highlighter',
        name: 'Turned-Off Highlighter',
        description: 'Highlights turned-off components (status "Off") in Power Apps and Power Automate solution views',
        version: '2.0',
        category: 'Power Platform',
        area: 'solutions',
        file: 'src/tools/off-status-highlighter.js',
        matches: [
            'https://make.powerapps.com/environments/*',
            'https://make.powerautomate.com/environments/*',
        ],
    },
    {
        id: 'audit-viewer',
        name: 'Audit History',
        description: 'Who changed what and when — browse audit history with old and new values, filtered by table, record, user, operation and date',
        version: '2.0',
        category: 'Dynamics 365',
        area: 'data',
        file: 'src/tools/audit-viewer.js',
        matches: ['https://*.dynamics.com/main.aspx*'],
    },
    {
        id: 'deep-clone',
        name: 'Deep Clone',
        description: 'Deep clone Dataverse records with related child records — in this org, or into another environment keeping the same GUID',
        version: '2.0',
        category: 'Dynamics 365',
        area: 'data',
        file: 'src/tools/deep-clone.js',
        matches: ['https://*.dynamics.com/main.aspx*'],
    },
    {
        id: 'field-editor',
        name: 'Record Editor',
        description: 'View every value on a Dataverse record and change any of them in place, bypassing the form — all column types incl. lookups',
        version: '3.0',
        category: 'Dynamics 365',
        area: 'data',
        file: 'src/tools/field-editor.js',
        matches: ['https://*.dynamics.com/main.aspx*'],
    },
    {
        id: 'record-browser',
        name: 'Record Browser',
        description: 'Every record of a table with every column on offer — sort, filter and pick columns without editing a view; starts from the view you are on, downloads files and shows images',
        version: '1.0',
        category: 'Dynamics 365',
        area: 'data',
        file: 'src/tools/record-browser.js',
        matches: ['https://*.dynamics.com/main.aspx*'],
    },
    {
        id: 'solution-deployer',
        name: 'Solution Deployer',
        description: 'Deploy solutions between environments, check dependencies, clean up deployed solutions',
        version: '3.0',
        category: 'Dynamics 365',
        area: 'solutions',
        file: 'src/tools/solution-deployer.js',
        matches: [
            'https://*.dynamics.com/main.aspx*',
            'https://make.powerapps.com/environments/*',
            'https://make.powerautomate.com/environments/*',
        ],
    },
    {
        id: 'solution-history',
        name: 'Solution History',
        description: 'Imports and exports in one panel — live progress and failure logs of solution imports and upgrades, and every export the environment still holds, re-downloadable',
        version: '4.0',
        category: 'Dynamics 365',
        area: 'solutions',
        file: 'src/tools/solution-history.js',
        // Off Dynamics, the org is the environment in the maker-portal URL.
        matches: [
            'https://*.dynamics.com/main.aspx*',
            'https://make.powerapps.com/environments/*',
            'https://make.powerautomate.com/environments/*',
        ],
    },
    {
        id: 'solution-add-existing',
        name: 'Add Existing Components',
        description: 'Add existing components to a solution from a grid you can sort, filter and pick columns on per column — like a model-driven view',
        version: '1.0',
        category: 'Dynamics 365',
        area: 'solutions',
        file: 'src/tools/solution-add-existing.js',
        matches: [
            'https://*.dynamics.com/main.aspx*',
            'https://make.powerapps.com/environments/*',
        ],
    },
    {
        id: 'cloud-flow-manager',
        name: 'Cloud Flow Manager',
        description: 'View and manage cloud flows in solutions — enable/disable individually or in bulk',
        version: '2.0',
        category: 'Power Automate',
        area: 'flows',
        file: 'src/tools/cloud-flow-manager.js',
        matches: [
            'https://*.dynamics.com/main.aspx*',
            'https://make.powerapps.com/environments/*',
            'https://make.powerautomate.com/environments/*',
        ],
    },
    {
        id: 'flow-expression-validator',
        name: 'Expression Validator',
        description: 'Validates flow expressions and finds references to non-existent actions or variables',
        version: '2.0',
        category: 'Power Automate',
        area: 'flows',
        file: 'src/tools/flow-expression-validator.js',
        matches: ['https://make.powerautomate.com/*', 'https://*.make.powerautomate.com/*'],
    },
    {
        id: 'flow-references',
        name: 'Find All References',
        description: 'Pick a step, trigger or variable and see everything that references it — expressions, runAfter and variable writes, plus what it references back',
        version: '1.0',
        category: 'Power Automate',
        area: 'flows',
        file: 'src/tools/flow-references.js',
        matches: ['https://make.powerautomate.com/*', 'https://*.make.powerautomate.com/*'],
    },
    {
        id: 'flow-schema-builder',
        name: 'Parse JSON Schema Builder',
        description: 'Field picker and Parse JSON schema for a Dataverse List rows query — restores dynamic content for records expanded with 1:N children, and inserts fields at your cursor',
        version: '1.1',
        category: 'Power Automate',
        area: 'flows',
        file: 'src/tools/flow-schema-builder.js',
        matches: ['https://make.powerautomate.com/*', 'https://*.make.powerautomate.com/*'],
    },
    {
        id: 'flow-run-monitor',
        name: 'Flow Run Monitor',
        description: 'Monitor flow runs with advanced filtering, statistics, and visualization',
        version: '2.2',
        category: 'Power Automate',
        area: 'flows',
        file: 'src/tools/flow-run-monitor.js',
        matches: [
            'https://*.dynamics.com/main.aspx*',
            'https://make.powerapps.com/environments/*',
            'https://make.powerautomate.com/environments/*',
        ],
    },
    {
        id: 'run-opener',
        name: 'Run Page Actions',
        description: '"Run tree", "Open run", "Re-run" and "Download" buttons on Power Automate run pages',
        version: '3.3',
        category: 'Power Automate',
        area: 'flows',
        file: 'src/tools/run-opener.js',
        matches: ['https://make.powerautomate.com/*', 'https://*.make.powerautomate.com/*'],
    },
    {
        id: 'relationship-opener',
        name: 'Classic Relationship Dialog',
        description: 'Adds "Manage Relationship" to the Power Apps Relationships page, opening the classic relationship dialog (1:n, n:1, n:n)',
        version: '3.0',
        category: 'Power Apps',
        area: 'data',
        file: 'src/tools/relationship-opener.js',
        matches: ['https://make.powerapps.com/*'],
    },
    {
        id: 'jira-clockify-timer',
        name: 'Jira Clockify Timer',
        description: 'Start/stop a Clockify timer from Jira issues with one click, and line the issue up with the work — your working status and assigned to you',
        version: '2.0',
        category: 'Jira & Clockify',
        area: 'time',
        defaultEnabled: false,
        file: 'src/tools/jira-clockify-timer.js',
        matches: [
            'https://*.atlassian.net/browse/*',
            'https://*.atlassian.net/jira/*',
        ],
    },
    {
        id: 'clockify-sync',
        name: 'Clockify → Dynamics 365 Sync',
        description: 'Import time entries from Clockify into Dynamics 365',
        version: '2.0',
        category: 'Jira & Clockify',
        area: 'time',
        defaultEnabled: false,
        file: 'src/tools/clockify-sync.js',
        matches: ['https://*.dynamics.com/main.aspx*'],
    },
];

// What a tool works on, for the palette and popup: tools are grouped by area
// and their icon sits on the area's color, so the eye finds the right group
// before reading a single title. `category` stays the product a tool runs in.
export const AREAS = [
    { id: 'solutions', name: 'Solutions', color: '#8764b8' },
    { id: 'flows', name: 'Flows', color: '#0f6cbd' },
    { id: 'data', name: 'Data', color: '#107c10' },
    { id: 'environment', name: 'Environment', color: '#ca5010' },
    { id: 'time', name: 'Time tracking', color: '#038387' },
];
// Commands registered with `kind: 'setting'` (toggles, caches, settings)
// collect here, below the tools.
export const SETTINGS_AREA = { id: 'settings', name: 'Settings', color: '#7a7574' };

/**
 * Group commands ({ toolId, kind?, ... }) into the areas above, in area order
 * and registration order within one; settings last, empty areas left out.
 * → [{ id, name, color, commands }]
 */
export function groupByArea(commands) {
    const areaOf = new Map(TOOLS.map((tool) => [tool.id, tool.area]));
    return [...AREAS, SETTINGS_AREA]
        .map((area) => ({
            ...area,
            commands: commands.filter((command) => (command.kind === 'setting'
                ? area === SETTINGS_AREA
                : area.id === (areaOf.get(command.toolId) ?? AREAS[0].id))),
        }))
        .filter((area) => area.commands.length);
}

export const CATEGORY_ORDER = ['Power Platform', 'Dynamics 365', 'Power Automate', 'Power Apps', 'Jira & Clockify'];

/**
 * Resolve a tool's on/off state from the stored `enabledTools` map.
 * A stored boolean always wins; without one the registry default applies.
 */
export function isToolEnabled(toolId, enabledMap = {}) {
    const stored = enabledMap[toolId];
    if (typeof stored === 'boolean') return stored;
    return TOOLS.find((tool) => tool.id === toolId)?.defaultEnabled !== false;
}
