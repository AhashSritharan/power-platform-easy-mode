// How a Dataverse record reference looks in a tool: the table's display name
// and icon, the record's primary name, and choice colours — shared by the
// Audit History and the Record Editor so a lookup reads the same in both.
// Every lookup is cached for the page's lifetime.

import { Dataverse } from '../../core/dataverse.js';

let dv;
const api = () => (dv ??= new Dataverse());

const entityInfoCache = {};     // entity -> { displayName, primaryNameAttr, ... } | null
const displayNameCache = {};    // "entity,guid" -> primary-name value
const optionsetColorCache = {}; // "entity.attribute" -> { value: hexColor }

export const cleanGuid = (guid) => (guid ? guid.replace(/[{}]/g, '').toLowerCase() : '');

export async function fetchEntityInfo(entityName) {
    if (!entityName) return null;
    if (entityName in entityInfoCache) return entityInfoCache[entityName];
    try {
        const data = await api().get(`/EntityDefinitions(LogicalName='${entityName}')?$select=LogicalName,DisplayName,PrimaryNameAttribute,PrimaryIdAttribute,EntitySetName,IconVectorName,IconSmallName`);
        return (entityInfoCache[entityName] = {
            displayName: data.DisplayName?.UserLocalizedLabel?.Label || data.LogicalName,
            primaryNameAttr: data.PrimaryNameAttribute,
            primaryIdAttr: data.PrimaryIdAttribute,
            entitySetName: data.EntitySetName,
            iconName: data.IconSmallName || data.IconVectorName || null,
        });
    } catch (e) {
        console.warn('[records] no entity info for', entityName, e);
        return (entityInfoCache[entityName] = null);
    }
}

export async function fetchRecordDisplayName(entityName, recordId) {
    const cacheKey = `${entityName},${cleanGuid(recordId)}`;
    if (displayNameCache[cacheKey]) return displayNameCache[cacheKey];
    const info = await fetchEntityInfo(entityName);
    if (!info?.entitySetName || !info.primaryNameAttr) return null;
    try {
        const data = await api().get(`/${info.entitySetName}(${cleanGuid(recordId)})?$select=${info.primaryNameAttr}`);
        const name = data[info.primaryNameAttr] ?? null;
        if (name) displayNameCache[cacheKey] = name;
        return name;
    } catch {
        return null;
    }
}

export async function fetchOptionsetColors(entityName, attributeName) {
    const cacheKey = `${entityName}.${attributeName}`;
    if (optionsetColorCache[cacheKey]) return optionsetColorCache[cacheKey];
    const attrType = attributeName === 'statuscode' ? 'StatusAttributeMetadata'
        : attributeName === 'statecode' ? 'StateAttributeMetadata' : 'PicklistAttributeMetadata';
    try {
        const data = await api().get(`/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.${attrType}?$select=LogicalName&$expand=OptionSet($select=Options)`);
        const colors = {};
        for (const option of data.OptionSet?.Options ?? []) {
            if (option.Color) colors[String(option.Value)] = option.Color;
        }
        return (optionsetColorCache[cacheKey] = colors);
    } catch {
        return (optionsetColorCache[cacheKey] = {});
    }
}

/** Table icons are web resources; null when the table has none. */
export const entityIconUrl = (info) => (info?.iconName ? `${location.origin}/WebResources/${info.iconName}` : null);

/** Choice colour as `#rrggbb`, or null; plus the text colour readable on it. */
export function choiceColor(colors, value) {
    const color = colors && value != null ? colors[String(value)] : null;
    if (!color) return null;
    const hex = color.startsWith('#') ? color : `#${color}`;
    return { background: hex, color: contrastText(hex) };
}

function contrastText(hex) {
    const clean = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000000' : '#ffffff';
}
