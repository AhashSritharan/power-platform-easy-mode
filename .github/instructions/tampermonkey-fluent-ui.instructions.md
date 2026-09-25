---
name: 'Tampermonkey Fluent UI Design System'
description: 'Fluent UI design conventions for all Tampermonkey userscripts — colors, components, typography, spacing, animations, and code patterns'
applyTo: '**/*.js'
---

# Tampermonkey Script — Fluent UI Design Guide

When creating or editing Tampermonkey userscripts, **always** follow the design system below. It is extracted from our existing scripts and ensures visual consistency across all tools.

---

## 1. Script Boilerplate

```javascript
// ==UserScript==
// @name         Script Name
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Description
// @author       You
// @match        https://*.dynamics.com/main.aspx*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // Use unsafeWindow for cross-script communication
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // SPA re-initialization guard
    if (pageWindow.__scriptNameLoaded) return;
    pageWindow.__scriptNameLoaded = true;

    // ... script code ...

    function openTool() {
        // Main tool logic here
    }

    function init() {
        console.log('🔍 Script Name loaded');
        injectStyles();

        // Register with Power Platform Tools Launcher
        if (pageWindow.PowerPlatformTools?.register) {
            pageWindow.PowerPlatformTools.register({
                id: 'script-name',
                name: 'Script Name',
                icon: '🔧',
                category: 'dynamics',  // 'dynamics' | 'powerautomate' | 'powerapps' | 'general'
                description: 'Short description',
                action: openTool,
                isAvailable: () => true  // Optional: control visibility
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
```

---

## 2. Color Palette

### Core Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `brand-primary` | `#0F6CBD` | Buttons, links, focus rings, accent badges, active chips |
| `brand-primary-hover` | `#115EA3` | Primary button hover |
| `text-primary` | `#242424` | Main body text, headings |
| `text-secondary` | `#616161` | Labels, descriptions, muted text, placeholders |
| `text-tertiary` | `#838383` | Subtle help text |
| `surface` | `#FFFFFF` | Panels, modals, cards, dropdowns |
| `surface-tinted` | `#FAFAFA` | Filter bars, toolbar backgrounds, sticky headers, footers |
| `surface-subtle` | `#F5F5F5` | Secondary hover, info blocks, monospace blocks |
| `border-default` | `#E0E0E0` | Panel dividers, section borders, table borders |
| `border-strong` | `#D1D1D1` | Input borders, secondary button borders |
| `border-subtle` | `#F0F0F0` | Table row dividers, dropdown separators |

### Semantic / Status Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `success` | `#107C10` | Success badges, success buttons |
| `success-hover` | `#0E6A0E` | Success button hover |
| `success-surface` | `#DFF6DD` | Success message background |
| `success-border` | `#A7E3A5` | Success message border |
| `error` | `#D13438` | Error text, danger buttons, destructive actions |
| `error-hover` | `#B10E11` | Danger button hover |
| `error-surface` | `#FDE7E9` | Error message background |
| `error-border` | `#F1BBBC` | Error message border |
| `error-dark` | `#A4262C` | Destructive text links |
| `warning` | `#835C00` | Warning text |
| `warning-surface` | `#FFF4CE` | Warning message background |
| `warning-border` | `#F5D06C` | Warning message border |
| `info-surface` | `#E5F1FB` | Info message background |
| `info-surface-light` | `#EBF3FC` | Active chip background, brand tint badges |
| `info-border` | `#B3D4FC` | Info message border |

### Overlay Colors

| Value | Usage |
|-------|-------|
| `rgba(0,0,0,0.3)` | Slide-in panel backdrop |
| `rgba(0,0,0,0.4)` | Modal backdrop |
| `rgba(255,255,255,0.85)` | Full-page loading overlay |

---

## 3. Typography

### Font Family

```css
/* Dynamics 365 / Power Platform scripts */
font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;

/* Jira / Atlassian scripts */
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;

/* Monospace (code blocks, IDs) */
font-family: 'Consolas', 'Courier New', monospace;
```

