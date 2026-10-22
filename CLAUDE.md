# Power Platform Toolbox — working rules

A Chrome/Edge MV3 extension with no build step: what is in `extension/` is
what ships. README.md is the user guide; CONTRIBUTING.md describes the
architecture, the tests and the README screenshots.

## Test first, every change

Every change is test-driven, whatever its size:

1. **Write the test first and watch it fail** for the reason you expect.
2. Make it pass with the smallest change.
3. Run `npm test` (unit + mock) before calling anything done; run
   `npm run test:e2e` too when the change touches how a tool talks to
   Dataverse or a portal.

A test is never weakened, skipped or deleted to get to green. If a test is
wrong, say why and fix the test in its own step.

A bug fix starts with a test that reproduces the bug.

## The test layers

| Layer | Where | Command | What belongs there |
|---|---|---|---|
| Unit | `tests/unit/*.test.mjs` | `npm run test:unit` | Logic with no UI: query builders, parsers, state machines, matching rules. Export the function from the tool module to test it. |
| Mock browser | `tests/e2e/mock/*.spec.js` | `npm run test:mock` | The real extension in Chromium against fake orgs (`fake-dataverse.js`). UI flows and everything that writes: save, clone, deploy, add, turn on/off. |
| Live browser | `tests/e2e/live/*.spec.js` | `npm run test:e2e` | The real extension against the developer environment. Read-only: proves the integration still works against Microsoft's current services. |
| Deploy | `tests/e2e/deploy/*.spec.js` | `npm run test:deploy` | Real writes across two environments (`TARGET_URL`): the deployer's deploy, dependency check and cleanup. Creates throwaway components and deletes them again — always clean up. |

Pick the lowest layer that can catch the bug. Logic goes to unit tests; a
flow that needs the page goes to mock; live tests stay few and read-only.

The fake orgs fail a test on any request they have no answer for — when a
tool starts calling something new, the test must say what the answer is.

## Real behaviour, not documentation

Dataverse and the maker portals do plenty that is undocumented or documented
wrongly. Before writing code or a mock for an API or page:

- **Check it against the developer environment**: the real request, the
  real response, the real error. `node scripts/live-request.mjs GET
  'solutions?$top=3'` sends one request as the test user (the live tests'
  saved session); a signed-in browser (the Playwright MCP) for anything that
  needs the page itself. Leave the leading `/` off paths in Git Bash.
- **Copy mock data from those real responses** — field names, casing,
  formatted-value annotations, error codes, empty-vs-missing — rather than
  writing what the documentation says should come back.

## Never commit identifying data

The repository is public. `scripts/sensitive-scan.mjs` runs before every
commit (`.githooks/pre-commit`) and in CI; never bypass it. In code, tests
and mock data use placeholders only: `contoso` / `fabrikam` hosts,
`guid(n)` ids, made-up names. Tenant ids, real org hosts, user names and
anything from `playwright.env.json` stay out — including from comments and
test titles.

## Commands

```
npm test                 # unit + mock — run before every commit
npm run test:unit        # seconds
npm run test:mock        # about a minute
npm run test:e2e         # live, needs playwright.env.json
npm run test:deploy      # real deployment to TARGET_URL and back
npm run test:report      # the last browser run's report
npm run screenshots      # retake the README screenshots (dev env, redacted — review every image)
npm run check            # syntax + sensitive-data scan
```
