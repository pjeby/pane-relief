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

class HistoryEntry {
    constructor(rawState) {
        this.setState(rawState);
    }

    setState(rawState) {
        this.raw = rawState;
        this.viewState = JSON.parse(rawState.state || "{}");
        this.eState = JSON.parse(rawState.eState || "null");
        this.path = this.viewState.state?.file;
    }

    onRename(file, oldPath) {
        if (this.path === oldPath) {
            this.path = this.viewState.state.file = file.path;
            this.raw.state = JSON.stringify(this.viewState);
        }
    }

    go(leaf) {
        let {viewState, path, eState} = this;
        let file = path && leaf?.app?.vault.getAbstractFileByPath(path);
        if (path && !file) {
            new obsidian.Notice("Missing file: "+path);
            viewState = {type: "empty", state:{}};
            eState = undefined;
        }
        leaf.setViewState({...viewState, active: true, popstate: true}, eState);
    }

    replaceState(rawState) {
        if (rawState.state !== this.raw.state) {
            const viewState = JSON.parse(rawState.state || "{}");
            // Don't replace a file with an empty in the history
            if (viewState.type === "empty") return true;
            // File is different from existing file: should be a push instead
            if (this.path && this.path !== viewState?.state?.file) return false;
        }
        this.setState(rawState);
        return true;
    }
}

class History {
    static current(app) {
        return this.forLeaf(app.workspace.activeLeaf) || new this();
    }

    static forLeaf(leaf) {
        if (leaf) return leaf[HIST_ATTR] instanceof this ?
            leaf[HIST_ATTR] :
            leaf[HIST_ATTR] = new this(leaf, leaf[HIST_ATTR]?.serialize() || undefined);
    }

    constructor(leaf, {pos, stack} = {pos:0, stack:[]}) {
        this.leaf = leaf;
        this.pos = pos;
        this.stack = stack.map(raw => new HistoryEntry(raw));
    }

    cloneTo(leaf) {
        return leaf[HIST_ATTR] = new this.constructor(leaf, this.serialize());
    }

    onRename(file, oldPath) {
        for(const histEntry of this.stack) histEntry.onRename(file, oldPath);
    }

    serialize() { return {pos: this.pos, stack: this.stack.map(e => e.raw)}; }

    get state() { return this.stack[this.pos].raw || null; }
    get length() { return this.stack.length; }

    back()    { this.go(-1); }
    forward() { this.go( 1); }

    lookAhead() { return this.stack.slice(0, this.pos).reverse(); }
    lookBehind() { return this.stack.slice(this.pos+1); }

    goto(pos) {
        if (!this.leaf) return;
        if (this.leaf.pinned) return new obsidian.Notice("Pinned pane: unpin before going forward or back"), undefined;
        pos = this.pos = Math.max(0, Math.min(pos, this.stack.length - 1));
        this.stack[pos]?.go(this.leaf);
        this.leaf.app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
    }

    go(by, force) {
        if (!this.leaf || !by) return;  // no-op
        // prevent wraparound
        const newPos = Math.max(0, Math.min(this.pos - by, this.stack.length - 1));
        if (force || newPos !== this.pos) {
            this.goto(newPos);
        } else {
            new obsidian.Notice(`No more ${by < 0 ? "back" : "forward"} history for pane`);
        }
    }

    replaceState(rawState, title, url){
        const entry = this.stack[this.pos];
        if (!entry) {
            this.stack[this.pos] = new HistoryEntry(rawState);
        } else if (!entry.replaceState(rawState)) {
            // replaceState was erroneously called with a new file for the same leaf;
            // force a pushState instead (fixes the issue reported here: https://forum.obsidian.md/t/18518)
            this.pushState(rawState, title, url);
        }
    }