### Font Sizes

| Size | Usage |
|------|-------|
| `18px–20px` | Panel/dialog title (h2) |
| `16px` | Sub-dialog title (h3) |
| `14px` | Body text, primary buttons, inputs |
| `13px` | Table cells, secondary buttons, filter inputs |
| `12px` | Chip text, date labels, auxiliary info |
| `11px` | Labels (uppercase), badge text, column headers |
| `10px` | Tiny badges |

### Font Weights

| Weight | Usage |
|--------|-------|
| `600` | Labels, headings, buttons, badges, strong text |
| `500` | Status badges, medium links |
| `400` | Normal body text (default) |

### Labels (Standardized)

```css
font-weight: 600;
color: #616161;
font-size: 11px;
text-transform: uppercase;
letter-spacing: 0.5px;
margin-bottom: 4px;
```

---

## 4. Components

### 4.1 Primary Button

```css
background: #0F6CBD;
color: white;
border: none;
padding: 8px 20px;
border-radius: 4px;
font-size: 14px;
font-weight: 600;
font-family: inherit;
cursor: pointer;
transition: background 0.1s;
```
```css
:hover  { background: #115EA3; }
:disabled { opacity: 0.5; cursor: not-allowed; }
```

### 4.2 Secondary Button

```css
background: #FFFFFF;
color: #242424;
border: 1px solid #D1D1D1;
padding: 8px 20px;
border-radius: 4px;
font-size: 14px;
font-weight: 600;
font-family: inherit;
cursor: pointer;
transition: background 0.1s;
```
```css
:hover  { background: #F5F5F5; }
:disabled { opacity: 0.4; cursor: default; }
```

### 4.3 Success Button

```css
background: #107C10; color: white; border: none;
/* Same padding/radius/weight as primary */
:hover  { background: #0E6A0E; }
```

### 4.4 Danger Button

```css
background: #D13438; color: white; border: none;
/* Same padding/radius/weight as primary */
:hover  { background: #B10E11; }
```

### 4.5 Outline Buttons (Optional Variants)

```css
/* Outline Primary */   color: #0F6CBD; border: 1px solid #0F6CBD; :hover bg: #EBF3FC;
/* Outline Success */   color: #107C10; border: 1px solid #107C10; :hover bg: #DFF6DD;
/* Outline Danger */    color: #D13438; border: 1px solid #D13438; :hover bg: #FDE7E9;
/* Outline Warning */   color: #D83B01; border: 1px solid #D83B01; :hover bg: #FFF4CE;
```

### 4.6 Close / Icon Button

```css
background: transparent;
border: none;
cursor: pointer;
padding: 6px;
border-radius: 4px;
color: #616161;
font-size: 20px;
line-height: 1;
transition: background 0.1s;
```
```css
:hover { background: #F5F5F5; }
```

### 4.7 Destructive Text Button

```css
background: transparent;
color: #A4262C;
border: none;
padding: 6px 12px;
border-radius: 4px;
font-size: 13px;
font-weight: 600;
```
```css
:hover { background: #FDF3F4; }
```

---

### 4.8 Text Input

```css
padding: 8px 12px;
font-size: 14px;
border: 1px solid #D1D1D1;
border-radius: 4px;
font-family: inherit;
outline: none;
background: #FFFFFF;
color: #242424;
transition: border-color 0.15s;
box-sizing: border-box;
width: 100%;
```
```css
:focus {
    border-color: #0F6CBD;
    box-shadow: 0 0 0 1px #0F6CBD;
}
```

### 4.9 Select / Dropdown Control

```css
/* Same as input, plus: */
cursor: pointer;
appearance: auto;
min-height: 36px;
```

### 4.10 Checkbox

```css
width: 16px;
height: 16px;
accent-color: #0F6CBD;
cursor: pointer;
```

### 4.11 Date Input

