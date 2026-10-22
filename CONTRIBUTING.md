# Contributing

Thanks for wanting to improve Power Platform Toolbox. This page is for people
working on the code; the [README](README.md) is the user guide.

Bugs and ideas: [open an issue](https://github.com/AhashSritharan/power-platform-toolbox/issues).
Pull requests are welcome. Every change is test-driven; the rules are in
[CLAUDE.md](CLAUDE.md), and the short version is below.

## Running it from source

No build step — what is in [`extension/`](extension/) is what ships.

1. Clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. After a change, click the reload icon on the extension's card and reload
   the page you test on.

This project started life as a set of Tampermonkey userscripts; those are
retired, and the extension is the only codebase.

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

On the maker portals, the tools work on the environment in the URL: they call
its Dataverse Web API through the extension's service worker, using the user's
own Dynamics 365 session. The environment's Dynamics URL is read off the
portal's own requests (or asked for once when it cannot be), and when the
browser has no Dynamics session yet — the portals sign in with tokens, not
cookies — one click opens the environment in a background tab so single sign-on
can create one, then closes it again.

Cross-origin requests are proxied through the service worker and validated
against a fixed host allowlist; see [PRIVACY.md](PRIVACY.md) for the exact
list. Tools coordinate across tabs and with each other through namespaced
extension storage (e.g. the Solution Deployer's hand-off to Cloud Flow
Manager).

**Credential rule:** all requests ride the user's browser session
(`credentials: include`); the extension never reads, extracts, or handles
tokens or other credentials — no MSAL/page-storage token access, no captured
`Authorization` headers. If a feature needs a bearer-token-only API, the
feature is out of scope. Passively observing responses the page already loads
(page agent) is the outer limit. See PRIVACY.md → "Credentials".

**Undocumented dependencies:** Add Existing Components builds on the
`msdyn_solutioncomponentsummaries` virtual table the portal's own "Add
existing" panels query, and the `solution-components-addexisting-subheader`
class that identifies those panels. Microsoft documents neither. If either
changes, the hand-off button stops appearing or a component type stops
loading — nothing else is affected.

## Tests

Every change is test-driven — see [CLAUDE.md](CLAUDE.md) for the rules. Four
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
npm run screenshots         # retake the README's screenshots (below)
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

## Screenshots

The README's screenshots in [`docs/screenshots/`](docs/screenshots/) are taken
by [`tests/e2e/screenshots/readme.shot.js`](tests/e2e/screenshots/readme.shot.js):
the real extension on the developer environment's real pages, as the live
tests' user. They show Microsoft's sample data plus demo content the script
creates the first time and then keeps
([`demo-data.js`](tests/e2e/screenshots/demo-data.js): a *Contoso Sales*
solution with a few cloud flows, a custom table and a choice). After a UI
change, run `npm run screenshots` and commit the images that changed.

The sensitive-data scan cannot read images, so
[`redact.js`](tests/e2e/screenshots/redact.js) does that job: right before
each capture it replaces every name that identifies the tenant, an org or the
user — hosts, environment and app names, the user's name, email and initials,
ids, anything in `.sensitive-denylist` — with a placeholder, and refuses the
capture if any of it is still on the page before or after. **Look at every
image before committing it anyway**: text drawn into a picture or a canvas is
beyond what it can read.

## Never commit identifying data

The repository is public. `playwright.env.json`, the saved session and the test
results name the tenant, the org and the user: they are gitignored, and the
sensitive-data scan ([`scripts/sensitive-scan.mjs`](scripts/sensitive-scan.mjs))
refuses them. In code, tests and mock data, use placeholders only — `contoso` /
`fabrikam` hosts, `guid(n)` ids, made-up names.
