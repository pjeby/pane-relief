'use strict';

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

const {Notice, WorkspaceLeaf} = require('obsidian');

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
        if (this.leaf.pinned) return new Notice("Pinned pane: unpin before going forward or back"), undefined;

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
            new Notice(`No more ${by < 0 ? "back" : "forward"} history for pane`);
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
    plugin.register(around(WorkspaceLeaf.prototype, {
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

const {Plugin, Notice: Notice$1, FileView, MarkdownView} = require('obsidian');

class PaneRelief extends Plugin {

    onload() {
        installHistory(this);
        addCommands(this, {
            [command("swap-prev", "Swap pane with previous in split",  "Mod+Shift+PageUp")]   (){ return this.leafPlacer(-1); },
            [command("swap-next", "Swap pane with next in split",      "Mod+Shift+PageDown")] (){ return this.leafPlacer( 1); },

            [command("go-next",  "Cycle to next workspace pane",       "Mod+PageUp"  )] () { return () => this.gotoNthLeaf(-1, true); },
            [command("go-prev",  "Cycle to previous workspace pane",   "Mod+PageDown")] () { return () => this.gotoNthLeaf( 1, true); },

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9wbHVnaW4uanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gU2ltcGxpZmllZCBDb21tYW5kcyBGcmFtZXdvcmtcblxuY29uc3QgY29tbWFuZHMgPSB7fTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmQoaWQsIG5hbWUsIGhvdGtleXM9W10sIGNtZD17fSkge1xuXG4gICAgLy8gQWxsb3cgaG90a2V5cyB0byBiZSBleHByZXNzZWQgYXMgYSBzdHJpbmcsIGFycmF5IG9mIHN0cmluZ3MsXG4gICAgLy8gb2JqZWN0LCBvciBhcnJheSBvZiBvYmplY3RzLiAgKE5vcm1hbGl6ZSB0byBhbiBhcnJheSBmaXJzdC4pXG4gICAgaWYgKHR5cGVvZiBob3RrZXlzID09PSBcInN0cmluZ1wiKSBob3RrZXlzID0gW2hvdGtleXNdO1xuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJvYmplY3RcIiAmJiBob3RrZXlzLmtleSkgaG90a2V5cyA9IFtob3RrZXlzXTtcblxuICAgIGhvdGtleXMgPSBob3RrZXlzLm1hcChmdW5jdGlvbihrZXkpIHtcbiAgICAgICAgLy8gSWYgYSBob3RrZXkgaXMgYW4gb2JqZWN0IGFscmVhZHksIG5vIG5lZWQgdG8gcHJvY2VzcyBpdFxuICAgICAgICBpZiAodHlwZW9mIGtleSA9PT0gXCJvYmplY3RcIikgcmV0dXJuIGtleTtcbiAgICAgICAgLy8gQ29udmVydCBzdHJpbmdzIHRvIE9ic2lkaWFuJ3MgaG90a2V5IGZvcm1hdFxuICAgICAgICBrZXkgPSBrZXkuc3BsaXQoXCIrXCIpXG4gICAgICAgIHJldHVybiB7IG1vZGlmaWVyczoga2V5LCBrZXk6IGtleS5wb3AoKSB8fCBcIitcIiB9ICAvLyBlbXB0eSBsYXN0IHBhcnQgPSBlLmcuICdNb2QrKydcbiAgICB9KTtcbiAgICBPYmplY3QuYXNzaWduKGNtZCwge2lkLCBuYW1lLCBob3RrZXlzfSk7XG5cbiAgICAvLyBTYXZlIHRoZSBjb21tYW5kIGRhdGEgdW5kZXIgYSB1bmlxdWUgc3ltYm9sXG4gICAgY29uc3Qgc3ltID0gU3ltYm9sKFwiY21kOlwiICsgaWQpO1xuICAgIGNvbW1hbmRzW3N5bV0gPSBjbWQ7XG4gICAgcmV0dXJuIHN5bTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbW1hbmRzKHBsdWdpbiwgY21kc2V0KSB7XG4gICAgLy8gRXh0cmFjdCBjb21tYW5kIHN5bWJvbHMgZnJvbSBjbWRzZXQgYW5kIHJlZ2lzdGVyIHRoZW0sIGJvdW5kIHRvIHRoZSBwbHVnaW4gZm9yIG1ldGhvZHNcbiAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlTeW1ib2xzKGNtZHNldCkuZm9yRWFjaChzeW0gPT4ge1xuICAgICAgICBjb25zdCBjbWQgPSBjb21tYW5kc1tzeW1dLCBtZXRob2QgPSBjbWRzZXRbc3ltXTtcbiAgICAgICAgaWYgKGNtZCkgcGx1Z2luLmFkZENvbW1hbmQoT2JqZWN0LmFzc2lnbih7fSwgY21kLCB7XG4gICAgICAgICAgICBjaGVja0NhbGxiYWNrKGNoZWNrKSB7XG4gICAgICAgICAgICAgICAgLy8gQ2FsbCB0aGUgbWV0aG9kIGJvZHkgd2l0aCB0aGUgcGx1Z2luIGFzICd0aGlzJ1xuICAgICAgICAgICAgICAgIGNvbnN0IGNiID0gbWV0aG9kLmNhbGwocGx1Z2luKTtcbiAgICAgICAgICAgICAgICAvLyBJdCB0aGVuIHJldHVybnMgYSBjbG9zdXJlIGlmIHRoZSBjb21tYW5kIGlzIHJlYWR5IHRvIGV4ZWN1dGUsIGFuZFxuICAgICAgICAgICAgICAgIC8vIHdlIGNhbGwgdGhhdCBjbG9zdXJlIHVubGVzcyB0aGlzIGlzIGp1c3QgYSBjaGVjayBmb3IgYXZhaWxhYmlsaXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuIChjaGVjayB8fCB0eXBlb2YgY2IgIT09IFwiZnVuY3Rpb25cIikgPyAhIWNiIDogKGNiKCksIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgfSlcbn0iLCJleHBvcnQgZnVuY3Rpb24gYXJvdW5kKG9iaiwgZmFjdG9yaWVzKSB7XG4gICAgY29uc3QgcmVtb3ZlcnMgPSBPYmplY3Qua2V5cyhmYWN0b3JpZXMpLm1hcChrZXkgPT4gYXJvdW5kMShvYmosIGtleSwgZmFjdG9yaWVzW2tleV0pKTtcbiAgICByZXR1cm4gcmVtb3ZlcnMubGVuZ3RoID09PSAxID8gcmVtb3ZlcnNbMF0gOiBmdW5jdGlvbiAoKSB7IHJlbW92ZXJzLmZvckVhY2gociA9PiByKCkpOyB9O1xufVxuZnVuY3Rpb24gYXJvdW5kMShvYmosIG1ldGhvZCwgY3JlYXRlV3JhcHBlcikge1xuICAgIGNvbnN0IG9yaWdpbmFsID0gb2JqW21ldGhvZF0sIGhhZE93biA9IG9iai5oYXNPd25Qcm9wZXJ0eShtZXRob2QpO1xuICAgIGxldCBjdXJyZW50ID0gY3JlYXRlV3JhcHBlcihvcmlnaW5hbCk7XG4gICAgLy8gTGV0IG91ciB3cmFwcGVyIGluaGVyaXQgc3RhdGljIHByb3BzIGZyb20gdGhlIHdyYXBwaW5nIG1ldGhvZCxcbiAgICAvLyBhbmQgdGhlIHdyYXBwaW5nIG1ldGhvZCwgcHJvcHMgZnJvbSB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgaWYgKG9yaWdpbmFsKVxuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY3VycmVudCwgb3JpZ2luYWwpO1xuICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBjdXJyZW50KTtcbiAgICBvYmpbbWV0aG9kXSA9IHdyYXBwZXI7XG4gICAgLy8gUmV0dXJuIGEgY2FsbGJhY2sgdG8gYWxsb3cgc2FmZSByZW1vdmFsXG4gICAgcmV0dXJuIHJlbW92ZTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgLy8gSWYgd2UgaGF2ZSBiZWVuIGRlYWN0aXZhdGVkIGFuZCBhcmUgbm8gbG9uZ2VyIHdyYXBwZWQsIHJlbW92ZSBvdXJzZWx2ZXNcbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsICYmIG9ialttZXRob2RdID09PSB3cmFwcGVyKVxuICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgIHJldHVybiBjdXJyZW50LmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgICBmdW5jdGlvbiByZW1vdmUoKSB7XG4gICAgICAgIC8vIElmIG5vIG90aGVyIHBhdGNoZXMsIGp1c3QgZG8gYSBkaXJlY3QgcmVtb3ZhbFxuICAgICAgICBpZiAob2JqW21ldGhvZF0gPT09IHdyYXBwZXIpIHtcbiAgICAgICAgICAgIGlmIChoYWRPd24pXG4gICAgICAgICAgICAgICAgb2JqW21ldGhvZF0gPSBvcmlnaW5hbDtcbiAgICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgICAgICBkZWxldGUgb2JqW21ldGhvZF07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAvLyBFbHNlIHBhc3MgZnV0dXJlIGNhbGxzIHRocm91Z2gsIGFuZCByZW1vdmUgd3JhcHBlciBmcm9tIHRoZSBwcm90b3R5cGUgY2hhaW5cbiAgICAgICAgY3VycmVudCA9IG9yaWdpbmFsO1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgb3JpZ2luYWwgfHwgRnVuY3Rpb24pO1xuICAgIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiBhZnRlcihwcm9taXNlLCBjYikge1xuICAgIHJldHVybiBwcm9taXNlLnRoZW4oY2IsIGNiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBzZXJpYWxpemUoYXN5bmNGdW5jdGlvbikge1xuICAgIGxldCBsYXN0UnVuID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7XG4gICAgICAgICAgICBhZnRlcihsYXN0UnVuLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgYXN5bmNGdW5jdGlvbi5hcHBseSh0aGlzLCBhcmdzKS50aGVuKHJlcywgcmVqKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgd3JhcHBlci5hZnRlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHsgYWZ0ZXIobGFzdFJ1biwgcmVzKTsgfSk7XG4gICAgfTtcbiAgICByZXR1cm4gd3JhcHBlcjtcbn1cbiIsImNvbnN0IHtOb3RpY2UsIFdvcmtzcGFjZUxlYWZ9ID0gcmVxdWlyZSgnb2JzaWRpYW4nKTtcbmltcG9ydCB7YXJvdW5kfSBmcm9tIFwibW9ua2V5LWFyb3VuZFwiO1xuXG5jb25zdCBISVNUX0FUVFIgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcbmNvbnN0IFNFUklBTF9QUk9QID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCI7XG5cbmNsYXNzIEhpc3Rvcnkge1xuICAgIHN0YXRpYyBjdXJyZW50KGFwcCkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgfHwgbmV3IHRoaXMoKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yTGVhZihsZWFmKSB7XG4gICAgICAgIGlmIChsZWFmKSByZXR1cm4gbGVhZltISVNUX0FUVFJdIHx8IChsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcyhsZWFmKSk7XG4gICAgfVxuXG4gICAgY29uc3RydWN0b3IobGVhZiwge3Bvcywgc3RhY2t9ID0ge3BvczowLCBzdGFjazpbXX0pIHtcbiAgICAgICAgdGhpcy5sZWFmID0gbGVhZjtcbiAgICAgICAgdGhpcy5wb3MgPSBwb3M7XG4gICAgICAgIHRoaXMuc3RhY2sgPSBzdGFjaztcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2t9OyB9XG5cbiAgICBnZXQgc3RhdGUoKSB7IHJldHVybiB0aGlzLnN0YWNrW3RoaXMucG9zXSB8fCBudWxsOyB9XG4gICAgZ2V0IGxlbmd0aCgpIHsgcmV0dXJuIHRoaXMuc3RhY2subGVuZ3RoOyB9XG5cbiAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfVxuICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9XG5cbiAgICBnbyhieSkge1xuICAgICAgICAvL2NvbnNvbGUubG9nKGJ5KTtcblxuICAgICAgICBpZiAoIXRoaXMubGVhZiB8fCAhYnkpIHJldHVybjsgIC8vIG5vLW9wXG4gICAgICAgIGlmICh0aGlzLmxlYWYucGlubmVkKSByZXR1cm4gbmV3IE5vdGljZShcIlBpbm5lZCBwYW5lOiB1bnBpbiBiZWZvcmUgZ29pbmcgZm9yd2FyZCBvciBiYWNrXCIpLCB1bmRlZmluZWQ7XG5cbiAgICAgICAgLy8gcHJldmVudCB3cmFwYXJvdW5kXG4gICAgICAgIGNvbnN0IG5ld1BvcyA9IE1hdGgubWF4KDAsIE1hdGgubWluKHRoaXMucG9zIC0gYnksIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuXG4gICAgICAgIGlmIChuZXdQb3MgIT09IHRoaXMucG9zKSB7XG4gICAgICAgICAgICB0aGlzLnBvcyA9IG5ld1BvcztcbiAgICAgICAgICAgIGlmICh0aGlzLnN0YXRlICYmIHRoaXMubGVhZikge1xuICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gSlNPTi5wYXJzZSh0aGlzLnN0YXRlLnN0YXRlIHx8IFwie31cIik7XG4gICAgICAgICAgICAgICAgY29uc3QgZVN0YXRlID0gSlNPTi5wYXJzZSh0aGlzLnN0YXRlLmVTdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgICAgIHN0YXRlLnBvcHN0YXRlID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBzdGF0ZS5hY3RpdmUgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHRoaXMubGVhZi5zZXRWaWV3U3RhdGUoc3RhdGUsIGVTdGF0ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBObyBtb3JlICR7YnkgPCAwID8gXCJiYWNrXCIgOiBcImZvcndhcmRcIn0gaGlzdG9yeSBmb3IgcGFuZWApO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKXsgdGhpcy5zdGFja1t0aGlzLnBvc10gPSBzdGF0ZTsgfVxuXG4gICAgcHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKSAgIHtcbiAgICAgICAgdGhpcy5zdGFjay5zcGxpY2UoMCwgdGhpcy5wb3MsIHN0YXRlKTtcbiAgICAgICAgdGhpcy5wb3MgPSAwO1xuICAgICAgICAvLyBMaW1pdCBcImJhY2tcIiB0byAyMFxuICAgICAgICB3aGlsZSAodGhpcy5zdGFjay5sZW5ndGggPiAyMCkgdGhpcy5zdGFjay5wb3AoKTtcbiAgICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsSGlzdG9yeShwbHVnaW4pIHtcblxuICAgIGNvbnN0IGFwcCA9IHBsdWdpbi5hcHA7XG5cbiAgICAvLyBNb25rZXlwYXRjaDogaW5jbHVkZSBoaXN0b3J5IGluIGxlYWYgc2VyaWFsaXphdGlvbiAoc28gaXQncyBwZXJzaXN0ZWQgd2l0aCB0aGUgd29ya3NwYWNlKVxuICAgIHBsdWdpbi5yZWdpc3Rlcihhcm91bmQoV29ya3NwYWNlTGVhZi5wcm90b3R5cGUsIHtcbiAgICAgICAgc2VyaWFsaXplKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24gc2VyaWFsaXplKCl7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBvbGQuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgIGlmICh0aGlzW0hJU1RfQVRUUl0pIHJlc3VsdFtTRVJJQUxfUFJPUF0gPSB0aGlzW0hJU1RfQVRUUl0uc2VyaWFsaXplKCk7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9fVxuICAgIH0pKTtcblxuICAgIC8vIE1vbmtleXBhdGNoOiBsb2FkIGhpc3RvcnkgZHVyaW5nIGxlYWYgbG9hZCwgaWYgcHJlc2VudFxuICAgIHBsdWdpbi5yZWdpc3Rlcihhcm91bmQoYXBwLndvcmtzcGFjZSwge1xuICAgICAgICBkZXNlcmlhbGl6ZUxheW91dChvbGQpIHsgcmV0dXJuIGFzeW5jIGZ1bmN0aW9uIGRlc2VyaWFsaXplTGF5b3V0KHN0YXRlLCAuLi5ldGMpe1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb2xkLmNhbGwodGhpcywgc3RhdGUsIC4uLmV0Yyk7XG4gICAgICAgICAgICBpZiAoc3RhdGUudHlwZSA9PT0gXCJsZWFmXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoc3RhdGVbU0VSSUFMX1BST1BdKSByZXN1bHRbSElTVF9BVFRSXSA9IG5ldyBIaXN0b3J5KHJlc3VsdCwgc3RhdGVbU0VSSUFMX1BST1BdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19XG4gICAgfSkpO1xuXG4gICAgLy8gT3ZlcnJpZGUgZGVmYXVsdCBtb3VzZSBoaXN0b3J5IGJlaGF2aW9yLiAgV2UgbmVlZCB0aGlzIGJlY2F1c2UgMSkgRWxlY3Ryb24gd2lsbCB1c2UgdGhlIGJ1aWx0LWluXG4gICAgLy8gaGlzdG9yeSBvYmplY3QgaWYgd2UgZG9uJ3QgKGluc3RlYWQgb2Ygb3VyIHdyYXBwZXIpLCBhbmQgMikgd2Ugd2FudCB0aGUgY2xpY2sgdG8gYXBwbHkgdG8gdGhlIGxlYWZcbiAgICAvLyB0aGF0IHdhcyB1bmRlciB0aGUgbW91c2UsIHJhdGhlciB0aGFuIHdoaWNoZXZlciBsZWFmIHdhcyBhY3RpdmUuXG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoICgpID0+IHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSkgKTtcbiAgICBmdW5jdGlvbiBoaXN0b3J5SGFuZGxlcihlKSB7XG4gICAgICAgIGlmIChlLmJ1dHRvbiAhPT0gMyAmJiBlLmJ1dHRvbiAhPT0gNCkgcmV0dXJuO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7ICAvLyBwcmV2ZW50IGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQubWF0Y2hQYXJlbnQoXCIud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgIGlmICh0YXJnZXQpIHtcbiAgICAgICAgICAgIGxldCBsZWFmO1xuICAgICAgICAgICAgYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKGwgPT4gbGVhZiA9IChsLmNvbnRhaW5lckVsID09PSB0YXJnZXQpID8gbCA6IGxlYWYpO1xuICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDMpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmJhY2soKTsgfVxuICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDQpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmZvcndhcmQoKTsgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBQcm94eSB0aGUgd2luZG93IGhpc3Rvcnkgd2l0aCBhIHdyYXBwZXIgdGhhdCBkZWxlZ2F0ZXMgdG8gdGhlIGFjdGl2ZSBsZWFmJ3MgSGlzdG9yeSBvYmplY3QsXG4gICAgY29uc3QgcmVhbEhpc3RvcnkgPSB3aW5kb3cuaGlzdG9yeTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoKCkgPT4gd2luZG93Lmhpc3RvcnkgPSByZWFsSGlzdG9yeSk7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJoaXN0b3J5XCIsIHsgZW51bWVyYWJsZTogdHJ1ZSwgY29uZmlndXJhYmxlOiB0cnVlLCB3cml0YWJsZTogdHJ1ZSwgdmFsdWU6IHtcbiAgICAgICAgZ2V0IHN0YXRlKCkgICAgICB7IHJldHVybiBIaXN0b3J5LmN1cnJlbnQoYXBwKS5zdGF0ZTsgfSxcbiAgICAgICAgZ2V0IGxlbmd0aCgpICAgICB7IHJldHVybiBIaXN0b3J5LmN1cnJlbnQoYXBwKS5sZW5ndGg7IH0sXG5cbiAgICAgICAgYmFjaygpICAgIHsgdGhpcy5nbygtMSk7IH0sXG4gICAgICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9LFxuICAgICAgICBnbyhieSkgICAgeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5nbyhieSk7IH0sXG5cbiAgICAgICAgcmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKXsgSGlzdG9yeS5jdXJyZW50KGFwcCkucmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcbiAgICAgICAgcHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKSAgIHsgSGlzdG9yeS5jdXJyZW50KGFwcCkucHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcblxuICAgICAgICBnZXQgc2Nyb2xsUmVzdG9yYXRpb24oKSAgICB7IHJldHVybiByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbjsgfSxcbiAgICAgICAgc2V0IHNjcm9sbFJlc3RvcmF0aW9uKHZhbCkgeyByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbiA9IHZhbDsgfSxcbiAgICB9fSk7XG5cbn1cbiIsImNvbnN0IHtQbHVnaW4sIE5vdGljZSwgRmlsZVZpZXcsIE1hcmtkb3duVmlld30gPSByZXF1aXJlKCdvYnNpZGlhbicpO1xuaW1wb3J0IHthZGRDb21tYW5kcywgY29tbWFuZH0gZnJvbSBcIi4vY29tbWFuZHNcIjtcbmltcG9ydCB7aW5zdGFsbEhpc3Rvcnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGFuZVJlbGllZiBleHRlbmRzIFBsdWdpbiB7XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIGluc3RhbGxIaXN0b3J5KHRoaXMpO1xuICAgICAgICBhZGRDb21tYW5kcyh0aGlzLCB7XG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtcHJldlwiLCBcIlN3YXAgcGFuZSB3aXRoIHByZXZpb3VzIGluIHNwbGl0XCIsICBcIk1vZCtTaGlmdCtQYWdlVXBcIildICAgKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoLTEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLW5leHRcIiwgXCJTd2FwIHBhbmUgd2l0aCBuZXh0IGluIHNwbGl0XCIsICAgICAgXCJNb2QrU2hpZnQrUGFnZURvd25cIildICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKCAxKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1uZXh0XCIsICBcIkN5Y2xlIHRvIG5leHQgd29ya3NwYWNlIHBhbmVcIiwgICAgICAgXCJNb2QrUGFnZVVwXCIgICldICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoLTEsIHRydWUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1wcmV2XCIsICBcIkN5Y2xlIHRvIHByZXZpb3VzIHdvcmtzcGFjZSBwYW5lXCIsICAgXCJNb2QrUGFnZURvd25cIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoIDEsIHRydWUpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTFzdFwiLCAgIFwiSnVtcCB0byAxc3QgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDApOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0ybmRcIiwgICBcIkp1bXAgdG8gMm5kIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigxKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tM3JkXCIsICAgXCJKdW1wIHRvIDNyZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTR0aFwiLCAgIFwiSnVtcCB0byA0dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDMpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby01dGhcIiwgICBcIkp1bXAgdG8gNXRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig0KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNnRoXCIsICAgXCJKdW1wIHRvIDZ0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTd0aFwiLCAgIFwiSnVtcCB0byA3dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDYpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby04dGhcIiwgICBcIkp1bXAgdG8gOHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig3KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbGFzdFwiLCAgXCJKdW1wIHRvIGxhc3QgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsIFwiQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoOTk5OTk5OTkpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0xc3RcIiwgIFwiUGxhY2UgYXMgMXN0IHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMm5kXCIsICBcIlBsYWNlIGFzIDJuZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDEsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTNyZFwiLCAgXCJQbGFjZSBhcyAzcmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigyLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC00dGhcIiwgIFwiUGxhY2UgYXMgNHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNXRoXCIsICBcIlBsYWNlIGFzIDV0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDQsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTZ0aFwiLCAgXCJQbGFjZSBhcyA2dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig1LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC03dGhcIiwgIFwiUGxhY2UgYXMgN3RoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtOHRoXCIsICBcIlBsYWNlIGFzIDh0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDcsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LWxhc3RcIiwgXCJQbGFjZSBhcyBsYXN0IHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgIFwiTW9kK0FsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig5OTk5OTk5OSwgZmFsc2UpOyB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGdvdG9OdGhMZWFmKG4sIHJlbGF0aXZlKSB7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9IFtdO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZVJvb3RMZWF2ZXMoKGxlYWYpID0+IChsZWF2ZXMucHVzaChsZWFmKSwgZmFsc2UpKTtcbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICBuICs9IGxlYXZlcy5pbmRleE9mKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKTtcbiAgICAgICAgICAgIG4gPSAobiArIGxlYXZlcy5sZW5ndGgpICUgbGVhdmVzLmxlbmd0aDsgIC8vIHdyYXAgYXJvdW5kXG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbGVhZiA9IGxlYXZlc1tuPj1sZWF2ZXMubGVuZ3RoID8gbGVhdmVzLmxlbmd0aC0xIDogbl07XG4gICAgICAgICFsZWFmIHx8IHRoaXMuYXBwLndvcmtzcGFjZS5zZXRBY3RpdmVMZWFmKGxlYWYsIHRydWUsIHRydWUpO1xuICAgIH1cblxuICAgIHBsYWNlTGVhZih0b1BvcywgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBjYiA9IHRoaXMubGVhZlBsYWNlcih0b1BvcywgcmVsYXRpdmUpO1xuICAgICAgICBpZiAoY2IpIGNiKCk7XG4gICAgfVxuXG4gICAgbGVhZlBsYWNlcih0b1BvcywgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWY7XG4gICAgICAgIGlmICghbGVhZikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGNvbnN0XG4gICAgICAgICAgICBwYXJlbnRTcGxpdCA9IGxlYWYucGFyZW50U3BsaXQsXG4gICAgICAgICAgICBjaGlsZHJlbiA9IHBhcmVudFNwbGl0LmNoaWxkcmVuLFxuICAgICAgICAgICAgZnJvbVBvcyA9IGNoaWxkcmVuLmluZGV4T2YobGVhZilcbiAgICAgICAgO1xuICAgICAgICBpZiAoZnJvbVBvcyA9PSAtMSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICAgICAgdG9Qb3MgKz0gZnJvbVBvcztcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDAgfHwgdG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSB0b1BvcyA9IGNoaWxkcmVuLmxlbmd0aCAtIDE7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwKSB0b1BvcyA9IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZnJvbVBvcyA9PSB0b1BvcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvdGhlciA9IGNoaWxkcmVuW3RvUG9zXTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZShmcm9tUG9zLCAxKTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZSh0b1BvcywgICAwLCBsZWFmKTtcbiAgICAgICAgICAgIGlmIChwYXJlbnRTcGxpdC5zZWxlY3RUYWIpIHtcbiAgICAgICAgICAgICAgICBwYXJlbnRTcGxpdC5zZWxlY3RUYWIobGVhZik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG90aGVyLmNvbnRhaW5lckVsLmluc2VydEFkamFjZW50RWxlbWVudChmcm9tUG9zID4gdG9Qb3MgPyBcImJlZm9yZWJlZ2luXCIgOiBcImFmdGVyZW5kXCIsIGxlYWYuY29udGFpbmVyRWwpO1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnJlY29tcHV0ZUNoaWxkcmVuRGltZW5zaW9ucygpO1xuICAgICAgICAgICAgICAgIGxlYWYub25SZXNpemUoKTtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRDaGFuZ2UoKTtcblxuICAgICAgICAgICAgICAgIC8vIEZvcmNlIGZvY3VzIGJhY2sgdG8gcGFuZTtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgZmFsc2UsIHRydWUpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbiJdLCJuYW1lcyI6WyJOb3RpY2UiXSwibWFwcGluZ3MiOiI7O0FBQUE7QUFDQTtBQUNBLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUNwQjtBQUNPLFNBQVMsT0FBTyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsT0FBTyxDQUFDLEVBQUUsRUFBRSxHQUFHLENBQUMsRUFBRSxFQUFFO0FBQ3REO0FBQ0E7QUFDQTtBQUNBLElBQUksSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLEVBQUUsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDekQsSUFBSSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFB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Q0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLG9DQUFvQyxFQUFFLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFO0FBQ2hJO0FBQ0EsWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FB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