```css
/* Same as text input, plus: */
appearance: none;
-webkit-appearance: none;
```
```css
::-webkit-calendar-picker-indicator {
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.1s;
}
::-webkit-calendar-picker-indicator:hover { opacity: 1; }
```

### 4.12 Input Clear Button (x inside input)

```css
position: absolute;
right: 8px;
top: 50%;
transform: translateY(-50%);
background: transparent;
border: none;
color: #616161;
cursor: pointer;
font-size: 14px;
padding: 2px 4px;
line-height: 1;
border-radius: 3px;
```
```css
:hover { color: #242424; background: #F0F0F0; }
```

---

### 4.13 Filter Chips (Pill Toggles)

```css
padding: 5px 12px;
font-size: 12px;
font-weight: 600;
border: 1px solid #D1D1D1;
border-radius: 16px;
background: #FFFFFF;
color: #424242;
cursor: pointer;
font-family: inherit;
transition: all 0.1s;
```
```css
:hover, .active {
    border-color: #0F6CBD;
    color: #0F6CBD;
    background: #EBF3FC;
}
```

### 4.14 Status Badge

```css
display: inline-flex;
align-items: center;
gap: 4px;
padding: 3px 8px;
border-radius: 12px;
font-size: 11px;
font-weight: 600;
/* Dynamic color: */
background: ${statusColor}15;
color: ${statusColor};
border: 1px solid ${statusColor}30;
```

### 4.15 Entity/Context Badge (Panel Header)

```css
background: #EBF3FC;
color: #0F6CBD;
padding: 2px 8px;
border-radius: 4px;
font-size: 11px;
font-weight: 600;
```

### 4.16 Optionset Color Pill

```css
display: inline-block;
padding: 2px 8px;
border-radius: 12px;
background: ${hexColor};          /* From CRM metadata */
color: ${contrastTextColor};      /* Auto-calculated black or white */
font-size: 12px;
font-weight: 500;
white-space: nowrap;
```

---

### 4.17 Autocomplete Dropdown

```css
/* Container */
position: absolute;
top: 100%;
left: 0;
right: 0;
background: #FFFFFF;
border: 1px solid #D1D1D1;
border-top: none;
border-radius: 0 0 4px 4px;
max-height: 200px;
overflow-y: auto;
z-index: 10003;
box-shadow: 0 4px 8px rgba(0,0,0,0.1);

/* Item */
padding: 8px 12px;
cursor: pointer;
font-size: 13px;
color: #242424;
border-bottom: 1px solid #F0F0F0;
:hover { background: #F5F5F5; }

/* Empty/loading message */
padding: 10px 12px;
font-size: 13px;
color: #616161;
```

---

### 4.18 Table

```css
/* Table */
width: 100%;
border-collapse: collapse;
font-size: 13px;

/* Sticky Header */
thead { position: sticky; top: 0; z-index: 1; }

/* th */
text-align: left;
padding: 8px 10px;
font-weight: 600;
color: #616161;
font-size: 11px;
text-transform: uppercase;
letter-spacing: 0.3px;
border-bottom: 2px solid #E0E0E0;
background: #FAFAFA;
white-space: nowrap;

/* td */
padding: 6px 10px;
color: #242424;
border-bottom: 1px solid #F0F0F0;
vertical-align: top;
line-height: 1.4;

/* Row hover (optional) */
tr:hover { background: #F9F9F9; }
```

---

### 4.19 Links

```css
/* Record / entity links */
color: #0F6CBD;
text-decoration: none;
cursor: pointer;
font-weight: 600;
:hover { text-decoration: underline; color: #115EA3; }

/* User / secondary links (same but no font-weight: 600) */
```

---

## 5. Layout Patterns

### 5.1 Slide-In Panel (Right Drawer)

