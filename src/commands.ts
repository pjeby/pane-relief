// Simplified Commands Framework

import {Command, Hotkey, Modifier, Plugin} from "obsidian"

type KeyDef = Hotkey | string

const commands: Record<symbol, Command> = {}; //new Map;

export function command(id: string, name: string, hotkeys: KeyDef | KeyDef[] = [], cmd={}) {

    // Allow hotkeys to be expressed as a string, array of strings,
    // object, or array of objects.  (Normalize to an array first.)
    if (typeof hotkeys === "string") hotkeys = [hotkeys];
    if (typeof hotkeys === "object" && (hotkeys as Hotkey).key) hotkeys = [hotkeys as Hotkey];

    let keys: Hotkey[] = (hotkeys as KeyDef[]).map(function(key): Hotkey {
        // If a hotkey is an object already, no need to process it
        if (typeof key === "object") return key;
        // Convert strings to Obsidian's hotkey format
        let parts = key.split("+")
        return { modifiers: parts as Modifier[], key: parts.pop() || "+" }  // empty last part = e.g. 'Mod++'
    });
    Object.assign(cmd, {id, name, hotkeys: keys});

    // Save the command data under a unique symbol
    const sym = Symbol("cmd:" + id);
    commands[sym] = cmd as Command;
    return sym;
}

export function addCommands<P extends Plugin>(
    plugin: P,
    cmdset: Record<symbol, (thisArg: P) => boolean | (() => any)>
) {
    // Extract command symbols from cmdset and register them, bound to the plugin for methods
    Object.getOwnPropertySymbols(cmdset).forEach(sym => {
        const cmd = commands[sym], method = cmdset[sym];
        if (cmd) plugin.addCommand(Object.assign({}, cmd, {
            checkCallback(check: boolean) {
                // Call the method body with the plugin as 'this'
                const cb = method.call(plugin);
                // It then returns a closure if the command is ready to execute, and
                // we call that closure unless this is just a check for availability
                return (check || typeof cb !== "function") ? !!cb : (cb(), true);
            }
        }));
    })
}