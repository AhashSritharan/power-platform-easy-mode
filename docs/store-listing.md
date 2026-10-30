# Chrome Web Store listing — Power Platform Easy Mode

**Live:** https://chromewebstore.google.com/detail/power-platform-toolbox/jdpbkpcoffofnpbeokkhfgfkjhjdbbeo
(2.0.0, October 2026). The README's Install section links here.

Everything to paste into the [developer dashboard](https://chrome.google.com/webstore/devconsole)
when publishing. One-time $5 registration fee applies to new developer accounts.

## Basics

- **Name:** Power Platform Easy Mode
- **Category:** Developer Tools
- **Language:** English

**Short description** (132-char limit):

> Developer tools for Dynamics 365, Power Platform, Jira & Clockify. Runs 100% locally — collects no data whatsoever.

**Detailed description** — plain text, paste as is (the stores show line breaks
but no formatting; the same text works for Edge Add-ons):

```text
Deploy solutions, browse and edit records, debug flows and see which environment you are in — right inside Dynamics 365 and the Power Platform maker portals.

✔ 18 tools, one palette (Alt+Shift+P)
✔ Labels all your environments DEV / TEST / PROD in one click
✔ No data collected, nothing leaves your browser, open source

SOLUTIONS
• Solution Deployer — deploy between environments, check dependencies
• Solution History — live import progress, failure logs, past exports
• Add Existing Components — sortable, filterable "Add existing"
• Turned-Off Highlighter — spot turned-off flows and components
• Classic Relationship Dialog — back in the maker portal

DATA
• Record Browser — every record, every column, no view needed
• Record Editor — edit any value in place, bypassing the form
• Deep Clone — copy a record with its children, even across environments
• Audit History — who changed what, and when

FLOWS
• Flow Run Monitor — trace failures to the child flow that broke
• Cloud Flow Manager — turn flows on or off in bulk
• Find All References — what uses this step or variable
• Expression Validator — catch references to missing actions
• Parse JSON Schema Builder — schema for List rows with children
• Run Page Actions — re-run and download from the run page

ENVIRONMENTS
• Environment Indicator — DEV / TEST / PROD badge, one-click switching

OPTIONAL
• Jira Clockify Timer — start Clockify timers from Jira issues
• Clockify → Dynamics 365 Sync — import time entries

Independent project, not affiliated with or endorsed by Microsoft.
```

- **Privacy policy URL:** https://github.com/AhashSritharan/power-platform-easy-mode/blob/main/PRIVACY.md
- **Homepage URL:** https://github.com/AhashSritharan/power-platform-easy-mode

## Privacy tab answers

As submitted for 2.0.0 (Chrome Web Store, October 2026).

**Single purpose:**

```text
Helps developers and administrators build and manage Microsoft Dynamics 365 and Power Platform solutions, by adding tools to the pages they already work in: the Dynamics 365 apps and the Power Apps and Power Automate maker portals. The tools inspect and edit Dataverse records, deploy and track solutions, debug Power Automate flows and show which environment the user is in. Two optional, off-by-default tools record the time spent on this work: a Clockify timer on Jira issues, and an import of Clockify time entries into Dynamics 365.
```

**Justification for `storage`:**

```text
Persists the user's own settings (enabled tools, environment labels, an optional user-provided Clockify API key) locally in the browser. Nothing is transmitted.
```

**Justification for host permissions** (one field for all hosts):

```text
The extension's tools run inside these sites and act only on the user's own data, using the session the user is already signed in with.
• *.dynamics.com: the Dynamics 365 tools run in model-driven apps and call that environment's own Dataverse Web API (records, solutions, flows, audit history).
• *.powerapps.com and *.powerautomate.com: tools run in the Power Apps and Power Automate maker portals (environment badge, solution and flow tools). During setup, only when the user clicks "Find my environments", the maker portal opens in a background tab so the list of environments it loads can be labelled; the tab then closes.
• *.atlassian.net: optional, off by default. Adds a Clockify timer button to Jira issues.
• api.clockify.me: optional, off by default. Used only with the user's own Clockify API key, to start and stop timers and read their time entries.
No data is collected or sent to the developer.
```

**Remote code:** No. All code is packaged; there is no `eval`, `new Function` or
script loaded from the network.

**Data usage:** no data-type box ticked. Pages and records are read only inside
the browser, requests go only to the user's own services, and nothing reaches
the developer. The one judgment call is the optional Clockify API key: it is
stored locally and sent only to Clockify, for the user's own account, so it was
not declared as "authentication information". All three confirmations at the
bottom are ticked.

## Test instructions

Submitted without a test account; if the review is rejected because it could
not be tested, create a dedicated reviewer user in the test tenant (maker
role, no MFA, removed after approval) and add its sign-in here.

**Additional instructions:**

```text
Requires a Microsoft Dynamics 365 / Power Platform account. A free one: https://aka.ms/PowerAppsDevPlan (Power Apps Developer Plan, includes an environment). Open the environment's Dynamics 365 app or https://make.powerapps.com, then press Alt+Shift+P (or click the purple switch tab on the right edge) to open Easy Mode, e.g. "Browse Records". Setup opens after install. Jira and Clockify tools are optional, off by default, and not needed for review.
```

## Images

All JPEG (the store rejects PNGs with an alpha channel). They were made from
captures of the test environment with identifying details replaced by
placeholders, and are not kept in this repository.

- Screenshots, 1280×800, in this order: command palette, Record Browser,
  Environment Indicator on the maker portal, Find All References in the flow
  designer, setup's environments step. (Chrome takes 5; a sixth, Solution
  History, is spare for Edge, which takes up to 10.)
- Small promo tile 440×280 and large promo tile 1400×560.
- Publisher icon 128×128: `extension/icons/icon128.png` on white.

## Publishing steps

1. Raise `version` in `extension/manifest.json` — the store rejects a version
   it has already seen (2.0.0 is taken).
2. Publish a GitHub release; the release workflow reruns the end-to-end tests
   and attaches `power-platform-easy-mode-extension.zip`.
3. Developer dashboard → the item → **Package** → upload that zip.
4. Update the listing and privacy tabs from this document if anything changed,
   and submit for review.