```css
/* Backdrop */
position: fixed; inset: 0;
background: rgba(0,0,0,0.3);
z-index: 10000;
animation: fade-in 0.2s ease;

/* Panel */
position: fixed; top: 0; right: 0; bottom: 0;
width: 75vw;
min-width: 480px;
max-width: 1800px;
background: #FFFFFF;
z-index: 10001;
display: flex; flex-direction: column;
font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
box-shadow: -4px 0 24px rgba(0,0,0,0.18);
animation: slide-in 0.25s ease;
```

**Panel structure:**
```
+-------------------------+
| Header (16px 24px)      |  <- flex-shrink: 0; border-bottom
+-------------------------+
| Filter Bar (FAFAFA bg)  |  <- flex-shrink: 0; border-bottom
+-------------------------+
| Results (scrollable)    |  <- flex: 1; overflow-y: auto
+-------------------------+
| Pagination (FAFAFA bg)  |  <- flex-shrink: 0; border-top
+-------------------------+
```

### 5.2 Centered Modal Dialog

```css
position: fixed; top: 50%; left: 50%;
transform: translate(-50%, -50%);
background: #FFFFFF;
border: 1px solid #E0E0E0;
border-radius: 8px;
padding: 24px;
max-width: 500px;            /* varies: 400px-800px */
width: 90%;
max-height: 80vh;
z-index: 10001;
box-shadow: 0 8px 16px rgba(0,0,0,0.14), 0 0 2px rgba(0,0,0,0.12);
font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
display: flex; flex-direction: column;
animation: scale-in 0.2s ease;   /* optional */
```

### 5.3 Full-Page Loading Overlay

```css
position: fixed; top: 0; left: 0; width: 100%; height: 100%;
background: rgba(255, 255, 255, 0.85);
z-index: 10002;
backdrop-filter: blur(4px);
display: flex; flex-direction: column;
align-items: center; justify-content: center;
```

### 5.4 Panel Header

```css
display: flex;
align-items: center;
justify-content: space-between;
padding: 16px 24px;
border-bottom: 1px solid #E0E0E0;
flex-shrink: 0;
```

### 5.5 Panel Footer

```css
padding: 16px 24px;
border-top: 1px solid #E0E0E0;
flex-shrink: 0;
background: #FAFAFA;
```

---

## 6. Animations

```css
/* Slide-in (panel from right) */
@keyframes slide-in {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
}

/* Fade-in (backdrop) */
@keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
}

/* Scale-in (modals) */
@keyframes scale-in {
    from { transform: translate(-50%, -50%) scale(0.95); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
}

/* Spin (loading spinners) */
@keyframes spin {
    0%   { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

/* Slide-up (toasts) */
@keyframes slide-up {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
}

/* Fade-out (toast dismiss) */
@keyframes fade-out {
    from { opacity: 1; }
    to   { opacity: 0; }
}

/* Pulse (live indicator dot) */
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.5; }
}
```

### Standard Transitions

```css
transition: background 0.1s;                /* Buttons */
transition: border-color 0.15s;             /* Input focus */
transition: all 0.1s;                       /* Chips */
transition: opacity 0.2s ease, transform 0.2s ease;  /* Toasts */
```

---

## 7. Loading States

### Standard Spinner

```css
width: 28px; height: 28px;
border: 3px solid #E0E0E0;
border-top-color: #0F6CBD;
border-radius: 50%;
animation: spin 0.7s linear infinite;
```

### Small Inline Spinner

```css
display: inline-block;
width: 14px; height: 14px;
border: 2px solid #E0E0E0;
border-top-color: #0F6CBD;
border-radius: 50%;
animation: spin 0.7s linear infinite;
```

### Light Spinner (on colored background)

```css
border: 2px solid rgba(255,255,255,0.3);
border-top-color: #FFFFFF;
```

### Loading Container Pattern

```html
<div style="display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px;">
    <div class="{prefix}-spinner"></div>
    <span style="color: #616161; font-size: 14px;">Loading...</span>
</div>
```

---

## 8. Message Patterns

### Inline Error

