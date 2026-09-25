// Command registry for native tools. The popup and the in-page command
// palette both read from here (merged with legacy-engine commands in main.js).

const commands = [];
let nextId = 1;

/**
 * register({ toolId, title, icon?, subtitle?, run })
 * Returns the stored command, so a tool that owns a stateful toggle can keep
 * its title in step with the state — the popup and palette read the title
 * afresh each time they open.
 */
export function register(command) {
    const stored = { cmdId: `native:${nextId++}`, ...command };
    commands.push(stored);
    return stored;
}

export function list() {
    return commands.map(({ run, ...rest }) => rest);
}

export function invoke(cmdId) {
    const command = commands.find((c) => c.cmdId === cmdId);
    command?.run();
    return !!command;
}

export function all() {
    return [...commands];
}
