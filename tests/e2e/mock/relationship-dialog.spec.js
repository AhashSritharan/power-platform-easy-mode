// Classic Relationship Dialog on a stub maker-portal Relationships page: the
// "Manage Relationship" item it adds to a row's Advanced menu, the relationship
// lookup in the org, and the classic dialog it opens. The row and menu markup
// is a live portal's (2026-10-15), trimmed.
import { test, expect } from './fixtures.js';
import { guid } from './fake-dataverse.js';

const SOLUTION = guid(1401);
const ACCOUNT = guid(1402);
const RELATIONSHIP = guid(1403);
const SCHEMA = 'account_primary_contact';

const menuItem = (key, icon, text) => '<li role="presentation" class="ms-ContextualMenu-item">'
    + `<button data-test-key="${key}" class="ms-ContextualMenu-link" role="menuitem" aria-disabled="false"><div class="ms-ContextualMenu-linkContent">`
    + `<i data-icon-name="${icon}" aria-hidden="true" class="ms-ContextualMenu-icon"></i><span class="ms-ContextualMenu-itemText">${text}</span></div></button></li>`;

// The portal builds the menu layer when it opens — the Advanced submenu is
// added to the page on click, which is what the tool waits for.
const advancedMenu = '<div class="ms-Layer ms-Layer--fixed"><div class="ms-ContextualMenu"><ul class="ms-ContextualMenu-list is-open" role="presentation">'
    + menuItem('ShowDependencies', 'Org', 'Show dependencies')
    + menuItem('SeeSolutionLayers', 'MapLayers', 'See solution layers')
    + menuItem('RelationshipManagedProperties', 'Settings', 'Managed properties')
    + '</ul></div></div>';

const relationshipsPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Relationships | Power Apps</title></head><body>
<div role="grid"><div role="row" data-automationid="DetailsRow" class="ms-FocusZone ms-DetailsRow is-selected">
  <div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="displayName">Primary Contact</div>
  <div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="contextualMenu"><button type="button" title="Commands" id="advanced">⋮</button></div>
  <div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="uniqueName">${SCHEMA}</div>
  <div role="gridcell" data-automationid="DetailsRowCell" data-automation-key="relationshipType">Many-to-one</div>
</div></div>
<script>
  document.getElementById('advanced').addEventListener('click', () => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(advancedMenu)}));
</script></body></html>`;

test.describe('Classic Relationship Dialog', () => {
    test('adds "Manage Relationship" to the Advanced menu and opens the classic dialog', async ({ page, org, serviceWorker, portal }) => {
        await serviceWorker.evaluate(({ host, envId }) => chrome.storage.local.set({
            'vals/environment-indicator/envIndicator_hostCache': { [host]: envId },
        }), { host: org.host, envId: org.environmentId });
        org.on('GET', new RegExp(`^/EntityDefinitions\\(${ACCOUNT}\\)/ManyToOneRelationships`), (req) => ({
            value: req.query.get('$filter') === `SchemaName eq '${SCHEMA}'` ? [{ MetadataId: RELATIONSHIP }] : [],
        }));
        org.on('GET', '/tools/systemcustomization/relationships/manageRelationship.aspx', () => ({
            contentType: 'text/html', body: '<!doctype html><html><body>Classic relationship dialog</body></html>',
        }));
        portal.page(relationshipsPage);
        await page.goto(`https://make.powerapps.com/environments/${org.environmentId}/solutions/${SOLUTION}/entities/${ACCOUNT}/relationships`);

        await expect(page.locator('.ppt-launcher')).toBeVisible(); // the toolbox has started
        await page.locator('#advanced').click();
        const item = page.locator('#ppt-manage-rel-item button');
        await expect(item).toHaveText('Manage Relationship');
        await expect(item).toHaveAttribute('data-test-key', 'ManageRelationship');
        await expect(item.locator('[data-icon-name]')).toHaveAttribute('data-icon-name', 'Relationship');
        await item.click();

        const frame = page.locator('.ppt-dialog', { hasText: 'Manage Relationship' }).locator('iframe');
        await expect(frame).toBeVisible();
        const src = new URL(await frame.getAttribute('src'));
        expect(src.origin).toBe(org.origin);
        expect(src.pathname).toBe('/tools/systemcustomization/relationships/manageRelationship.aspx');
        expect(Object.fromEntries(src.searchParams)).toEqual({
            entityRole: 'referencing', entityRelationshipId: RELATIONSHIP, entityId: ACCOUNT, appSolutionId: SOLUTION,
        });
        await expect(page.frameLocator('.ppt-dialog iframe').locator('body')).toHaveText('Classic relationship dialog');
    });
});