```html
<div style="padding: 32px; text-align: center;">
    <div style="color: #D13438; font-weight: 600; margin-bottom: 8px;">Error Title</div>
    <div style="color: #616161; font-size: 13px;">Error details here</div>
</div>
```

### Boxed Alert Messages

```css
/* All use: border-radius: 6px; padding: 12px 16px; font-size: 13px; */

/* Info */    background: #E5F1FB; border: 1px solid #B3D4FC; color: #0F6CBD;
/* Success */ background: #DFF6DD; border: 1px solid #A7E3A5; color: #107C10;
/* Warning */ background: #FFF4CE; border: 1px solid #F5D06C; color: #835C00;
/* Error */   background: #FDE7E9; border: 1px solid #F1BBBC; color: #D13438;
```

### Result Dialog with Icon Circle

```css
/* 48px circle */
width: 48px; height: 48px;
border-radius: 50%;
background: ${semanticBgColor};
display: flex; align-items: center; justify-content: center;
/* Icon: font-size: 24px; color: ${semanticColor}; */
```

---

## 9. Toast Notifications

```css
position: fixed;
bottom: 24px;
right: 24px;
z-index: 99999;
background: #FFFFFF;
color: #242424;
border: 1px solid #E0E0E0;
border-radius: 8px;
padding: 12px 16px;
font-size: 13px;
line-height: 1.4;
box-shadow: 0 4px 12px rgba(0,0,0,0.14), 0 0 2px rgba(0,0,0,0.08);
max-width: 320px;
/* Animate in with slide-up, auto-dismiss after 3s */
```

---

## 10. Spacing & Layout Conventions

| Context | Value |
|---------|-------|
| Panel header/footer padding | `16px 24px` |
| Panel content padding | `8px 24px 16px` |
| Modal padding | `24px` |
| Filter group gap | `12px` |
| Button group gap | `8px` |
| Chip gap | `4px` |
| Section vertical spacing | `12px` or `16px` |
| Card inner padding | `12px 16px` |

---

## 11. Border Radius Reference

| Value | Usage |
|-------|-------|
| `4px` | **Standard** — inputs, buttons, selects, badges, close buttons |
| `6px` | Alert message boxes |
| `8px` | Modals, dialogs, toasts, radio cards |
| `12px` | Pill badges, status badges |
| `16px` | Filter chips |
| `50%` | Spinners, status dots, icon circles |

---

## 12. Box Shadow Reference

| Value | Usage |
|-------|-------|
| `0 4px 8px rgba(0,0,0,0.1)` | Dropdown menus |
| `0 4px 12px rgba(0,0,0,0.15)` | Toast notifications |
| `0 8px 16px rgba(0,0,0,0.14), 0 0 2px rgba(0,0,0,0.12)` | Modal dialogs |
| `0 8px 32px rgba(0,0,0,0.24)` | Primary/confirm dialogs |
| `-4px 0 24px rgba(0,0,0,0.18)` | Slide-in panels |
| `0 0 0 1px #0F6CBD` | Input focus ring |

---

## 13. Z-Index Layering

| Z-Index | Layer |
|---------|-------|
| `9999` | Floating action buttons |
| `10000` | Backdrop / primary overlay |
| `10001` | Panel / primary modal |
| `10002` | Nested overlays / loading overlays |
| `10003` | Dropdowns inside panels |
| `10010` | Confirm dialog backdrop |
| `10011` | Confirm dialog |
| `99999` | Toast notifications |
| `100000+` | Nested modals (rare) |

---

## 14. Common Utility Functions

Always include these helpers:

