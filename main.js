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

function createCommonjsModule(fn) {
  var module = { exports: {} };
	return fn(module, module.exports), module.exports;
}

var monkeyAround = createCommonjsModule(function (module, exports) {
Object.defineProperty(exports, "__esModule", { value: true });
exports.serialize = exports.after = exports.around = void 0;
function around(obj, factories) {
    const removers = Object.keys(factories).map(key => around1(obj, key, factories[key]));
    return removers.length === 1 ? removers[0] : function () { removers.forEach(r => r()); };
}
exports.around = around;
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
function after(promise, cb) {
    return promise.then(cb, cb);
}
exports.after = after;
function serialize(asyncFunction) {
    let lastRun = Promise.resolve();
    function wrapper(...args) {
        return lastRun = new Promise((res, rej) => {
            after(lastRun, () => {
                asyncFunction.apply(this, args).then(res, rej);
            });
        });
    }
    wrapper.after = function () {
        return lastRun = new Promise((res, rej) => { after(lastRun, res); });
    };
    return wrapper;
}
exports.serialize = serialize;
});

const {Notice, WorkspaceLeaf} = require('obsidian');

const HIST_ATTR = "pane-relief:history-v1";

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
    set state(state) { this.stack[this.pos] = state; }
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

    replaceState(state, title, url){ this.state = state; }

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
    plugin.register(monkeyAround.around(WorkspaceLeaf.prototype, {
        serialize(old) { return function serialize(){
            const result = old.call(this);
            if (this[HIST_ATTR]) result["pane-relief:history-v1"] = this[HIST_ATTR].serialize();
            return result;
        }}
    }));

    // Monkeypatch: load history during leaf load, if present
    plugin.register(monkeyAround.around(app.workspace, {
        deserializeLayout(old) { return async function deserializeLayout(state, ...etc){
            const result = await old.call(this, state, ...etc);
            if (state.type === "leaf") {
                if (state["pane-relief:history-v1"]) result[HIST_ATTR] = new History(result, state["pane-relief:history-v1"]);
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
        set state(state) { History.current(app).state = state; },
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4wLjAtODdmYzE4MTIyYS1jMTE0N2NmZWExLnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9pbmRleC5qcyIsInNyYy9IaXN0b3J5LmpzIiwic3JjL3BsdWdpbi5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBTaW1wbGlmaWVkIENvbW1hbmRzIEZyYW1ld29ya1xuXG5jb25zdCBjb21tYW5kcyA9IHt9O1xuXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZChpZCwgbmFtZSwgaG90a2V5cz1bXSwgY21kPXt9KSB7XG5cbiAgICAvLyBBbGxvdyBob3RrZXlzIHRvIGJlIGV4cHJlc3NlZCBhcyBhIHN0cmluZywgYXJyYXkgb2Ygc3RyaW5ncyxcbiAgICAvLyBvYmplY3QsIG9yIGFycmF5IG9mIG9iamVjdHMuICAoTm9ybWFsaXplIHRvIGFuIGFycmF5IGZpcnN0LilcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwic3RyaW5nXCIpIGhvdGtleXMgPSBbaG90a2V5c107XG4gICAgaWYgKHR5cGVvZiBob3RrZXlzID09PSBcIm9iamVjdFwiICYmIGhvdGtleXMua2V5KSBob3RrZXlzID0gW2hvdGtleXNdO1xuXG4gICAgaG90a2V5cyA9IGhvdGtleXMubWFwKGZ1bmN0aW9uKGtleSkge1xuICAgICAgICAvLyBJZiBhIGhvdGtleSBpcyBhbiBvYmplY3QgYWxyZWFkeSwgbm8gbmVlZCB0byBwcm9jZXNzIGl0XG4gICAgICAgIGlmICh0eXBlb2Yga2V5ID09PSBcIm9iamVjdFwiKSByZXR1cm4ga2V5O1xuICAgICAgICAvLyBDb252ZXJ0IHN0cmluZ3MgdG8gT2JzaWRpYW4ncyBob3RrZXkgZm9ybWF0XG4gICAgICAgIGtleSA9IGtleS5zcGxpdChcIitcIilcbiAgICAgICAgcmV0dXJuIHsgbW9kaWZpZXJzOiBrZXksIGtleToga2V5LnBvcCgpIHx8IFwiK1wiIH0gIC8vIGVtcHR5IGxhc3QgcGFydCA9IGUuZy4gJ01vZCsrJ1xuICAgIH0pO1xuICAgIE9iamVjdC5hc3NpZ24oY21kLCB7aWQsIG5hbWUsIGhvdGtleXN9KTtcblxuICAgIC8vIFNhdmUgdGhlIGNvbW1hbmQgZGF0YSB1bmRlciBhIHVuaXF1ZSBzeW1ib2xcbiAgICBjb25zdCBzeW0gPSBTeW1ib2woXCJjbWQ6XCIgKyBpZCk7XG4gICAgY29tbWFuZHNbc3ltXSA9IGNtZDtcbiAgICByZXR1cm4gc3ltO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkQ29tbWFuZHMocGx1Z2luLCBjbWRzZXQpIHtcbiAgICAvLyBFeHRyYWN0IGNvbW1hbmQgc3ltYm9scyBmcm9tIGNtZHNldCBhbmQgcmVnaXN0ZXIgdGhlbSwgYm91bmQgdG8gdGhlIHBsdWdpbiBmb3IgbWV0aG9kc1xuICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eVN5bWJvbHMoY21kc2V0KS5mb3JFYWNoKHN5bSA9PiB7XG4gICAgICAgIGNvbnN0IGNtZCA9IGNvbW1hbmRzW3N5bV0sIG1ldGhvZCA9IGNtZHNldFtzeW1dO1xuICAgICAgICBpZiAoY21kKSBwbHVnaW4uYWRkQ29tbWFuZChPYmplY3QuYXNzaWduKHt9LCBjbWQsIHtcbiAgICAgICAgICAgIGNoZWNrQ2FsbGJhY2soY2hlY2spIHtcbiAgICAgICAgICAgICAgICAvLyBDYWxsIHRoZSBtZXRob2QgYm9keSB3aXRoIHRoZSBwbHVnaW4gYXMgJ3RoaXMnXG4gICAgICAgICAgICAgICAgY29uc3QgY2IgPSBtZXRob2QuY2FsbChwbHVnaW4pO1xuICAgICAgICAgICAgICAgIC8vIEl0IHRoZW4gcmV0dXJucyBhIGNsb3N1cmUgaWYgdGhlIGNvbW1hbmQgaXMgcmVhZHkgdG8gZXhlY3V0ZSwgYW5kXG4gICAgICAgICAgICAgICAgLy8gd2UgY2FsbCB0aGF0IGNsb3N1cmUgdW5sZXNzIHRoaXMgaXMganVzdCBhIGNoZWNrIGZvciBhdmFpbGFiaWxpdHlcbiAgICAgICAgICAgICAgICByZXR1cm4gKGNoZWNrIHx8IHR5cGVvZiBjYiAhPT0gXCJmdW5jdGlvblwiKSA/ICEhY2IgOiAoY2IoKSwgdHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pKTtcbiAgICB9KVxufSIsIlwidXNlIHN0cmljdFwiO1xuT2JqZWN0LmRlZmluZVByb3BlcnR5KGV4cG9ydHMsIFwiX19lc01vZHVsZVwiLCB7IHZhbHVlOiB0cnVlIH0pO1xuZXhwb3J0cy5zZXJpYWxpemUgPSBleHBvcnRzLmFmdGVyID0gZXhwb3J0cy5hcm91bmQgPSB2b2lkIDA7XG5mdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5leHBvcnRzLmFyb3VuZCA9IGFyb3VuZDtcbmZ1bmN0aW9uIGFyb3VuZDEob2JqLCBtZXRob2QsIGNyZWF0ZVdyYXBwZXIpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG9ialttZXRob2RdLCBoYWRPd24gPSBvYmouaGFzT3duUHJvcGVydHkobWV0aG9kKTtcbiAgICBsZXQgY3VycmVudCA9IGNyZWF0ZVdyYXBwZXIob3JpZ2luYWwpO1xuICAgIC8vIExldCBvdXIgd3JhcHBlciBpbmhlcml0IHN0YXRpYyBwcm9wcyBmcm9tIHRoZSB3cmFwcGluZyBtZXRob2QsXG4gICAgLy8gYW5kIHRoZSB3cmFwcGluZyBtZXRob2QsIHByb3BzIGZyb20gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgIGlmIChvcmlnaW5hbClcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGN1cnJlbnQsIG9yaWdpbmFsKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgY3VycmVudCk7XG4gICAgb2JqW21ldGhvZF0gPSB3cmFwcGVyO1xuICAgIC8vIFJldHVybiBhIGNhbGxiYWNrIHRvIGFsbG93IHNhZmUgcmVtb3ZhbFxuICAgIHJldHVybiByZW1vdmU7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBkZWFjdGl2YXRlZCBhbmQgYXJlIG5vIGxvbmdlciB3cmFwcGVkLCByZW1vdmUgb3Vyc2VsdmVzXG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbCAmJiBvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcilcbiAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICByZXR1cm4gY3VycmVudC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuICAgICAgICAvLyBJZiBubyBvdGhlciBwYXRjaGVzLCBqdXN0IGRvIGEgZGlyZWN0IHJlbW92YWxcbiAgICAgICAgaWYgKG9ialttZXRob2RdID09PSB3cmFwcGVyKSB7XG4gICAgICAgICAgICBpZiAoaGFkT3duKVxuICAgICAgICAgICAgICAgIG9ialttZXRob2RdID0gb3JpZ2luYWw7XG4gICAgICAgICAgICBlbHNlXG4gICAgICAgICAgICAgICAgZGVsZXRlIG9ialttZXRob2RdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbClcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgLy8gRWxzZSBwYXNzIGZ1dHVyZSBjYWxscyB0aHJvdWdoLCBhbmQgcmVtb3ZlIHdyYXBwZXIgZnJvbSB0aGUgcHJvdG90eXBlIGNoYWluXG4gICAgICAgIGN1cnJlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIG9yaWdpbmFsIHx8IEZ1bmN0aW9uKTtcbiAgICB9XG59XG5mdW5jdGlvbiBhZnRlcihwcm9taXNlLCBjYikge1xuICAgIHJldHVybiBwcm9taXNlLnRoZW4oY2IsIGNiKTtcbn1cbmV4cG9ydHMuYWZ0ZXIgPSBhZnRlcjtcbmZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuZXhwb3J0cy5zZXJpYWxpemUgPSBzZXJpYWxpemU7XG4iLCJjb25zdCB7Tm90aWNlLCBXb3Jrc3BhY2VMZWFmfSA9IHJlcXVpcmUoJ29ic2lkaWFuJyk7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcblxuY29uc3QgSElTVF9BVFRSID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCI7XG5cbmNsYXNzIEhpc3Rvcnkge1xuICAgIHN0YXRpYyBjdXJyZW50KGFwcCkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgfHwgbmV3IHRoaXMoKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yTGVhZihsZWFmKSB7XG4gICAgICAgIGlmIChsZWFmKSByZXR1cm4gbGVhZltISVNUX0FUVFJdIHx8IChsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcyhsZWFmKSk7XG4gICAgfVxuXG4gICAgY29uc3RydWN0b3IobGVhZiwge3Bvcywgc3RhY2t9ID0ge3BvczowLCBzdGFjazpbXX0pIHtcbiAgICAgICAgdGhpcy5sZWFmID0gbGVhZjtcbiAgICAgICAgdGhpcy5wb3MgPSBwb3M7XG4gICAgICAgIHRoaXMuc3RhY2sgPSBzdGFjaztcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2t9OyB9XG5cbiAgICBnZXQgc3RhdGUoKSB7IHJldHVybiB0aGlzLnN0YWNrW3RoaXMucG9zXSB8fCBudWxsOyB9XG4gICAgc2V0IHN0YXRlKHN0YXRlKSB7IHRoaXMuc3RhY2tbdGhpcy5wb3NdID0gc3RhdGU7IH1cbiAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gdGhpcy5zdGFjay5sZW5ndGg7IH1cblxuICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9XG4gICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH1cblxuICAgIGdvKGJ5KSB7XG4gICAgICAgIC8vY29uc29sZS5sb2coYnkpO1xuXG4gICAgICAgIGlmICghdGhpcy5sZWFmIHx8ICFieSkgcmV0dXJuOyAgLy8gbm8tb3BcbiAgICAgICAgaWYgKHRoaXMubGVhZi5waW5uZWQpIHJldHVybiBuZXcgTm90aWNlKFwiUGlubmVkIHBhbmU6IHVucGluIGJlZm9yZSBnb2luZyBmb3J3YXJkIG9yIGJhY2tcIiksIHVuZGVmaW5lZDtcblxuICAgICAgICAvLyBwcmV2ZW50IHdyYXBhcm91bmRcbiAgICAgICAgY29uc3QgbmV3UG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odGhpcy5wb3MgLSBieSwgdGhpcy5zdGFjay5sZW5ndGggLSAxKSk7XG5cbiAgICAgICAgaWYgKG5ld1BvcyAhPT0gdGhpcy5wb3MpIHtcbiAgICAgICAgICAgIHRoaXMucG9zID0gbmV3UG9zO1xuICAgICAgICAgICAgaWYgKHRoaXMuc3RhdGUgJiYgdGhpcy5sZWFmKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBKU09OLnBhcnNlKHRoaXMuc3RhdGUuc3RhdGUgfHwgXCJ7fVwiKTtcbiAgICAgICAgICAgICAgICBjb25zdCBlU3RhdGUgPSBKU09OLnBhcnNlKHRoaXMuc3RhdGUuZVN0YXRlIHx8IFwie31cIik7XG4gICAgICAgICAgICAgICAgc3RhdGUucG9wc3RhdGUgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHN0YXRlLmFjdGl2ZSA9IHRydWU7XG4gICAgICAgICAgICAgICAgdGhpcy5sZWFmLnNldFZpZXdTdGF0ZShzdGF0ZSwgZVN0YXRlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYE5vIG1vcmUgJHtieSA8IDAgPyBcImJhY2tcIiA6IFwiZm9yd2FyZFwifSBoaXN0b3J5IGZvciBwYW5lYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpeyB0aGlzLnN0YXRlID0gc3RhdGU7IH1cblxuICAgIHB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCkgICB7XG4gICAgICAgIHRoaXMuc3RhY2suc3BsaWNlKDAsIHRoaXMucG9zLCBzdGF0ZSk7XG4gICAgICAgIHRoaXMucG9zID0gMDtcbiAgICAgICAgLy8gTGltaXQgXCJiYWNrXCIgdG8gMjBcbiAgICAgICAgd2hpbGUgKHRoaXMuc3RhY2subGVuZ3RoID4gMjApIHRoaXMuc3RhY2sucG9wKCk7XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbEhpc3RvcnkocGx1Z2luKSB7XG5cbiAgICBjb25zdCBhcHAgPSBwbHVnaW4uYXBwO1xuXG4gICAgLy8gTW9ua2V5cGF0Y2g6IGluY2x1ZGUgaGlzdG9yeSBpbiBsZWFmIHNlcmlhbGl6YXRpb24gKHNvIGl0J3MgcGVyc2lzdGVkIHdpdGggdGhlIHdvcmtzcGFjZSlcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKFdvcmtzcGFjZUxlYWYucHJvdG90eXBlLCB7XG4gICAgICAgIHNlcmlhbGl6ZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNlcmlhbGl6ZSgpe1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICBpZiAodGhpc1tISVNUX0FUVFJdKSByZXN1bHRbXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCJdID0gdGhpc1tISVNUX0FUVFJdLnNlcmlhbGl6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX1cbiAgICB9KSk7XG5cbiAgICAvLyBNb25rZXlwYXRjaDogbG9hZCBoaXN0b3J5IGR1cmluZyBsZWFmIGxvYWQsIGlmIHByZXNlbnRcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKGFwcC53b3Jrc3BhY2UsIHtcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZUxheW91dChzdGF0ZSwgLi4uZXRjKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlW1wicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiXSkgcmVzdWx0W0hJU1RfQVRUUl0gPSBuZXcgSGlzdG9yeShyZXN1bHQsIHN0YXRlW1wicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9fVxuICAgIH0pKTtcblxuICAgIC8vIE92ZXJyaWRlIGRlZmF1bHQgbW91c2UgaGlzdG9yeSBiZWhhdmlvci4gIFdlIG5lZWQgdGhpcyBiZWNhdXNlIDEpIEVsZWN0cm9uIHdpbGwgdXNlIHRoZSBidWlsdC1pblxuICAgIC8vIGhpc3Rvcnkgb2JqZWN0IGlmIHdlIGRvbid0IChpbnN0ZWFkIG9mIG91ciB3cmFwcGVyKSwgYW5kIDIpIHdlIHdhbnQgdGhlIGNsaWNrIHRvIGFwcGx5IHRvIHRoZSBsZWFmXG4gICAgLy8gdGhhdCB3YXMgdW5kZXIgdGhlIG1vdXNlLCByYXRoZXIgdGhhbiB3aGljaGV2ZXIgbGVhZiB3YXMgYWN0aXZlLlxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCAoKSA9PiB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpICk7XG4gICAgZnVuY3Rpb24gaGlzdG9yeUhhbmRsZXIoZSkge1xuICAgICAgICBpZiAoZS5idXR0b24gIT09IDMgJiYgZS5idXR0b24gIT09IDQpIHJldHVybjtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOyBlLnN0b3BQcm9wYWdhdGlvbigpOyAgLy8gcHJldmVudCBkZWZhdWx0IGJlaGF2aW9yXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0Lm1hdGNoUGFyZW50KFwiLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICBpZiAodGFyZ2V0KSB7XG4gICAgICAgICAgICBsZXQgbGVhZjtcbiAgICAgICAgICAgIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcyhsID0+IGxlYWYgPSAobC5jb250YWluZXJFbCA9PT0gdGFyZ2V0KSA/IGwgOiBsZWFmKTtcbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSAzKSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5iYWNrKCk7IH1cbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSA0KSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5mb3J3YXJkKCk7IH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUHJveHkgdGhlIHdpbmRvdyBoaXN0b3J5IHdpdGggYSB3cmFwcGVyIHRoYXQgZGVsZWdhdGVzIHRvIHRoZSBhY3RpdmUgbGVhZidzIEhpc3Rvcnkgb2JqZWN0LFxuICAgIGNvbnN0IHJlYWxIaXN0b3J5ID0gd2luZG93Lmhpc3Rvcnk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+IHdpbmRvdy5oaXN0b3J5ID0gcmVhbEhpc3RvcnkpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiaGlzdG9yeVwiLCB7IGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUsIHZhbHVlOiB7XG4gICAgICAgIGdldCBzdGF0ZSgpICAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkuc3RhdGU7IH0sXG4gICAgICAgIHNldCBzdGF0ZShzdGF0ZSkgeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5zdGF0ZSA9IHN0YXRlOyB9LFxuICAgICAgICBnZXQgbGVuZ3RoKCkgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudChhcHApLmxlbmd0aDsgfSxcblxuICAgICAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfSxcbiAgICAgICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH0sXG4gICAgICAgIGdvKGJ5KSAgICB7IEhpc3RvcnkuY3VycmVudChhcHApLmdvKGJ5KTsgfSxcblxuICAgICAgICByZXBsYWNlU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5yZXBsYWNlU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpOyB9LFxuICAgICAgICBwdXNoU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpICAgeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5wdXNoU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpOyB9LFxuXG4gICAgICAgIGdldCBzY3JvbGxSZXN0b3JhdGlvbigpICAgIHsgcmV0dXJuIHJlYWxIaXN0b3J5LnNjcm9sbFJlc3RvcmF0aW9uOyB9LFxuICAgICAgICBzZXQgc2Nyb2xsUmVzdG9yYXRpb24odmFsKSB7IHJlYWxIaXN0b3J5LnNjcm9sbFJlc3RvcmF0aW9uID0gdmFsOyB9LFxuICAgIH19KTtcblxufVxuIiwiY29uc3Qge1BsdWdpbiwgTm90aWNlLCBGaWxlVmlldywgTWFya2Rvd25WaWV3fSA9IHJlcXVpcmUoJ29ic2lkaWFuJyk7XG5pbXBvcnQge2FkZENvbW1hbmRzLCBjb21tYW5kfSBmcm9tIFwiLi9jb21tYW5kc1wiO1xuaW1wb3J0IHtpbnN0YWxsSGlzdG9yeX0gZnJvbSBcIi4vSGlzdG9yeVwiO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBQYW5lUmVsaWVmIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgaW5zdGFsbEhpc3RvcnkodGhpcyk7XG4gICAgICAgIGFkZENvbW1hbmRzKHRoaXMsIHtcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1wcmV2XCIsIFwiU3dhcCBwYW5lIHdpdGggcHJldmlvdXMgaW4gc3BsaXRcIiwgIFwiTW9kK1NoaWZ0K1BhZ2VVcFwiKV0gICAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlcigtMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtbmV4dFwiLCBcIlN3YXAgcGFuZSB3aXRoIG5leHQgaW4gc3BsaXRcIiwgICAgICBcIk1vZCtTaGlmdCtQYWdlRG93blwiKV0gKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoIDEpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLW5leHRcIiwgIFwiQ3ljbGUgdG8gbmV4dCB3b3Jrc3BhY2UgcGFuZVwiLCAgICAgICBcIk1vZCtQYWdlVXBcIiAgKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigtMSwgdHJ1ZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLXByZXZcIiwgIFwiQ3ljbGUgdG8gcHJldmlvdXMgd29ya3NwYWNlIHBhbmVcIiwgICBcIk1vZCtQYWdlRG93blwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZiggMSwgdHJ1ZSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMXN0XCIsICAgXCJKdW1wIHRvIDFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTJuZFwiLCAgIFwiSnVtcCB0byAybmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0zcmRcIiwgICBcIkp1bXAgdG8gM3JkIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigyKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNHRoXCIsICAgXCJKdW1wIHRvIDR0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTV0aFwiLCAgIFwiSnVtcCB0byA1dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDQpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby02dGhcIiwgICBcIkp1bXAgdG8gNnRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig1KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tN3RoXCIsICAgXCJKdW1wIHRvIDd0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTh0aFwiLCAgIFwiSnVtcCB0byA4dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDcpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1sYXN0XCIsICBcIkp1bXAgdG8gbGFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgXCJBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig5OTk5OTk5OSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTFzdFwiLCAgXCJQbGFjZSBhcyAxc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigwLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0ybmRcIiwgIFwiUGxhY2UgYXMgMm5kIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtM3JkXCIsICBcIlBsYWNlIGFzIDNyZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDIsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTR0aFwiLCAgXCJQbGFjZSBhcyA0dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigzLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC01dGhcIiwgIFwiUGxhY2UgYXMgNXRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNnRoXCIsICBcIlBsYWNlIGFzIDZ0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDUsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTd0aFwiLCAgXCJQbGFjZSBhcyA3dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig2LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC04dGhcIiwgIFwiUGxhY2UgYXMgOHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtbGFzdFwiLCBcIlBsYWNlIGFzIGxhc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgXCJNb2QrQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDk5OTk5OTk5LCBmYWxzZSk7IH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZ290b050aExlYWYobiwgcmVsYXRpdmUpIHtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gW107XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlUm9vdExlYXZlcygobGVhZikgPT4gKGxlYXZlcy5wdXNoKGxlYWYpLCBmYWxzZSkpO1xuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIG4gKz0gbGVhdmVzLmluZGV4T2YodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpO1xuICAgICAgICAgICAgbiA9IChuICsgbGVhdmVzLmxlbmd0aCkgJSBsZWF2ZXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBsZWFmID0gbGVhdmVzW24+PWxlYXZlcy5sZW5ndGggPyBsZWF2ZXMubGVuZ3RoLTEgOiBuXTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGNiID0gdGhpcy5sZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZSk7XG4gICAgICAgIGlmIChjYikgY2IoKTtcbiAgICB9XG5cbiAgICBsZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgY29uc3RcbiAgICAgICAgICAgIHBhcmVudFNwbGl0ID0gbGVhZi5wYXJlbnRTcGxpdCxcbiAgICAgICAgICAgIGNoaWxkcmVuID0gcGFyZW50U3BsaXQuY2hpbGRyZW4sXG4gICAgICAgICAgICBmcm9tUG9zID0gY2hpbGRyZW4uaW5kZXhPZihsZWFmKVxuICAgICAgICA7XG4gICAgICAgIGlmIChmcm9tUG9zID09IC0xKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICB0b1BvcyArPSBmcm9tUG9zO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCB8fCB0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHRvUG9zID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDApIHRvUG9zID0gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmcm9tUG9zID09IHRvUG9zKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG90aGVyID0gY2hpbGRyZW5bdG9Qb3NdO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKGZyb21Qb3MsIDEpO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKHRvUG9zLCAgIDAsIGxlYWYpO1xuICAgICAgICAgICAgaWYgKHBhcmVudFNwbGl0LnNlbGVjdFRhYikge1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnNlbGVjdFRhYihsZWFmKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb3RoZXIuY29udGFpbmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KGZyb21Qb3MgPiB0b1BvcyA/IFwiYmVmb3JlYmVnaW5cIiA6IFwiYWZ0ZXJlbmRcIiwgbGVhZi5jb250YWluZXJFbCk7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQucmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk7XG4gICAgICAgICAgICAgICAgbGVhZi5vblJlc2l6ZSgpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dENoYW5nZSgpO1xuXG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgZm9jdXMgYmFjayB0byBwYW5lO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCBmYWxzZSwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuIl0sIm5hbWVzIjpbImNvbW1vbmpzSGVscGVycy5jcmVhdGVDb21tb25qc01vZHVsZSIsImFyb3VuZCIsIk5vdGljZSJdLCJtYXBwaW5ncyI6Ijs7QUFBQTtBQUNBO0FBQ0EsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQ3BCO0FBQ08sU0FBUyxPQUFPLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFLEVBQUU7QUFDdEQ7QUFDQTtBQUNBO0FBQ0EsSUFBSSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsRUFBRSxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN6RCxJQUFJLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDeEU7QUFDQSxJQUFJLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsR0FBRyxFQUFFO0FBQ3hDO0FBQ0EsUUFBUSxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUNoRDtBQUNBLFFBQVEsR0FBRyxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFDO0FBQzVCLFFBQVEsT0FBTyxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxHQUFHLEVBQUU7QUFDeEQsS0FBSyxDQUFDLENBQUM7QUFDUCxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQzVDO0FBQ0E7QUFDQSxJQUFJLE1BQU0sR0FBRyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDcEMsSUFBSSxRQUFRLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyxD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LENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxvQ0FBb0MsRUFBRSxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRTtBQUNoSTtBQUNBLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsaUNBQWlDLEtBQUssV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ3pJLFNBQVMsQ0FBQyxDQUFDO0FBQ1gsS0FBSztBQUNMO0FBQ0EsSUFBSSxXQUFXLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRTtBQUM3QixRQUFRLE1BQU0sTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUMxQixRQUFRLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLGlCQUFpQixDQUFDLENBQUMsSUFBSSxNQUFNLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUNuRixRQUFRLElBQUksUUFBUSxFQUFFO0FBQ3RCLFlBQVksQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDL0QsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsTUFBTSxDQUFDO0FBQ3BELFNBQVM7QUFDVCxRQUFRLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNwRSxRQUFRLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ3BFLEtBQUs7QUFDTDtBQUNBLElBQUksU0FBUyxDQUFDLEtBQUssRUFBRSxRQUFRLENBQUMsSUFBSSxFQUFFO0FBQ3BDLFFBQVEsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFDcEQsUUFBUSxJQUFJLEVBQUUsRUFBRSxFQUFFLEVBQUUsQ0FBQztBQUNyQixLQUFLO0FBQ0w7QUFDQSxJQUFJLFVBQVUsQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLElBQUksRUFBRTtBQUNyQyxRQUFRLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQztBQUNuRCxRQUFRLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFDaEM7QUFDQSxRQUFRO0FBQ1IsWUFBWSxXQUFXLEdBQUcsSUFBSSxDQUFDLFdBQVc7QUFDMUMsWUFBWSxRQUFRLEdBQUcsV0FBVyxDQUFDLFFBQVE7QUFDM0MsWUFBWSxPQUFPLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7QUFDNUMsU0FBUztBQUNULFFBQVEsSUFBSSxPQUFPLElBQUksQ0FBQyxDQUFDLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFDeEM7QUFDQSxRQUFRLElBQUksUUFBUSxFQUFFO0FBQ3RCLFlBQVksS0FBSyxJQUFJLE9BQU8sQ0FBQztBQUM3QixZQUFZLElBQUksS0FBSyxHQUFHLENBQUMsSUFBSSxLQUFLLElBQUksUUFBUSxDQUFDLE1BQU0sRUFBRSxPQUFPLEtBQUssQ0FBQztBQUNwRSxTQUFTLE1BQU07QUFDZixZQUFZLElBQUksS0FBSyxJQUFJLFFBQVEsQ0FBQyxNQUFNLEVBQUUsS0FBSyxHQUFHLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQ3RFLFlBQVksSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxDQUFDLENBQUM7QUFDckMsU0FBUztBQUNUO0FBQ0EsUUFBUSxJQUFJLE9BQU8sSUFBSSxLQUFLLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFDM0M7QUFDQSxRQUFRLE9BQU8sTUFBTTtBQUNyQixZQUFZLE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUMxQyxZQUFZLFFBQVEsQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3hDLFlBQVksUUFBUSxDQUFDLE1BQU0sQ0FBQyxLQUFLLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQzlDLFlBQVksSUFBSSxXQUFXLENBQUMsU0FBUyxFQUFFO0FBQ3ZDLGdCQUFnQixXQUFXLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzVDLGFBQWEsTUFBTTtBQUNuQixnQkFBZ0IsS0FBSyxDQUFDLFdBQVcsQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLEdBQUcsS0FBSyxHQUFHLGFBQWEsR0FBRyxVQUFVLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ3hILGdCQUFnQixXQUFXLENBQUMsMkJBQTJCLEVBQUUsQ0FBQztBQUMxRCxnQkFBZ0IsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO0FBQ2hDLGdCQUFnQixJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxjQUFjLEVBQUUsQ0FBQztBQUNwRDtBQUNBO0FBQ0EsZ0JBQWdCLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUM7QUFDckQsZ0JBQWdCLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBQztBQUNuRSxhQUFhO0FBQ2IsU0FBUztBQUNULEtBQUs7QUFDTDs7OzsifQ==
