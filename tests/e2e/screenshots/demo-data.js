// The demo content the README screenshots show, in the developer environment:
// a "Contoso Sales" solution (publisher prefix contoso) with a handful of cloud
// flows, a custom table and a column on a global choice. Created the first time
// and then left in place as a fixture, so retaking the screenshots is quick
// and they come out the same. Everything else on screen is Microsoft's sample
// data.
//
// The solution holds only part of what it needs — the table's form but not the
// table, the column but not its choice — so the Solution Deployer's dependency
// check finds them missing on the target environment.

export const SOLUTION = 'ContosoSales';
const PREFIX = 'contoso';
const DESCRIPTION = 'Demo content for the Power Platform Toolbox README screenshots. Safe to delete.';

const SCHEMA = 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';
const label = (text) => ({ LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: 1033 }] });
const recurrence = (frequency, interval) => ({ Recurrence: { type: 'Recurrence', recurrence: { frequency, interval } } });
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {}, required: [] } } } };
const compose = (inputs, after) => ({ type: 'Compose', runAfter: after ? { [after]: ['Succeeded'] } : {}, inputs });

/** name → { on, triggers, actions }. Recurring flows that are on produce the runs the Flow Run Monitor shows. */
export const FLOWS = {
    'Sync accounts': { on: true, triggers: recurrence('Minute', 30), actions: { Compose_sync: compose("@utcNow()") } },
    // Fails on every run: the expression divides by zero.
    'Notify approver': { on: true, triggers: recurrence('Hour', 1), actions: { Compose_message: compose("@div(100, 0)") } },
    'Send weekly report': { on: true, triggers: recurrence('Week', 1), actions: { Compose_report: compose("Weekly report @{utcNow()}") } },
    'Archive invoices': { on: false, triggers: recurrence('Day', 1), actions: { Compose_archive: compose('archive') } },
    'Import price list': { on: false, triggers: manual, actions: { Compose_import: compose('import') } },
    // Off: the designer demo for Find All References and the Expression
    // Validator — Send_summary points at a step that does not exist.
    'Invoice summary': {
        on: false, triggers: manual, actions: {
            Initialize_total: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'Total', type: 'integer', value: 0 }] } },
            Compose_total: compose("@add(variables('Total'), 42)", 'Initialize_total'),
            Compose_report: compose("Invoices: @{outputs('Compose_total')}, total @{variables('Total')}", 'Compose_total'),
            Send_summary: compose("@{outputs('Compose_reports')}", 'Compose_report'),
        },
    },
};

const clientdata = ({ triggers, actions }) => JSON.stringify({
    properties: {
        connectionReferences: {},
        definition: {
            $schema: SCHEMA, contentVersion: '1.0.0.0',
            parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
            triggers, actions,
        },
    },
    schemaVersion: '1.0.0.0',
});

