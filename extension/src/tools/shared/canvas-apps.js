// Canvas-app resolution against Dataverse, shared by Run Opener and
// Flow Run Monitor.
//
// The trigger headers of an app-triggered run (x-ms-client-app-id,
// x-ms-user-agent "AppName=…") only carry the app ID — and they are only
// readable for the run whose page is open. So:
//  - fetchCanvasAppNames turns app IDs into display names (canvasapps table),
//  - buildCanvasOriginResolver identifies the app(s) behind a run tree's root
//    run: trigger kind "PowerApp*" in the flow definition says it WAS
//    app-triggered, RetrieveDependentComponents (type 300) says which app(s)
//    reference the flow. Definition-level — the actual triggering app isn't
//    stored on foreign runs, so multiple referencing apps are all shown.

export async function fetchCanvasAppNames(apiGet, appIds) {
    const names = new Map();
    const ids = [...new Set(appIds.map((id) => String(id).toLowerCase()))].filter((id) => /^[a-f0-9-]{36}$/.test(id));
    for (let i = 0; i < ids.length; i += 10) {
        const filter = ids.slice(i, i + 10).map((id) => `canvasappid eq ${id}`).join(' or ');
        const data = await apiGet(`/canvasapps?$select=canvasappid,name,displayname&$filter=${encodeURIComponent(filter)}`);
        for (const app of data.value ?? []) {
            names.set(app.canvasappid.toLowerCase(), app.displayname || app.name || null);
        }
    }
    return names;
}

async function fetchDependentCanvasAppIds(apiGet, workflowId) {
    const data = await apiGet(`/RetrieveDependentComponents(ObjectId=${workflowId},ComponentType=29)`);
    const ids = new Set();
    for (const dep of data.value ?? []) {
        if (dep.dependentcomponenttype === 300 && dep.dependentcomponentobjectid) {
            ids.add(dep.dependentcomponentobjectid.toLowerCase());
        }
    }
    return [...ids];
}

// The canvas app(s) that reference a flow, via solution dependencies, with
// names resolved. Returns [{ id, name }] (id = canvasappid, name may be null),
// or [] when the flow has no canvas-app dependency (e.g. not in a solution).
// This is definition-level: it finds apps that CAN trigger the flow, which is
// how the run tree resolves the origin, and how Run Opener falls back when a
// run's trigger header carries no usable app id (solution apps).
export async function resolveCanvasAppsForFlow(apiGet, workflowId) {
    const appIds = await fetchDependentCanvasAppIds(apiGet, workflowId);
    if (!appIds.length) return [];
    const names = await fetchCanvasAppNames(apiGet, appIds).catch(() => new Map());
    return appIds.map((id) => ({ id, name: names.get(id) || null }));
}

// Trigger kind "PowerApp" (V1) / "PowerAppV2" ⇒ the flow is app-triggered.
async function hasCanvasAppTrigger(apiGet, workflowId) {
    const data = await apiGet(`/workflows(${workflowId})?$select=clientdata`);
    const definition = JSON.parse(data?.clientdata ?? 'null');
    const triggers = definition?.properties?.definition?.triggers ?? {};
    return Object.values(triggers).some((trigger) => /^PowerApp/i.test(trigger?.kind ?? ''));
}

/**
 * Returns a resolveOrigin callback for showConnectedRunsDialog. Resolves the
 * canvas app(s) that trigger the tree's root flow, or null when the root run
 * wasn't app-triggered. getPlayUrl(appId) may be async (the play URL needs
 * the environment id, which each caller knows differently).
 */
export function buildCanvasOriginResolver(apiGet, getPlayUrl) {
    return async (rootRun) => {
        const workflowId = rootRun?._workflow_value;
        if (!workflowId || rootRun.parentrunid) return null;
        try {
            if (!await hasCanvasAppTrigger(apiGet, workflowId)) return null;

            const apps = await resolveCanvasAppsForFlow(apiGet, workflowId);
            if (!apps.length) {
                return [{
                    label: 'Canvas App',
                    subLabel: 'App-triggered, but the app could not be resolved (likely not in a solution)',
                    url: null,
                }];
            }

            const entries = [];
            for (const { id, name } of apps) {
                entries.push({
                    label: name || 'Canvas App',
                    subLabel: apps.length > 1 ? 'One of several apps using this flow' : `App ID: ${id}`,
                    url: await getPlayUrl(id),
                });
            }
            return entries;
        } catch (e) {
            console.warn('[Canvas origin] resolution failed:', e);
            return null;
        }
    };
}
