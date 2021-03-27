'use strict';

var obsidian = require('obsidian');

// Simplified Commands Framework

const commands = {};

function command(id, name, hotkeys=[], cmd={}) {

    // Allow hotkeys to be expressed as a string, array of strings,
    // object, or array of objects.  (Normalize to an array first.)
    if (typeof hotkeys === "string") hotkeys = [hotkeys];
    if (typeof hotkeys === "object" && hotkeys.key) hotkeys = [hotkeys];

    hotkeys = hotkeys.map(function(key) {
        // If a hotkey is an object already, no need to process it
        if (typeof key === "object") return key;
        // Convert strings to Obsidian's hotkey format
        key = key.split("+");
        return { modifiers: key, key: key.pop() || "+" }  // empty last part = e.g. 'Mod++'
    });
    Object.assign(cmd, {id, name, hotkeys});

    // Save the command data under a unique symbol
    const sym = Symbol("cmd:" + id);
    commands[sym] = cmd;
    return sym;
}

function addCommands(plugin, cmdset) {
    // Extract command symbols from cmdset and register them, bound to the plugin for methods
    Object.getOwnPropertySymbols(cmdset).forEach(sym => {
        const cmd = commands[sym], method = cmdset[sym];
        if (cmd) plugin.addCommand(Object.assign({}, cmd, {
            checkCallback(check) {
                // Call the method body with the plugin as 'this'
                const cb = method.call(plugin);
                // It then returns a closure if the command is ready to execute, and
                // we call that closure unless this is just a check for availability
                return (check || typeof cb !== "function") ? !!cb : (cb(), true);
            }
        }));
    });
}

function around(obj, factories) {
    const removers = Object.keys(factories).map(key => around1(obj, key, factories[key]));
    return removers.length === 1 ? removers[0] : function () { removers.forEach(r => r()); };
}
function around1(obj, method, createWrapper) {
    const original = obj[method], hadOwn = obj.hasOwnProperty(method);
    let current = createWrapper(original);
    // Let our wrapper inherit static props from the wrapping method,
    // and the wrapping method, props from the original method
    if (original)
        Object.setPrototypeOf(current, original);
    Object.setPrototypeOf(wrapper, current);
    obj[method] = wrapper;
    // Return a callback to allow safe removal
    return remove;
    function wrapper(...args) {
        // If we have been deactivated and are no longer wrapped, remove ourselves
        if (current === original && obj[method] === wrapper)
            remove();
        return current.apply(this, args);
    }
    function remove() {
        // If no other patches, just do a direct removal
        if (obj[method] === wrapper) {
            if (hadOwn)
                obj[method] = original;
            else
                delete obj[method];
        }
        if (current === original)
            return;
        // Else pass future calls through, and remove wrapper from the prototype chain
        current = original;
        Object.setPrototypeOf(wrapper, original || Function);
    }
}

const HIST_ATTR = "pane-relief:history-v1";
const SERIAL_PROP = "pane-relief:history-v1";

class History {
    static current(app) {
        return this.forLeaf(app.workspace.activeLeaf) || new this();
    }

    static forLeaf(leaf) {
        if (leaf) return leaf[HIST_ATTR] || (leaf[HIST_ATTR] = new this(leaf));
    }

    constructor(leaf, {pos, stack} = {pos:0, stack:[]}) {
        this.leaf = leaf;
        this.pos = pos;
        this.stack = stack;
    }

    serialize() { return {pos: this.pos, stack: this.stack}; }

    get state() { return this.stack[this.pos] || null; }
    get length() { return this.stack.length; }

    back()    { this.go(-1); }
    forward() { this.go( 1); }

    go(by) {
        //console.log(by);

        if (!this.leaf || !by) return;  // no-op
        if (this.leaf.pinned) return new obsidian.Notice("Pinned pane: unpin before going forward or back"), undefined;

        // prevent wraparound
        const newPos = Math.max(0, Math.min(this.pos - by, this.stack.length - 1));

        if (newPos !== this.pos) {
            this.pos = newPos;
            if (this.state && this.leaf) {
                const state = JSON.parse(this.state.state || "{}");
                const eState = JSON.parse(this.state.eState || "{}");
                state.popstate = true;
                state.active = true;
                this.leaf.setViewState(state, eState);
            }
        } else {
            new obsidian.Notice(`No more ${by < 0 ? "back" : "forward"} history for pane`);
        }
    }

    replaceState(state, title, url){ this.stack[this.pos] = state; }

    pushState(state, title, url)   {
        this.stack.splice(0, this.pos, state);
        this.pos = 0;
        // Limit "back" to 20
        while (this.stack.length > 20) this.stack.pop();
    }
}