/** A Web API call from `page`, which must be on the org: returns the JSON body (or null). */
async function api(page, method, path, body, headers = {}) {
    return page.evaluate(async ({ method, path, body, headers }) => {
        const res = await fetch(`/api/data/v9.2/${path}`, {
            method,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
        return text ? JSON.parse(text) : null;
    }, { method, path, body, headers });
}

const first = async (page, path) => (await api(page, 'GET', path)).value[0] ?? null;

/** Makes sure the demo content exists; returns { solutionId, flows: { name: id } }. */
export async function ensureDemoData(page) {
    let publisher = await first(page, `publishers?$filter=customizationprefix eq '${PREFIX}'&$select=publisherid`);
    if (!publisher) {
        publisher = await api(page, 'POST', 'publishers', {
            uniquename: 'Contoso', friendlyname: 'Contoso', customizationprefix: PREFIX, customizationoptionvalueprefix: 72210, description: DESCRIPTION,
        }, { Prefer: 'return=representation' });
    }
    let solution = await first(page, `solutions?$filter=uniquename eq '${SOLUTION}'&$select=solutionid`);
    if (!solution) {
        solution = await api(page, 'POST', 'solutions', {
            uniquename: SOLUTION, friendlyname: 'Contoso Sales', version: '1.0.0.0', description: DESCRIPTION,
            'publisherid@odata.bind': `/publishers(${publisher.publisherid})`,
        }, { Prefer: 'return=representation' });
    }
    const add = (ComponentId, ComponentType) => api(page, 'POST', 'AddSolutionComponent', {
        ComponentId, ComponentType, SolutionUniqueName: SOLUTION, AddRequiredComponents: false, DoNotIncludeSubcomponents: true,
    });

    // A global choice and an account column on it: the column goes into the solution, the choice does not.
    // GlobalOptionSetDefinitions takes no $filter, and a column binds its choice by MetadataId, not by name.
    const choice = () => api(page, 'GET', `GlobalOptionSetDefinitions(Name='${PREFIX}_region')?$select=MetadataId`).catch(() => null);
    if (!await choice()) {
        await api(page, 'POST', 'GlobalOptionSetDefinitions', {
            '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', Name: `${PREFIX}_region`, DisplayName: label('Sales Region'),
            IsGlobal: true, OptionSetType: 'Picklist',
            Options: ['North', 'South', 'East', 'West'].map((name, i) => ({ Value: 722100000 + i, Label: label(name) })),
        });
    }
    let region = (await api(page, 'GET', `EntityDefinitions(LogicalName='account')/Attributes?$filter=LogicalName eq '${PREFIX}_region'&$select=MetadataId`)).value[0];
    if (!region) {
        await api(page, 'POST', "EntityDefinitions(LogicalName='account')/Attributes", {
            '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata', SchemaName: `${PREFIX}_Region`,
            DisplayName: label('Sales Region'), RequiredLevel: { Value: 'None' },
            'GlobalOptionSet@odata.bind': `/GlobalOptionSetDefinitions(${(await choice()).MetadataId})`,
        });
        region = (await api(page, 'GET', `EntityDefinitions(LogicalName='account')/Attributes?$filter=LogicalName eq '${PREFIX}_region'&$select=MetadataId`)).value[0];
    }

    // A custom table: its main form goes into the solution, the table does not.
    if (!await first(page, `EntityDefinitions?$filter=LogicalName eq '${PREFIX}_invoice'&$select=LogicalName`)) {
        await api(page, 'POST', 'EntityDefinitions', {
            '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata', SchemaName: `${PREFIX}_Invoice`,
            DisplayName: label('Invoice'), DisplayCollectionName: label('Invoices'), Description: label(DESCRIPTION),
            OwnershipType: 'UserOwned', HasActivities: false, HasNotes: false, IsActivity: false,
            Attributes: [{
                '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: `${PREFIX}_Name`, IsPrimaryName: true,
                MaxLength: 100, FormatName: { Value: 'Text' }, RequiredLevel: { Value: 'None' }, DisplayName: label('Invoice Number'),
            }],
        });
        await api(page, 'POST', 'PublishXml', { ParameterXml: `<importexportxml><entities><entity>${PREFIX}_invoice</entity></entities></importexportxml>` });
    }
    const form = await first(page, `systemforms?$filter=objecttypecode eq '${PREFIX}_invoice' and type eq 2&$select=formid`);

    const inSolution = new Set((await api(page, 'GET', `solutioncomponents?$filter=_solutionid_value eq ${solution.solutionid}&$select=objectid`)).value.map((c) => c.objectid));
    if (!inSolution.has(region.MetadataId)) await add(region.MetadataId, 2);
    if (form && !inSolution.has(form.formid)) await add(form.formid, 60);

    const flows = {};
    for (const [name, flow] of Object.entries(FLOWS)) {
        let row = await first(page, `workflows?$filter=name eq '${name}' and category eq 5 and type eq 1&$select=workflowid,statecode`);
        if (!row) {
            row = await api(page, 'POST', 'workflows', {
                name, category: 5, type: 1, primaryentity: 'none', description: DESCRIPTION, clientdata: clientdata(flow),
            }, { Prefer: 'return=representation', 'MSCRM.SolutionUniqueName': SOLUTION });
        }
        if (flow.on && row.statecode !== 1) {
            await api(page, 'PATCH', `workflows(${row.workflowid})`, { statecode: 1, statuscode: 2 });
        }
        flows[name] = row.workflowid;
    }
    return { solutionId: solution.solutionid, flows };
}

/** An account with four of the sample contacts under it, for Deep Clone and the Record Browser. Returns its id. */
export async function ensureAccountWithContacts(page) {
    const NAME = 'Fabrikam, Inc.';
    let account = await first(page, `accounts?$filter=name eq '${NAME}'&$select=accountid`);
    if (!account) {
        account = await api(page, 'POST', 'accounts', {
            name: NAME, telephone1: '555-0150', websiteurl: 'https://www.fabrikam.com', address1_city: 'Redmond', description: DESCRIPTION,
        }, { Prefer: 'return=representation' });
    }
    for (const fullname of ['Maria Campbell (sample)', 'Nancy Anderson (sample)', 'Sidney Higa (sample)', 'John Glynn (sample)']) {
        const contact = await first(page, `contacts?$filter=fullname eq '${fullname}'&$select=contactid,_parentcustomerid_value`);
        if (contact && contact._parentcustomerid_value !== account.accountid) {
            await api(page, 'PATCH', `contacts(${contact.contactid})`, { 'parentcustomerid_account@odata.bind': `/accounts(${account.accountid})` });
        }
    }
    return account.accountid;
}

/** A few edits on a sample contact, so its audit history has something to show. Returns its id. */
export async function ensureAuditTrail(page, fullname) {
    const contact = await first(page, `contacts?$filter=fullname eq '${fullname.replace(/'/g, "''")}'&$select=contactid,jobtitle`);
    const audits = await api(page, 'GET', `audits?$filter=_objectid_value eq ${contact.contactid} and operation eq 2&$select=auditid&$top=5`);
    if (audits.value.length < 3) {
        for (const change of [
            { jobtitle: 'Buyer', telephone1: '555-0100' },
            { jobtitle: 'Purchasing Manager', preferredcontactmethodcode: 2 },
            { jobtitle: 'Head of Purchasing', donotemail: true },
        ]) await api(page, 'PATCH', `contacts(${contact.contactid})`, change);
    }
    return contact.contactid;
}
