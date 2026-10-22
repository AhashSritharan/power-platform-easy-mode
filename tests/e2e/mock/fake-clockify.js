// A fake Clockify API for the Clockify settings forms: one user with two
// workspaces for any key but 'wrong-key', which gets Clockify's real 401.
// Answers follow Clockify's API reference and its real answer to a bad key.
// Returns the API keys the requests carried.
export async function fakeClockify(extensionContext) {
    const keys = [];
    await extensionContext.route('https://api.clockify.me/api/v1/**', (route) => {
        const key = route.request().headers()['x-api-key'];
        keys.push(key);
        if (key === 'wrong-key') return route.fulfill({ status: 401, json: { message: 'Api key does not exist', code: 4003 } });
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/v1/user') return route.fulfill({ json: { id: 'user-1', name: 'Pat Doe', email: 'pat@contoso.com', activeWorkspace: 'ws-2', defaultWorkspace: 'ws-1' } });
        if (path === '/api/v1/workspaces') return route.fulfill({ json: [{ id: 'ws-1', name: 'Contoso' }, { id: 'ws-2', name: 'Fabrikam' }] });
        return route.fulfill({ status: 404, json: { message: 'Not found', code: 404 } });
    });
    return keys;
}
