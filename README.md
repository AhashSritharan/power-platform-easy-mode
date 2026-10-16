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
| Turned-Off Highlighter | Maker portals | Highlights turned-off components (status "Off") in solution views |
| Audit History | Dynamics 365 | Who changed what and when — audit history with old and new values, filtered by table, record, user, operation and date |
| Deep Clone | Dynamics 365 | Clone records together with related child records — in place, or into another environment keeping the same GUID |
| Record Editor | Dynamics 365 | View every value on a record and change any of them in place, bypassing the form — including lookups; file columns download and image columns show their thumbnail |
| Record Browser | Dynamics 365 | Every record of a table with every column — no view to edit first. Opens on the view you are on (its columns first, its filter as a removable chip), searches all columns at once and highlights the matches, sorts on any column, filters with operators that fit each column type, hides empty columns, downloads files, shows image thumbnails, exports CSV, and opens a row in the Record Editor |
| Solution Deployer | Dynamics 365 & maker portals | Deploy solutions between environments, check dependencies, clean up deployed solutions |
| Solution History | Dynamics 365 & maker portals | Imports and exports in one panel: real-time progress of running solution imports and upgrades with the failure log for each, and every export the environment still holds — years of them — with one-click re-download of the original zip |
| Add Existing Components | Dynamics 365 & Power Apps maker | The maker portal's "Add existing" with a real grid — sort on any column (several at once), filter any column with the usual operators, pick the columns, multi-select and add in one go; opens on the solution you are viewing in make.powerapps.com, and adds a "Filter & sort in Toolbox" button to the portal's own Add existing panel that reopens the same list here |
| Cloud Flow Manager | Dynamics 365 & maker portals | Enable/disable the cloud flows in a solution, individually or in bulk |
| Expression Validator | Power Automate | Finds flow expressions referencing missing actions/variables |
| Find All References | Power Automate | `Shift+F12` on a step, trigger or variable — everything that references it (expressions, runAfter, variable writes) and everything it references back |
| Parse JSON Schema Builder | Power Automate | Field picker + Parse JSON schema for a Dataverse List rows query — gets dynamic content back for records expanded with 1:N children, inserting fields at your cursor |
| Flow Run Monitor | Dynamics 365 & maker portals | Flow run filtering, statistics and visualization, plus an issue list that collapses parent→child failure cascades into one incident filed under the flow that actually broke — tracing up through ancestors that caught the error and reported success — and pivots them by flow, error, flow × error or caller |
| Run Page Actions | Power Automate | "Run tree", "Open run", "Re-run" and "Download" buttons on run pages |
| Classic Relationship Dialog | Power Apps | "Manage Relationship" on the Relationships page, opening the classic relationship dialog |
| Jira Clockify Timer | Jira Cloud | Start/stop a Clockify timer from a Jira issue, offering to move it to your working status and assign it to you when it is not already there |
| Clockify → Dynamics 365 Sync | Dynamics 365 | Import Clockify time entries into Dynamics 365 |

On the maker portals, the tools marked "maker portals" work on the environment in
the URL: they call its Dataverse Web API through the extension's service worker,
using your own Dynamics 365 session. The environment's Dynamics URL is read off
the portal's own requests (or asked for once when it cannot be), and when the
browser has no Dynamics session yet — the portals sign in with tokens, not
cookies — one click opens the environment in a background tab so single sign-on
can create one, then closes it again.

**Add Existing Components** builds on two things Microsoft does not document:
the `msdyn_solutioncomponentsummaries` virtual table the portal's own "Add
existing" panels query, and the `solution-components-addexisting-subheader`
class that identifies those panels. If either changes, the hand-off button
stops appearing or a component type stops loading — nothing else is affected.
Please open an issue if you see that happen.

Every tool's commands are reachable from the toolbar popup and from the
**command palette** — open it with `Alt+Shift+P`, or with the small 🧰 tab on
the right edge of every supported page (drag it up or down out of the way; hover
it for a × to hide it, or turn it off in the options). Individual tools can be
switched on/off in the options page.