```javascript
// Escape HTML to prevent XSS
function escapeHtml(text) {
    if (!text) return '';
    let div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Hover effect helper (use for programmatic hover on inline-styled elements)
function addHover(el, hoverBg, normalBg) {
    if (!el) return;
    el.addEventListener('mouseenter', () => { el.style.background = hoverBg; });
    el.addEventListener('mouseleave', () => { el.style.background = normalBg; });
}

// Clean GUID (remove braces, lowercase)
function cleanGuid(guid) {
    return guid ? guid.replace(/[{}]/g, '').toLowerCase() : '';
}

// ISO date format for filters
function formatDateISO(date) {
    let y = date.getFullYear();
    let m = String(date.getMonth() + 1).padStart(2, '0');
    let d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
```

---

## 15. Behavioral Patterns

- **SPA guard**: Always use `if (window.__uniqueFlag) return; window.__uniqueFlag = true;`
- **Style injection**: Create a `<style>` element with a unique `id` (e.g., `'my-script-styles'`) and append to `<head>`
- **Escape key**: Close panel/modal on `Escape` keypress; remove listener on close
- **Click outside**: Backdrop click closes the panel; `e.stopPropagation()` on the panel itself
- **CSS class prefix**: Use a unique prefix per script to avoid collisions (e.g., `audit-`, `flow-`, `clone-`)
- **Debounced search**: Use `setTimeout` with 350ms delay for search-as-you-type inputs
- **Enter key**: Trigger search on `Enter` in filter inputs
- **Menu command**: Use `GM_registerMenuCommand('Open Tool Name', openFunction);`
- **Launcher registration**: Register with `window.PowerPlatformTools.register()` for unified toolbar access

---

## 16. Power Platform Launcher Integration

All scripts should register with the Power Platform Tools Launcher to appear in the unified toolbar menu.

**Important:** Use `unsafeWindow` for cross-script communication between Tampermonkey scripts:

```javascript
// Add to @grant section:
// @grant        unsafeWindow

// At top of IIFE:
const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

// Register with launcher (call in init function)
if (pageWindow.PowerPlatformTools?.register) {
    pageWindow.PowerPlatformTools.register({
        id: 'unique-tool-id',           // Unique identifier
        name: 'Tool Name',              // Display name in menu
        icon: '🔧',                     // Emoji icon
        category: 'dynamics',           // 'dynamics' | 'powerautomate' | 'powerapps' | 'general'
        description: 'What the tool does',  // Short description
        action: openToolFunction,       // Function to execute
        isAvailable: () => {            // Optional: control when tool appears
            // Return false to hide on certain pages
            return window.location.href.includes('/main.aspx');
        },
        shortcut: 'Ctrl+Shift+X'        // Optional: keyboard shortcut hint (display only)
    });
}
```

### Category Guidelines

| Category | Use for |
|----------|--------|
| `dynamics` | Tools for Dynamics 365 CRM pages |
| `powerautomate` | Tools for Power Automate maker portal |
| `powerapps` | Tools for Power Apps maker portal |
| `general` | Tools that work across multiple platforms |

### isAvailable Function

Use `isAvailable` to hide tools on pages where they don't apply:

```javascript
// Only show on entity forms
isAvailable: () => window.location.href.includes('/main.aspx') && 
                   typeof Xrm !== 'undefined' && 
                   Xrm.Page?.data?.entity

// Only show on flow designer pages
isAvailable: () => window.location.href.includes('/flows/') &&
                   window.location.href.includes('/edit')
```

---

## 17. Dynamics 365 API Conventions

When scripts target Dynamics 365:

```javascript
function getClientUrl() {
    try {
        if (typeof Xrm !== 'undefined' && Xrm.Utility) {
            return Xrm.Utility.getGlobalContext().getClientUrl();
        }
    } catch (e) { /* ignore */ }
    return window.location.origin;
}

function getApiUrl() {
    return getClientUrl() + '/api/data/v9.2';
}

async function apiFetch(url) {
    let response = await fetch(url, {
        headers: {
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            'Accept': 'application/json',
            'Prefer': 'odata.include-annotations="*"'
        }
    });
    if (!response.ok) throw new Error(`API ${response.status}: ${response.statusText}`);
    return response.json();
}
```