function installHistory(plugin) {

    const app = plugin.app;

    // Monkeypatch: include history in leaf serialization (so it's persisted with the workspace)
    plugin.register(around(obsidian.WorkspaceLeaf.prototype, {
        serialize(old) { return function serialize(){
            const result = old.call(this);
            if (this[HIST_ATTR]) result[SERIAL_PROP] = this[HIST_ATTR].serialize();
            return result;
        }}
    }));

    // Monkeypatch: load history during leaf load, if present
    plugin.register(around(app.workspace, {
        deserializeLayout(old) { return async function deserializeLayout(state, ...etc){
            const result = await old.call(this, state, ...etc);
            if (state.type === "leaf") {
                if (state[SERIAL_PROP]) result[HIST_ATTR] = new History(result, state[SERIAL_PROP]);
                if (state.active && app.workspace.rootSplit === null) {
                    // Fix for https://forum.obsidian.md/t/active-leaf-is-saved-but-not-restored/15402
                    app.workspace.rootSplit = result.getRoot();
                    app.workspace.setActiveLeaf(result, false, true);
                }
            }
            return result;
        }}
    }));

    // Override default mouse history behavior.  We need this because 1) Electron will use the built-in
    // history object if we don't (instead of our wrapper), and 2) we want the click to apply to the leaf
    // that was under the mouse, rather than whichever leaf was active.
    window.addEventListener("mouseup", historyHandler, true);
    plugin.register( () => window.removeEventListener("mouseup", historyHandler, true) );
    function historyHandler(e) {
        if (e.button !== 3 && e.button !== 4) return;
        e.preventDefault(); e.stopPropagation();  // prevent default behavior
        const target = e.target.matchParent(".workspace-leaf");
        if (target) {
            let leaf;
            app.workspace.iterateAllLeaves(l => leaf = (l.containerEl === target) ? l : leaf);
            if (e.button == 3) { History.forLeaf(leaf).back(); }
            if (e.button == 4) { History.forLeaf(leaf).forward(); }
        }
        return false;
    }

    // Proxy the window history with a wrapper that delegates to the active leaf's History object,
    const realHistory = window.history;
    plugin.register(() => window.history = realHistory);
    Object.defineProperty(window, "history", { enumerable: true, configurable: true, writable: true, value: {
        get state()      { return History.current(app).state; },
        get length()     { return History.current(app).length; },

        back()    { this.go(-1); },
        forward() { this.go( 1); },
        go(by)    { History.current(app).go(by); },

        replaceState(state, title, url){ History.current(app).replaceState(state, title, url); },
        pushState(state, title, url)   { History.current(app).pushState(state, title, url); },

        get scrollRestoration()    { return realHistory.scrollRestoration; },
        set scrollRestoration(val) { realHistory.scrollRestoration = val; },
    }});

}

class PaneRelief extends obsidian.Plugin {

    onload() {
        installHistory(this);
        addCommands(this, {
            [command("swap-prev", "Swap pane with previous in split",  "Mod+Shift+PageUp")]   (){ return this.leafPlacer(-1); },
            [command("swap-next", "Swap pane with next in split",      "Mod+Shift+PageDown")] (){ return this.leafPlacer( 1); },

            [command("go-prev",  "Cycle to previous workspace pane",   "Mod+PageUp"  )] () { return () => this.gotoNthLeaf(-1, true); },
            [command("go-next",  "Cycle to next workspace pane",       "Mod+PageDown")] () { return () => this.gotoNthLeaf( 1, true); },

            [command("go-1st",   "Jump to 1st pane in the workspace",  "Alt+1")] () { return () => this.gotoNthLeaf(0); },
            [command("go-2nd",   "Jump to 2nd pane in the workspace",  "Alt+2")] () { return () => this.gotoNthLeaf(1); },
            [command("go-3rd",   "Jump to 3rd pane in the workspace",  "Alt+3")] () { return () => this.gotoNthLeaf(2); },
            [command("go-4th",   "Jump to 4th pane in the workspace",  "Alt+4")] () { return () => this.gotoNthLeaf(3); },
            [command("go-5th",   "Jump to 5th pane in the workspace",  "Alt+5")] () { return () => this.gotoNthLeaf(4); },
            [command("go-6th",   "Jump to 6th pane in the workspace",  "Alt+6")] () { return () => this.gotoNthLeaf(5); },
            [command("go-7th",   "Jump to 7th pane in the workspace",  "Alt+7")] () { return () => this.gotoNthLeaf(6); },
            [command("go-8th",   "Jump to 8th pane in the workspace",  "Alt+8")] () { return () => this.gotoNthLeaf(7); },
            [command("go-last",  "Jump to last pane in the workspace", "Alt+9")] () { return () => this.gotoNthLeaf(99999999); },

            [command("put-1st",  "Place as 1st pane in the split",     "Mod+Alt+1")] () { return () => this.placeLeaf(0, false); },
            [command("put-2nd",  "Place as 2nd pane in the split",     "Mod+Alt+2")] () { return () => this.placeLeaf(1, false); },
            [command("put-3rd",  "Place as 3rd pane in the split",     "Mod+Alt+3")] () { return () => this.placeLeaf(2, false); },
            [command("put-4th",  "Place as 4th pane in the split",     "Mod+Alt+4")] () { return () => this.placeLeaf(3, false); },
            [command("put-5th",  "Place as 5th pane in the split",     "Mod+Alt+5")] () { return () => this.placeLeaf(4, false); },
            [command("put-6th",  "Place as 6th pane in the split",     "Mod+Alt+6")] () { return () => this.placeLeaf(5, false); },
            [command("put-7th",  "Place as 7th pane in the split",     "Mod+Alt+7")] () { return () => this.placeLeaf(6, false); },
            [command("put-8th",  "Place as 8th pane in the split",     "Mod+Alt+8")] () { return () => this.placeLeaf(7, false); },
            [command("put-last", "Place as last pane in the split",    "Mod+Alt+9")] () { return () => this.placeLeaf(99999999, false); }
        });
    }

