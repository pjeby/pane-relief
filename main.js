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

    get state() { return this.stack[this.pos]?.raw || null; }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9OYXZpZ2F0b3IuanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmNvbnN0IGNvbW1hbmRzID0ge307XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kKGlkLCBuYW1lLCBob3RrZXlzPVtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgaG90a2V5cy5rZXkpIGhvdGtleXMgPSBbaG90a2V5c107XG5cbiAgICBob3RrZXlzID0gaG90a2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAga2V5ID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IGtleSwga2V5OiBrZXkucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kcyhwbHVnaW4sIGNtZHNldCkge1xuICAgIC8vIEV4dHJhY3QgY29tbWFuZCBzeW1ib2xzIGZyb20gY21kc2V0IGFuZCByZWdpc3RlciB0aGVtLCBib3VuZCB0byB0aGUgcGx1Z2luIGZvciBtZXRob2RzXG4gICAgT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scyhjbWRzZXQpLmZvckVhY2goc3ltID0+IHtcbiAgICAgICAgY29uc3QgY21kID0gY29tbWFuZHNbc3ltXSwgbWV0aG9kID0gY21kc2V0W3N5bV07XG4gICAgICAgIGlmIChjbWQpIHBsdWdpbi5hZGRDb21tYW5kKE9iamVjdC5hc3NpZ24oe30sIGNtZCwge1xuICAgICAgICAgICAgY2hlY2tDYWxsYmFjayhjaGVjaykge1xuICAgICAgICAgICAgICAgIC8vIENhbGwgdGhlIG1ldGhvZCBib2R5IHdpdGggdGhlIHBsdWdpbiBhcyAndGhpcydcbiAgICAgICAgICAgICAgICBjb25zdCBjYiA9IG1ldGhvZC5jYWxsKHBsdWdpbik7XG4gICAgICAgICAgICAgICAgLy8gSXQgdGhlbiByZXR1cm5zIGEgY2xvc3VyZSBpZiB0aGUgY29tbWFuZCBpcyByZWFkeSB0byBleGVjdXRlLCBhbmRcbiAgICAgICAgICAgICAgICAvLyB3ZSBjYWxsIHRoYXQgY2xvc3VyZSB1bmxlc3MgdGhpcyBpcyBqdXN0IGEgY2hlY2sgZm9yIGF2YWlsYWJpbGl0eVxuICAgICAgICAgICAgICAgIHJldHVybiAoY2hlY2sgfHwgdHlwZW9mIGNiICE9PSBcImZ1bmN0aW9uXCIpID8gISFjYiA6IChjYigpLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH0pXG59IiwiZXhwb3J0IGZ1bmN0aW9uIGFyb3VuZChvYmosIGZhY3Rvcmllcykge1xuICAgIGNvbnN0IHJlbW92ZXJzID0gT2JqZWN0LmtleXMoZmFjdG9yaWVzKS5tYXAoa2V5ID0+IGFyb3VuZDEob2JqLCBrZXksIGZhY3Rvcmllc1trZXldKSk7XG4gICAgcmV0dXJuIHJlbW92ZXJzLmxlbmd0aCA9PT0gMSA/IHJlbW92ZXJzWzBdIDogZnVuY3Rpb24gKCkgeyByZW1vdmVycy5mb3JFYWNoKHIgPT4gcigpKTsgfTtcbn1cbmZ1bmN0aW9uIGFyb3VuZDEob2JqLCBtZXRob2QsIGNyZWF0ZVdyYXBwZXIpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG9ialttZXRob2RdLCBoYWRPd24gPSBvYmouaGFzT3duUHJvcGVydHkobWV0aG9kKTtcbiAgICBsZXQgY3VycmVudCA9IGNyZWF0ZVdyYXBwZXIob3JpZ2luYWwpO1xuICAgIC8vIExldCBvdXIgd3JhcHBlciBpbmhlcml0IHN0YXRpYyBwcm9wcyBmcm9tIHRoZSB3cmFwcGluZyBtZXRob2QsXG4gICAgLy8gYW5kIHRoZSB3cmFwcGluZyBtZXRob2QsIHByb3BzIGZyb20gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgIGlmIChvcmlnaW5hbClcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGN1cnJlbnQsIG9yaWdpbmFsKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgY3VycmVudCk7XG4gICAgb2JqW21ldGhvZF0gPSB3cmFwcGVyO1xuICAgIC8vIFJldHVybiBhIGNhbGxiYWNrIHRvIGFsbG93IHNhZmUgcmVtb3ZhbFxuICAgIHJldHVybiByZW1vdmU7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBkZWFjdGl2YXRlZCBhbmQgYXJlIG5vIGxvbmdlciB3cmFwcGVkLCByZW1vdmUgb3Vyc2VsdmVzXG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbCAmJiBvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcilcbiAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICByZXR1cm4gY3VycmVudC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuICAgICAgICAvLyBJZiBubyBvdGhlciBwYXRjaGVzLCBqdXN0IGRvIGEgZGlyZWN0IHJlbW92YWxcbiAgICAgICAgaWYgKG9ialttZXRob2RdID09PSB3cmFwcGVyKSB7XG4gICAgICAgICAgICBpZiAoaGFkT3duKVxuICAgICAgICAgICAgICAgIG9ialttZXRob2RdID0gb3JpZ2luYWw7XG4gICAgICAgICAgICBlbHNlXG4gICAgICAgICAgICAgICAgZGVsZXRlIG9ialttZXRob2RdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbClcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgLy8gRWxzZSBwYXNzIGZ1dHVyZSBjYWxscyB0aHJvdWdoLCBhbmQgcmVtb3ZlIHdyYXBwZXIgZnJvbSB0aGUgcHJvdG90eXBlIGNoYWluXG4gICAgICAgIGN1cnJlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIG9yaWdpbmFsIHx8IEZ1bmN0aW9uKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXIocHJvbWlzZSwgY2IpIHtcbiAgICByZXR1cm4gcHJvbWlzZS50aGVuKGNiLCBjYik7XG59XG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplKGFzeW5jRnVuY3Rpb24pIHtcbiAgICBsZXQgbGFzdFJ1biA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4ge1xuICAgICAgICAgICAgYWZ0ZXIobGFzdFJ1biwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGFzeW5jRnVuY3Rpb24uYXBwbHkodGhpcywgYXJncykudGhlbihyZXMsIHJlaik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdyYXBwZXIuYWZ0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGFmdGVyKGxhc3RSdW4sIHJlcyk7IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHdyYXBwZXI7XG59XG4iLCJpbXBvcnQge05vdGljZSwgV29ya3NwYWNlTGVhZn0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmNvbnN0IEhJU1RfQVRUUiA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuY29uc3QgU0VSSUFMX1BST1AgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcblxuZnVuY3Rpb24gcGFyc2Uoc3RhdGUpIHtcbiAgICBpZiAodHlwZW9mIHN0YXRlLnN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5zdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGUuc3RhdGUpO1xuICAgIGlmICh0eXBlb2Ygc3RhdGUuZVN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5lU3RhdGUgPSBKU09OLnBhcnNlKHN0YXRlLmVTdGF0ZSk7XG4gICAgcmV0dXJuIHN0YXRlO1xufVxuXG5jbGFzcyBIaXN0b3J5RW50cnkge1xuICAgIGNvbnN0cnVjdG9yKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgIH1cblxuICAgIHNldFN0YXRlKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMucmF3ID0gcmF3U3RhdGU7XG4gICAgICAgIHRoaXMudmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICB0aGlzLmVTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuZVN0YXRlIHx8IFwibnVsbFwiKTtcbiAgICAgICAgdGhpcy5wYXRoID0gdGhpcy52aWV3U3RhdGUuc3RhdGU/LmZpbGU7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBpZiAodGhpcy5wYXRoID09PSBvbGRQYXRoKSB7XG4gICAgICAgICAgICB0aGlzLnBhdGggPSB0aGlzLnZpZXdTdGF0ZS5zdGF0ZS5maWxlID0gZmlsZS5wYXRoXG4gICAgICAgICAgICB0aGlzLnJhdy5zdGF0ZSA9IEpTT04uc3RyaW5naWZ5KHRoaXMudmlld1N0YXRlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvKGxlYWYpIHtcbiAgICAgICAgbGV0IHt2aWV3U3RhdGUsIHBhdGgsIGVTdGF0ZX0gPSB0aGlzO1xuICAgICAgICBsZXQgZmlsZSA9IHBhdGggJiYgbGVhZj8uYXBwPy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiTWlzc2luZyBmaWxlOiBcIitwYXRoKTtcbiAgICAgICAgICAgIHZpZXdTdGF0ZSA9IHt0eXBlOiBcImVtcHR5XCIsIHN0YXRlOnt9fTtcbiAgICAgICAgICAgIGVTdGF0ZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBsZWFmLnNldFZpZXdTdGF0ZSh7Li4udmlld1N0YXRlLCBhY3RpdmU6IHRydWUsIHBvcHN0YXRlOiB0cnVlfSwgZVN0YXRlKTtcbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGUpIHtcbiAgICAgICAgaWYgKHJhd1N0YXRlLnN0YXRlICE9PSB0aGlzLnJhdy5zdGF0ZSkge1xuICAgICAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgLy8gRG9uJ3QgcmVwbGFjZSBhIGZpbGUgd2l0aCBhbiBlbXB0eSBpbiB0aGUgaGlzdG9yeVxuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcImVtcHR5XCIpIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgLy8gRmlsZSBpcyBkaWZmZXJlbnQgZnJvbSBleGlzdGluZyBmaWxlOiBzaG91bGQgYmUgYSBwdXNoIGluc3RlYWRcbiAgICAgICAgICAgIGlmICh0aGlzLnBhdGggJiYgdGhpcy5wYXRoICE9PSB2aWV3U3RhdGU/LnN0YXRlPy5maWxlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICAgIHN0YXRpYyBjdXJyZW50KGFwcCkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgfHwgbmV3IHRoaXMoKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yTGVhZihsZWFmKSB7XG4gICAgICAgIGlmIChsZWFmKSByZXR1cm4gbGVhZltISVNUX0FUVFJdIGluc3RhbmNlb2YgdGhpcyA/XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gOlxuICAgICAgICAgICAgbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMobGVhZiwgbGVhZltISVNUX0FUVFJdPy5zZXJpYWxpemUoKSB8fCB1bmRlZmluZWQpO1xuICAgIH1cblxuICAgIGNvbnN0cnVjdG9yKGxlYWYsIHtwb3MsIHN0YWNrfSA9IHtwb3M6MCwgc3RhY2s6W119KSB7XG4gICAgICAgIHRoaXMubGVhZiA9IGxlYWY7XG4gICAgICAgIHRoaXMucG9zID0gcG9zO1xuICAgICAgICB0aGlzLnN0YWNrID0gc3RhY2subWFwKHJhdyA9PiBuZXcgSGlzdG9yeUVudHJ5KHJhdykpO1xuICAgIH1cblxuICAgIGNsb25lVG8obGVhZikge1xuICAgICAgICByZXR1cm4gbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMuY29uc3RydWN0b3IobGVhZiwgdGhpcy5zZXJpYWxpemUoKSk7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBmb3IoY29uc3QgaGlzdEVudHJ5IG9mIHRoaXMuc3RhY2spIGhpc3RFbnRyeS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKTtcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2subWFwKGUgPT4gZS5yYXcpfTsgfVxuXG4gICAgZ2V0IHN0YXRlKCkgeyByZXR1cm4gdGhpcy5zdGFja1t0aGlzLnBvc10/LnJhdyB8fCBudWxsOyB9XG4gICAgZ2V0IGxlbmd0aCgpIHsgcmV0dXJuIHRoaXMuc3RhY2subGVuZ3RoOyB9XG5cbiAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfVxuICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9XG5cbiAgICBsb29rQWhlYWQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKDAsIHRoaXMucG9zKS5yZXZlcnNlKCk7IH1cbiAgICBsb29rQmVoaW5kKCkgeyByZXR1cm4gdGhpcy5zdGFjay5zbGljZSh0aGlzLnBvcysxKTsgfVxuXG4gICAgZ290byhwb3MpIHtcbiAgICAgICAgaWYgKCF0aGlzLmxlYWYpIHJldHVybjtcbiAgICAgICAgaWYgKHRoaXMubGVhZi5waW5uZWQpIHJldHVybiBuZXcgTm90aWNlKFwiUGlubmVkIHBhbmU6IHVucGluIGJlZm9yZSBnb2luZyBmb3J3YXJkIG9yIGJhY2tcIiksIHVuZGVmaW5lZDtcbiAgICAgICAgcG9zID0gdGhpcy5wb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihwb3MsIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICB0aGlzLnN0YWNrW3Bvc10/LmdvKHRoaXMubGVhZik7XG4gICAgICAgIHRoaXMubGVhZi5hcHA/LndvcmtzcGFjZT8udHJpZ2dlcihcInBhbmUtcmVsaWVmOnVwZGF0ZS1oaXN0b3J5XCIsIHRoaXMubGVhZiwgdGhpcyk7XG4gICAgfVxuXG4gICAgZ28oYnksIGZvcmNlKSB7XG4gICAgICAgIGlmICghdGhpcy5sZWFmIHx8ICFieSkgcmV0dXJuOyAgLy8gbm8tb3BcbiAgICAgICAgLy8gcHJldmVudCB3cmFwYXJvdW5kXG4gICAgICAgIGNvbnN0IG5ld1BvcyA9IE1hdGgubWF4KDAsIE1hdGgubWluKHRoaXMucG9zIC0gYnksIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICBpZiAoZm9yY2UgfHwgbmV3UG9zICE9PSB0aGlzLnBvcykge1xuICAgICAgICAgICAgdGhpcy5nb3RvKG5ld1Bvcyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBObyBtb3JlICR7YnkgPCAwID8gXCJiYWNrXCIgOiBcImZvcndhcmRcIn0gaGlzdG9yeSBmb3IgcGFuZWApO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVwbGFjZVN0YXRlKHJhd1N0YXRlLCB0aXRsZSwgdXJsKXtcbiAgICAgICAgY29uc3QgZW50cnkgPSB0aGlzLnN0YWNrW3RoaXMucG9zXTtcbiAgICAgICAgaWYgKCFlbnRyeSkge1xuICAgICAgICAgICAgdGhpcy5zdGFja1t0aGlzLnBvc10gPSBuZXcgSGlzdG9yeUVudHJ5KHJhd1N0YXRlKTtcbiAgICAgICAgfSBlbHNlIGlmICghZW50cnkucmVwbGFjZVN0YXRlKHJhd1N0YXRlKSkge1xuICAgICAgICAgICAgLy8gcmVwbGFjZVN0YXRlIHdhcyBlcnJvbmVvdXNseSBjYWxsZWQgd2l0aCBhIG5ldyBmaWxlIGZvciB0aGUgc2FtZSBsZWFmO1xuICAgICAgICAgICAgLy8gZm9yY2UgYSBwdXNoU3RhdGUgaW5zdGVhZCAoZml4ZXMgdGhlIGlzc3VlIHJlcG9ydGVkIGhlcmU6IGh0dHBzOi8vZm9ydW0ub2JzaWRpYW4ubWQvdC8xODUxOClcbiAgICAgICAgICAgIHRoaXMucHVzaFN0YXRlKHJhd1N0YXRlLCB0aXRsZSwgdXJsKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHB1c2hTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCkgICB7XG4gICAgICAgIGNvbnNvbGUubG9nKFwicHVzaGluZ1wiLCByYXdTdGF0ZSlcbiAgICAgICAgdGhpcy5zdGFjay5zcGxpY2UoMCwgdGhpcy5wb3MsIG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpKTtcbiAgICAgICAgdGhpcy5wb3MgPSAwO1xuICAgICAgICAvLyBMaW1pdCBcImJhY2tcIiB0byAyMFxuICAgICAgICB3aGlsZSAodGhpcy5zdGFjay5sZW5ndGggPiAyMCkgdGhpcy5zdGFjay5wb3AoKTtcbiAgICAgICAgdGhpcy5sZWFmLmFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKVxuICAgIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxIaXN0b3J5KHBsdWdpbikge1xuXG4gICAgY29uc3QgYXBwID0gcGx1Z2luLmFwcDtcblxuICAgIC8vIE1vbmtleXBhdGNoOiBpbmNsdWRlIGhpc3RvcnkgaW4gbGVhZiBzZXJpYWxpemF0aW9uIChzbyBpdCdzIHBlcnNpc3RlZCB3aXRoIHRoZSB3b3Jrc3BhY2UpXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChXb3Jrc3BhY2VMZWFmLnByb3RvdHlwZSwge1xuICAgICAgICBzZXJpYWxpemUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXJpYWxpemUoKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgaWYgKHRoaXNbSElTVF9BVFRSXSkgcmVzdWx0W1NFUklBTF9QUk9QXSA9IHRoaXNbSElTVF9BVFRSXS5zZXJpYWxpemUoKTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19XG4gICAgfSkpO1xuXG4gICAgLy8gTW9ua2V5cGF0Y2g6IGxvYWQgaGlzdG9yeSBkdXJpbmcgbGVhZiBsb2FkLCBpZiBwcmVzZW50XG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChhcHAud29ya3NwYWNlLCB7XG4gICAgICAgIGRlc2VyaWFsaXplTGF5b3V0KG9sZCkgeyByZXR1cm4gYXN5bmMgZnVuY3Rpb24gZGVzZXJpYWxpemVMYXlvdXQoc3RhdGUsIC4uLmV0Yyl7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBvbGQuY2FsbCh0aGlzLCBzdGF0ZSwgLi4uZXRjKTtcbiAgICAgICAgICAgIGlmIChzdGF0ZS50eXBlID09PSBcImxlYWZcIikge1xuICAgICAgICAgICAgICAgIGlmIChzdGF0ZVtTRVJJQUxfUFJPUF0pIHJlc3VsdFtISVNUX0FUVFJdID0gbmV3IEhpc3RvcnkocmVzdWx0LCBzdGF0ZVtTRVJJQUxfUFJPUF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX1cbiAgICB9KSk7XG5cbiAgICAvLyBPdmVycmlkZSBkZWZhdWx0IG1vdXNlIGhpc3RvcnkgYmVoYXZpb3IuICBXZSBuZWVkIHRoaXMgYmVjYXVzZSAxKSBFbGVjdHJvbiB3aWxsIHVzZSB0aGUgYnVpbHQtaW5cbiAgICAvLyBoaXN0b3J5IG9iamVjdCBpZiB3ZSBkb24ndCAoaW5zdGVhZCBvZiBvdXIgd3JhcHBlciksIGFuZCAyKSB3ZSB3YW50IHRoZSBjbGljayB0byBhcHBseSB0byB0aGUgbGVhZlxuICAgIC8vIHRoYXQgd2FzIHVuZGVyIHRoZSBtb3VzZSwgcmF0aGVyIHRoYW4gd2hpY2hldmVyIGxlYWYgd2FzIGFjdGl2ZS5cbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpO1xuICAgIHBsdWdpbi5yZWdpc3RlciggKCkgPT4gd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKSApO1xuICAgIGZ1bmN0aW9uIGhpc3RvcnlIYW5kbGVyKGUpIHtcbiAgICAgICAgaWYgKGUuYnV0dG9uICE9PSAzICYmIGUuYnV0dG9uICE9PSA0KSByZXR1cm47XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgIC8vIHByZXZlbnQgZGVmYXVsdCBiZWhhdmlvclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldC5tYXRjaFBhcmVudChcIi53b3Jrc3BhY2UtbGVhZlwiKTtcbiAgICAgICAgaWYgKHRhcmdldCkge1xuICAgICAgICAgICAgbGV0IGxlYWY7XG4gICAgICAgICAgICBhcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMobCA9PiBsZWFmID0gKGwuY29udGFpbmVyRWwgPT09IHRhcmdldCkgPyBsIDogbGVhZik7XG4gICAgICAgICAgICBpZiAoZS5idXR0b24gPT0gMykgeyBIaXN0b3J5LmZvckxlYWYobGVhZikuYmFjaygpOyB9XG4gICAgICAgICAgICBpZiAoZS5idXR0b24gPT0gNCkgeyBIaXN0b3J5LmZvckxlYWYobGVhZikuZm9yd2FyZCgpOyB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIFByb3h5IHRoZSB3aW5kb3cgaGlzdG9yeSB3aXRoIGEgd3JhcHBlciB0aGF0IGRlbGVnYXRlcyB0byB0aGUgYWN0aXZlIGxlYWYncyBIaXN0b3J5IG9iamVjdCxcbiAgICBjb25zdCByZWFsSGlzdG9yeSA9IHdpbmRvdy5oaXN0b3J5O1xuICAgIHBsdWdpbi5yZWdpc3RlcigoKSA9PiB3aW5kb3cuaGlzdG9yeSA9IHJlYWxIaXN0b3J5KTtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCBcImhpc3RvcnlcIiwgeyBlbnVtZXJhYmxlOiB0cnVlLCBjb25maWd1cmFibGU6IHRydWUsIHdyaXRhYmxlOiB0cnVlLCB2YWx1ZToge1xuICAgICAgICBnZXQgc3RhdGUoKSAgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudChhcHApLnN0YXRlOyB9LFxuICAgICAgICBnZXQgbGVuZ3RoKCkgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudChhcHApLmxlbmd0aDsgfSxcblxuICAgICAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfSxcbiAgICAgICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH0sXG4gICAgICAgIGdvKGJ5KSAgICB7IEhpc3RvcnkuY3VycmVudChhcHApLmdvKGJ5KTsgfSxcblxuICAgICAgICByZXBsYWNlU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5yZXBsYWNlU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpOyB9LFxuICAgICAgICBwdXNoU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpICAgeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5wdXNoU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpOyB9LFxuXG4gICAgICAgIGdldCBzY3JvbGxSZXN0b3JhdGlvbigpICAgIHsgcmV0dXJuIHJlYWxIaXN0b3J5LnNjcm9sbFJlc3RvcmF0aW9uOyB9LFxuICAgICAgICBzZXQgc2Nyb2xsUmVzdG9yYXRpb24odmFsKSB7IHJlYWxIaXN0b3J5LnNjcm9sbFJlc3RvcmF0aW9uID0gdmFsOyB9LFxuICAgIH19KTtcblxufVxuIiwiaW1wb3J0IHtNZW51LCBLZXltYXAsIENvbXBvbmVudH0gZnJvbSAnb2JzaWRpYW4nO1xuXG5jb25zdCB2aWV3dHlwZUljb25zID0ge1xuICAgIG1hcmtkb3duOiBcImRvY3VtZW50XCIsXG4gICAgaW1hZ2U6IFwiaW1hZ2UtZmlsZVwiLFxuICAgIGF1ZGlvOiBcImF1ZGlvLWZpbGVcIixcbiAgICBwZGY6IFwicGRmLWZpbGVcIixcbiAgICBsb2NhbGdyYXBoOiBcImRvdC1uZXR3b3JrXCIsXG4gICAgb3V0bGluZTogXCJidWxsZXQtbGlzdFwiLFxuICAgIGJhY2tsaW5rOiBcImxpbmtcIixcblxuICAgIC8vIHRoaXJkLXBhcnR5IHBsdWdpbnNcbiAgICBrYW5iYW46IFwiYmxvY2tzXCIsXG4gICAgZXhjYWxpZHJhdzogXCJleGNhbGlkcmF3LWljb25cIixcbn1cblxuY29uc3Qgbm9uRmlsZVZpZXdzID0ge1xuICAgIGdyYXBoOiBbXCJkb3QtbmV0d29ya1wiLCBcIkdyYXBoIFZpZXdcIl0sXG4gICAgXCJmaWxlLWV4cGxvcmVyXCI6IFtcImZvbGRlclwiLCBcIkZpbGUgRXhwbG9yZXJcIl0sXG4gICAgc3RhcnJlZDogW1wic3RhclwiLCBcIlN0YXJyZWQgRmlsZXNcIl0sXG4gICAgdGFnOiBbXCJ0YWdcIiwgXCJUYWdzIFZpZXdcIl0sXG5cbiAgICAvLyB0aGlyZC1wYXJ0eSBwbHVnaW5zXG4gICAgXCJyZWNlbnQtZmlsZXNcIjogW1wiY2xvY2tcIiwgXCJSZWNlbnQgRmlsZXNcIl0sXG4gICAgY2FsZW5kYXI6IFtcImNhbGVuZGFyLXdpdGgtY2hlY2ttYXJrXCIsIFwiQ2FsZW5kYXJcIl0sXG4gICAgZW1wdHk6IFtcImNyb3NzXCIsIFwiTm8gZmlsZVwiXVxufVxuXG5leHBvcnQgY2xhc3MgTmF2aWdhdG9yIGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIHN0YXRpYyBob3ZlclNvdXJjZSA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS1tZW51XCI7XG5cbiAgICBjb25zdHJ1Y3RvcihhcHAsIGtpbmQsIGRpcikgIHtcbiAgICAgICAgc3VwZXIoKTtcbiAgICAgICAgdGhpcy5hcHAgPSBhcHA7XG4gICAgICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgICAgIHRoaXMuZGlyID0gZGlyO1xuICAgIH1cblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgdGhpcy5jb250YWluZXJFbCA9IGRvY3VtZW50LmJvZHkuZmluZChcbiAgICAgICAgICAgIGAudGl0bGViYXIgLnRpdGxlYmFyLWJ1dHRvbi1jb250YWluZXIubW9kLWxlZnQgLnRpdGxlYmFyLWJ1dHRvbi5tb2QtJHt0aGlzLmtpbmR9YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvdW50ID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVTcGFuKHtwcmVwZW5kOiB0aGlzLmtpbmQgPT09IFwiYmFja1wiLCBjbHM6IFwiaGlzdG9yeS1jb3VudGVyXCJ9KTtcbiAgICAgICAgdGhpcy5sZWFmID0gbnVsbDtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gbnVsbDtcbiAgICAgICAgdGhpcy5zdGF0ZXMgPSBbXTtcbiAgICAgICAgdGhpcy5vbGRMYWJlbCA9IHRoaXMuY29udGFpbmVyRWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckRvbUV2ZW50KHRoaXMuY29udGFpbmVyRWwsIFwiY29udGV4dG1lbnVcIiwgdGhpcy5vcGVuTWVudS5iaW5kKHRoaXMpKTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHRoaXMub2xkTGFiZWwpO1xuICAgICAgICB0aGlzLmNvdW50LmRldGFjaCgpO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc2V0Q291bnQobnVtKSB7IHRoaXMuY291bnQudGV4dENvbnRlbnQgPSBudW0gfHwgXCJcIjsgfVxuXG4gICAgc2V0VG9vbHRpcCh0ZXh0KSB7XG4gICAgICAgIGlmICh0ZXh0KSB0aGlzLmNvbnRhaW5lckVsLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdGV4dCB8fCB1bmRlZmluZWQpO1xuICAgICAgICBlbHNlIHRoaXMuY29udGFpbmVyRWwucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICB9XG5cbiAgICBzZXRIaXN0b3J5KGhpc3RvcnkpIHtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gaGlzdG9yeTtcbiAgICAgICAgY29uc3Qgc3RhdGVzID0gdGhpcy5zdGF0ZXMgPSBoaXN0b3J5W3RoaXMuZGlyIDwgMCA/IFwibG9va0JlaGluZFwiIDogXCJsb29rQWhlYWRcIl0uY2FsbChoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5zZXRDb3VudChzdGF0ZXMubGVuZ3RoKTtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHN0YXRlcy5sZW5ndGggP1xuICAgICAgICAgICAgdGhpcy5vbGRMYWJlbCArIFwiXFxuXCIgKyB0aGlzLmZvcm1hdFN0YXRlKHN0YXRlc1swXSkudGl0bGUgOlxuICAgICAgICAgICAgYE5vICR7dGhpcy5raW5kfSBoaXN0b3J5YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBzdGF0ZXMubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgb3Blbk1lbnUoZXZ0KSB7XG4gICAgICAgIGlmICghdGhpcy5zdGF0ZXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIGNvbnN0IG1lbnUgPSBjcmVhdGVNZW51KHRoaXMuYXBwKTtcbiAgICAgICAgbWVudS5kb20uc3R5bGUuc2V0UHJvcGVydHkoXCItLWxheWVyLW1lbnVcIiwgMjkpO1xuICAgICAgICB0aGlzLnN0YXRlcy5tYXAodGhpcy5mb3JtYXRTdGF0ZS5iaW5kKHRoaXMpKS5mb3JFYWNoKFxuICAgICAgICAgICAgKGluZm8sIGlkeCkgPT4gdGhpcy5tZW51SXRlbShpbmZvLCBpZHgsIG1lbnUpXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGV2dC5jbGllbnRYLCB5OiBldnQuY2xpZW50WSArIDIwfSk7XG4gICAgfVxuXG4gICAgbWVudUl0ZW0oaW5mbywgaWR4LCBtZW51KSB7XG4gICAgICAgIGNvbnN0IG15ID0gdGhpcztcbiAgICAgICAgbWVudS5hZGRJdGVtKGkgPT4geyBjcmVhdGVJdGVtKGkpOyBpZiAoaW5mby5maWxlKSBzZXR1cEZpbGVFdmVudHMoaS5kb20pOyB9KTtcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAgIGZ1bmN0aW9uIGNyZWF0ZUl0ZW0oaSwgcHJlZml4PVwiXCIpIHtcbiAgICAgICAgICAgIGkuc2V0SWNvbihpbmZvLmljb24pLnNldFRpdGxlKHByZWZpeCArIGluZm8udGl0bGUpLm9uQ2xpY2soZSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGhpc3RvcnkgPSBteS5oaXN0b3J5O1xuICAgICAgICAgICAgICAgIC8vIENoZWNrIGZvciBjdHJsL2NtZC9taWRkbGUgYnV0dG9uIGFuZCBzcGxpdCBsZWFmICsgY29weSBoaXN0b3J5XG4gICAgICAgICAgICAgICAgaWYgKEtleW1hcC5pc01vZGlmaWVyKGUsIFwiTW9kXCIpIHx8IDEgPT09IGUuYnV0dG9uKSB7XG4gICAgICAgICAgICAgICAgICAgIGhpc3RvcnkgPSBoaXN0b3J5LmNsb25lVG8obXkuYXBwLndvcmtzcGFjZS5zcGxpdEFjdGl2ZUxlYWYoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGhpc3RvcnkuZ28oKGlkeCsxKSAqIG15LmRpciwgdHJ1ZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwRmlsZUV2ZW50cyhkb20pIHtcbiAgICAgICAgICAgIC8vIEhvdmVyIHByZXZpZXdcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW92ZXInLCBlID0+IHtcbiAgICAgICAgICAgICAgICBteS5hcHAud29ya3NwYWNlLnRyaWdnZXIoJ2hvdmVyLWxpbmsnLCB7XG4gICAgICAgICAgICAgICAgICAgIGV2ZW50OiBlLCBzb3VyY2U6IE5hdmlnYXRvci5ob3ZlclNvdXJjZSxcbiAgICAgICAgICAgICAgICAgICAgaG92ZXJQYXJlbnQ6IG1lbnUuZG9tLCB0YXJnZXRFbDogZG9tLCBsaW5rdGV4dDogaW5mby5maWxlLnBhdGhcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBEcmFnIG1lbnUgaXRlbSB0byBtb3ZlIG9yIGxpbmsgZmlsZVxuICAgICAgICAgICAgZG9tLnNldEF0dHIoJ2RyYWdnYWJsZScsICd0cnVlJyk7XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgZHJhZ01hbmFnZXIgPSBteS5hcHAuZHJhZ01hbmFnZXI7XG4gICAgICAgICAgICAgICAgY29uc3QgZHJhZ0RhdGEgPSBkcmFnTWFuYWdlci5kcmFnRmlsZShlLCBpbmZvLmZpbGUpO1xuICAgICAgICAgICAgICAgIGRyYWdNYW5hZ2VyLm9uRHJhZ1N0YXJ0KGUsIGRyYWdEYXRhKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdlbmQnLCBlID0+IG1lbnUuaGlkZSgpKTtcblxuICAgICAgICAgICAgLy8gRmlsZSBtZW51XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcihcImNvbnRleHRtZW51XCIsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IG1lbnUgPSBjcmVhdGVNZW51KG15LmFwcCk7XG4gICAgICAgICAgICAgICAgbWVudS5hZGRJdGVtKGkgPT4gY3JlYXRlSXRlbShpLCBgR28gJHtteS5raW5kfSB0byBgKSkuYWRkU2VwYXJhdG9yKCk7XG4gICAgICAgICAgICAgICAgbXkuYXBwLndvcmtzcGFjZS50cmlnZ2VyKFxuICAgICAgICAgICAgICAgICAgICBcImZpbGUtbWVudVwiLCBtZW51LCBpbmZvLmZpbGUsIFwibGluay1jb250ZXh0LW1lbnVcIlxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgbWVudS5zaG93QXRQb3NpdGlvbih7eDogZS5jbGllbnRYLCB5OiBlLmNsaWVudFl9KTtcbiAgICAgICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOyAvLyBrZWVwIHRoZSBwYXJlbnQgbWVudSBvcGVuIGZvciBub3dcbiAgICAgICAgICAgIH0sIHRydWUpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZm9ybWF0U3RhdGUoZW50cnkpIHtcbiAgICAgICAgY29uc3Qge3ZpZXdTdGF0ZToge3R5cGUsIHN0YXRlfSwgZVN0YXRlLCBwYXRofSA9IGVudHJ5O1xuICAgICAgICBjb25zdCBmaWxlID0gcGF0aCAmJiB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGNvbnN0IGluZm8gPSB7aWNvbjogXCJcIiwgdGl0bGU6IFwiXCIsIGZpbGUsIHR5cGUsIHN0YXRlLCBlU3RhdGV9O1xuXG4gICAgICAgIGlmIChub25GaWxlVmlld3NbdHlwZV0pIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gbm9uRmlsZVZpZXdzW3R5cGVdO1xuICAgICAgICB9IGVsc2UgaWYgKHBhdGggJiYgIWZpbGUpIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gW1widHJhc2hcIiwgXCJNaXNzaW5nIGZpbGUgXCIrcGF0aF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpbmZvLmljb24gPSB2aWV3dHlwZUljb25zW3R5cGVdID8/IFwiZG9jdW1lbnRcIjtcbiAgICAgICAgICAgIGlmICh0eXBlID09PSBcIm1hcmtkb3duXCIgJiYgc3RhdGUubW9kZSA9PT0gXCJwcmV2aWV3XCIpIGluZm8uaWNvbiA9IFwibGluZXMtb2YtdGV4dFwiO1xuICAgICAgICAgICAgaW5mby50aXRsZSA9IGZpbGUgPyBmaWxlLmJhc2VuYW1lICsgKGZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIgPyBcIi5cIitmaWxlLmV4dGVuc2lvbiA6IFwiXCIpIDogXCJObyBmaWxlXCI7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UudHJpZ2dlcihcInBhbmUtcmVsaWVmOmZvcm1hdC1oaXN0b3J5LWl0ZW1cIiwgaW5mbyk7XG4gICAgICAgIHJldHVybiBpbmZvO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gb25FbGVtZW50KGVsLCBldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKSB7XG4gICAgZWwub24oZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucylcbiAgICByZXR1cm4gKCkgPT4gZWwub2ZmKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNZW51KGFwcCkge1xuICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudShhcHApO1xuICAgIG1lbnUucmVnaXN0ZXIoXG4gICAgICAgIC8vIFhYWCB0aGlzIHJlYWxseSBzaG91bGQgYmUgYSBzY29wZSBwdXNoXG4gICAgICAgIG9uRWxlbWVudChkb2N1bWVudCwgXCJrZXlkb3duXCIsIFwiKlwiLCBlID0+IHtcbiAgICAgICAgICAgIGlmIChlLmtleT09PVwiRXNjYXBlXCIpIHtcbiAgICAgICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgICAgICBtZW51LmhpZGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwge2NhcHR1cmU6IHRydWV9KVxuICAgICk7XG4gICAgcmV0dXJuIG1lbnU7XG59IiwiaW1wb3J0IHtNZW51LCBQbHVnaW4sIFRGaWxlfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2FkZENvbW1hbmRzLCBjb21tYW5kfSBmcm9tIFwiLi9jb21tYW5kc1wiO1xuaW1wb3J0IHtIaXN0b3J5LCBpbnN0YWxsSGlzdG9yeX0gZnJvbSBcIi4vSGlzdG9yeVwiO1xuaW1wb3J0IHtOYXZpZ2F0b3J9IGZyb20gXCIuL05hdmlnYXRvclwiO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBQYW5lUmVsaWVmIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgaW5zdGFsbEhpc3RvcnkodGhpcyk7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5yZWdpc3RlckhvdmVyTGlua1NvdXJjZShOYXZpZ2F0b3IuaG92ZXJTb3VyY2UsIHtcbiAgICAgICAgICAgIGRpc3BsYXk6ICdIaXN0b3J5IGRyb3Bkb3ducycsIGRlZmF1bHRNb2Q6IHRydWVcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuc2V0dXBEaXNwbGF5KCk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAudmF1bHQub24oXCJyZW5hbWVcIiwgKGZpbGUsIG9sZFBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcyhcbiAgICAgICAgICAgICAgICAgICAgbGVhZiA9PiBIaXN0b3J5LmZvckxlYWYobGVhZikub25SZW5hbWUoZmlsZSwgb2xkUGF0aClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLndvcmtzcGFjZS5vbihcInBhbmUtcmVsaWVmOnVwZGF0ZS1oaXN0b3J5XCIsIChsZWFmLCBoaXN0b3J5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGxlYWYgPT09IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB0aGlzLmRpc3BsYXkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwiYWN0aXZlLWxlYWYtY2hhbmdlXCIsIGxlYWYgPT4gdGhpcy5kaXNwbGF5KEhpc3RvcnkuZm9yTGVhZihsZWFmKSkpKTtcbiAgICAgICAgICAgIGlmICh0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgdGhpcy5kaXNwbGF5KEhpc3RvcnkuZm9yTGVhZih0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikpO1xuICAgICAgICB9KTtcblxuICAgICAgICBhZGRDb21tYW5kcyh0aGlzLCB7XG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtcHJldlwiLCBcIlN3YXAgcGFuZSB3aXRoIHByZXZpb3VzIGluIHNwbGl0XCIsICBcIk1vZCtTaGlmdCtQYWdlVXBcIildICAgKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoLTEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLW5leHRcIiwgXCJTd2FwIHBhbmUgd2l0aCBuZXh0IGluIHNwbGl0XCIsICAgICAgXCJNb2QrU2hpZnQrUGFnZURvd25cIildICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKCAxKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1wcmV2XCIsICBcIkN5Y2xlIHRvIHByZXZpb3VzIHdvcmtzcGFjZSBwYW5lXCIsICAgXCJNb2QrUGFnZVVwXCIgICldICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoLTEsIHRydWUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1uZXh0XCIsICBcIkN5Y2xlIHRvIG5leHQgd29ya3NwYWNlIHBhbmVcIiwgICAgICAgXCJNb2QrUGFnZURvd25cIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoIDEsIHRydWUpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTFzdFwiLCAgIFwiSnVtcCB0byAxc3QgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDApOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0ybmRcIiwgICBcIkp1bXAgdG8gMm5kIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigxKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tM3JkXCIsICAgXCJKdW1wIHRvIDNyZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTR0aFwiLCAgIFwiSnVtcCB0byA0dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDMpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby01dGhcIiwgICBcIkp1bXAgdG8gNXRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig0KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNnRoXCIsICAgXCJKdW1wIHRvIDZ0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTd0aFwiLCAgIFwiSnVtcCB0byA3dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDYpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby04dGhcIiwgICBcIkp1bXAgdG8gOHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig3KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbGFzdFwiLCAgXCJKdW1wIHRvIGxhc3QgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsIFwiQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoOTk5OTk5OTkpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0xc3RcIiwgIFwiUGxhY2UgYXMgMXN0IHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMm5kXCIsICBcIlBsYWNlIGFzIDJuZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDEsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTNyZFwiLCAgXCJQbGFjZSBhcyAzcmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigyLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC00dGhcIiwgIFwiUGxhY2UgYXMgNHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNXRoXCIsICBcIlBsYWNlIGFzIDV0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDQsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTZ0aFwiLCAgXCJQbGFjZSBhcyA2dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig1LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC03dGhcIiwgIFwiUGxhY2UgYXMgN3RoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtOHRoXCIsICBcIlBsYWNlIGFzIDh0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDcsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LWxhc3RcIiwgXCJQbGFjZSBhcyBsYXN0IHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgIFwiTW9kK0FsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig5OTk5OTk5OSwgZmFsc2UpOyB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHNldHVwRGlzcGxheSgpIHtcbiAgICAgICAgdGhpcy5hZGRDaGlsZCh0aGlzLmJhY2sgICAgPSBuZXcgTmF2aWdhdG9yKHRoaXMuYXBwLCBcImJhY2tcIiwgLTEpKTtcbiAgICAgICAgdGhpcy5hZGRDaGlsZCh0aGlzLmZvcndhcmQgPSBuZXcgTmF2aWdhdG9yKHRoaXMuYXBwLCBcImZvcndhcmRcIiwgMSkpO1xuICAgIH1cblxuICAgIGRpc3BsYXkoaGlzdG9yeSkge1xuICAgICAgICB0aGlzLmJhY2suc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5mb3J3YXJkLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgfVxuXG4gICAgb251bmxvYWQoKSB7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS51bnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKE5hdmlnYXRvci5ob3ZlclNvdXJjZSk7XG4gICAgfVxuXG4gICAgZ290b050aExlYWYobiwgcmVsYXRpdmUpIHtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gW107XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlUm9vdExlYXZlcygobGVhZikgPT4gKGxlYXZlcy5wdXNoKGxlYWYpLCBmYWxzZSkpO1xuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIG4gKz0gbGVhdmVzLmluZGV4T2YodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpO1xuICAgICAgICAgICAgbiA9IChuICsgbGVhdmVzLmxlbmd0aCkgJSBsZWF2ZXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBsZWFmID0gbGVhdmVzW24+PWxlYXZlcy5sZW5ndGggPyBsZWF2ZXMubGVuZ3RoLTEgOiBuXTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGNiID0gdGhpcy5sZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZSk7XG4gICAgICAgIGlmIChjYikgY2IoKTtcbiAgICB9XG5cbiAgICBsZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgY29uc3RcbiAgICAgICAgICAgIHBhcmVudFNwbGl0ID0gbGVhZi5wYXJlbnRTcGxpdCxcbiAgICAgICAgICAgIGNoaWxkcmVuID0gcGFyZW50U3BsaXQuY2hpbGRyZW4sXG4gICAgICAgICAgICBmcm9tUG9zID0gY2hpbGRyZW4uaW5kZXhPZihsZWFmKVxuICAgICAgICA7XG4gICAgICAgIGlmIChmcm9tUG9zID09IC0xKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICB0b1BvcyArPSBmcm9tUG9zO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCB8fCB0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHRvUG9zID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDApIHRvUG9zID0gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmcm9tUG9zID09IHRvUG9zKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG90aGVyID0gY2hpbGRyZW5bdG9Qb3NdO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKGZyb21Qb3MsIDEpO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKHRvUG9zLCAgIDAsIGxlYWYpO1xuICAgICAgICAgICAgaWYgKHBhcmVudFNwbGl0LnNlbGVjdFRhYikge1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnNlbGVjdFRhYihsZWFmKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb3RoZXIuY29udGFpbmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KGZyb21Qb3MgPiB0b1BvcyA/IFwiYmVmb3JlYmVnaW5cIiA6IFwiYWZ0ZXJlbmRcIiwgbGVhZi5jb250YWluZXJFbCk7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQucmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk7XG4gICAgICAgICAgICAgICAgbGVhZi5vblJlc2l6ZSgpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dENoYW5nZSgpO1xuXG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgZm9jdXMgYmFjayB0byBwYW5lO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCBmYWxzZSwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuIl0sIm5hbWVzIjpbIk5vdGljZSIsIldvcmtzcGFjZUxlYWYiLCJDb21wb25lbnQiLCJLZXltYXAiLCJNZW51IiwiUGx1Z2luIiwiVEZpbGUiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQTtBQUNBO0FBQ0EsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQ3BCO0FBQ08sU0FBUyxPQUFPLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFLEVBQUU7QUFDdEQ7QUFDQTtBQUNBO0FBQ0EsSUFBSSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsRUFBRSxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN6RCxJQUFJLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDeEU7QUFDQSxJQUFJLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsR0FBRyxFQUFFO0FBQ3hDO0FBQ0EsUUFBUSxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUNoRDtBQUNBLFFBQVEsR0FBRyxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFDO0FBQzVCLFFBQVEsT0FBTyxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxHQUFHLEVBQUU7QUFDeEQsS0FBSyxDQUFDLENBQUM7QUFD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LElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO0FBQ3ZCLFFBQVEsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxJQUFJLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzdELEtBQUs7QUFDTDtBQUNBLElBQUksT0FBTyxDQUFDLElBQUksRUFBRTtBQUNsQixRQUFRLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLENBQUM7QUFDOUUsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUM1QixRQUFRLElBQUksTUFBTSxTQUFTLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztBQUM3RSxLQUFLO0FBQ0w7QUFDQSxJQUFJLFNBQVMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUU7QUFDQSxJQUFJLElBQUksS0FBSyxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxHQUFHLElBQUksSUFBSSxDQUFDLEVBQUU7QUFDN0QsSUFBSSxJQUFJLE1BQU0sR0FBRyxFQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRTtBQUM5QztBQUNBLElBQUksSUFBSSxNQUFNLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUIsSUFBSSxPQUFPLEdBQUcsRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUI7QUFDQSxJQUFJLFNBQVMsR0FBRyxFQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxFQUFFO0FBQ25FLElBQUksVUFBVSxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekQ7QUFDQSxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUU7QUFDZCxRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU87QUFDL0IsUUFBUSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLE9BQU8sSUFBSUEsZUFBTSxDQUFDLGlEQUFpRCxDQUFDLEVBQUUsU0FBUyxDQUFDO0FBQzlHLFFBQVEsR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRSxRQUFRLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN2QyxRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRSxPQUFPLENBQUMsNEJBQTRCLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQztBQUN6RixLQUFLO0FBQ0w7QUFDQSxJQUFJLEVBQUUsQ0FBQyxFQUFFLEVBQUUsS0FBSyxFQUFFO0FBQ2xCLFFBQVEsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxFQUFFLEVBQUUsT0FBTztBQUN0QztBQUNBLFFBQVEsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLEVBQUUsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25GLFFBQVEsSUFBSSxLQUFLLElBQUksTUFBTSxLQUFLLElBQUksQ0FBQyxHQUFHLEVBQUU7QUFDMUMsWUFBWSxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQzlCLFNBQVMsTUFBTTtBQUNmLFlBQVksSUFBSUEsZUFBTSxDQUFDLENBQUMsUUFBUSxFQUFFLEVBQUUsR0FBRyxDQUFDLEdBQUcsTUFBTSxHQUFHLFNBQVMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUM7QUFDbEYsU0FBUztBQUNULEtBQUs7QUFDTDtBQUNBLElBQUksWUFBWSxDQUFDLFFBQVEsRUFBRSxLQUFLLEVBQUUsR0FBRyxDQUFDO0FBQ3RDLFFBQVEsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0MsUUFBUSxJQUFJLENBQUMsS0FBSyxFQUFFO0FBQ3BCLFlBQVksSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDOUQsU0FBUyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxFQUFFO0FBQ2xEO0FBQ0E7QUFDQSxZQUFZLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztBQUNqRCxTQUFTO0FBQ1QsS0FBSztBQUNMO0FBQ0EsSUFBSSxTQUFTLENBQUMsUUFBUSxFQUFFLEtBQUssRUFBRSxHQUFHLElBQUk7QUFDdEMsUUFBUSxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxRQUFRLEVBQUM7QUFDeEMsUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQ25FLFFBQVEsSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUM7QUFDckI7QUFDQSxRQUFRLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsRUFBRSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUM7QUFDeEQsUUFBUSxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsT0FBTyxDQUFDLDRCQUE0QixFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFDO0FBQ3hGLEtBQUs7QUFDTCxDQUFDO0FBQ0Q7QUFDTyxTQUFTLGNBQWMsQ0FBQyxNQUFNLEVBQUU7QUFDdkM7QUFDQSxJQUFJLE1BQU0sR0FBRyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUM7QUFDM0I7QUFDQTtBQUNBLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUNDLHNCQUFhLENBQUMsU0FBUyxFQUFFO0FBQ3BELFFBQVEsU0FBUyxDQUFDLEdBQUcsRUFBRSxFQUFFLE9BQU8sU0FBUyxTQUFTLEVBQUU7QUFDcEQsWUFBWSxNQUFNLE1BQU0sR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzFDLFlBQVksSUFBSSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxTQUFTLEVBQUUsQ0FBQztBQUNuRixZQUFZLE9BQU8sTUFBTSxDQUFDO0FBQzFCLFNBQVMsQ0FBQztBQUNWLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDUjtBQUNBO0FBQ0EsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFO0FBQzFDLFFBQVEsaUJBQWlCLENBQUMsR0FBRyxFQUFFLEVBQUUsT0FBTyxlQUFlLGlCQUFpQixDQUFDLEtBQUssRUFBRSxHQUFHLEdBQUcsQ0FBQztBQUN2RixZQUFZLE1BQU0sTUFBTSxHQUFHLE1BQU0sR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEdBQUcsR0FBRyxDQUFDLENBQUM7QUFDL0QsWUFBWSxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFO0FBQ3ZDLGdCQUFnQixJQUFJLEtBQUssQ0FBQyxXQUFXLENBQUMsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDLEdBQUcsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQ3BHLGFBQWE7QUFDYixZQUFZLE9BQU8sTUFBTSxDQUFDO0FBQzFCLFNBQVMsQ0FBQztBQUNWLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDUjtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUksTUFBTSxDQUFDLGdCQUFnQixDQUFDLFNBQVMsRUFBRSxjQUFjLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDN0QsSUFBSSxNQUFNLENBQUMsUUFBUSxFQUFFLE1BQU0sTUFBTSxDQUFDLG1CQUFtQixDQUFDLFNBQVMsRUFBRSxjQUFjLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQztBQUN6RixJQUFJLFNBQVMsY0FBYyxDQUFDLENBQUMsRUFBRTtBQUMvQixRQUFRLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsT0FBTztBQUNyRCxRQUFRLENBQUMsQ0FBQyxjQUFjLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxlQUFlLEVBQUUsQ0FBQztBQUNoRCxRQUFRLE1BQU0sTUFBTSxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLGlCQUFpQixDQUFDLENBQUM7QUFDL0QsUUFBUSxJQUFJLE1BQU0sRUFBRTtBQUNwQixZQUFZLElBQUksSUFBSSxDQUFDO0FBQ3JCLFlBQVksR0FBRyxDQUFDLFNBQVMsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLFdBQVcsS0FBSyxNQUFNLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQzlGLFlBQVksSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsRUFBRSxFQUFFLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsRUFBRTtBQUNoRSxZQUFZLElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEVBQUUsRUFBRSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLEVBQUU7QUFDbkUsU0FBUztBQUNULFFBQVEsT0FBTyxLQUFLLENBQUM7QUFDckIsS0FBSztBQUNMO0FBQ0E7QUFDQSxJQUFJLE1BQU0sV0FBVyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUM7QUFDdkMsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sTUFBTSxDQUFDLE9BQU8sR0FBRyxXQUFXLENBQUMsQ0FBQztBQUN4RCxJQUFJLE1BQU0sQ0FBQyxjQUFjLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRTtBQUM1RyxRQUFRLElBQUksS0FBSyxRQUFRLEVBQUUsT0FBTyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxFQUFFO0FBQy9ELFFBQVEsSUFBSSxNQUFNLE9BQU8sRUFBRSxPQUFPLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUU7QUFDaEU7QUFDQSxRQUFRLElBQUksTUFBTSxFQUFFLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ2xDLFFBQVEsT0FBTyxHQUFHLEVBQUUsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ2xDLFFBQVEsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUU7QUFDbEQ7QUFDQSxRQUFRLFlBQVksQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFLEdBQUcsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsWUFBWSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUMsRUFBRTtBQUNoRyxRQUFRLFNBQVMsQ0FBQyxLQUFLLEVBQUUsS0FBSyxFQUFFLEdBQUcsSUFBSSxFQUFFLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUMsRUFBRTtBQUM3RjtBQUNBLFFBQVEsSUFBSSxpQkFBaUIsTUFBTSxFQUFFLE9BQU8sV0FBVyxDQUFDLGlCQUFpQixDQUFDLEVBQUU7QUFDNUUsUUFBUSxJQUFJLGlCQUFpQixDQUFDLEdBQUcsRUFBRSxFQUFFLFdBQVcsQ0FBQyxpQkFBaUIsR0FBRyxHQUFHLENBQUMsRUFBRTtBQUMzRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ1I7QUFDQTs7QUM3TEEsTUFBTSxhQUFhLEdBQUc7QUFDdEIsSUFBSSxRQUFRLEVBQUUsVUFBVTtBQUN4QixJQUFJLEtBQUssRUFBRSxZQUFZO0FBQ3ZCLElBQUksS0FBSyxFQUFFLFlBQVk7QUFDdkIsSUFBSSxHQUFHLEVBQUUsVUFBVTtBQUNuQixJQUFJLFVBQVUsRUFBRSxhQUFhO0FBQzdCLElBQUksT0FBTyxFQUFFLGFBQWE7QUFDMUIsSUFBSSxRQUFRLEVBQUUsTUFBTTtBQUNwQjtBQUNBO0FBQ0EsSUFBSSxNQUFNLEVBQUUsUUFBUTtBQUNwQixJQUFJLFVBQVUsRUFBRSxpQkFBaUI7QUFDakMsRUFBQztBQUNEO0FBQ0EsTUFBTSxZQUFZLEdBQUc7QUFDckIsSUFBSSxLQUFLLEVBQUUsQ0FBQyxhQUFhLEVBQUUsWUFBWSxDQUFDO0FBQ3hDLElBQUksZUFBZSxFQUFFLENBQUMsUUFBUSxFQUFFLGVBQWUsQ0FBQztBQUNoRCxJQUFJLE9BQU8sRUFBRSxDQUFDLE1BQU0sRUFBRSxlQUFlLENBQUM7QUFDdEMsSUFBSSxHQUFHLEVBQUUsQ0FBQyxLQUFLLEVBQUUsV0FBVyxDQUFDO0FBQzdCO0FBQ0E7QUFDQSxJQUFJLGNBQWMsRUFBRSxDQUFDLE9BQU8sRUFBRSxjQUFjLENBQUM7QUFDN0MsSUFBSSxRQUFRLEVBQUUsQ0FBQyx5QkFBeUIsRUFBRSxVQUFVLENBQUM7QUFDckQsSUFBSSxLQUFLLEVBQUUsQ0FBQyxPQUFPLEVBQUUsU0FBUyxDQUFDO0FBQy9CLEVBQUM7QUFDRDtBQUNPLE1BQU0sU0FBUyxTQUFTQyxrQkFBUyxDQUFDO0FBQ3pDO0FBQ0EsSUFBSSxPQUFPLFdBQVcsR0FBRywwQkFBMEI7QUFDbkQ7QUFDQSxJQUFJLFdBQVcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLEdBQUcsR0FBRztBQUNqQyxRQUFRLEtBQUssRUFBRSxDQUFDO0FBQ2hCLFFBQVEsSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7QUFDdkIsUUFBUSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztBQUN6QixRQUFRLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO0FBQ3ZCLEtBQUs7QUFDTDtBQUNBLElBQUksTUFBTSxHQUFHO0FBQ2IsUUFBUSxJQUFJLENBQUMsV0FBVyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSTtBQUM3QyxZQUFZLENBQUMsbUVBQW1FLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzdGLFNBQVMsQ0FBQztBQUNWLFFBQVEsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sRUFBRSxHQUFHLEVBQUUsaUJBQWlCLENBQUMsQ0FBQyxDQUFDO0FBQzFHLFFBQVEsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7QUFDekIsUUFBUSxJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQztBQUM1QixRQUFRLElBQUksQ0FBQyxNQUFNLEdBQUcsRUFBRSxDQUFDO0FBQ3pCLFFBQVEsSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLFlBQVksQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUNwRSxRQUFRLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLGFBQWEsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3pGLEtBQUs7QUFDTDtBQUNBLElBQUksUUFBUSxHQUFHO0FBQ2YsUUFBUSxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN2QyxRQUFRLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7QUFDNUIsUUFBUSxJQUFJLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDMUQsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsR0FBRyxFQUFFLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxXQUFXLEdBQUcsR0FBRyxJQUFJLEVBQUUsQ0FBQyxFQUFFO0FBQ3pEO0FBQ0EsSUFBSSxVQUFVLENBQUMsSUFBSSxFQUFFO0FBQ3JCLFFBQVEsSUFBSSxJQUFJLEVBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxZQUFZLENBQUMsWUFBWSxFQUFFLElBQUksSUFBSSxTQUFTLENBQUMsQ0FBQztBQUNqRixhQUFhLElBQUksQ0FBQyxXQUFXLENBQUMsZUFBZSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBQzVELEtBQUs7QUFDTDtBQUNBLElBQUksVUFBVSxDQUFDLE9BQU8sRUFBRTtBQUN4QixRQUFRLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO0FBQy9CLFFBQVEsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsWUFBWSxHQUFHLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN0RyxRQUFRLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ3JDLFFBQVEsSUFBSSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsTUFBTTtBQUNyQyxZQUFZLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSztBQUNwRSxZQUFZLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO0FBQ3JDLFNBQVMsQ0FBQztBQUNWLFFBQVEsSUFBSSxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDdEUsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsR0FBRyxFQUFFO0FBQ2xCLFFBQVEsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLE9BQU87QUFDeEMsUUFBUSxNQUFNLElBQUksR0FBRyxVQUFVLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzFDLFFBQVEsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLGNBQWMsRUFBRSxFQUFFLENBQUMsQ0FBQztBQUN2RCxRQUFRLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTztBQUM1RCxZQUFZLENBQUMsSUFBSSxFQUFFLEdBQUcsS0FBSyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDO0FBQ3pELFNBQVMsQ0FBQztBQUNWLFFBQVEsSUFBSSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsT0FBTyxFQUFFLENBQUMsRUFBRSxHQUFHLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDbkUsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUU7QUFDOUIsUUFBUSxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFDeEIsUUFBUSxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxlQUFlLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3JGLFFBQVEsT0FBTztBQUNmO0FBQ0EsUUFBUSxTQUFTLFVBQVUsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFDLEVBQUUsRUFBRTtBQUMxQyxZQUFZLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUk7QUFDNUUsZ0JBQWdCLElBQUksT0FBTyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUM7QUFDekM7QUFDQSxnQkFBZ0IsSUFBSUMsZUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLEVBQUU7QUFDbkUsb0JBQW9CLE9BQU8sR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLGVBQWUsRUFBRSxDQUFDLENBQUM7QUFDbEYsaUJBQWlCO0FBQ2pCLGdCQUFnQixPQUFPLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ25ELGFBQWEsQ0FBQyxDQUFDO0FBQ2YsU0FBUztBQUNUO0FBQ0EsUUFBUSxTQUFTLGVBQWUsQ0FBQyxHQUFHLEVBQUU7QUFDdEM7QUFDQSxZQUFZLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxJQUFJO0FBQ25ELGdCQUFnQixFQUFFLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsWUFBWSxFQUFFO0FBQ3ZELG9CQUFvQixLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxTQUFTLENBQUMsV0FBVztBQUMzRCxvQkFBb0IsV0FBVyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxRQUFRLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJO0FBQ2xGLGlCQUFpQixDQUFDLENBQUM7QUFDbkIsYUFBYSxDQUFDLENBQUM7QUFDZjtBQUNBO0FBQ0EsWUFBWSxHQUFHLENBQUMsT0FBTyxDQUFDLFdBQVcsRUFBRSxNQUFNLENBQUMsQ0FBQztBQUM3QyxZQUFZLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxJQUFJO0FBQ25ELGdCQUFnQixNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQztBQUN2RCxnQkFBZ0IsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3BFLGdCQUFnQixXQUFXLENBQUMsV0FBVyxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQztBQUNyRCxhQUFhLENBQUMsQ0FBQztBQUNmLFlBQVksR0FBRyxDQUFDLGdCQUFnQixDQUFDLFNBQVMsRUFBRSxDQUFDLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7QUFDOUQ7QUFDQTtBQUNBLFlBQVksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGFBQWEsRUFBRSxDQUFDLElBQUk7QUFDckQsZ0JBQWdCLE1BQU0sSUFBSSxHQUFHLFVBQVUsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDaEQsZ0JBQWdCLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLFVBQVUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxFQUFFLENBQUM7QUFDckYsZ0JBQWdCLEVBQUUsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLE9BQU87QUFDeEMsb0JBQW9CLFdBQVcsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxtQkFBbUI7QUFDckUsaUJBQWlCLENBQUM7QUFDbEIsZ0JBQWdCLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDbEUsZ0JBQWdCLENBQUMsQ0FBQyxlQUFlLEVBQUUsQ0FBQztBQUNwQyxhQUFhLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDckIsU0FBUztBQUNULEtBQUs7QUFDTDtBQUNBLElBQUksV0FBVyxDQUFDLEtBQUssRUFBRTtBQUN2QixRQUFRLE1BQU0sQ0FBQyxTQUFTLEVBQUUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLEVBQUUsTUFBTSxFQUFFLElBQUksQ0FBQyxHQUFHLEtBQUssQ0FBQztBQUMvRCxRQUFRLE1BQU0sSUFBSSxHQUFHLElBQUksSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN4RSxRQUFRLE1BQU0sSUFBSSxHQUFHLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBQ3RFO0FBQ0EsUUFBUSxJQUFJLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRTtBQUNoQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3pELFNBQVMsTUFBTSxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksRUFBRTtBQUNsQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3RFLFNBQVMsTUFBTTtBQUNmLFlBQVksSUFBSSxDQUFDLElBQUksR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksVUFBVSxDQUFDO0FBQzFELFlBQVksSUFBSSxJQUFJLEtBQUssVUFBVSxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssU0FBUyxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsZUFBZSxDQUFDO0FBQzdGLFlBQVksSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLEdBQUcsSUFBSSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsU0FBUyxLQUFLLElBQUksR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsR0FBRyxFQUFFLENBQUMsR0FBRyxTQUFTLENBQUM7QUFDaEgsU0FBUztBQUNUO0FBQ0EsUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsaUNBQWlDLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDNUUsUUFBUSxPQUFPLElBQUksQ0FBQztBQUNwQixLQUFLO0FBQ0wsQ0FBQztBQUNEO0FBQ0EsU0FBUyxTQUFTLENBQUMsRUFBRSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRTtBQUMzRCxJQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFDO0FBQzdDLElBQUksT0FBTyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUNEO0FBQ0EsU0FBUyxVQUFVLENBQUMsR0FBRyxFQUFFO0FBQ3pCLElBQUksTUFBTSxJQUFJLEdBQUcsSUFBSUMsYUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQy9CLElBQUksSUFBSSxDQUFDLFFBQVE7QUFDakI7QUFDQSxRQUFRLFNBQVMsQ0FBQyxRQUFRLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUk7QUFDakQsWUFBWSxJQUFJLENBQUMsQ0FBQyxHQUFHLEdBQUcsUUFBUSxFQUFFO0FBQ2xDLGdCQUFnQixDQUFDLENBQUMsY0FBYyxFQUFFLENBQUM7QUFDbkMsZ0JBQWdCLENBQUMsQ0FBQyxlQUFlLEVBQUUsQ0FBQztBQUNwQyxnQkFBZ0IsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzVCLGFBQWE7QUFDYixTQUFTLEVBQUUsQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDM0IsS0FBSyxDQUFDO0FBQ04sSUFBSSxPQUFPLElBQUksQ0FBQztBQUNoQjs7QUNyS2UsTUFBTSxVQUFVLFNBQVNDLGVBQU0sQ0FBQztBQUMvQztBQUNBLElBQUksTUFBTSxHQUFHO0FBQ2IsUUFBUSxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDN0IsUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyx1QkFBdUIsQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFO0FBQzFFLFlBQVksT0FBTyxFQUFFLG1CQUFtQixFQUFFLFVBQVUsRUFBRSxJQUFJO0FBQzFELFNBQVMsQ0FBQyxDQUFDO0FBQ1gsUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsTUFBTTtBQUMvQyxZQUFZLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztBQUNoQyxZQUFZLElBQUksQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLFFBQVEsRUFBRSxDQUFDLElBQUksRUFBRSxPQUFPLEtBQUs7QUFDOUUsZ0JBQWdCLElBQUksSUFBSSxZQUFZQyxjQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsZ0JBQWdCO0FBQzlFLG9CQUFvQixJQUFJLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztBQUN6RSxpQkFBaUIsQ0FBQztBQUNsQixhQUFhLENBQUMsQ0FBQyxDQUFDO0FBQ2hCLFlBQVksSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsNEJBQTRCLEVBQUUsQ0FBQyxJQUFJLEVBQUUsT0FBTyxLQUFLO0FBQ3RHLGdCQUFnQixJQUFJLElBQUksS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNsRixhQUFhLENBQUMsQ0FBQyxDQUFDO0FBQ2hCLFlBQVksSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsb0JBQW9CLEVBQUUsSUFBSSxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6SCxZQUFZLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO0FBQzVHLFNBQVMsQ0FBQyxDQUFDO0FBQ1g7QUFDQSxRQUFRLFdBQVcsQ0FBQyxJQUFJLEVBQUU7QUFDMUIsWUFBWSxDQUFDLE9BQU8sQ0FBQyxXQUFXLEVBQUUsa0NBQWtDLEdBQUcsa0JBQWtCLENBQUMsSUFBSSxFQUFFLEVBQUUsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUMvSCxZQUFZLENBQUMsT0FBTyxDQUFDLFdBQVcsRUFBRSw4QkFBOEIsT0FBTyxvQkFBb0IsQ0FBQyxFQUFFLEVBQUUsRUFBRSxPQUFPLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUMvSDtBQUNBLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGtDQUFrQyxJQUFJLFlBQVksR0FBRyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFO0FBQ3ZJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLDhCQUE4QixRQUFRLGNBQWMsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRTtBQUN2STtBQUNBLFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxJQUFJLG1DQUFtQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQ3pILFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLG9DQUFvQyxFQUFFLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFO0FBQ2hJO0FBQ0EsWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FB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
