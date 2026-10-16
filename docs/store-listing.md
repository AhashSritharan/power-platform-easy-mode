# Chrome Web Store listing — Power Platform Toolbox

Everything to paste into the [developer dashboard](https://chrome.google.com/webstore/devconsole)
when publishing. One-time $5 registration fee applies to new developer accounts.

## Basics

- **Name:** Power Platform Toolbox
- **Category:** Developer Tools
- **Language:** English

**Short description** (132-char limit):

> Developer tools for Dynamics 365, Power Platform, Jira & Clockify. Runs 100% locally — collects no data whatsoever.

**Detailed description:**

> A toolbox of developer utilities that live right inside the pages you already work in — Dynamics 365 model-driven apps, the Power Apps and Power Automate maker portals, and Jira.
>
> 🔒 PRIVACY FIRST
> No analytics, no telemetry, no accounts, no remote code. Everything runs locally in your browser; settings are stored only in local extension storage. The only network requests are the ones tools make on your behalf to the services you already use. Fully open source.
>
> 🧰 THE TOOLS
> • Environment Indicator — colored DEV/TEST/PROD badge with one-click environment switching
> • Solution Deployer — deploy solutions between environments, check dependencies, clean up deployed solutions
> • Solution History — imports and exports in one panel: live progress of running solution imports and upgrades with a drill-down log viewer, and every export the environment still holds, re-downloadable
> • Add Existing Components — the maker portal's "Add existing" with a real grid: sort on any column (several at once), filter any column with the usual operators (contains, begins with, on or after, has data…), choose the columns, multi-select and add in one go. Already open the portal's own panel? One click on "Filter & sort in Toolbox" reopens the same list — same solution, same component type, same search — in the filterable grid
> • Cloud Flow Manager — enable/disable the cloud flows in a solution, individually or in bulk
> • Flow Run Monitor — flow run filtering, statistics and visualization, plus an issue list that understands child flows: a flow1→flow2→flow3 cascade counts as one incident filed under flow3 where the error really happened, the chain is traced up even through parents that caught the error and reported success, and everything pivots by flow, error, flow × error or caller ("which callers trigger this failure, and how often")
> • Expression Validator — find flow expressions referencing missing actions or variables
> • Find All References — the thing your IDE does, for flows: pick a step, trigger or variable and see every expression, runAfter and variable write that references it, and everything it references back
> • Parse JSON Schema Builder — a field picker and Parse JSON schema for a Dataverse List rows query, so records expanded with their 1:N children get dynamic content back; picked fields drop straight in at your cursor
> • Run Page Actions — "Run tree", "Open run", "Re-run" and "Download" buttons on Power Automate run pages
> • Audit History — who changed what and when, with old and new values
> • Record Editor — view every value on a record and change any of them in place, bypassing the form (including lookups)
> • Record Browser — every record of a table with every column on offer, sortable and filterable, without editing a view first
> • Deep Clone — clone records with related child records, or copy them to another environment with the same GUID
> • Classic Relationship Dialog — open the classic "Manage Relationship" dialog from the maker portal
> • Turned-Off Highlighter — spot turned-off flows and components in solution views at a glance
> • Jira Clockify Timer (off by default) — start/stop a Clockify timer from any Jira issue, and, when the issue is not already there, offer to move it to a status of your choice and assign it to you
> • Clockify → Dynamics 365 Sync (off by default) — import time entries into Dynamics 365
>
> Every tool is individually toggleable, and every command is reachable from the toolbar popup or the command palette (Alt+Shift+P). A short setup after installing lets you pick your tools, label all the environments you can access as DEV/TEST/PROD in one go, and enter your Clockify settings once for both Clockify tools. The two Clockify/Jira integrations ship switched off — turn them on in setup or the options page if you use those services.

- **Privacy policy URL:** https://github.com/AhashSritharan/power-platform-toolbox/blob/main/PRIVACY.md
- **Homepage URL:** https://github.com/AhashSritharan/power-platform-toolbox

## Privacy tab answers

- **Single purpose:** Adds developer/administrator productivity tools to Microsoft Power Platform, Dynamics 365 and Jira pages.
- **Data usage:** check **none** of the data-type boxes. The extension does not collect or transmit any user data.
- **Remote code:** No. All code is packaged; nothing is loaded or evaluated from the network.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Persists the user's own settings (enabled tools, environment labels, an optional user-provided Clockify API key) locally in the browser. Nothing is transmitted. |
| `*.dynamics.com` | The Dynamics 365 tools run on these pages and call the environment's own Dataverse Web API using the user's existing session. |
| `*.powerapps.com` | Tools run on the Power Apps maker portal / canvas player (environment badge, turned-off highlighting, classic relationship dialog, adding existing components to a solution). During setup, and only when the user asks for it, the maker portal is opened in a background tab so the list of environments it loads can be labelled DEV/TEST/PROD; the tab closes again. |
| `*.powerautomate.com` | Tools run on the Power Automate maker portal (run page actions, expression validator, environment badge). |
| `*.atlassian.net` | The Jira Clockify Timer adds a start/stop timer button to Jira issue pages, and — only for changes the user confirms in the dialog it shows — transitions the issue to their chosen status and assigns it to them through Jira’s own REST API, using the browser session the user is already signed in with. |
| `api.clockify.me` | Only used if the user configures their own Clockify API key, to start/stop timers and read time entries in their own workspace. |

## Assets checklist

- [ ] Icon 128×128 — already in the package (`extension/icons/icon128.png`)
- [ ] 1–5 screenshots, 1280×800 (or 640×400). Suggested shots:
  - [ ] Command palette open on a Dynamics 365 page
  - [ ] Solution History side panel with a running import
  - [ ] Add Existing Components: the "Filter & sort in Toolbox" button in the portal's
        "Add existing web resources" panel, and the grid it opens with a column filter menu
        and a couple of filter chips applied
  - [ ] Environment Indicator badge + config dialog on the maker portal
  - [ ] Options page showing the per-tool toggles
  - [ ] Popup on a supported page
- [ ] (Optional) small promo tile 440×280

## Publishing steps

1. `cd extension && zip -r ../power-platform-toolbox-extension.zip .` (or take the
   zip from the GitHub release workflow).
2. Developer dashboard → **New item** → upload the zip.
3. Fill in the listing/privacy tabs from this document, upload screenshots.
4. Submit for review. First review typically takes a few days; "no data
   collected" + narrow host permissions keeps it uncomplicated.
