# Privacy Policy — Power Platform Toolbox

_Last updated: 2026-07-06_

## The short version

**Power Platform Toolbox collects no data. Period.**

No analytics, no telemetry, no crash reporting, no accounts, no cookies of its
own, no fingerprinting. There is no server behind this extension — everything
runs locally in your browser.

## What the extension stores

Tool settings (for example: which tools you have enabled, your environment
DEV/TEST/PROD labels, or a Clockify API key **you** enter) are stored in your
browser's local extension storage (`chrome.storage.local`) on your machine.
This data:

- never leaves your browser,
- is not synced, transmitted, or backed up anywhere by the extension,
- is removed by Chrome when you uninstall the extension.

## Network requests

The extension itself phones home to nothing. The only network requests are the
ones individual tools make **on your behalf, to services you already use**:

| Destination | When | Purpose |
|---|---|---|
| Your Dynamics 365 / Dataverse environments (`*.dynamics.com`) | Using Dynamics 365 tools | Reading/writing the data the tool works on, using your existing browser session |
| Power Apps / Power Automate maker portals (`*.powerapps.com`, `*.powerautomate.com`) | Using Power Platform tools | Same as above |
| Power Apps maker portal (`make.powerapps.com`) | Only when you click "Find my environments" in setup | The portal is opened in a background tab and loads its own list of the environments you can access; the extension keeps the names and addresses from that list in local storage, then closes the tab |
| Jira Cloud (`*.atlassian.net`) | Using the Jira Clockify Timer | Reading the issue you are viewing |
| Clockify API (`api.clockify.me`) | Only if you configure a Clockify API key | Starting/stopping timers and reading time entries in **your** Clockify workspace |

Requests to any other destination are actively blocked by the extension's
internal allowlist, and Chrome's permission model prevents the extension from
touching any other website.

## Credentials — the extension never holds them

Every request rides on your existing browser session: the browser attaches
your cookies itself (`credentials: include`). The extension's code never
reads, extracts, stores, or handles credentials of any kind — no passwords,
no access/bearer tokens, no MSAL or other token caches in page storage.

This is a hard design rule, not just current behavior: APIs that would
require the extension to take a token into its own hands are deliberately
not used, even when that means doing without a feature that would be
technically possible. Requests the tools make can read real business data
(that is their job, on your instruction) — but the extension itself never
possesses the keys. Passively observing responses the page has already
loaded (the page agent) is the outer limit; actively extracting secrets is
out of bounds. You can verify this in the source: there is no code path in
which a credential exists as a value.

## Permissions explained

- **`storage`** — save your settings locally.
- **Host access** to the domains in the table above — the pages the tools run
  on and the APIs they call. The extension has no access to any other site.

## Third parties

None. No third-party code is loaded at runtime, no remote code is executed,
and no data is shared with anyone (there is nothing to share).

## Open source

The complete source code is available at
<https://github.com/AhashSritharan/power-platform-toolbox> — you can
audit every request the extension is capable of making.

## Changes & contact

If this policy ever changes, the change will be visible in the repository's
history. Questions or concerns: please
[open an issue](https://github.com/AhashSritharan/power-platform-toolbox/issues).