    pushState(rawState, title, url)   {
        console.log("pushing", rawState);
        this.stack.splice(0, this.pos, new HistoryEntry(rawState));
        this.pos = 0;
        // Limit "back" to 20
        while (this.stack.length > 20) this.stack.pop();
        this.leaf.app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
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

const viewtypeIcons = {
    markdown: "document",
    image: "image-file",
    audio: "audio-file",
    pdf: "pdf-file",
    localgraph: "dot-network",
    outline: "bullet-list",
    backlink: "link",

    // third-party plugins
    kanban: "blocks",
    excalidraw: "excalidraw-icon",
};

const nonFileViews = {
    graph: ["dot-network", "Graph View"],
    "file-explorer": ["folder", "File Explorer"],
    starred: ["star", "Starred Files"],
    tag: ["tag", "Tags View"],

    // third-party plugins
    "recent-files": ["clock", "Recent Files"],
    calendar: ["calendar-with-checkmark", "Calendar"],
    empty: ["cross", "No file"]
};

class Navigator extends obsidian.Component {

    static hoverSource = "pane-relief:history-menu";

    constructor(app, kind, dir)  {
        super();
        this.app = app;
        this.kind = kind;
        this.dir = dir;
    }

    onload() {
        this.containerEl = document.body.find(
            `.titlebar .titlebar-button-container.mod-left .titlebar-button.mod-${this.kind}`
        );
        this.count = this.containerEl.createSpan({prepend: this.kind === "back", cls: "history-counter"});
        this.leaf = null;
        this.history = null;
        this.states = [];
        this.oldLabel = this.containerEl.getAttribute("aria-label");
        this.registerDomEvent(this.containerEl, "contextmenu", this.openMenu.bind(this));
    }

    onunload() {
        this.setTooltip(this.oldLabel);
        this.count.detach();
        this.containerEl.toggleClass("mod-active", false);
    }

    setCount(num) { this.count.textContent = num || ""; }

    setTooltip(text) {
        if (text) this.containerEl.setAttribute("aria-label", text || undefined);
        else this.containerEl.removeAttribute("aria-label");
    }

    setHistory(history) {
        this.history = history;
        const states = this.states = history[this.dir < 0 ? "lookBehind" : "lookAhead"].call(history);
        this.setCount(states.length);
        this.setTooltip(states.length ?
            this.oldLabel + "\n" + this.formatState(states[0]).title :
            `No ${this.kind} history`
        );
        this.containerEl.toggleClass("mod-active", states.length > 0);
    }

    openMenu(evt) {
        if (!this.states.length) return;
        const menu = createMenu(this.app);
        menu.dom.style.setProperty("--layer-menu", 29);
        this.states.map(this.formatState.bind(this)).forEach(
            (info, idx) => this.menuItem(info, idx, menu)
        );
        menu.showAtPosition({x: evt.clientX, y: evt.clientY + 20});
    }

    menuItem(info, idx, menu) {
        const my = this;
        menu.addItem(i => { createItem(i); if (info.file) setupFileEvents(i.dom); });
        return;

        function createItem(i, prefix="") {
            i.setIcon(info.icon).setTitle(prefix + info.title).onClick(e => {
                let history = my.history;
                // Check for ctrl/cmd/middle button and split leaf + copy history
                if (obsidian.Keymap.isModifier(e, "Mod") || 1 === e.button) {
                    history = history.cloneTo(my.app.workspace.splitActiveLeaf());
                }
                history.go((idx+1) * my.dir, true);
            });
        }

        function setupFileEvents(dom) {
            // Hover preview
            dom.addEventListener('mouseover', e => {
                my.app.workspace.trigger('hover-link', {
                    event: e, source: Navigator.hoverSource,
                    hoverParent: menu.dom, targetEl: dom, linktext: info.file.path
                });
            });

            // Drag menu item to move or link file
            dom.setAttr('draggable', 'true');
            dom.addEventListener('dragstart', e => {
                const dragManager = my.app.dragManager;
                const dragData = dragManager.dragFile(e, info.file);
                dragManager.onDragStart(e, dragData);
            });
            dom.addEventListener('dragend', e => menu.hide());

            // File menu
            dom.addEventListener("contextmenu", e => {
                const menu = createMenu(my.app);
                menu.addItem(i => createItem(i, `Go ${my.kind} to `)).addSeparator();
                my.app.workspace.trigger(
                    "file-menu", menu, info.file, "link-context-menu"
                );
                menu.showAtPosition({x: e.clientX, y: e.clientY});
                e.stopPropagation(); // keep the parent menu open for now
            }, true);
        }
    }

    formatState(entry) {
        const {viewState: {type, state}, eState, path} = entry;
        const file = path && this.app.vault.getAbstractFileByPath(path);
        const info = {icon: "", title: "", file, type, state, eState};

        if (nonFileViews[type]) {
            [info.icon, info.title] = nonFileViews[type];
        } else if (path && !file) {
            [info.icon, info.title] = ["trash", "Missing file "+path];
        } else {
            info.icon = viewtypeIcons[type] ?? "document";
            if (type === "markdown" && state.mode === "preview") info.icon = "lines-of-text";
            info.title = file ? file.basename + (file.extension !== "md" ? "."+file.extension : "") : "No file";
        }

        this.app.workspace.trigger("pane-relief:format-history-item", info);
        return info;
    }
}

function onElement(el, event, selector, callback, options) {
    el.on(event, selector, callback, options);
    return () => el.off(event, selector, callback, options);
}

function createMenu(app) {
    const menu = new obsidian.Menu(app);
    menu.register(
        // XXX this really should be a scope push
        onElement(document, "keydown", "*", e => {
            if (e.key==="Escape") {
                e.preventDefault();
                e.stopPropagation();
                menu.hide();
            }
        }, {capture: true})
    );
    return menu;
}

class PaneRelief extends obsidian.Plugin {

    onload() {
        installHistory(this);
        this.app.workspace.registerHoverLinkSource(Navigator.hoverSource, {
            display: 'History dropdowns', defaultMod: true
        });
        this.app.workspace.onLayoutReady(() => {
            this.setupDisplay();
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof obsidian.TFile) this.app.workspace.iterateAllLeaves(
                    leaf => History.forLeaf(leaf).onRename(file, oldPath)
                );
            }));
            this.registerEvent(this.app.workspace.on("pane-relief:update-history", (leaf, history) => {
                if (leaf === this.app.workspace.activeLeaf) this.display(history);
            }));
            this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => this.display(History.forLeaf(leaf))));
            if (this.app.workspace.activeLeaf) this.display(History.forLeaf(this.app.workspace.activeLeaf));
        });

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

    setupDisplay() {
        this.addChild(this.back    = new Navigator(this.app, "back", -1));
        this.addChild(this.forward = new Navigator(this.app, "forward", 1));
    }

    display(history) {
        this.back.setHistory(history);
        this.forward.setHistory(history);
    }

    onunload() {
        this.app.workspace.unregisterHoverLinkSource(Navigator.hoverSource);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9OYXZpZ2F0b3IuanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmNvbnN0IGNvbW1hbmRzID0ge307XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kKGlkLCBuYW1lLCBob3RrZXlzPVtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgaG90a2V5cy5rZXkpIGhvdGtleXMgPSBbaG90a2V5c107XG5cbiAgICBob3RrZXlzID0gaG90a2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAga2V5ID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IGtleSwga2V5OiBrZXkucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kcyhwbHVnaW4sIGNtZHNldCkge1xuICAgIC8vIEV4dHJhY3QgY29tbWFuZCBzeW1ib2xzIGZyb20gY21kc2V0IGFuZCByZWdpc3RlciB0aGVtLCBib3VuZCB0byB0aGUgcGx1Z2luIGZvciBtZXRob2RzXG4gICAgT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scyhjbWRzZXQpLmZvckVhY2goc3ltID0+IHtcbiAgICAgICAgY29uc3QgY21kID0gY29tbWFuZHNbc3ltXSwgbWV0aG9kID0gY21kc2V0W3N5bV07XG4gICAgICAgIGlmIChjbWQpIHBsdWdpbi5hZGRDb21tYW5kKE9iamVjdC5hc3NpZ24oe30sIGNtZCwge1xuICAgICAgICAgICAgY2hlY2tDYWxsYmFjayhjaGVjaykge1xuICAgICAgICAgICAgICAgIC8vIENhbGwgdGhlIG1ldGhvZCBib2R5IHdpdGggdGhlIHBsdWdpbiBhcyAndGhpcydcbiAgICAgICAgICAgICAgICBjb25zdCBjYiA9IG1ldGhvZC5jYWxsKHBsdWdpbik7XG4gICAgICAgICAgICAgICAgLy8gSXQgdGhlbiByZXR1cm5zIGEgY2xvc3VyZSBpZiB0aGUgY29tbWFuZCBpcyByZWFkeSB0byBleGVjdXRlLCBhbmRcbiAgICAgICAgICAgICAgICAvLyB3ZSBjYWxsIHRoYXQgY2xvc3VyZSB1bmxlc3MgdGhpcyBpcyBqdXN0IGEgY2hlY2sgZm9yIGF2YWlsYWJpbGl0eVxuICAgICAgICAgICAgICAgIHJldHVybiAoY2hlY2sgfHwgdHlwZW9mIGNiICE9PSBcImZ1bmN0aW9uXCIpID8gISFjYiA6IChjYigpLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH0pXG59IiwiZXhwb3J0IGZ1bmN0aW9uIGFyb3VuZChvYmosIGZhY3Rvcmllcykge1xuICAgIGNvbnN0IHJlbW92ZXJzID0gT2JqZWN0LmtleXMoZmFjdG9yaWVzKS5tYXAoa2V5ID0+IGFyb3VuZDEob2JqLCBrZXksIGZhY3Rvcmllc1trZXldKSk7XG4gICAgcmV0dXJuIHJlbW92ZXJzLmxlbmd0aCA9PT0gMSA/IHJlbW92ZXJzWzBdIDogZnVuY3Rpb24gKCkgeyByZW1vdmVycy5mb3JFYWNoKHIgPT4gcigpKTsgfTtcbn1cbmZ1bmN0aW9uIGFyb3VuZDEob2JqLCBtZXRob2QsIGNyZWF0ZVdyYXBwZXIpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG9ialttZXRob2RdLCBoYWRPd24gPSBvYmouaGFzT3duUHJvcGVydHkobWV0aG9kKTtcbiAgICBsZXQgY3VycmVudCA9IGNyZWF0ZVdyYXBwZXIob3JpZ2luYWwpO1xuICAgIC8vIExldCBvdXIgd3JhcHBlciBpbmhlcml0IHN0YXRpYyBwcm9wcyBmcm9tIHRoZSB3cmFwcGluZyBtZXRob2QsXG4gICAgLy8gYW5kIHRoZSB3cmFwcGluZyBtZXRob2QsIHByb3BzIGZyb20gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgIGlmIChvcmlnaW5hbClcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGN1cnJlbnQsIG9yaWdpbmFsKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgY3VycmVudCk7XG4gICAgb2JqW21ldGhvZF0gPSB3cmFwcGVyO1xuICAgIC8vIFJldHVybiBhIGNhbGxiYWNrIHRvIGFsbG93IHNhZmUgcmVtb3ZhbFxuICAgIHJldHVybiByZW1vdmU7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBkZWFjdGl2YXRlZCBhbmQgYXJlIG5vIGxvbmdlciB3cmFwcGVkLCByZW1vdmUgb3Vyc2VsdmVzXG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbCAmJiBvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcilcbiAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICByZXR1cm4gY3VycmVudC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuICAgICAgICAvLyBJZiBubyBvdGhlciBwYXRjaGVzLCBqdXN0IGRvIGEgZGlyZWN0IHJlbW92YWxcbiAgICAgICAgaWYgKG9ialttZXRob2RdID09PSB3cmFwcGVyKSB7XG4gICAgICAgICAgICBpZiAoaGFkT3duKVxuICAgICAgICAgICAgICAgIG9ialttZXRob2RdID0gb3JpZ2luYWw7XG4gICAgICAgICAgICBlbHNlXG4gICAgICAgICAgICAgICAgZGVsZXRlIG9ialttZXRob2RdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbClcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgLy8gRWxzZSBwYXNzIGZ1dHVyZSBjYWxscyB0aHJvdWdoLCBhbmQgcmVtb3ZlIHdyYXBwZXIgZnJvbSB0aGUgcHJvdG90eXBlIGNoYWluXG4gICAgICAgIGN1cnJlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIG9yaWdpbmFsIHx8IEZ1bmN0aW9uKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXIocHJvbWlzZSwgY2IpIHtcbiAgICByZXR1cm4gcHJvbWlzZS50aGVuKGNiLCBjYik7XG59XG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplKGFzeW5jRnVuY3Rpb24pIHtcbiAgICBsZXQgbGFzdFJ1biA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4ge1xuICAgICAgICAgICAgYWZ0ZXIobGFzdFJ1biwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGFzeW5jRnVuY3Rpb24uYXBwbHkodGhpcywgYXJncykudGhlbihyZXMsIHJlaik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdyYXBwZXIuYWZ0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGFmdGVyKGxhc3RSdW4sIHJlcyk7IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHdyYXBwZXI7XG59XG4iLCJpbXBvcnQge05vdGljZSwgV29ya3NwYWNlTGVhZn0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmNvbnN0IEhJU1RfQVRUUiA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuY29uc3QgU0VSSUFMX1BST1AgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcblxuZnVuY3Rpb24gcGFyc2Uoc3RhdGUpIHtcbiAgICBpZiAodHlwZW9mIHN0YXRlLnN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5zdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGUuc3RhdGUpO1xuICAgIGlmICh0eXBlb2Ygc3RhdGUuZVN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5lU3RhdGUgPSBKU09OLnBhcnNlKHN0YXRlLmVTdGF0ZSk7XG4gICAgcmV0dXJuIHN0YXRlO1xufVxuXG5jbGFzcyBIaXN0b3J5RW50cnkge1xuICAgIGNvbnN0cnVjdG9yKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgIH1cblxuICAgIHNldFN0YXRlKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMucmF3ID0gcmF3U3RhdGU7XG4gICAgICAgIHRoaXMudmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICB0aGlzLmVTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuZVN0YXRlIHx8IFwibnVsbFwiKTtcbiAgICAgICAgdGhpcy5wYXRoID0gdGhpcy52aWV3U3RhdGUuc3RhdGU/LmZpbGU7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBpZiAodGhpcy5wYXRoID09PSBvbGRQYXRoKSB7XG4gICAgICAgICAgICB0aGlzLnBhdGggPSB0aGlzLnZpZXdTdGF0ZS5zdGF0ZS5maWxlID0gZmlsZS5wYXRoXG4gICAgICAgICAgICB0aGlzLnJhdy5zdGF0ZSA9IEpTT04uc3RyaW5naWZ5KHRoaXMudmlld1N0YXRlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvKGxlYWYpIHtcbiAgICAgICAgbGV0IHt2aWV3U3RhdGUsIHBhdGgsIGVTdGF0ZX0gPSB0aGlzO1xuICAgICAgICBsZXQgZmlsZSA9IHBhdGggJiYgbGVhZj8uYXBwPy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiTWlzc2luZyBmaWxlOiBcIitwYXRoKTtcbiAgICAgICAgICAgIHZpZXdTdGF0ZSA9IHt0eXBlOiBcImVtcHR5XCIsIHN0YXRlOnt9fTtcbiAgICAgICAgICAgIGVTdGF0ZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBsZWFmLnNldFZpZXdTdGF0ZSh7Li4udmlld1N0YXRlLCBhY3RpdmU6IHRydWUsIHBvcHN0YXRlOiB0cnVlfSwgZVN0YXRlKTtcbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGUpIHtcbiAgICAgICAgaWYgKHJhd1N0YXRlLnN0YXRlICE9PSB0aGlzLnJhdy5zdGF0ZSkge1xuICAgICAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgLy8gRG9uJ3QgcmVwbGFjZSBhIGZpbGUgd2l0aCBhbiBlbXB0eSBpbiB0aGUgaGlzdG9yeVxuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcImVtcHR5XCIpIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgLy8gRmlsZSBpcyBkaWZmZXJlbnQgZnJvbSBleGlzdGluZyBmaWxlOiBzaG91bGQgYmUgYSBwdXNoIGluc3RlYWRcbiAgICAgICAgICAgIGlmICh0aGlzLnBhdGggJiYgdGhpcy5wYXRoICE9PSB2aWV3U3RhdGU/LnN0YXRlPy5maWxlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICAgIHN0YXRpYyBjdXJyZW50KGFwcCkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgfHwgbmV3IHRoaXMoKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yTGVhZihsZWFmKSB7XG4gICAgICAgIGlmIChsZWFmKSByZXR1cm4gbGVhZltISVNUX0FUVFJdIGluc3RhbmNlb2YgdGhpcyA/XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gOlxuICAgICAgICAgICAgbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMobGVhZiwgbGVhZltISVNUX0FUVFJdPy5zZXJpYWxpemUoKSB8fCB1bmRlZmluZWQpO1xuICAgIH1cblxuICAgIGNvbnN0cnVjdG9yKGxlYWYsIHtwb3MsIHN0YWNrfSA9IHtwb3M6MCwgc3RhY2s6W119KSB7XG4gICAgICAgIHRoaXMubGVhZiA9IGxlYWY7XG4gICAgICAgIHRoaXMucG9zID0gcG9zO1xuICAgICAgICB0aGlzLnN0YWNrID0gc3RhY2subWFwKHJhdyA9PiBuZXcgSGlzdG9yeUVudHJ5KHJhdykpO1xuICAgIH1cblxuICAgIGNsb25lVG8obGVhZikge1xuICAgICAgICByZXR1cm4gbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMuY29uc3RydWN0b3IobGVhZiwgdGhpcy5zZXJpYWxpemUoKSk7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBmb3IoY29uc3QgaGlzdEVudHJ5IG9mIHRoaXMuc3RhY2spIGhpc3RFbnRyeS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKTtcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2subWFwKGUgPT4gZS5yYXcpfTsgfVxuXG4gICAgZ2V0IHN0YXRlKCkgeyByZXR1cm4gdGhpcy5zdGFja1t0aGlzLnBvc10ucmF3IHx8IG51bGw7IH1cbiAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gdGhpcy5zdGFjay5sZW5ndGg7IH1cblxuICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9XG4gICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH1cblxuICAgIGxvb2tBaGVhZCgpIHsgcmV0dXJuIHRoaXMuc3RhY2suc2xpY2UoMCwgdGhpcy5wb3MpLnJldmVyc2UoKTsgfVxuICAgIGxvb2tCZWhpbmQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKHRoaXMucG9zKzEpOyB9XG5cbiAgICBnb3RvKHBvcykge1xuICAgICAgICBpZiAoIXRoaXMubGVhZikgcmV0dXJuO1xuICAgICAgICBpZiAodGhpcy5sZWFmLnBpbm5lZCkgcmV0dXJuIG5ldyBOb3RpY2UoXCJQaW5uZWQgcGFuZTogdW5waW4gYmVmb3JlIGdvaW5nIGZvcndhcmQgb3IgYmFja1wiKSwgdW5kZWZpbmVkO1xuICAgICAgICBwb3MgPSB0aGlzLnBvcyA9IE1hdGgubWF4KDAsIE1hdGgubWluKHBvcywgdGhpcy5zdGFjay5sZW5ndGggLSAxKSk7XG4gICAgICAgIHRoaXMuc3RhY2tbcG9zXT8uZ28odGhpcy5sZWFmKTtcbiAgICAgICAgdGhpcy5sZWFmLmFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKTtcbiAgICB9XG5cbiAgICBnbyhieSwgZm9yY2UpIHtcbiAgICAgICAgaWYgKCF0aGlzLmxlYWYgfHwgIWJ5KSByZXR1cm47ICAvLyBuby1vcFxuICAgICAgICAvLyBwcmV2ZW50IHdyYXBhcm91bmRcbiAgICAgICAgY29uc3QgbmV3UG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odGhpcy5wb3MgLSBieSwgdGhpcy5zdGFjay5sZW5ndGggLSAxKSk7XG4gICAgICAgIGlmIChmb3JjZSB8fCBuZXdQb3MgIT09IHRoaXMucG9zKSB7XG4gICAgICAgICAgICB0aGlzLmdvdG8obmV3UG9zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYE5vIG1vcmUgJHtieSA8IDAgPyBcImJhY2tcIiA6IFwiZm9yd2FyZFwifSBoaXN0b3J5IGZvciBwYW5lYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpe1xuICAgICAgICBjb25zdCBlbnRyeSA9IHRoaXMuc3RhY2tbdGhpcy5wb3NdO1xuICAgICAgICBpZiAoIWVudHJ5KSB7XG4gICAgICAgICAgICB0aGlzLnN0YWNrW3RoaXMucG9zXSA9IG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpO1xuICAgICAgICB9IGVsc2UgaWYgKCFlbnRyeS5yZXBsYWNlU3RhdGUocmF3U3RhdGUpKSB7XG4gICAgICAgICAgICAvLyByZXBsYWNlU3RhdGUgd2FzIGVycm9uZW91c2x5IGNhbGxlZCB3aXRoIGEgbmV3IGZpbGUgZm9yIHRoZSBzYW1lIGxlYWY7XG4gICAgICAgICAgICAvLyBmb3JjZSBhIHB1c2hTdGF0ZSBpbnN0ZWFkIChmaXhlcyB0aGUgaXNzdWUgcmVwb3J0ZWQgaGVyZTogaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90LzE4NTE4KVxuICAgICAgICAgICAgdGhpcy5wdXNoU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcHVzaFN0YXRlKHJhd1N0YXRlLCB0aXRsZSwgdXJsKSAgIHtcbiAgICAgICAgY29uc29sZS5sb2coXCJwdXNoaW5nXCIsIHJhd1N0YXRlKVxuICAgICAgICB0aGlzLnN0YWNrLnNwbGljZSgwLCB0aGlzLnBvcywgbmV3IEhpc3RvcnlFbnRyeShyYXdTdGF0ZSkpO1xuICAgICAgICB0aGlzLnBvcyA9IDA7XG4gICAgICAgIC8vIExpbWl0IFwiYmFja1wiIHRvIDIwXG4gICAgICAgIHdoaWxlICh0aGlzLnN0YWNrLmxlbmd0aCA+IDIwKSB0aGlzLnN0YWNrLnBvcCgpO1xuICAgICAgICB0aGlzLmxlYWYuYXBwPy53b3Jrc3BhY2U/LnRyaWdnZXIoXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCB0aGlzLmxlYWYsIHRoaXMpXG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbEhpc3RvcnkocGx1Z2luKSB7XG5cbiAgICBjb25zdCBhcHAgPSBwbHVnaW4uYXBwO1xuXG4gICAgLy8gTW9ua2V5cGF0Y2g6IGluY2x1ZGUgaGlzdG9yeSBpbiBsZWFmIHNlcmlhbGl6YXRpb24gKHNvIGl0J3MgcGVyc2lzdGVkIHdpdGggdGhlIHdvcmtzcGFjZSlcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKFdvcmtzcGFjZUxlYWYucHJvdG90eXBlLCB7XG4gICAgICAgIHNlcmlhbGl6ZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNlcmlhbGl6ZSgpe1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICBpZiAodGhpc1tISVNUX0FUVFJdKSByZXN1bHRbU0VSSUFMX1BST1BdID0gdGhpc1tISVNUX0FUVFJdLnNlcmlhbGl6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX1cbiAgICB9KSk7XG5cbiAgICAvLyBNb25rZXlwYXRjaDogbG9hZCBoaXN0b3J5IGR1cmluZyBsZWFmIGxvYWQsIGlmIHByZXNlbnRcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKGFwcC53b3Jrc3BhY2UsIHtcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZUxheW91dChzdGF0ZSwgLi4uZXRjKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlW1NFUklBTF9QUk9QXSkgcmVzdWx0W0hJU1RfQVRUUl0gPSBuZXcgSGlzdG9yeShyZXN1bHQsIHN0YXRlW1NFUklBTF9QUk9QXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9fVxuICAgIH0pKTtcblxuICAgIC8vIE92ZXJyaWRlIGRlZmF1bHQgbW91c2UgaGlzdG9yeSBiZWhhdmlvci4gIFdlIG5lZWQgdGhpcyBiZWNhdXNlIDEpIEVsZWN0cm9uIHdpbGwgdXNlIHRoZSBidWlsdC1pblxuICAgIC8vIGhpc3Rvcnkgb2JqZWN0IGlmIHdlIGRvbid0IChpbnN0ZWFkIG9mIG91ciB3cmFwcGVyKSwgYW5kIDIpIHdlIHdhbnQgdGhlIGNsaWNrIHRvIGFwcGx5IHRvIHRoZSBsZWFmXG4gICAgLy8gdGhhdCB3YXMgdW5kZXIgdGhlIG1vdXNlLCByYXRoZXIgdGhhbiB3aGljaGV2ZXIgbGVhZiB3YXMgYWN0aXZlLlxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCAoKSA9PiB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpICk7XG4gICAgZnVuY3Rpb24gaGlzdG9yeUhhbmRsZXIoZSkge1xuICAgICAgICBpZiAoZS5idXR0b24gIT09IDMgJiYgZS5idXR0b24gIT09IDQpIHJldHVybjtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOyBlLnN0b3BQcm9wYWdhdGlvbigpOyAgLy8gcHJldmVudCBkZWZhdWx0IGJlaGF2aW9yXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0Lm1hdGNoUGFyZW50KFwiLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICBpZiAodGFyZ2V0KSB7XG4gICAgICAgICAgICBsZXQgbGVhZjtcbiAgICAgICAgICAgIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcyhsID0+IGxlYWYgPSAobC5jb250YWluZXJFbCA9PT0gdGFyZ2V0KSA/IGwgOiBsZWFmKTtcbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSAzKSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5iYWNrKCk7IH1cbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSA0KSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5mb3J3YXJkKCk7IH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUHJveHkgdGhlIHdpbmRvdyBoaXN0b3J5IHdpdGggYSB3cmFwcGVyIHRoYXQgZGVsZWdhdGVzIHRvIHRoZSBhY3RpdmUgbGVhZidzIEhpc3Rvcnkgb2JqZWN0LFxuICAgIGNvbnN0IHJlYWxIaXN0b3J5ID0gd2luZG93Lmhpc3Rvcnk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+IHdpbmRvdy5oaXN0b3J5ID0gcmVhbEhpc3RvcnkpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiaGlzdG9yeVwiLCB7IGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUsIHZhbHVlOiB7XG4gICAgICAgIGdldCBzdGF0ZSgpICAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkuc3RhdGU7IH0sXG4gICAgICAgIGdldCBsZW5ndGgoKSAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkubGVuZ3RoOyB9LFxuXG4gICAgICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9LFxuICAgICAgICBmb3J3YXJkKCkgeyB0aGlzLmdvKCAxKTsgfSxcbiAgICAgICAgZ28oYnkpICAgIHsgSGlzdG9yeS5jdXJyZW50KGFwcCkuZ28oYnkpOyB9LFxuXG4gICAgICAgIHJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCl7IEhpc3RvcnkuY3VycmVudChhcHApLnJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG4gICAgICAgIHB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCkgICB7IEhpc3RvcnkuY3VycmVudChhcHApLnB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG5cbiAgICAgICAgZ2V0IHNjcm9sbFJlc3RvcmF0aW9uKCkgICAgeyByZXR1cm4gcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb247IH0sXG4gICAgICAgIHNldCBzY3JvbGxSZXN0b3JhdGlvbih2YWwpIHsgcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb24gPSB2YWw7IH0sXG4gICAgfX0pO1xuXG59XG4iLCJpbXBvcnQge01lbnUsIEtleW1hcCwgQ29tcG9uZW50fSBmcm9tICdvYnNpZGlhbic7XG5cbmNvbnN0IHZpZXd0eXBlSWNvbnMgPSB7XG4gICAgbWFya2Rvd246IFwiZG9jdW1lbnRcIixcbiAgICBpbWFnZTogXCJpbWFnZS1maWxlXCIsXG4gICAgYXVkaW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHBkZjogXCJwZGYtZmlsZVwiLFxuICAgIGxvY2FsZ3JhcGg6IFwiZG90LW5ldHdvcmtcIixcbiAgICBvdXRsaW5lOiBcImJ1bGxldC1saXN0XCIsXG4gICAgYmFja2xpbms6IFwibGlua1wiLFxuXG4gICAgLy8gdGhpcmQtcGFydHkgcGx1Z2luc1xuICAgIGthbmJhbjogXCJibG9ja3NcIixcbiAgICBleGNhbGlkcmF3OiBcImV4Y2FsaWRyYXctaWNvblwiLFxufVxuXG5jb25zdCBub25GaWxlVmlld3MgPSB7XG4gICAgZ3JhcGg6IFtcImRvdC1uZXR3b3JrXCIsIFwiR3JhcGggVmlld1wiXSxcbiAgICBcImZpbGUtZXhwbG9yZXJcIjogW1wiZm9sZGVyXCIsIFwiRmlsZSBFeHBsb3JlclwiXSxcbiAgICBzdGFycmVkOiBbXCJzdGFyXCIsIFwiU3RhcnJlZCBGaWxlc1wiXSxcbiAgICB0YWc6IFtcInRhZ1wiLCBcIlRhZ3MgVmlld1wiXSxcblxuICAgIC8vIHRoaXJkLXBhcnR5IHBsdWdpbnNcbiAgICBcInJlY2VudC1maWxlc1wiOiBbXCJjbG9ja1wiLCBcIlJlY2VudCBGaWxlc1wiXSxcbiAgICBjYWxlbmRhcjogW1wiY2FsZW5kYXItd2l0aC1jaGVja21hcmtcIiwgXCJDYWxlbmRhclwiXSxcbiAgICBlbXB0eTogW1wiY3Jvc3NcIiwgXCJObyBmaWxlXCJdXG59XG5cbmV4cG9ydCBjbGFzcyBOYXZpZ2F0b3IgZXh0ZW5kcyBDb21wb25lbnQge1xuXG4gICAgc3RhdGljIGhvdmVyU291cmNlID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LW1lbnVcIjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcCwga2luZCwgZGlyKSAge1xuICAgICAgICBzdXBlcigpO1xuICAgICAgICB0aGlzLmFwcCA9IGFwcDtcbiAgICAgICAgdGhpcy5raW5kID0ga2luZDtcbiAgICAgICAgdGhpcy5kaXIgPSBkaXI7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gZG9jdW1lbnQuYm9keS5maW5kKFxuICAgICAgICAgICAgYC50aXRsZWJhciAudGl0bGViYXItYnV0dG9uLWNvbnRhaW5lci5tb2QtbGVmdCAudGl0bGViYXItYnV0dG9uLm1vZC0ke3RoaXMua2luZH1gXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY291bnQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZVNwYW4oe3ByZXBlbmQ6IHRoaXMua2luZCA9PT0gXCJiYWNrXCIsIGNsczogXCJoaXN0b3J5LWNvdW50ZXJcIn0pO1xuICAgICAgICB0aGlzLmxlYWYgPSBudWxsO1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBudWxsO1xuICAgICAgICB0aGlzLnN0YXRlcyA9IFtdO1xuICAgICAgICB0aGlzLm9sZExhYmVsID0gdGhpcy5jb250YWluZXJFbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQodGhpcy5jb250YWluZXJFbCwgXCJjb250ZXh0bWVudVwiLCB0aGlzLm9wZW5NZW51LmJpbmQodGhpcykpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAodGhpcy5vbGRMYWJlbCk7XG4gICAgICAgIHRoaXMuY291bnQuZGV0YWNoKCk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzZXRDb3VudChudW0pIHsgdGhpcy5jb3VudC50ZXh0Q29udGVudCA9IG51bSB8fCBcIlwiOyB9XG5cbiAgICBzZXRUb29sdGlwKHRleHQpIHtcbiAgICAgICAgaWYgKHRleHQpIHRoaXMuY29udGFpbmVyRWwuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCB0ZXh0IHx8IHVuZGVmaW5lZCk7XG4gICAgICAgIGVsc2UgdGhpcy5jb250YWluZXJFbC5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgIH1cblxuICAgIHNldEhpc3RvcnkoaGlzdG9yeSkge1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBoaXN0b3J5O1xuICAgICAgICBjb25zdCBzdGF0ZXMgPSB0aGlzLnN0YXRlcyA9IGhpc3RvcnlbdGhpcy5kaXIgPCAwID8gXCJsb29rQmVoaW5kXCIgOiBcImxvb2tBaGVhZFwiXS5jYWxsKGhpc3RvcnkpO1xuICAgICAgICB0aGlzLnNldENvdW50KHN0YXRlcy5sZW5ndGgpO1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAoc3RhdGVzLmxlbmd0aCA/XG4gICAgICAgICAgICB0aGlzLm9sZExhYmVsICsgXCJcXG5cIiArIHRoaXMuZm9ybWF0U3RhdGUoc3RhdGVzWzBdKS50aXRsZSA6XG4gICAgICAgICAgICBgTm8gJHt0aGlzLmtpbmR9IGhpc3RvcnlgXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIHN0YXRlcy5sZW5ndGggPiAwKTtcbiAgICB9XG5cbiAgICBvcGVuTWVudShldnQpIHtcbiAgICAgICAgaWYgKCF0aGlzLnN0YXRlcy5sZW5ndGgpIHJldHVybjtcbiAgICAgICAgY29uc3QgbWVudSA9IGNyZWF0ZU1lbnUodGhpcy5hcHApO1xuICAgICAgICBtZW51LmRvbS5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tbGF5ZXItbWVudVwiLCAyOSk7XG4gICAgICAgIHRoaXMuc3RhdGVzLm1hcCh0aGlzLmZvcm1hdFN0YXRlLmJpbmQodGhpcykpLmZvckVhY2goXG4gICAgICAgICAgICAoaW5mbywgaWR4KSA9PiB0aGlzLm1lbnVJdGVtKGluZm8sIGlkeCwgbWVudSlcbiAgICAgICAgKTtcbiAgICAgICAgbWVudS5zaG93QXRQb3NpdGlvbih7eDogZXZ0LmNsaWVudFgsIHk6IGV2dC5jbGllbnRZICsgMjB9KTtcbiAgICB9XG5cbiAgICBtZW51SXRlbShpbmZvLCBpZHgsIG1lbnUpIHtcbiAgICAgICAgY29uc3QgbXkgPSB0aGlzO1xuICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiB7IGNyZWF0ZUl0ZW0oaSk7IGlmIChpbmZvLmZpbGUpIHNldHVwRmlsZUV2ZW50cyhpLmRvbSk7IH0pO1xuICAgICAgICByZXR1cm47XG5cbiAgICAgICAgZnVuY3Rpb24gY3JlYXRlSXRlbShpLCBwcmVmaXg9XCJcIikge1xuICAgICAgICAgICAgaS5zZXRJY29uKGluZm8uaWNvbikuc2V0VGl0bGUocHJlZml4ICsgaW5mby50aXRsZSkub25DbGljayhlID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgaGlzdG9yeSA9IG15Lmhpc3Rvcnk7XG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgZm9yIGN0cmwvY21kL21pZGRsZSBidXR0b24gYW5kIHNwbGl0IGxlYWYgKyBjb3B5IGhpc3RvcnlcbiAgICAgICAgICAgICAgICBpZiAoS2V5bWFwLmlzTW9kaWZpZXIoZSwgXCJNb2RcIikgfHwgMSA9PT0gZS5idXR0b24pIHtcbiAgICAgICAgICAgICAgICAgICAgaGlzdG9yeSA9IGhpc3RvcnkuY2xvbmVUbyhteS5hcHAud29ya3NwYWNlLnNwbGl0QWN0aXZlTGVhZigpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaGlzdG9yeS5nbygoaWR4KzEpICogbXkuZGlyLCB0cnVlKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gc2V0dXBGaWxlRXZlbnRzKGRvbSkge1xuICAgICAgICAgICAgLy8gSG92ZXIgcHJldmlld1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlb3ZlcicsIGUgPT4ge1xuICAgICAgICAgICAgICAgIG15LmFwcC53b3Jrc3BhY2UudHJpZ2dlcignaG92ZXItbGluaycsIHtcbiAgICAgICAgICAgICAgICAgICAgZXZlbnQ6IGUsIHNvdXJjZTogTmF2aWdhdG9yLmhvdmVyU291cmNlLFxuICAgICAgICAgICAgICAgICAgICBob3ZlclBhcmVudDogbWVudS5kb20sIHRhcmdldEVsOiBkb20sIGxpbmt0ZXh0OiBpbmZvLmZpbGUucGF0aFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIERyYWcgbWVudSBpdGVtIHRvIG1vdmUgb3IgbGluayBmaWxlXG4gICAgICAgICAgICBkb20uc2V0QXR0cignZHJhZ2dhYmxlJywgJ3RydWUnKTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBkcmFnTWFuYWdlciA9IG15LmFwcC5kcmFnTWFuYWdlcjtcbiAgICAgICAgICAgICAgICBjb25zdCBkcmFnRGF0YSA9IGRyYWdNYW5hZ2VyLmRyYWdGaWxlKGUsIGluZm8uZmlsZSk7XG4gICAgICAgICAgICAgICAgZHJhZ01hbmFnZXIub25EcmFnU3RhcnQoZSwgZHJhZ0RhdGEpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsIGUgPT4gbWVudS5oaWRlKCkpO1xuXG4gICAgICAgICAgICAvLyBGaWxlIG1lbnVcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKFwiY29udGV4dG1lbnVcIiwgZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVudSA9IGNyZWF0ZU1lbnUobXkuYXBwKTtcbiAgICAgICAgICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiBjcmVhdGVJdGVtKGksIGBHbyAke215LmtpbmR9IHRvIGApKS5hZGRTZXBhcmF0b3IoKTtcbiAgICAgICAgICAgICAgICBteS5hcHAud29ya3NwYWNlLnRyaWdnZXIoXG4gICAgICAgICAgICAgICAgICAgIFwiZmlsZS1tZW51XCIsIG1lbnUsIGluZm8uZmlsZSwgXCJsaW5rLWNvbnRleHQtbWVudVwiXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBtZW51LnNob3dBdFBvc2l0aW9uKHt4OiBlLmNsaWVudFgsIHk6IGUuY2xpZW50WX0pO1xuICAgICAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7IC8vIGtlZXAgdGhlIHBhcmVudCBtZW51IG9wZW4gZm9yIG5vd1xuICAgICAgICAgICAgfSwgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmb3JtYXRTdGF0ZShlbnRyeSkge1xuICAgICAgICBjb25zdCB7dmlld1N0YXRlOiB7dHlwZSwgc3RhdGV9LCBlU3RhdGUsIHBhdGh9ID0gZW50cnk7XG4gICAgICAgIGNvbnN0IGZpbGUgPSBwYXRoICYmIHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcbiAgICAgICAgY29uc3QgaW5mbyA9IHtpY29uOiBcIlwiLCB0aXRsZTogXCJcIiwgZmlsZSwgdHlwZSwgc3RhdGUsIGVTdGF0ZX07XG5cbiAgICAgICAgaWYgKG5vbkZpbGVWaWV3c1t0eXBlXSkge1xuICAgICAgICAgICAgW2luZm8uaWNvbiwgaW5mby50aXRsZV0gPSBub25GaWxlVmlld3NbdHlwZV07XG4gICAgICAgIH0gZWxzZSBpZiAocGF0aCAmJiAhZmlsZSkge1xuICAgICAgICAgICAgW2luZm8uaWNvbiwgaW5mby50aXRsZV0gPSBbXCJ0cmFzaFwiLCBcIk1pc3NpbmcgZmlsZSBcIitwYXRoXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGluZm8uaWNvbiA9IHZpZXd0eXBlSWNvbnNbdHlwZV0gPz8gXCJkb2N1bWVudFwiO1xuICAgICAgICAgICAgaWYgKHR5cGUgPT09IFwibWFya2Rvd25cIiAmJiBzdGF0ZS5tb2RlID09PSBcInByZXZpZXdcIikgaW5mby5pY29uID0gXCJsaW5lcy1vZi10ZXh0XCI7XG4gICAgICAgICAgICBpbmZvLnRpdGxlID0gZmlsZSA/IGZpbGUuYmFzZW5hbWUgKyAoZmlsZS5leHRlbnNpb24gIT09IFwibWRcIiA/IFwiLlwiK2ZpbGUuZXh0ZW5zaW9uIDogXCJcIikgOiBcIk5vIGZpbGVcIjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS50cmlnZ2VyKFwicGFuZS1yZWxpZWY6Zm9ybWF0LWhpc3RvcnktaXRlbVwiLCBpbmZvKTtcbiAgICAgICAgcmV0dXJuIGluZm87XG4gICAgfVxufVxuXG5mdW5jdGlvbiBvbkVsZW1lbnQoZWwsIGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpIHtcbiAgICBlbC5vbihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKVxuICAgIHJldHVybiAoKSA9PiBlbC5vZmYoZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucyk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1lbnUoYXBwKSB7XG4gICAgY29uc3QgbWVudSA9IG5ldyBNZW51KGFwcCk7XG4gICAgbWVudS5yZWdpc3RlcihcbiAgICAgICAgLy8gWFhYIHRoaXMgcmVhbGx5IHNob3VsZCBiZSBhIHNjb3BlIHB1c2hcbiAgICAgICAgb25FbGVtZW50KGRvY3VtZW50LCBcImtleWRvd25cIiwgXCIqXCIsIGUgPT4ge1xuICAgICAgICAgICAgaWYgKGUua2V5PT09XCJFc2NhcGVcIikge1xuICAgICAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICAgICAgICAgIG1lbnUuaGlkZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCB7Y2FwdHVyZTogdHJ1ZX0pXG4gICAgKTtcbiAgICByZXR1cm4gbWVudTtcbn0iLCJpbXBvcnQge01lbnUsIFBsdWdpbiwgVEZpbGV9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7YWRkQ29tbWFuZHMsIGNvbW1hbmR9IGZyb20gXCIuL2NvbW1hbmRzXCI7XG5pbXBvcnQge0hpc3RvcnksIGluc3RhbGxIaXN0b3J5fSBmcm9tIFwiLi9IaXN0b3J5XCI7XG5pbXBvcnQge05hdmlnYXRvcn0gZnJvbSBcIi4vTmF2aWdhdG9yXCI7XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBhbmVSZWxpZWYgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBpbnN0YWxsSGlzdG9yeSh0aGlzKTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKE5hdmlnYXRvci5ob3ZlclNvdXJjZSwge1xuICAgICAgICAgICAgZGlzcGxheTogJ0hpc3RvcnkgZHJvcGRvd25zJywgZGVmYXVsdE1vZDogdHJ1ZVxuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zZXR1cERpc3BsYXkoKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC52YXVsdC5vbihcInJlbmFtZVwiLCAoZmlsZSwgb2xkUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKFxuICAgICAgICAgICAgICAgICAgICBsZWFmID0+IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgKGxlYWYsIGhpc3RvcnkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAobGVhZiA9PT0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHRoaXMuZGlzcGxheShoaXN0b3J5KTtcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oXCJhY3RpdmUtbGVhZi1jaGFuZ2VcIiwgbGVhZiA9PiB0aGlzLmRpc3BsYXkoSGlzdG9yeS5mb3JMZWFmKGxlYWYpKSkpO1xuICAgICAgICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB0aGlzLmRpc3BsYXkoSGlzdG9yeS5mb3JMZWFmKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGFkZENvbW1hbmRzKHRoaXMsIHtcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1wcmV2XCIsIFwiU3dhcCBwYW5lIHdpdGggcHJldmlvdXMgaW4gc3BsaXRcIiwgIFwiTW9kK1NoaWZ0K1BhZ2VVcFwiKV0gICAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlcigtMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtbmV4dFwiLCBcIlN3YXAgcGFuZSB3aXRoIG5leHQgaW4gc3BsaXRcIiwgICAgICBcIk1vZCtTaGlmdCtQYWdlRG93blwiKV0gKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoIDEpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLXByZXZcIiwgIFwiQ3ljbGUgdG8gcHJldmlvdXMgd29ya3NwYWNlIHBhbmVcIiwgICBcIk1vZCtQYWdlVXBcIiAgKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigtMSwgdHJ1ZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLW5leHRcIiwgIFwiQ3ljbGUgdG8gbmV4dCB3b3Jrc3BhY2UgcGFuZVwiLCAgICAgICBcIk1vZCtQYWdlRG93blwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZiggMSwgdHJ1ZSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMXN0XCIsICAgXCJKdW1wIHRvIDFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTJuZFwiLCAgIFwiSnVtcCB0byAybmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0zcmRcIiwgICBcIkp1bXAgdG8gM3JkIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigyKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNHRoXCIsICAgXCJKdW1wIHRvIDR0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTV0aFwiLCAgIFwiSnVtcCB0byA1dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDQpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby02dGhcIiwgICBcIkp1bXAgdG8gNnRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig1KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tN3RoXCIsICAgXCJKdW1wIHRvIDd0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTh0aFwiLCAgIFwiSnVtcCB0byA4dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDcpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1sYXN0XCIsICBcIkp1bXAgdG8gbGFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgXCJBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig5OTk5OTk5OSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTFzdFwiLCAgXCJQbGFjZSBhcyAxc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigwLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0ybmRcIiwgIFwiUGxhY2UgYXMgMm5kIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtM3JkXCIsICBcIlBsYWNlIGFzIDNyZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDIsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTR0aFwiLCAgXCJQbGFjZSBhcyA0dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigzLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC01dGhcIiwgIFwiUGxhY2UgYXMgNXRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNnRoXCIsICBcIlBsYWNlIGFzIDZ0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDUsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTd0aFwiLCAgXCJQbGFjZSBhcyA3dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig2LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC04dGhcIiwgIFwiUGxhY2UgYXMgOHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtbGFzdFwiLCBcIlBsYWNlIGFzIGxhc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgXCJNb2QrQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDk5OTk5OTk5LCBmYWxzZSk7IH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc2V0dXBEaXNwbGF5KCkge1xuICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuYmFjayAgICA9IG5ldyBOYXZpZ2F0b3IodGhpcy5hcHAsIFwiYmFja1wiLCAtMSkpO1xuICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuZm9yd2FyZCA9IG5ldyBOYXZpZ2F0b3IodGhpcy5hcHAsIFwiZm9yd2FyZFwiLCAxKSk7XG4gICAgfVxuXG4gICAgZGlzcGxheShoaXN0b3J5KSB7XG4gICAgICAgIHRoaXMuYmFjay5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgICAgICB0aGlzLmZvcndhcmQuc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnVucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlKTtcbiAgICB9XG5cbiAgICBnb3RvTnRoTGVhZihuLCByZWxhdGl2ZSkge1xuICAgICAgICBjb25zdCBsZWF2ZXMgPSBbXTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVSb290TGVhdmVzKChsZWFmKSA9PiAobGVhdmVzLnB1c2gobGVhZiksIGZhbHNlKSk7XG4gICAgICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICAgICAgbiArPSBsZWF2ZXMuaW5kZXhPZih0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZik7XG4gICAgICAgICAgICBuID0gKG4gKyBsZWF2ZXMubGVuZ3RoKSAlIGxlYXZlcy5sZW5ndGg7ICAvLyB3cmFwIGFyb3VuZFxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGxlYWYgPSBsZWF2ZXNbbj49bGVhdmVzLmxlbmd0aCA/IGxlYXZlcy5sZW5ndGgtMSA6IG5dO1xuICAgICAgICAhbGVhZiB8fCB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCB0cnVlLCB0cnVlKTtcbiAgICB9XG5cbiAgICBwbGFjZUxlYWYodG9Qb3MsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgY2IgPSB0aGlzLmxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlKTtcbiAgICAgICAgaWYgKGNiKSBjYigpO1xuICAgIH1cblxuICAgIGxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmO1xuICAgICAgICBpZiAoIWxlYWYpIHJldHVybiBmYWxzZTtcblxuICAgICAgICBjb25zdFxuICAgICAgICAgICAgcGFyZW50U3BsaXQgPSBsZWFmLnBhcmVudFNwbGl0LFxuICAgICAgICAgICAgY2hpbGRyZW4gPSBwYXJlbnRTcGxpdC5jaGlsZHJlbixcbiAgICAgICAgICAgIGZyb21Qb3MgPSBjaGlsZHJlbi5pbmRleE9mKGxlYWYpXG4gICAgICAgIDtcbiAgICAgICAgaWYgKGZyb21Qb3MgPT0gLTEpIHJldHVybiBmYWxzZTtcblxuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIHRvUG9zICs9IGZyb21Qb3M7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwIHx8IHRvUG9zID49IGNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRvUG9zID49IGNoaWxkcmVuLmxlbmd0aCkgdG9Qb3MgPSBjaGlsZHJlbi5sZW5ndGggLSAxO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCkgdG9Qb3MgPSAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZyb21Qb3MgPT0gdG9Qb3MpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3RoZXIgPSBjaGlsZHJlblt0b1Bvc107XG4gICAgICAgICAgICBjaGlsZHJlbi5zcGxpY2UoZnJvbVBvcywgMSk7XG4gICAgICAgICAgICBjaGlsZHJlbi5zcGxpY2UodG9Qb3MsICAgMCwgbGVhZik7XG4gICAgICAgICAgICBpZiAocGFyZW50U3BsaXQuc2VsZWN0VGFiKSB7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQuc2VsZWN0VGFiKGxlYWYpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvdGhlci5jb250YWluZXJFbC5pbnNlcnRBZGphY2VudEVsZW1lbnQoZnJvbVBvcyA+IHRvUG9zID8gXCJiZWZvcmViZWdpblwiIDogXCJhZnRlcmVuZFwiLCBsZWFmLmNvbnRhaW5lckVsKTtcbiAgICAgICAgICAgICAgICBwYXJlbnRTcGxpdC5yZWNvbXB1dGVDaGlsZHJlbkRpbWVuc2lvbnMoKTtcbiAgICAgICAgICAgICAgICBsZWFmLm9uUmVzaXplKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0Q2hhbmdlKCk7XG5cbiAgICAgICAgICAgICAgICAvLyBGb3JjZSBmb2N1cyBiYWNrIHRvIHBhbmU7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5zZXRBY3RpdmVMZWFmKGxlYWYsIGZhbHNlLCB0cnVlKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG4iXSwibmFtZXMiOlsiTm90aWNlIiwiV29ya3NwYWNlTGVhZiIsIkNvbXBvbmVudCIsIktleW1hcCIsIk1lbnUiLCJQbHVnaW4iLCJURmlsZSJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBO0FBQ0E7QUFDQSxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEI7QUFDTyxTQUFTLE9BQU8sQ0FBQyxFQUFFLEVBQUUsSUFBSSxFQUFFLE9BQU8sQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRTtBQUN0RDtBQUNBO0FBQ0E7QUFDQSxJQUFJLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUSxFQUFFLE9BQU8sR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3pELElBQUksSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLEdBQUcsRUFBRSxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN4RTtBQUNBLElBQUksT0FBTyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxHQUFHLEVBQUU7QUFDeEM7QUFDQSxRQUFRLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxFQUFFLE9BQU8sR0FBRyxDQUFDO0FBQ2hEO0FBQ0EsUUFBUSxHQUFHLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUM7QUFDNUIsUUFBUSxPQUFPLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLEdBQUcsRUFBRTtBQUN4RCxLQUFLLENBQUMsQ0FBQztBQUNQLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDNUM7QUFDQTtBQUNBLElBQUksTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLE1BQU0sR0FBRyxFQUFFLENBQUMsQ0FBQztBQUNwQyxJQUFJLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUM7QUFDeEIsSUFBSSxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUM7QUFDRDtBQUNPLFNBQVMsV0FBVyxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUU7QUFDNUM7QUFDQSxJQUFJLE1BQU0sQ0FBQyxxQkFBcUIsQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxJQUFJO0FBQ3hELFFBQVEsTUFBTSxHQUFHLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLE1BQU0sR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDeEQsUUFBUSxJQUFJLEdBQUcsRUFBRSxNQUFNLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxFQUFFLEdBQUcsRUFBRTtBQUMxRCxZQUFZLGFBQWEsQ0FBQyxLQUFLLEVBQUU7QUFDakM7QUFDQSxnQkFBZ0IsTUFBTSxFQUFFLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUMvQztBQUNBO0FBQ0EsZ0JBQWdCLE9BQU8sQ0FBQyxLQUFLLElBQUksT0FBTyxFQUFFLEtBQUssVUFBVSxJQUFJLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDakYsYUFBYTtBQUNiLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDWixLQUFLLEVBQUM7QUFDTjs7QUN4Q08sU0FBUyxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRTtBQUN2QyxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFGLElBQUksT0FBTyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsWUFBWSxFQUFFLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQzdGLENBQUM7QUFDRCxTQUFTLE9BQU8sQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRTtBQUM3QyxJQUFJLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUN0RSxJQUFJLElBQUksT0FBTyxHQUFHLGFBQWEsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUMxQztBQUNBO0FBQ0EsSUFBSSxJQUFJLFFBQVE7QUFDaEIsUUFBUSxNQUFNLENBQUMsY0FBYyxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQztBQUNqRCxJQUFJLE1BQU0sQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQzVDLElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLE9BQU8sQ0FBQztBQUMxQjtBQUNBLElBQUksT0FBTyxNQUFNLENBQUM7QUFDbEIsSUFBSSxTQUFTLE9BQU8sQ0FBQyxHQUFHLElBQUksRUFBRTtBQUM5QjtBQUNBLFFBQVEsSUFBSSxPQUFPLEtBQUssUUFBUSxJQUFJLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxPQUFPO0FBQzNELFlBQVksTUFBTSxFQUFFLENBQUM7QUFDckIsUUFBUSxPQUFPLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ3pDLEtBQUs7QUFDTCxJQUFJLFNBQVMsTUFBTSxHQUFHO0FBQ3RCO0FBQ0EsUUFBUSxJQUFJLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxPQUFPLEVBQUU7QUFDckMsWUFBWSxJQUFJLE1BQU07QUFDdEIsZ0JBQWdCLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxRQUFRLENBQUM7QUFDdkM7QUFDQSxnQkFBZ0IsT0FBTyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDbkMsU0FBUztBQUNULFFBQVEsSUFBSSxPQUFPLEtBQUssUUFBUTtBQUNoQyxZQUFZLE9BQU87QUFDbkI7QUFDQSxRQUFRLE9BQU8sR0FBRyxRQUFRLENBQUM7QUFDM0IsUUFBUSxNQUFNLENBQUMsY0FBYyxDQUFDLE9BQU8sRUFBRSxRQUFRLElBQUksUUFBUSxDQUFDLENBQUM7QUFDN0QsS0FBSztBQUNMOztBQ2hDQSxNQUFNLFNBQVMsR0FBRyx3QkFBd0IsQ0FBQztBQUMzQyxNQUFNLFdBQVcsR0FBRyx3QkFBd0IsQ0FBQztBQU83QztBQUNBLE1BQU0sWUFBWSxDQUFDO0FBQ25CLElBQUksV0FBVyxDQUFDLFFBQVEsRUFBRTtBQUMxQixRQUFRLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDaEMsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsUUFBUSxFQUFFO0FBQ3ZCLFFBQVEsSUFBSSxDQUFDLEdBQUcsR0FBRyxRQUFRLENBQUM7QUFDNUIsUUFBUSxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsQ0FBQztBQUM1RCxRQUFRLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQyxDQUFDO0FBQzVELFFBQVEsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUM7QUFDL0MsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUM1QixRQUFRLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUU7QUFDbkMsWUFBWSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSTtBQUM3RCxZQUFZLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBQzVELFNBQVM7QUFDVCxLQUFLO0FBQ0w7QUFDQSxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUU7QUFDYixRQUFRLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQztBQUM3QyxRQUFRLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxJQUFJLEVBQUUsR0FBRyxFQUFFLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN4RSxRQUFRLElBQUksSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFO0FBQzNCLFlBQVksSUFBSUEsZUFBTSxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzlDLFlBQVksU0FBUyxHQUFHLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDbEQsWUFBWSxNQUFNLEdBQUcsU0FBUyxDQUFDO0FBQy9CLFNBQVM7QUFDVCxRQUFRLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxHQUFHLFNBQVMsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLENBQUMsRUFBRSxNQUFNLENBQUMsQ0FBQztBQUNoRixLQUFLO0FBQ0w7QUFDQSxJQUFJLFlBQVksQ0FBQyxRQUFRLEVBQUU7QUFDM0IsUUFBUSxJQUFJLFFBQVEsQ0FBQyxLQUFLLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUU7QUFDL0MsWUFBWSxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLENBQUM7QUFDakU7QUFDQSxZQUFZLElBQUksU0FBUyxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsT0FBTyxJQUFJLENBQUM7QUFDeEQ7QUFDQSxZQUFZLElBQUksSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFNBQVMsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLE9BQU8sS0FBSyxDQUFDO0FBQ2hGLFNBQVM7QUFDVCxRQUFRLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDaEMsUUFBUSxPQUFPLElBQUksQ0FBQztBQUNwQixLQUFLO0FBQ0wsQ0FBQztBQUNEO0FBQ08sTUFBTSxPQUFPLENBQUM7QUFDckIsSUFBSSxPQUFPLE9BQU8sQ0FBQyxHQUFHLEVBQUU7QUFDeEIsUUFBUSxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUMsSUFBSSxJQUFJLElBQUksRUFBRSxDQUFDO0FBQ3BFLEtBQUs7QUFDTDtBQUNBLElBQUksT0FBTyxPQUFPLENBQUMsSUFBSSxFQUFFO0FBQ3pCLFFBQVEsSUFBSSxJQUFJLEVBQUUsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksSUFBSTtBQUN4RCxZQUFZLElBQUksQ0FBQyxTQUFTLENBQUM7QUFDM0IsWUFBWSxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxTQUFTLEVBQUUsSUFBSSxTQUFTLENBQUMsQ0FBQztBQUN4RixLQUFLO0FBQ0w7QUFDQSxJQUFJLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxFQUFFLENBQUMsRUFBRTtBQUN4RCxRQUFRLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQ3pCLFFBQVEsSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7QUFDdkIsUUFBUSxJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLElBQUksWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDN0QsS0FBSztBQUNMO0FBQ0EsSUFBSSxPQUFPLENBQUMsSUFBSSxFQUFFO0FBQ2xCLFFBQVEsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsQ0FBQztBQUM5RSxLQUFLO0FBQ0w7QUFDQSxJQUFJLFFBQVEsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQzVCLFFBQVEsSUFBSSxNQUFNLFNBQVMsSUFBSSxJQUFJLENBQUMsS0FBSyxFQUFFLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQzdFLEtBQUs7QUFDTDtBQUNBLElBQUksU0FBUyxHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUM5RTtBQUNBLElBQUksSUFBSSxLQUFLLEdBQUcsRUFBRSxPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsRUFBRTtBQUM1RCxJQUFJLElBQUksTUFBTSxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFO0FBQzlDO0FBQ0EsSUFBSSxJQUFJLE1BQU0sRUFBRSxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUM5QixJQUFJLE9BQU8sR0FBRyxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUs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QUFDLE9BQU8sR0FBRyxPQUFPLENBQUM7QUFDL0IsUUFBUSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxZQUFZLEdBQUcsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3RHLFFBQVEsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDckMsUUFBUSxJQUFJLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxNQUFNO0FBQ3JDLFlBQVksSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLO0FBQ3BFLFlBQVksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7QUFDckMsU0FBUyxDQUFDO0FBQ1YsUUFBUSxJQUFJLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxZQUFZLEVBQUUsTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztBQUN0RSxLQUFLO0FBQ0w7QUFDQSxJQUFJLFFBQVEsQ0FBQyxHQUFHLEVBQUU7QUFDbEIsUUFBUSxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsT0FBTztBQUN4QyxRQUFRLE1BQU0sSUFBSSxHQUFHLFVBQVUsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDMUMsUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsY0FBYyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ3ZELFFBQVEsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPO0FBQzVELFlBQVksQ0FBQyxJQUFJLEVBQUUsR0FBRyxLQUFLLElBQUksQ0FBQyxRQUFR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QUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsb0NBQW9DLEVBQUUsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUU7QUFDaEk7QUFDQSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFP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