    gotoNthLeaf(n, relative) {
        const leaves = [];
        this.app.workspace.iterateRootLeaves((leaf) => (leaves.push(leaf), false));
        if (relative) {
            n += leaves.indexOf(this.app.workspace.activeLeaf);
            n = (n + leaves.length) % leaves.length;  // wrap around
        }
        const leaf = leaves[n>=leaves.length ? leaves.length-1 : n];
        !leaf || this.app.workspace.setActiveLeaf(leaf, true, true);
    }

    placeLeaf(toPos, relative=true) {
        const cb = this.leafPlacer(toPos, relative);
        if (cb) cb();
    }

    leafPlacer(toPos, relative=true) {
        const leaf = this.app.workspace.activeLeaf;
        if (!leaf) return false;

        const
            parentSplit = leaf.parentSplit,
            children = parentSplit.children,
            fromPos = children.indexOf(leaf)
        ;
        if (fromPos == -1) return false;

        if (relative) {
            toPos += fromPos;
            if (toPos < 0 || toPos >= children.length) return false;
        } else {
            if (toPos >= children.length) toPos = children.length - 1;
            if (toPos < 0) toPos = 0;
        }

        if (fromPos == toPos) return false;

        return () => {
            const other = children[toPos];
            children.splice(fromPos, 1);
            children.splice(toPos,   0, leaf);
            if (parentSplit.selectTab) {
                parentSplit.selectTab(leaf);
            } else {
                other.containerEl.insertAdjacentElement(fromPos > toPos ? "beforebegin" : "afterend", leaf.containerEl);
                parentSplit.recomputeChildrenDimensions();
                leaf.onResize();
                this.app.workspace.onLayoutChange();

                // Force focus back to pane;
                this.app.workspace.activeLeaf = null;
                this.app.workspace.setActiveLeaf(leaf, false, true);
            }
        }
    }
}

