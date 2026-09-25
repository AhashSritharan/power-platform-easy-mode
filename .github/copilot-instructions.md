# Project: Tampermonkey Userscripts for Dynamics 365 & Power Platform

This workspace contains Tampermonkey userscripts that extend Dynamics 365 CRM, Power Platform (Power Automate, Power Apps), and Jira with custom UI tools.

## Key Rules

- **All new Tampermonkey scripts must follow our Fluent UI design system.** See the detailed design guide in `.github/instructions/tampermonkey-fluent-ui.instructions.md` for exact colors, components, typography, spacing, animations, and code patterns.
- Target Dynamics 365 scripts at `https://*.dynamics.com/main.aspx*` and use the Dataverse Web API (`/api/data/v9.2`).
- Use `GM_registerMenuCommand` to expose script entry points.
- **Register tools with the Power Platform Launcher** using `window.PowerPlatformTools.register()` so they appear in the unified toolbar menu.
- Wrap the entire script in an IIFE with `'use strict'` and an SPA re-initialization guard.
- Inject styles via a `<style>` element with a unique `id` per script.
- Use a unique CSS class prefix per script to avoid collisions (e.g., `audit-`, `flow-`, `clone-`).
- Always include `escapeHtml()`, `addHover()`, and `cleanGuid()` utility functions.

## Power Platform Launcher Integration

All scripts should register with the unified launcher so users can access tools from a single toolbar button. Use `unsafeWindow` for cross-script communication:

```javascript
// Add to @grant section:
// @grant        unsafeWindow

// At the top of your IIFE, define pageWindow:
const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

// Register with Power Platform Tools Launcher (if available)
if (pageWindow.PowerPlatformTools?.register) {
    pageWindow.PowerPlatformTools.register({
        id: 'my-tool-id',
        name: 'My Tool Name',
        icon: '🔧',
        category: 'dynamics',  // 'dynamics' | 'powerautomate' | 'powerapps' | 'general'
        description: 'Short description of what the tool does',
        action: openMyTool,    // Function to call when clicked
        isAvailable: () => {   // Optional: return false to hide on certain pages
            return window.location.href.includes('/main.aspx');
        }
    });
}
```