After installing, the welcome page walks through **setup** in one go: which
tools to run, a DEV/TEST/PROD label for every environment you can access, and —
if a Clockify tool is on — your Clockify key, workspace and duration rounding.
The environments come from the Power Apps maker portal's own environment list,
read in a background tab that closes again, so there is no need to visit each
environment first. The labels are the ones the Environment Indicator shows and
every environment picker offers; the Clockify settings are shared by both
Clockify tools. Setup can be run again from the options page.

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
      launcher.js           floating 🧰 tab on the page that opens the palette
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
Run Page Actions to observe the flow portal's own network responses on demand.
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

## Tests

Every change is test-driven — see [CLAUDE.md](CLAUDE.md) for the rules. Three
layers, from fastest to most real:

| Layer | Where | What it covers |
|---|---|---|
| Unit | [`tests/unit/`](tests/unit/) | Logic with no UI — query builders, parsers, the import/export watchers, the dependency matching — on Node's built-in test runner |
| Mock browser | [`tests/e2e/mock/`](tests/e2e/mock/) | The unpacked extension in Chromium against fake orgs ([`fake-dataverse.js`](tests/e2e/mock/fake-dataverse.js)) answering every Dataverse request — the UI flows, including everything that writes: deploy, clone, save, add, turn on/off |
| Live browser | [`tests/e2e/live/`](tests/e2e/live/) | The unpacked extension against a real developer environment: every tool starts on Dynamics and both maker portals and loads its data. Read-only |
| Deploy | [`tests/e2e/deploy/`](tests/e2e/deploy/) | A real deployment through the Solution Deployer: a throwaway solution goes from the developer environment to a second one (`TARGET_URL`), gets a dependency check and a cleanup, and everything is deleted again |

```
npm install
npx playwright install chromium
npm test                    # unit + mock: no tenant, no secrets
npm run test:e2e            # live: needs playwright.env.json (below)
npm run test:deploy         # a real deployment to TARGET_URL and back out
npm run test:e2e -- --headed   # watch the browsers
npm run test:report         # the last browser run's report, with traces of failures
npm run check               # syntax of every script + the sensitive-data scan
node scripts/live-request.mjs GET 'solutions?$top=3'   # one real request as the test user
```

The browser tests run headless, four browsers side by side, each loading the
extension once. They fail on anything the extension logs as an error, on any
of its own requests that fails, and — in the mock tests — on any request the
fake orgs were not told how to answer.

**Where they run:** the pre-commit hook ([`.githooks/pre-commit`](.githooks/pre-commit),
enabled with `git config core.hooksPath .githooks`) runs the sensitive-data
scan, the syntax check and the unit tests. [CI](.github/workflows/ci.yml) runs
those plus the mock tests on every push and pull request. The
[live and deploy tests](.github/workflows/e2e.yml) run on pushes to `main`
that change the extension or the tests, every weekday morning, and before
every release.

**Live test setup:** copy `playwright.env.example.json` to
`playwright.env.json` and fill in the developer environment's URL and a test
user with an authenticator-app MFA method (`TOTP` is the authenticator secret
key). Without the user's credentials the first run opens a browser and waits
for you to sign in. The session is saved to `playwright/.auth/user.json` and
reused until it expires. Chromium starts signed out every time; Edge would sign
in with the account connected to Windows, which is why it is not the default
(`"BROWSER": "msedge"` still selects it). In CI the same JSON comes from the
`ENV_VAR_JSON` repository secret; the workflow masks its values in the log and
uploads no screenshots, as the repository is public.

For the deploy tests, add `TARGET_URL`: a second environment the test user
can deploy to (a free Developer environment is enough); without it they are
skipped. The live flow-designer tests use a flow named `ppt-e2e designer
fixture` in the developer environment and create it the first time.

`playwright.env.json`, the saved session and the test results name the tenant,
the org and the user: they are gitignored, and the sensitive-data scan refuses
them.

## License

MIT

Tool icons are from [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) by Microsoft, MIT licensed — see [extension/src/core/icons.LICENSE](extension/src/core/icons.LICENSE).
