# Power Platform Toolbox

A Chrome extension with developer tools for **Dynamics 365**, **Power Platform**,
**Jira** and **Clockify** — running right inside the pages you already work in.

> 🔒 **Privacy:** no data collection of any kind. Everything runs locally in
> your browser. See [PRIVACY.md](PRIVACY.md).

This project started life as a set of Tampermonkey userscripts; those are now
fully retired — the extension in [`extension/`](extension/) is the only
codebase, and all development happens there.

## The tools

| Tool | Where it runs | What it does |
|---|---|---|
| Environment Indicator | Everywhere | Colored DEV/TEST/PROD badge, environment labeling grouped by project & one-click switching |
| Off-Status Highlighter | Maker portals | Highlights solution rows whose status is "Off" |
| Audit Viewer | Dynamics 365 | Fast record change-history viewer via the Web API |
| Deep Clone | Dynamics 365 | Clone records together with related child records — in place, or into another environment keeping the same GUID |
| Field Editor | Dynamics 365 | Update any field, bypassing the form — including lookups |
| Solution Deployer | Dynamics 365 | Deploy solutions between environments, check dependencies, clean up deployed solutions |
| Solution Import Monitor | Dynamics 365 | Real-time progress of running solution imports and upgrades, with the failure log for each |
| Solution Export History | Dynamics 365 | Every solution export the environment still holds — years of them — with one-click re-download of the original zip |
| Add Existing Components | Dynamics 365 & Power Apps maker | The maker portal's "Add existing" with a real grid — sort on any column (several at once), filter any column with the usual operators, pick the columns, multi-select and add in one go; opens on the solution you are viewing in make.powerapps.com, and adds a "Filter & sort in Toolbox" button to the portal's own Add existing panel that reopens the same list here |
| Cloud Flow Manager | Dynamics 365 | Enable/disable the cloud flows in a solution, individually or in bulk |
| Expression Validator | Power Automate | Finds flow expressions referencing missing actions/variables |
| Find All References | Power Automate | `Shift+F12` on a step, trigger or variable — everything that references it (expressions, runAfter, variable writes) and everything it references back |
| Parse JSON Schema Builder | Power Automate | Field picker + Parse JSON schema for a Dataverse List rows query — gets dynamic content back for records expanded with 1:N children, inserting fields at your cursor |
| Flow Run Monitor | Dynamics 365 | Flow run filtering, statistics and visualization, plus an issue list that collapses parent→child failure cascades into one incident filed under the flow that actually broke — tracing up through ancestors that caught the error and reported success — and pivots them by flow, error, flow × error or caller |
| Run Opener | Power Automate | "Open run" / "Open details" buttons on run pages |
| Relationship Opener | Power Apps | "Manage relationship" from the Relationships page |
| Jira Clockify Timer | Jira Cloud | Start/stop a Clockify timer from a Jira issue, offering to move it to your working status and assign it to you when it is not already there |
| Clockify → Dynamics 365 Sync | Dynamics 365 | Import Clockify time entries into Dynamics 365 |

**Add Existing Components** builds on two things Microsoft does not document:
the `msdyn_solutioncomponentsummaries` virtual table the portal's own "Add
existing" panels query, and the `solution-components-addexisting-subheader`
class that identifies those panels. If either changes, the hand-off button
stops appearing or a component type stops loading — nothing else is affected.
Please open an issue if you see that happen.

Every tool's commands are reachable from the toolbar popup and from the
**command palette** (`Alt+Shift+P` on any supported page). Individual tools can
be switched on/off in the options page.

The two Clockify/Jira tools are **off by default** — they integrate with
third-party services rather than the Power Platform, so switch them on in the
options page if you use them.

## Install

**From source (until the Web Store listing is live):**

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.

No build step — the extension loads as-is.

## Architecture

```
extension/
  manifest.json           MV3; storage + first-party hosts only
  bootstrap.js            classic content script → dynamic-imports src/main.js
  src/
    main.js               loads enabled tools, serves popup/palette
    registry.js           single source of truth for all tool metadata
    background.js         service worker: allowlisted fetch proxy, helper tabs
    core/                 shared libraries every tool builds on
      storage.js            namespaced chrome.storage.local stores
      http.js               fetch + cross-origin proxy (host-allowlisted)
      dataverse.js          Dataverse Web API client (same-org & cross-env)
      context.js            site detection, URL parsing, match patterns
      ui.js                 shadow-DOM UI kit: modal, toast, palette, inputs
      caret.js              remembers the page field the user was in; inserts at their cursor
      commands.js           command registry (popup + palette)
      agent.js              client for the page agent (network interception)
    agent/
      page-agent.js         MAIN-world script: on-demand fetch/XHR interception
    tools/                one ES module per tool (isolated world)
  popup/  options/  welcome/  icons/
```

Every tool is an ES module with `export default { init({ store, tool }) }`,
loaded by `src/main.js` when its match patterns fit the page and it is enabled
in the options. Tools build on `src/core/` for storage, HTTP/Dataverse, UI and
command registration; the only MAIN-world code is the tiny page agent, used by
Run Opener to observe the flow portal's own network responses on demand.
Add Existing Components needs even less: it reads the URLs of the maker
portal's own requests from the browser's Resource Timing entries — no
responses, no headers, nothing patched in the page.

Cross-origin requests are proxied through the service worker and validated
against a fixed host allowlist; see [PRIVACY.md](PRIVACY.md) for the exact
list. Tools coordinate across tabs and with each other through namespaced
extension storage (e.g. the Solution Deployer's hand-off to Cloud Flow
Manager).

**Credential rule (for contributors):** all requests ride the user's browser
session (`credentials: include`); the extension never reads, extracts, or
handles tokens or other credentials — no MSAL/page-storage token access, no
captured `Authorization` headers. If a feature needs a bearer-token-only API,
the feature is out of scope. Passively observing responses the page already
loads (page agent) is the outer limit. See PRIVACY.md → "Credentials".

## Verifying changes

```
node scripts/smoke-test.mjs           # exercises the page agent end-to-end
node scripts/caret-test.mjs           # exercises caret insertion into page fields
node scripts/solution-import-test.mjs # exercises the deployer's import watcher
node scripts/add-existing-test.mjs    # the component query builder and portal hand-off parser
node scripts/sensitive-scan.mjs       # no tenant ids, real org hosts, emails or secrets in tracked files
```

Then load the unpacked extension and exercise the affected tool on a real
page. The release workflow runs the same checks and attaches the packaged
extension zip to GitHub releases.

## License

MIT