module.exports = PaneRelief;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9wbHVnaW4uanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gU2ltcGxpZmllZCBDb21tYW5kcyBGcmFtZXdvcmtcblxuY29uc3QgY29tbWFuZHMgPSB7fTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmQoaWQsIG5hbWUsIGhvdGtleXM9W10sIGNtZD17fSkge1xuXG4gICAgLy8gQWxsb3cgaG90a2V5cyB0byBiZSBleHByZXNzZWQgYXMgYSBzdHJpbmcsIGFycmF5IG9mIHN0cmluZ3MsXG4gICAgLy8gb2JqZWN0LCBvciBhcnJheSBvZiBvYmplY3RzLiAgKE5vcm1hbGl6ZSB0byBhbiBhcnJheSBmaXJzdC4pXG4gICAgaWYgKHR5cGVvZiBob3RrZXlzID09PSBcInN0cmluZ1wiKSBob3RrZXlzID0gW2hvdGtleXNdO1xuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJvYmplY3RcIiAmJiBob3RrZXlzLmtleSkgaG90a2V5cyA9IFtob3RrZXlzXTtcblxuICAgIGhvdGtleXMgPSBob3RrZXlzLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgICAgLy8gSWYgYSBob3RrZXkgaXMgYW4gb2JqZWN0IGFscmVhZHksIG5vIG5lZWQgdG8gcHJvY2VzcyBpdFxuICAgICAgICBpZiAodHlwZW9mIGtleSA9PT0gXCJvYmplY3RcIikgcmV0dXJuIGtleTtcbiAgICAgICAgLy8gQ29udmVydCBzdHJpbmdzIHRvIE9ic2lkaWFuJ3MgaG90a2V5IGZvcm1hdFxuICAgICAgICBrZXkgPSBrZXkuc3BsaXQoXCIrXCIpXG4gICAgICAgIHJldHVybiB7IG1vZGlmaWVyczoga2V5LCBrZXk6IGtleS5wb3AoKSB8fCBcIitcIiB9ICAvLyBlbXB0eSBsYXN0IHBhcnQgPSBlLmcuICdNb2QrKydcbiAgICB9KTtcbiAgICBPYmplY3QuYXNzaWduKGNtZCwge2lkLCBuYW1lLCBob3RrZXlzfSk7XG5cbiAgICAvLyBTYXZlIHRoZSBjb21tYW5kIGRhdGEgdW5kZXIgYSB1bmlxdWUgc3ltYm9sXG4gICAgY29uc3Qgc3ltID0gU3ltYm9sKFwiY21kOlwiICsgaWQpO1xuICAgIGNvbW1hbmRzW3N5bV0gPSBjbWQ7XG4gICAgcmV0dXJuIHN5bTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbW1hbmRzKHBsdWdpbiwgY21kc2V0KSB7XG4gICAgLy8gRXh0cmFjdCBjb21tYW5kIHN5bWJvbHMgZnJvbSBjbWRzZXQgYW5kIHJlZ2lzdGVyIHRoZW0sIGJvdW5kIHRvIHRoZSBwbHVnaW4gZm9yIG1ldGhvZHNcbiAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlTeW1ib2xzKGNtZHNldCkuZm9yRWFjaChzeW0gPT4ge1xuICAgICAgICBjb25zdCBjbWQgPSBjb21tYW5kc1tzeW1dLCBtZXRob2QgPSBjbWRzZXRbc3ltXTtcbiAgICAgICAgaWYgKGNtZCkgcGx1Z2luLmFkZENvbW1hbmQoT2JqZWN0LmFzc2lnbih7fSwgY21kLCB7XG4gICAgICAgICAgICBjaGVja0NhbGxiYWNrKGNoZWNrKSB7XG4gICAgICAgICAgICAgICAgLy8gQ2FsbCB0aGUgbWV0aG9kIGJvZHkgd2l0aCB0aGUgcGx1Z2luIGFzICd0aGlzJ1xuICAgICAgICAgICAgICAgIGNvbnN0IGNiID0gbWV0aG9kLmNhbGwocGx1Z2luKTtcbiAgICAgICAgICAgICAgICAvLyBJdCB0aGVuIHJldHVybnMgYSBjbG9zdXJlIGlmIHRoZSBjb21tYW5kIGlzIHJlYWR5IHRvIGV4ZWN1dGUsIGFuZFxuICAgICAgICAgICAgICAgIC8vIHdlIGNhbGwgdGhhdCBjbG9zdXJlIHVubGVzcyB0aGlzIGlzIGp1c3QgYSBjaGVjayBmb3IgYXZhaWxhYmlsaXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuIChjaGVjayB8fCB0eXBlb2YgY2IgIT09IFwiZnVuY3Rpb25cIikgPyAhIWNiIDogKGNiKCksIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgfSlcbn0iLCJleHBvcnQgZnVuY3Rpb24gYXJvdW5kKG9iaiwgZmFjdG9yaWVzKSB7XG4gICAgY29uc3QgcmVtb3ZlcnMgPSBPYmplY3Qua2V5cyhmYWN0b3JpZXMpLm1hcChrZXkgPT4gYXJvdW5kMShvYmosIGtleSwgZmFjdG9yaWVzW2tleV0pKTtcbiAgICByZXR1cm4gcmVtb3ZlcnMubGVuZ3RoID09PSAxID8gcmVtb3ZlcnNbMF0gOiBmdW5jdGlvbiAoKSB7IHJlbW92ZXJzLmZvckVhY2gociA9PiByKCkpOyB9O1xufVxuZnVuY3Rpb24gYXJvdW5kMShvYmosIG1ldGhvZCwgY3JlYXRlV3JhcHBlcikge1xuICAgIGNvbnN0IG9yaWdpbmFsID0gb2JqW21ldGhvZF0sIGhhZE93biA9IG9iai5oYXNPd25Qcm9wZXJ0eShtZXRob2QpO1xuICAgIGxldCBjdXJyZW50ID0gY3JlYXRlV3JhcHBlcihvcmlnaW5hbCk7XG4gICAgLy8gTGV0IG91ciB3cmFwcGVyIGluaGVyaXQgc3RhdGljIHByb3BzIGZyb20gdGhlIHdyYXBwaW5nIG1ldGhvZCxcbiAgICAvLyBhbmQgdGhlIHdyYXBwaW5nIG1ldGhvZCwgcHJvcHMgZnJvbSB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgaWYgKG9yaWdpbmFsKVxuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY3VycmVudCwgb3JpZ2luYWwpO1xuICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBjdXJyZW50KTtcbiAgICBvYmpbbWV0aG9kXSA9IHdyYXBwZXI7XG4gICAgLy8gUmV0dXJuIGEgY2FsbGJhY2sgdG8gYWxsb3cgc2FmZSByZW1vdmFsXG4gICAgcmV0dXJuIHJlbW92ZTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgLy8gSWYgd2UgaGF2ZSBiZWVuIGRlYWN0aXZhdGVkIGFuZCBhcmUgbm8gbG9uZ2VyIHdyYXBwZWQsIHJlbW92ZSBvdXJzZWx2ZXNcbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsICYmIG9ialttZXRob2RdID09PSB3cmFwcGVyKVxuICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgIHJldHVybiBjdXJyZW50LmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgICBmdW5jdGlvbiByZW1vdmUoKSB7XG4gICAgICAgIC8vIElmIG5vIG90aGVyIHBhdGNoZXMsIGp1c3QgZG8gYSBkaXJlY3QgcmVtb3ZhbFxuICAgICAgICBpZiAob2JqW21ldGhvZF0gPT09IHdyYXBwZXIpIHtcbiAgICAgICAgICAgIGlmIChoYWRPd24pXG4gICAgICAgICAgICAgICAgb2JqW21ldGhvZF0gPSBvcmlnaW5hbDtcbiAgICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgICAgICBkZWxldGUgb2JqW21ldGhvZF07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAvLyBFbHNlIHBhc3MgZnV0dXJlIGNhbGxzIHRocm91Z2gsIGFuZCByZW1vdmUgd3JhcHBlciBmcm9tIHRoZSBwcm90b3R5cGUgY2hhaW5cbiAgICAgICAgY3VycmVudCA9IG9yaWdpbmFsO1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgb3JpZ2luYWwgfHwgRnVuY3Rpb24pO1xuICAgIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiBhZnRlcihwcm9taXNlLCBjYikge1xuICAgIHJldHVybiBwcm9taXNlLnRoZW4oY2IsIGNiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBzZXJpYWxpemUoYXN5bmNGdW5jdGlvbikge1xuICAgIGxldCBsYXN0UnVuID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7XG4gICAgICAgICAgICBhZnRlcihsYXN0UnVuLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgYXN5bmNGdW5jdGlvbi5hcHBseSh0aGlzLCBhcmdzKS50aGVuKHJlcywgcmVqKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgd3JhcHBlci5hZnRlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHsgYWZ0ZXIobGFzdFJ1biwgcmVzKTsgfSk7XG4gICAgfTtcbiAgICByZXR1cm4gd3JhcHBlcjtcbn1cbiIsImltcG9ydCB7Tm90aWNlLCBXb3Jrc3BhY2VMZWFmfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcblxuY29uc3QgSElTVF9BVFRSID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCI7XG5jb25zdCBTRVJJQUxfUFJPUCA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuXG5jbGFzcyBIaXN0b3J5IHtcbiAgICBzdGF0aWMgY3VycmVudChhcHApIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yTGVhZihhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHx8IG5ldyB0aGlzKCk7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvckxlYWYobGVhZikge1xuICAgICAgICBpZiAobGVhZikgcmV0dXJuIGxlYWZbSElTVF9BVFRSXSB8fCAobGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMobGVhZikpO1xuICAgIH1cblxuICAgIGNvbnN0cnVjdG9yKGxlYWYsIHtwb3MsIHN0YWNrfSA9IHtwb3M6MCwgc3RhY2s6W119KSB7XG4gICAgICAgIHRoaXMubGVhZiA9IGxlYWY7XG4gICAgICAgIHRoaXMucG9zID0gcG9zO1xuICAgICAgICB0aGlzLnN0YWNrID0gc3RhY2s7XG4gICAgfVxuXG4gICAgc2VyaWFsaXplKCkgeyByZXR1cm4ge3BvczogdGhpcy5wb3MsIHN0YWNrOiB0aGlzLnN0YWNrfTsgfVxuXG4gICAgZ2V0IHN0YXRlKCkgeyByZXR1cm4gdGhpcy5zdGFja1t0aGlzLnBvc10gfHwgbnVsbDsgfVxuICAgIGdldCBsZW5ndGgoKSB7IHJldHVybiB0aGlzLnN0YWNrLmxlbmd0aDsgfVxuXG4gICAgYmFjaygpICAgIHsgdGhpcy5nbygtMSk7IH1cbiAgICBmb3J3YXJkKCkgeyB0aGlzLmdvKCAxKTsgfVxuXG4gICAgZ28oYnkpIHtcbiAgICAgICAgLy9jb25zb2xlLmxvZyhieSk7XG5cbiAgICAgICAgaWYgKCF0aGlzLmxlYWYgfHwgIWJ5KSByZXR1cm47ICAvLyBuby1vcFxuICAgICAgICBpZiAodGhpcy5sZWFmLnBpbm5lZCkgcmV0dXJuIG5ldyBOb3RpY2UoXCJQaW5uZWQgcGFuZTogdW5waW4gYmVmb3JlIGdvaW5nIGZvcndhcmQgb3IgYmFja1wiKSwgdW5kZWZpbmVkO1xuXG4gICAgICAgIC8vIHByZXZlbnQgd3JhcGFyb3VuZFxuICAgICAgICBjb25zdCBuZXdQb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbih0aGlzLnBvcyAtIGJ5LCB0aGlzLnN0YWNrLmxlbmd0aCAtIDEpKTtcblxuICAgICAgICBpZiAobmV3UG9zICE9PSB0aGlzLnBvcykge1xuICAgICAgICAgICAgdGhpcy5wb3MgPSBuZXdQb3M7XG4gICAgICAgICAgICBpZiAodGhpcy5zdGF0ZSAmJiB0aGlzLmxlYWYpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2UodGhpcy5zdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGVTdGF0ZSA9IEpTT04ucGFyc2UodGhpcy5zdGF0ZS5lU3RhdGUgfHwgXCJ7fVwiKTtcbiAgICAgICAgICAgICAgICBzdGF0ZS5wb3BzdGF0ZSA9IHRydWU7XG4gICAgICAgICAgICAgICAgc3RhdGUuYWN0aXZlID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB0aGlzLmxlYWYuc2V0Vmlld1N0YXRlKHN0YXRlLCBlU3RhdGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbmV3IE5vdGljZShgTm8gbW9yZSAke2J5IDwgMCA/IFwiYmFja1wiIDogXCJmb3J3YXJkXCJ9IGhpc3RvcnkgZm9yIHBhbmVgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCl7IHRoaXMuc3RhY2tbdGhpcy5wb3NdID0gc3RhdGU7IH1cblxuICAgIHB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCkgICB7XG4gICAgICAgIHRoaXMuc3RhY2suc3BsaWNlKDAsIHRoaXMucG9zLCBzdGF0ZSk7XG4gICAgICAgIHRoaXMucG9zID0gMDtcbiAgICAgICAgLy8gTGltaXQgXCJiYWNrXCIgdG8gMjBcbiAgICAgICAgd2hpbGUgKHRoaXMuc3RhY2subGVuZ3RoID4gMjApIHRoaXMuc3RhY2sucG9wKCk7XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbEhpc3RvcnkocGx1Z2luKSB7XG5cbiAgICBjb25zdCBhcHAgPSBwbHVnaW4uYXBwO1xuXG4gICAgLy8gTW9ua2V5cGF0Y2g6IGluY2x1ZGUgaGlzdG9yeSBpbiBsZWFmIHNlcmlhbGl6YXRpb24gKHNvIGl0J3MgcGVyc2lzdGVkIHdpdGggdGhlIHdvcmtzcGFjZSlcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKFdvcmtzcGFjZUxlYWYucHJvdG90eXBlLCB7XG4gICAgICAgIHNlcmlhbGl6ZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNlcmlhbGl6ZSgpe1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICBpZiAodGhpc1tISVNUX0FUVFJdKSByZXN1bHRbU0VSSUFMX1BST1BdID0gdGhpc1tISVNUX0FUVFJdLnNlcmlhbGl6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX1cbiAgICB9KSk7XG5cbiAgICAvLyBNb25rZXlwYXRjaDogbG9hZCBoaXN0b3J5IGR1cmluZyBsZWFmIGxvYWQsIGlmIHByZXNlbnRcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKGFwcC53b3Jrc3BhY2UsIHtcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZUxheW91dChzdGF0ZSwgLi4uZXRjKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlW1NFUklBTF9QUk9QXSkgcmVzdWx0W0hJU1RfQVRUUl0gPSBuZXcgSGlzdG9yeShyZXN1bHQsIHN0YXRlW1NFUklBTF9QUk9QXSk7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlLmFjdGl2ZSAmJiBhcHAud29ya3NwYWNlLnJvb3RTcGxpdCA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBGaXggZm9yIGh0dHBzOi8vZm9ydW0ub2JzaWRpYW4ubWQvdC9hY3RpdmUtbGVhZi1pcy1zYXZlZC1idXQtbm90LXJlc3RvcmVkLzE1NDAyXG4gICAgICAgICAgICAgICAgICAgIGFwcC53b3Jrc3BhY2Uucm9vdFNwbGl0ID0gcmVzdWx0LmdldFJvb3QoKTtcbiAgICAgICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS5zZXRBY3RpdmVMZWFmKHJlc3VsdCwgZmFsc2UsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19XG4gICAgfSkpO1xuXG4gICAgLy8gT3ZlcnJpZGUgZGVmYXVsdCBtb3VzZSBoaXN0b3J5IGJlaGF2aW9yLiAgV2UgbmVlZCB0aGlzIGJlY2F1c2UgMSkgRWxlY3Ryb24gd2lsbCB1c2UgdGhlIGJ1aWx0LWluXG4gICAgLy8gaGlzdG9yeSBvYmplY3QgaWYgd2UgZG9uJ3QgKGluc3RlYWQgb2Ygb3VyIHdyYXBwZXIpLCBhbmQgMikgd2Ugd2FudCB0aGUgY2xpY2sgdG8gYXBwbHkgdG8gdGhlIGxlYWZcbiAgICAvLyB0aGF0IHdhcyB1bmRlciB0aGUgbW91c2UsIHJhdGhlciB0aGFuIHdoaWNoZXZlciBsZWFmIHdhcyBhY3RpdmUuXG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoICgpID0+IHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSkgKTtcbiAgICBmdW5jdGlvbiBoaXN0b3J5SGFuZGxlcihlKSB7XG4gICAgICAgIGlmIChlLmJ1dHRvbiAhPT0gMyAmJiBlLmJ1dHRvbiAhPT0gNCkgcmV0dXJuO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7ICAvLyBwcmV2ZW50IGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQubWF0Y2hQYXJlbnQoXCIud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgIGlmICh0YXJnZXQpIHtcbiAgICAgICAgICAgIGxldCBsZWFmO1xuICAgICAgICAgICAgYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKGwgPT4gbGVhZiA9IChsLmNvbnRhaW5lckVsID09PSB0YXJnZXQpID8gbCA6IGxlYWYpO1xuICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDMpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmJhY2soKTsgfVxuICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDQpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmZvcndhcmQoKTsgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBQcm94eSB0aGUgd2luZG93IGhpc3Rvcnkgd2l0aCBhIHdyYXBwZXIgdGhhdCBkZWxlZ2F0ZXMgdG8gdGhlIGFjdGl2ZSBsZWFmJ3MgSGlzdG9yeSBvYmplY3QsXG4gICAgY29uc3QgcmVhbEhpc3RvcnkgPSB3aW5kb3cuaGlzdG9yeTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoKCkgPT4gd2luZG93Lmhpc3RvcnkgPSByZWFsSGlzdG9yeSk7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJoaXN0b3J5XCIsIHsgZW51bWVyYWJsZTogdHJ1ZSwgY29uZmlndXJhYmxlOiB0cnVlLCB3cml0YWJsZTogdHJ1ZSwgdmFsdWU6IHtcbiAgICAgICAgZ2V0IHN0YXRlKCkgICAgICB7IHJldHVybiBIaXN0b3J5LmN1cnJlbnQoYXBwKS5zdGF0ZTsgfSxcbiAgICAgICAgZ2V0IGxlbmd0aCgpICAgICB7IHJldHVybiBIaXN0b3J5LmN1cnJlbnQoYXBwKS5sZW5ndGg7IH0sXG5cbiAgICAgICAgYmFjaygpICAgIHsgdGhpcy5nbygtMSk7IH0sXG4gICAgICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9LFxuICAgICAgICBnbyhieSkgICAgeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5nbyhieSk7IH0sXG5cbiAgICAgICAgcmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKXsgSGlzdG9yeS5jdXJyZW50KGFwcCkucmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcbiAgICAgICAgcHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKSAgIHsgSGlzdG9yeS5jdXJyZW50KGFwcCkucHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcblxuICAgICAgICBnZXQgc2Nyb2xsUmVzdG9yYXRpb24oKSAgICB7IHJldHVybiByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbjsgfSxcbiAgICAgICAgc2V0IHNjcm9sbFJlc3RvcmF0aW9uKHZhbCkgeyByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbiA9IHZhbDsgfSxcbiAgICB9fSk7XG5cbn1cbiIsImltcG9ydCB7UGx1Z2lufSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2FkZENvbW1hbmRzLCBjb21tYW5kfSBmcm9tIFwiLi9jb21tYW5kc1wiO1xuaW1wb3J0IHtpbnN0YWxsSGlzdG9yeX0gZnJvbSBcIi4vSGlzdG9yeVwiO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBQYW5lUmVsaWVmIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgaW5zdGFsbEhpc3RvcnkodGhpcyk7XG4gICAgICAgIGFkZENvbW1hbmRzKHRoaXMsIHtcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1wcmV2XCIsIFwiU3dhcCBwYW5lIHdpdGggcHJldmlvdXMgaW4gc3BsaXRcIiwgIFwiTW9kK1NoaWZ0K1BhZ2VVcFwiKV0gICAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlcigtMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtbmV4dFwiLCBcIlN3YXAgcGFuZSB3aXRoIG5leHQgaW4gc3BsaXRcIiwgICAgICBcIk1vZCtTaGlmdCtQYWdlRG93blwiKV0gKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoIDEpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLXByZXZcIiwgIFwiQ3ljbGUgdG8gcHJldmlvdXMgd29ya3NwYWNlIHBhbmVcIiwgICBcIk1vZCtQYWdlVXBcIiAgKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigtMSwgdHJ1ZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLW5leHRcIiwgIFwiQ3ljbGUgdG8gbmV4dCB3b3Jrc3BhY2UgcGFuZVwiLCAgICAgICBcIk1vZCtQYWdlRG93blwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZiggMSwgdHJ1ZSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMXN0XCIsICAgXCJKdW1wIHRvIDFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTJuZFwiLCAgIFwiSnVtcCB0byAybmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0zcmRcIiwgICBcIkp1bXAgdG8gM3JkIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigyKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNHRoXCIsICAgXCJKdW1wIHRvIDR0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTV0aFwiLCAgIFwiSnVtcCB0byA1dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDQpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby02dGhcIiwgICBcIkp1bXAgdG8gNnRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig1KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tN3RoXCIsICAgXCJKdW1wIHRvIDd0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTh0aFwiLCAgIFwiSnVtcCB0byA4dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDcpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1sYXN0XCIsICBcIkp1bXAgdG8gbGFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgXCJBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig5OTk5OTk5OSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTFzdFwiLCAgXCJQbGFjZSBhcyAxc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigwLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0ybmRcIiwgIFwiUGxhY2UgYXMgMm5kIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtM3JkXCIsICBcIlBsYWNlIGFzIDNyZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDIsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTR0aFwiLCAgXCJQbGFjZSBhcyA0dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigzLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC01dGhcIiwgIFwiUGxhY2UgYXMgNXRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNnRoXCIsICBcIlBsYWNlIGFzIDZ0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDUsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTd0aFwiLCAgXCJQbGFjZSBhcyA3dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig2LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC04dGhcIiwgIFwiUGxhY2UgYXMgOHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtbGFzdFwiLCBcIlBsYWNlIGFzIGxhc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgXCJNb2QrQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDk5OTk5OTk5LCBmYWxzZSk7IH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZ290b050aExlYWYobiwgcmVsYXRpdmUpIHtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gW107XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlUm9vdExlYXZlcygobGVhZikgPT4gKGxlYXZlcy5wdXNoKGxlYWYpLCBmYWxzZSkpO1xuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIG4gKz0gbGVhdmVzLmluZGV4T2YodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpO1xuICAgICAgICAgICAgbiA9IChuICsgbGVhdmVzLmxlbmd0aCkgJSBsZWF2ZXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBsZWFmID0gbGVhdmVzW24+PWxlYXZlcy5sZW5ndGggPyBsZWF2ZXMubGVuZ3RoLTEgOiBuXTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGNiID0gdGhpcy5sZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZSk7XG4gICAgICAgIGlmIChjYikgY2IoKTtcbiAgICB9XG5cbiAgICBsZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgY29uc3RcbiAgICAgICAgICAgIHBhcmVudFNwbGl0ID0gbGVhZi5wYXJlbnRTcGxpdCxcbiAgICAgICAgICAgIGNoaWxkcmVuID0gcGFyZW50U3BsaXQuY2hpbGRyZW4sXG4gICAgICAgICAgICBmcm9tUG9zID0gY2hpbGRyZW4uaW5kZXhPZihsZWFmKVxuICAgICAgICA7XG4gICAgICAgIGlmIChmcm9tUG9zID09IC0xKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICB0b1BvcyArPSBmcm9tUG9zO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCB8fCB0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHRvUG9zID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDApIHRvUG9zID0gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmcm9tUG9zID09IHRvUG9zKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG90aGVyID0gY2hpbGRyZW5bdG9Qb3NdO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKGZyb21Qb3MsIDEpO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKHRvUG9zLCAgIDAsIGxlYWYpO1xuICAgICAgICAgICAgaWYgKHBhcmVudFNwbGl0LnNlbGVjdFRhYikge1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnNlbGVjdFRhYihsZWFmKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb3RoZXIuY29udGFpbmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KGZyb21Qb3MgPiB0b1BvcyA/IFwiYmVmb3JlYmVnaW5cIiA6IFwiYWZ0ZXJlbmRcIiwgbGVhZi5jb250YWluZXJFbCk7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQucmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk7XG4gICAgICAgICAgICAgICAgbGVhZi5vblJlc2l6ZSgpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dENoYW5nZSgpO1xuXG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgZm9jdXMgYmFjayB0byBwYW5lO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCBmYWxzZSwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAg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LEVBQUU7QUFDdkksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsOEJBQThCLFFBQVEsY0FBYyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFO0FBQ3ZJO0FBQ0EsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9B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
