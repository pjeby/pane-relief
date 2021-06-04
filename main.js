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
        //console.log("pushing", rawState)
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
        menu.dom.style.setProperty(
            // Allow popovers (hover preview) to overlay this menu
            "--layer-menu", getComputedStyle(document.body).getPropertyValue("--layer-popover")-1
        );
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9OYXZpZ2F0b3IuanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmNvbnN0IGNvbW1hbmRzID0ge307XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kKGlkLCBuYW1lLCBob3RrZXlzPVtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgaG90a2V5cy5rZXkpIGhvdGtleXMgPSBbaG90a2V5c107XG5cbiAgICBob3RrZXlzID0gaG90a2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAga2V5ID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IGtleSwga2V5OiBrZXkucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kcyhwbHVnaW4sIGNtZHNldCkge1xuICAgIC8vIEV4dHJhY3QgY29tbWFuZCBzeW1ib2xzIGZyb20gY21kc2V0IGFuZCByZWdpc3RlciB0aGVtLCBib3VuZCB0byB0aGUgcGx1Z2luIGZvciBtZXRob2RzXG4gICAgT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scyhjbWRzZXQpLmZvckVhY2goc3ltID0+IHtcbiAgICAgICAgY29uc3QgY21kID0gY29tbWFuZHNbc3ltXSwgbWV0aG9kID0gY21kc2V0W3N5bV07XG4gICAgICAgIGlmIChjbWQpIHBsdWdpbi5hZGRDb21tYW5kKE9iamVjdC5hc3NpZ24oe30sIGNtZCwge1xuICAgICAgICAgICAgY2hlY2tDYWxsYmFjayhjaGVjaykge1xuICAgICAgICAgICAgICAgIC8vIENhbGwgdGhlIG1ldGhvZCBib2R5IHdpdGggdGhlIHBsdWdpbiBhcyAndGhpcydcbiAgICAgICAgICAgICAgICBjb25zdCBjYiA9IG1ldGhvZC5jYWxsKHBsdWdpbik7XG4gICAgICAgICAgICAgICAgLy8gSXQgdGhlbiByZXR1cm5zIGEgY2xvc3VyZSBpZiB0aGUgY29tbWFuZCBpcyByZWFkeSB0byBleGVjdXRlLCBhbmRcbiAgICAgICAgICAgICAgICAvLyB3ZSBjYWxsIHRoYXQgY2xvc3VyZSB1bmxlc3MgdGhpcyBpcyBqdXN0IGEgY2hlY2sgZm9yIGF2YWlsYWJpbGl0eVxuICAgICAgICAgICAgICAgIHJldHVybiAoY2hlY2sgfHwgdHlwZW9mIGNiICE9PSBcImZ1bmN0aW9uXCIpID8gISFjYiA6IChjYigpLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH0pXG59IiwiZXhwb3J0IGZ1bmN0aW9uIGFyb3VuZChvYmosIGZhY3Rvcmllcykge1xuICAgIGNvbnN0IHJlbW92ZXJzID0gT2JqZWN0LmtleXMoZmFjdG9yaWVzKS5tYXAoa2V5ID0+IGFyb3VuZDEob2JqLCBrZXksIGZhY3Rvcmllc1trZXldKSk7XG4gICAgcmV0dXJuIHJlbW92ZXJzLmxlbmd0aCA9PT0gMSA/IHJlbW92ZXJzWzBdIDogZnVuY3Rpb24gKCkgeyByZW1vdmVycy5mb3JFYWNoKHIgPT4gcigpKTsgfTtcbn1cbmZ1bmN0aW9uIGFyb3VuZDEob2JqLCBtZXRob2QsIGNyZWF0ZVdyYXBwZXIpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG9ialttZXRob2RdLCBoYWRPd24gPSBvYmouaGFzT3duUHJvcGVydHkobWV0aG9kKTtcbiAgICBsZXQgY3VycmVudCA9IGNyZWF0ZVdyYXBwZXIob3JpZ2luYWwpO1xuICAgIC8vIExldCBvdXIgd3JhcHBlciBpbmhlcml0IHN0YXRpYyBwcm9wcyBmcm9tIHRoZSB3cmFwcGluZyBtZXRob2QsXG4gICAgLy8gYW5kIHRoZSB3cmFwcGluZyBtZXRob2QsIHByb3BzIGZyb20gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgIGlmIChvcmlnaW5hbClcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGN1cnJlbnQsIG9yaWdpbmFsKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgY3VycmVudCk7XG4gICAgb2JqW21ldGhvZF0gPSB3cmFwcGVyO1xuICAgIC8vIFJldHVybiBhIGNhbGxiYWNrIHRvIGFsbG93IHNhZmUgcmVtb3ZhbFxuICAgIHJldHVybiByZW1vdmU7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBkZWFjdGl2YXRlZCBhbmQgYXJlIG5vIGxvbmdlciB3cmFwcGVkLCByZW1vdmUgb3Vyc2VsdmVzXG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbCAmJiBvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcilcbiAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICByZXR1cm4gY3VycmVudC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuICAgICAgICAvLyBJZiBubyBvdGhlciBwYXRjaGVzLCBqdXN0IGRvIGEgZGlyZWN0IHJlbW92YWxcbiAgICAgICAgaWYgKG9ialttZXRob2RdID09PSB3cmFwcGVyKSB7XG4gICAgICAgICAgICBpZiAoaGFkT3duKVxuICAgICAgICAgICAgICAgIG9ialttZXRob2RdID0gb3JpZ2luYWw7XG4gICAgICAgICAgICBlbHNlXG4gICAgICAgICAgICAgICAgZGVsZXRlIG9ialttZXRob2RdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbClcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgLy8gRWxzZSBwYXNzIGZ1dHVyZSBjYWxscyB0aHJvdWdoLCBhbmQgcmVtb3ZlIHdyYXBwZXIgZnJvbSB0aGUgcHJvdG90eXBlIGNoYWluXG4gICAgICAgIGN1cnJlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIG9yaWdpbmFsIHx8IEZ1bmN0aW9uKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXIocHJvbWlzZSwgY2IpIHtcbiAgICByZXR1cm4gcHJvbWlzZS50aGVuKGNiLCBjYik7XG59XG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplKGFzeW5jRnVuY3Rpb24pIHtcbiAgICBsZXQgbGFzdFJ1biA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4ge1xuICAgICAgICAgICAgYWZ0ZXIobGFzdFJ1biwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGFzeW5jRnVuY3Rpb24uYXBwbHkodGhpcywgYXJncykudGhlbihyZXMsIHJlaik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdyYXBwZXIuYWZ0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGFmdGVyKGxhc3RSdW4sIHJlcyk7IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHdyYXBwZXI7XG59XG4iLCJpbXBvcnQge05vdGljZSwgV29ya3NwYWNlTGVhZn0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmNvbnN0IEhJU1RfQVRUUiA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuY29uc3QgU0VSSUFMX1BST1AgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcblxuZnVuY3Rpb24gcGFyc2Uoc3RhdGUpIHtcbiAgICBpZiAodHlwZW9mIHN0YXRlLnN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5zdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGUuc3RhdGUpO1xuICAgIGlmICh0eXBlb2Ygc3RhdGUuZVN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5lU3RhdGUgPSBKU09OLnBhcnNlKHN0YXRlLmVTdGF0ZSk7XG4gICAgcmV0dXJuIHN0YXRlO1xufVxuXG5jbGFzcyBIaXN0b3J5RW50cnkge1xuICAgIGNvbnN0cnVjdG9yKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgIH1cblxuICAgIHNldFN0YXRlKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMucmF3ID0gcmF3U3RhdGU7XG4gICAgICAgIHRoaXMudmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICB0aGlzLmVTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuZVN0YXRlIHx8IFwibnVsbFwiKTtcbiAgICAgICAgdGhpcy5wYXRoID0gdGhpcy52aWV3U3RhdGUuc3RhdGU/LmZpbGU7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBpZiAodGhpcy5wYXRoID09PSBvbGRQYXRoKSB7XG4gICAgICAgICAgICB0aGlzLnBhdGggPSB0aGlzLnZpZXdTdGF0ZS5zdGF0ZS5maWxlID0gZmlsZS5wYXRoXG4gICAgICAgICAgICB0aGlzLnJhdy5zdGF0ZSA9IEpTT04uc3RyaW5naWZ5KHRoaXMudmlld1N0YXRlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvKGxlYWYpIHtcbiAgICAgICAgbGV0IHt2aWV3U3RhdGUsIHBhdGgsIGVTdGF0ZX0gPSB0aGlzO1xuICAgICAgICBsZXQgZmlsZSA9IHBhdGggJiYgbGVhZj8uYXBwPy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiTWlzc2luZyBmaWxlOiBcIitwYXRoKTtcbiAgICAgICAgICAgIHZpZXdTdGF0ZSA9IHt0eXBlOiBcImVtcHR5XCIsIHN0YXRlOnt9fTtcbiAgICAgICAgICAgIGVTdGF0ZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBsZWFmLnNldFZpZXdTdGF0ZSh7Li4udmlld1N0YXRlLCBhY3RpdmU6IHRydWUsIHBvcHN0YXRlOiB0cnVlfSwgZVN0YXRlKTtcbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGUpIHtcbiAgICAgICAgaWYgKHJhd1N0YXRlLnN0YXRlICE9PSB0aGlzLnJhdy5zdGF0ZSkge1xuICAgICAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgLy8gRG9uJ3QgcmVwbGFjZSBhIGZpbGUgd2l0aCBhbiBlbXB0eSBpbiB0aGUgaGlzdG9yeVxuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcImVtcHR5XCIpIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgLy8gRmlsZSBpcyBkaWZmZXJlbnQgZnJvbSBleGlzdGluZyBmaWxlOiBzaG91bGQgYmUgYSBwdXNoIGluc3RlYWRcbiAgICAgICAgICAgIGlmICh0aGlzLnBhdGggJiYgdGhpcy5wYXRoICE9PSB2aWV3U3RhdGU/LnN0YXRlPy5maWxlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICAgIHN0YXRpYyBjdXJyZW50KGFwcCkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgfHwgbmV3IHRoaXMoKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yTGVhZihsZWFmKSB7XG4gICAgICAgIGlmIChsZWFmKSByZXR1cm4gbGVhZltISVNUX0FUVFJdIGluc3RhbmNlb2YgdGhpcyA/XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gOlxuICAgICAgICAgICAgbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMobGVhZiwgbGVhZltISVNUX0FUVFJdPy5zZXJpYWxpemUoKSB8fCB1bmRlZmluZWQpO1xuICAgIH1cblxuICAgIGNvbnN0cnVjdG9yKGxlYWYsIHtwb3MsIHN0YWNrfSA9IHtwb3M6MCwgc3RhY2s6W119KSB7XG4gICAgICAgIHRoaXMubGVhZiA9IGxlYWY7XG4gICAgICAgIHRoaXMucG9zID0gcG9zO1xuICAgICAgICB0aGlzLnN0YWNrID0gc3RhY2subWFwKHJhdyA9PiBuZXcgSGlzdG9yeUVudHJ5KHJhdykpO1xuICAgIH1cblxuICAgIGNsb25lVG8obGVhZikge1xuICAgICAgICByZXR1cm4gbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMuY29uc3RydWN0b3IobGVhZiwgdGhpcy5zZXJpYWxpemUoKSk7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBmb3IoY29uc3QgaGlzdEVudHJ5IG9mIHRoaXMuc3RhY2spIGhpc3RFbnRyeS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKTtcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2subWFwKGUgPT4gZS5yYXcpfTsgfVxuXG4gICAgZ2V0IHN0YXRlKCkgeyByZXR1cm4gdGhpcy5zdGFja1t0aGlzLnBvc10/LnJhdyB8fCBudWxsOyB9XG4gICAgZ2V0IGxlbmd0aCgpIHsgcmV0dXJuIHRoaXMuc3RhY2subGVuZ3RoOyB9XG5cbiAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfVxuICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9XG5cbiAgICBsb29rQWhlYWQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKDAsIHRoaXMucG9zKS5yZXZlcnNlKCk7IH1cbiAgICBsb29rQmVoaW5kKCkgeyByZXR1cm4gdGhpcy5zdGFjay5zbGljZSh0aGlzLnBvcysxKTsgfVxuXG4gICAgZ290byhwb3MpIHtcbiAgICAgICAgaWYgKCF0aGlzLmxlYWYpIHJldHVybjtcbiAgICAgICAgaWYgKHRoaXMubGVhZi5waW5uZWQpIHJldHVybiBuZXcgTm90aWNlKFwiUGlubmVkIHBhbmU6IHVucGluIGJlZm9yZSBnb2luZyBmb3J3YXJkIG9yIGJhY2tcIiksIHVuZGVmaW5lZDtcbiAgICAgICAgcG9zID0gdGhpcy5wb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihwb3MsIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICB0aGlzLnN0YWNrW3Bvc10/LmdvKHRoaXMubGVhZik7XG4gICAgICAgIHRoaXMubGVhZi5hcHA/LndvcmtzcGFjZT8udHJpZ2dlcihcInBhbmUtcmVsaWVmOnVwZGF0ZS1oaXN0b3J5XCIsIHRoaXMubGVhZiwgdGhpcyk7XG4gICAgfVxuXG4gICAgZ28oYnksIGZvcmNlKSB7XG4gICAgICAgIGlmICghdGhpcy5sZWFmIHx8ICFieSkgcmV0dXJuOyAgLy8gbm8tb3BcbiAgICAgICAgLy8gcHJldmVudCB3cmFwYXJvdW5kXG4gICAgICAgIGNvbnN0IG5ld1BvcyA9IE1hdGgubWF4KDAsIE1hdGgubWluKHRoaXMucG9zIC0gYnksIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICBpZiAoZm9yY2UgfHwgbmV3UG9zICE9PSB0aGlzLnBvcykge1xuICAgICAgICAgICAgdGhpcy5nb3RvKG5ld1Bvcyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBObyBtb3JlICR7YnkgPCAwID8gXCJiYWNrXCIgOiBcImZvcndhcmRcIn0gaGlzdG9yeSBmb3IgcGFuZWApO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVwbGFjZVN0YXRlKHJhd1N0YXRlLCB0aXRsZSwgdXJsKXtcbiAgICAgICAgY29uc3QgZW50cnkgPSB0aGlzLnN0YWNrW3RoaXMucG9zXTtcbiAgICAgICAgaWYgKCFlbnRyeSkge1xuICAgICAgICAgICAgdGhpcy5zdGFja1t0aGlzLnBvc10gPSBuZXcgSGlzdG9yeUVudHJ5KHJhd1N0YXRlKTtcbiAgICAgICAgfSBlbHNlIGlmICghZW50cnkucmVwbGFjZVN0YXRlKHJhd1N0YXRlKSkge1xuICAgICAgICAgICAgLy8gcmVwbGFjZVN0YXRlIHdhcyBlcnJvbmVvdXNseSBjYWxsZWQgd2l0aCBhIG5ldyBmaWxlIGZvciB0aGUgc2FtZSBsZWFmO1xuICAgICAgICAgICAgLy8gZm9yY2UgYSBwdXNoU3RhdGUgaW5zdGVhZCAoZml4ZXMgdGhlIGlzc3VlIHJlcG9ydGVkIGhlcmU6IGh0dHBzOi8vZm9ydW0ub2JzaWRpYW4ubWQvdC8xODUxOClcbiAgICAgICAgICAgIHRoaXMucHVzaFN0YXRlKHJhd1N0YXRlLCB0aXRsZSwgdXJsKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHB1c2hTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCkgICB7XG4gICAgICAgIC8vY29uc29sZS5sb2coXCJwdXNoaW5nXCIsIHJhd1N0YXRlKVxuICAgICAgICB0aGlzLnN0YWNrLnNwbGljZSgwLCB0aGlzLnBvcywgbmV3IEhpc3RvcnlFbnRyeShyYXdTdGF0ZSkpO1xuICAgICAgICB0aGlzLnBvcyA9IDA7XG4gICAgICAgIC8vIExpbWl0IFwiYmFja1wiIHRvIDIwXG4gICAgICAgIHdoaWxlICh0aGlzLnN0YWNrLmxlbmd0aCA+IDIwKSB0aGlzLnN0YWNrLnBvcCgpO1xuICAgICAgICB0aGlzLmxlYWYuYXBwPy53b3Jrc3BhY2U/LnRyaWdnZXIoXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCB0aGlzLmxlYWYsIHRoaXMpXG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbEhpc3RvcnkocGx1Z2luKSB7XG5cbiAgICBjb25zdCBhcHAgPSBwbHVnaW4uYXBwO1xuXG4gICAgLy8gTW9ua2V5cGF0Y2g6IGluY2x1ZGUgaGlzdG9yeSBpbiBsZWFmIHNlcmlhbGl6YXRpb24gKHNvIGl0J3MgcGVyc2lzdGVkIHdpdGggdGhlIHdvcmtzcGFjZSlcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKFdvcmtzcGFjZUxlYWYucHJvdG90eXBlLCB7XG4gICAgICAgIHNlcmlhbGl6ZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNlcmlhbGl6ZSgpe1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICBpZiAodGhpc1tISVNUX0FUVFJdKSByZXN1bHRbU0VSSUFMX1BST1BdID0gdGhpc1tISVNUX0FUVFJdLnNlcmlhbGl6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX1cbiAgICB9KSk7XG5cbiAgICAvLyBNb25rZXlwYXRjaDogbG9hZCBoaXN0b3J5IGR1cmluZyBsZWFmIGxvYWQsIGlmIHByZXNlbnRcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKGFwcC53b3Jrc3BhY2UsIHtcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZUxheW91dChzdGF0ZSwgLi4uZXRjKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlW1NFUklBTF9QUk9QXSkgcmVzdWx0W0hJU1RfQVRUUl0gPSBuZXcgSGlzdG9yeShyZXN1bHQsIHN0YXRlW1NFUklBTF9QUk9QXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9fVxuICAgIH0pKTtcblxuICAgIC8vIE92ZXJyaWRlIGRlZmF1bHQgbW91c2UgaGlzdG9yeSBiZWhhdmlvci4gIFdlIG5lZWQgdGhpcyBiZWNhdXNlIDEpIEVsZWN0cm9uIHdpbGwgdXNlIHRoZSBidWlsdC1pblxuICAgIC8vIGhpc3Rvcnkgb2JqZWN0IGlmIHdlIGRvbid0IChpbnN0ZWFkIG9mIG91ciB3cmFwcGVyKSwgYW5kIDIpIHdlIHdhbnQgdGhlIGNsaWNrIHRvIGFwcGx5IHRvIHRoZSBsZWFmXG4gICAgLy8gdGhhdCB3YXMgdW5kZXIgdGhlIG1vdXNlLCByYXRoZXIgdGhhbiB3aGljaGV2ZXIgbGVhZiB3YXMgYWN0aXZlLlxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCAoKSA9PiB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpICk7XG4gICAgZnVuY3Rpb24gaGlzdG9yeUhhbmRsZXIoZSkge1xuICAgICAgICBpZiAoZS5idXR0b24gIT09IDMgJiYgZS5idXR0b24gIT09IDQpIHJldHVybjtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOyBlLnN0b3BQcm9wYWdhdGlvbigpOyAgLy8gcHJldmVudCBkZWZhdWx0IGJlaGF2aW9yXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0Lm1hdGNoUGFyZW50KFwiLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICBpZiAodGFyZ2V0KSB7XG4gICAgICAgICAgICBsZXQgbGVhZjtcbiAgICAgICAgICAgIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcyhsID0+IGxlYWYgPSAobC5jb250YWluZXJFbCA9PT0gdGFyZ2V0KSA/IGwgOiBsZWFmKTtcbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSAzKSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5iYWNrKCk7IH1cbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSA0KSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5mb3J3YXJkKCk7IH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUHJveHkgdGhlIHdpbmRvdyBoaXN0b3J5IHdpdGggYSB3cmFwcGVyIHRoYXQgZGVsZWdhdGVzIHRvIHRoZSBhY3RpdmUgbGVhZidzIEhpc3Rvcnkgb2JqZWN0LFxuICAgIGNvbnN0IHJlYWxIaXN0b3J5ID0gd2luZG93Lmhpc3Rvcnk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+IHdpbmRvdy5oaXN0b3J5ID0gcmVhbEhpc3RvcnkpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiaGlzdG9yeVwiLCB7IGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUsIHZhbHVlOiB7XG4gICAgICAgIGdldCBzdGF0ZSgpICAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkuc3RhdGU7IH0sXG4gICAgICAgIGdldCBsZW5ndGgoKSAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkubGVuZ3RoOyB9LFxuXG4gICAgICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9LFxuICAgICAgICBmb3J3YXJkKCkgeyB0aGlzLmdvKCAxKTsgfSxcbiAgICAgICAgZ28oYnkpICAgIHsgSGlzdG9yeS5jdXJyZW50KGFwcCkuZ28oYnkpOyB9LFxuXG4gICAgICAgIHJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCl7IEhpc3RvcnkuY3VycmVudChhcHApLnJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG4gICAgICAgIHB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCkgICB7IEhpc3RvcnkuY3VycmVudChhcHApLnB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG5cbiAgICAgICAgZ2V0IHNjcm9sbFJlc3RvcmF0aW9uKCkgICAgeyByZXR1cm4gcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb247IH0sXG4gICAgICAgIHNldCBzY3JvbGxSZXN0b3JhdGlvbih2YWwpIHsgcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb24gPSB2YWw7IH0sXG4gICAgfX0pO1xuXG59XG4iLCJpbXBvcnQge01lbnUsIEtleW1hcCwgQ29tcG9uZW50fSBmcm9tICdvYnNpZGlhbic7XG5cbmNvbnN0IHZpZXd0eXBlSWNvbnMgPSB7XG4gICAgbWFya2Rvd246IFwiZG9jdW1lbnRcIixcbiAgICBpbWFnZTogXCJpbWFnZS1maWxlXCIsXG4gICAgYXVkaW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHBkZjogXCJwZGYtZmlsZVwiLFxuICAgIGxvY2FsZ3JhcGg6IFwiZG90LW5ldHdvcmtcIixcbiAgICBvdXRsaW5lOiBcImJ1bGxldC1saXN0XCIsXG4gICAgYmFja2xpbms6IFwibGlua1wiLFxuXG4gICAgLy8gdGhpcmQtcGFydHkgcGx1Z2luc1xuICAgIGthbmJhbjogXCJibG9ja3NcIixcbiAgICBleGNhbGlkcmF3OiBcImV4Y2FsaWRyYXctaWNvblwiLFxufVxuXG5jb25zdCBub25GaWxlVmlld3MgPSB7XG4gICAgZ3JhcGg6IFtcImRvdC1uZXR3b3JrXCIsIFwiR3JhcGggVmlld1wiXSxcbiAgICBcImZpbGUtZXhwbG9yZXJcIjogW1wiZm9sZGVyXCIsIFwiRmlsZSBFeHBsb3JlclwiXSxcbiAgICBzdGFycmVkOiBbXCJzdGFyXCIsIFwiU3RhcnJlZCBGaWxlc1wiXSxcbiAgICB0YWc6IFtcInRhZ1wiLCBcIlRhZ3MgVmlld1wiXSxcblxuICAgIC8vIHRoaXJkLXBhcnR5IHBsdWdpbnNcbiAgICBcInJlY2VudC1maWxlc1wiOiBbXCJjbG9ja1wiLCBcIlJlY2VudCBGaWxlc1wiXSxcbiAgICBjYWxlbmRhcjogW1wiY2FsZW5kYXItd2l0aC1jaGVja21hcmtcIiwgXCJDYWxlbmRhclwiXSxcbiAgICBlbXB0eTogW1wiY3Jvc3NcIiwgXCJObyBmaWxlXCJdXG59XG5cbmV4cG9ydCBjbGFzcyBOYXZpZ2F0b3IgZXh0ZW5kcyBDb21wb25lbnQge1xuXG4gICAgc3RhdGljIGhvdmVyU291cmNlID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LW1lbnVcIjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcCwga2luZCwgZGlyKSAge1xuICAgICAgICBzdXBlcigpO1xuICAgICAgICB0aGlzLmFwcCA9IGFwcDtcbiAgICAgICAgdGhpcy5raW5kID0ga2luZDtcbiAgICAgICAgdGhpcy5kaXIgPSBkaXI7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gZG9jdW1lbnQuYm9keS5maW5kKFxuICAgICAgICAgICAgYC50aXRsZWJhciAudGl0bGViYXItYnV0dG9uLWNvbnRhaW5lci5tb2QtbGVmdCAudGl0bGViYXItYnV0dG9uLm1vZC0ke3RoaXMua2luZH1gXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY291bnQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZVNwYW4oe3ByZXBlbmQ6IHRoaXMua2luZCA9PT0gXCJiYWNrXCIsIGNsczogXCJoaXN0b3J5LWNvdW50ZXJcIn0pO1xuICAgICAgICB0aGlzLmxlYWYgPSBudWxsO1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBudWxsO1xuICAgICAgICB0aGlzLnN0YXRlcyA9IFtdO1xuICAgICAgICB0aGlzLm9sZExhYmVsID0gdGhpcy5jb250YWluZXJFbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQodGhpcy5jb250YWluZXJFbCwgXCJjb250ZXh0bWVudVwiLCB0aGlzLm9wZW5NZW51LmJpbmQodGhpcykpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAodGhpcy5vbGRMYWJlbCk7XG4gICAgICAgIHRoaXMuY291bnQuZGV0YWNoKCk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzZXRDb3VudChudW0pIHsgdGhpcy5jb3VudC50ZXh0Q29udGVudCA9IG51bSB8fCBcIlwiOyB9XG5cbiAgICBzZXRUb29sdGlwKHRleHQpIHtcbiAgICAgICAgaWYgKHRleHQpIHRoaXMuY29udGFpbmVyRWwuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCB0ZXh0IHx8IHVuZGVmaW5lZCk7XG4gICAgICAgIGVsc2UgdGhpcy5jb250YWluZXJFbC5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgIH1cblxuICAgIHNldEhpc3RvcnkoaGlzdG9yeSkge1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBoaXN0b3J5O1xuICAgICAgICBjb25zdCBzdGF0ZXMgPSB0aGlzLnN0YXRlcyA9IGhpc3RvcnlbdGhpcy5kaXIgPCAwID8gXCJsb29rQmVoaW5kXCIgOiBcImxvb2tBaGVhZFwiXS5jYWxsKGhpc3RvcnkpO1xuICAgICAgICB0aGlzLnNldENvdW50KHN0YXRlcy5sZW5ndGgpO1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAoc3RhdGVzLmxlbmd0aCA/XG4gICAgICAgICAgICB0aGlzLm9sZExhYmVsICsgXCJcXG5cIiArIHRoaXMuZm9ybWF0U3RhdGUoc3RhdGVzWzBdKS50aXRsZSA6XG4gICAgICAgICAgICBgTm8gJHt0aGlzLmtpbmR9IGhpc3RvcnlgXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIHN0YXRlcy5sZW5ndGggPiAwKTtcbiAgICB9XG5cbiAgICBvcGVuTWVudShldnQpIHtcbiAgICAgICAgaWYgKCF0aGlzLnN0YXRlcy5sZW5ndGgpIHJldHVybjtcbiAgICAgICAgY29uc3QgbWVudSA9IGNyZWF0ZU1lbnUodGhpcy5hcHApO1xuICAgICAgICBtZW51LmRvbS5zdHlsZS5zZXRQcm9wZXJ0eShcbiAgICAgICAgICAgIC8vIEFsbG93IHBvcG92ZXJzIChob3ZlciBwcmV2aWV3KSB0byBvdmVybGF5IHRoaXMgbWVudVxuICAgICAgICAgICAgXCItLWxheWVyLW1lbnVcIiwgZ2V0Q29tcHV0ZWRTdHlsZShkb2N1bWVudC5ib2R5KS5nZXRQcm9wZXJ0eVZhbHVlKFwiLS1sYXllci1wb3BvdmVyXCIpLTFcbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5zdGF0ZXMubWFwKHRoaXMuZm9ybWF0U3RhdGUuYmluZCh0aGlzKSkuZm9yRWFjaChcbiAgICAgICAgICAgIChpbmZvLCBpZHgpID0+IHRoaXMubWVudUl0ZW0oaW5mbywgaWR4LCBtZW51KVxuICAgICAgICApO1xuICAgICAgICBtZW51LnNob3dBdFBvc2l0aW9uKHt4OiBldnQuY2xpZW50WCwgeTogZXZ0LmNsaWVudFkgKyAyMH0pO1xuICAgIH1cblxuICAgIG1lbnVJdGVtKGluZm8sIGlkeCwgbWVudSkge1xuICAgICAgICBjb25zdCBteSA9IHRoaXM7XG4gICAgICAgIG1lbnUuYWRkSXRlbShpID0+IHsgY3JlYXRlSXRlbShpKTsgaWYgKGluZm8uZmlsZSkgc2V0dXBGaWxlRXZlbnRzKGkuZG9tKTsgfSk7XG4gICAgICAgIHJldHVybjtcblxuICAgICAgICBmdW5jdGlvbiBjcmVhdGVJdGVtKGksIHByZWZpeD1cIlwiKSB7XG4gICAgICAgICAgICBpLnNldEljb24oaW5mby5pY29uKS5zZXRUaXRsZShwcmVmaXggKyBpbmZvLnRpdGxlKS5vbkNsaWNrKGUgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBoaXN0b3J5ID0gbXkuaGlzdG9yeTtcbiAgICAgICAgICAgICAgICAvLyBDaGVjayBmb3IgY3RybC9jbWQvbWlkZGxlIGJ1dHRvbiBhbmQgc3BsaXQgbGVhZiArIGNvcHkgaGlzdG9yeVxuICAgICAgICAgICAgICAgIGlmIChLZXltYXAuaXNNb2RpZmllcihlLCBcIk1vZFwiKSB8fCAxID09PSBlLmJ1dHRvbikge1xuICAgICAgICAgICAgICAgICAgICBoaXN0b3J5ID0gaGlzdG9yeS5jbG9uZVRvKG15LmFwcC53b3Jrc3BhY2Uuc3BsaXRBY3RpdmVMZWFmKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBoaXN0b3J5LmdvKChpZHgrMSkgKiBteS5kaXIsIHRydWUpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXR1cEZpbGVFdmVudHMoZG9tKSB7XG4gICAgICAgICAgICAvLyBIb3ZlciBwcmV2aWV3XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VvdmVyJywgZSA9PiB7XG4gICAgICAgICAgICAgICAgbXkuYXBwLndvcmtzcGFjZS50cmlnZ2VyKCdob3Zlci1saW5rJywge1xuICAgICAgICAgICAgICAgICAgICBldmVudDogZSwgc291cmNlOiBOYXZpZ2F0b3IuaG92ZXJTb3VyY2UsXG4gICAgICAgICAgICAgICAgICAgIGhvdmVyUGFyZW50OiBtZW51LmRvbSwgdGFyZ2V0RWw6IGRvbSwgbGlua3RleHQ6IGluZm8uZmlsZS5wYXRoXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRHJhZyBtZW51IGl0ZW0gdG8gbW92ZSBvciBsaW5rIGZpbGVcbiAgICAgICAgICAgIGRvbS5zZXRBdHRyKCdkcmFnZ2FibGUnLCAndHJ1ZScpO1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdNYW5hZ2VyID0gbXkuYXBwLmRyYWdNYW5hZ2VyO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdEYXRhID0gZHJhZ01hbmFnZXIuZHJhZ0ZpbGUoZSwgaW5mby5maWxlKTtcbiAgICAgICAgICAgICAgICBkcmFnTWFuYWdlci5vbkRyYWdTdGFydChlLCBkcmFnRGF0YSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgZSA9PiBtZW51LmhpZGUoKSk7XG5cbiAgICAgICAgICAgIC8vIEZpbGUgbWVudVxuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoXCJjb250ZXh0bWVudVwiLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZW51ID0gY3JlYXRlTWVudShteS5hcHApO1xuICAgICAgICAgICAgICAgIG1lbnUuYWRkSXRlbShpID0+IGNyZWF0ZUl0ZW0oaSwgYEdvICR7bXkua2luZH0gdG8gYCkpLmFkZFNlcGFyYXRvcigpO1xuICAgICAgICAgICAgICAgIG15LmFwcC53b3Jrc3BhY2UudHJpZ2dlcihcbiAgICAgICAgICAgICAgICAgICAgXCJmaWxlLW1lbnVcIiwgbWVudSwgaW5mby5maWxlLCBcImxpbmstY29udGV4dC1tZW51XCJcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGUuY2xpZW50WCwgeTogZS5jbGllbnRZfSk7XG4gICAgICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsgLy8ga2VlcCB0aGUgcGFyZW50IG1lbnUgb3BlbiBmb3Igbm93XG4gICAgICAgICAgICB9LCB0cnVlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZvcm1hdFN0YXRlKGVudHJ5KSB7XG4gICAgICAgIGNvbnN0IHt2aWV3U3RhdGU6IHt0eXBlLCBzdGF0ZX0sIGVTdGF0ZSwgcGF0aH0gPSBlbnRyeTtcbiAgICAgICAgY29uc3QgZmlsZSA9IHBhdGggJiYgdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuICAgICAgICBjb25zdCBpbmZvID0ge2ljb246IFwiXCIsIHRpdGxlOiBcIlwiLCBmaWxlLCB0eXBlLCBzdGF0ZSwgZVN0YXRlfTtcblxuICAgICAgICBpZiAobm9uRmlsZVZpZXdzW3R5cGVdKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IG5vbkZpbGVWaWV3c1t0eXBlXTtcbiAgICAgICAgfSBlbHNlIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IFtcInRyYXNoXCIsIFwiTWlzc2luZyBmaWxlIFwiK3BhdGhdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaW5mby5pY29uID0gdmlld3R5cGVJY29uc1t0eXBlXSA/PyBcImRvY3VtZW50XCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtYXJrZG93blwiICYmIHN0YXRlLm1vZGUgPT09IFwicHJldmlld1wiKSBpbmZvLmljb24gPSBcImxpbmVzLW9mLXRleHRcIjtcbiAgICAgICAgICAgIGluZm8udGl0bGUgPSBmaWxlID8gZmlsZS5iYXNlbmFtZSArIChmaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiID8gXCIuXCIrZmlsZS5leHRlbnNpb24gOiBcIlwiKSA6IFwiTm8gZmlsZVwiO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnRyaWdnZXIoXCJwYW5lLXJlbGllZjpmb3JtYXQtaGlzdG9yeS1pdGVtXCIsIGluZm8pO1xuICAgICAgICByZXR1cm4gaW5mbztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIG9uRWxlbWVudChlbCwgZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucykge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWVudShhcHApIHtcbiAgICBjb25zdCBtZW51ID0gbmV3IE1lbnUoYXBwKTtcbiAgICBtZW51LnJlZ2lzdGVyKFxuICAgICAgICAvLyBYWFggdGhpcyByZWFsbHkgc2hvdWxkIGJlIGEgc2NvcGUgcHVzaFxuICAgICAgICBvbkVsZW1lbnQoZG9jdW1lbnQsIFwia2V5ZG93blwiLCBcIipcIiwgZSA9PiB7XG4gICAgICAgICAgICBpZiAoZS5rZXk9PT1cIkVzY2FwZVwiKSB7XG4gICAgICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgbWVudS5oaWRlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHtjYXB0dXJlOiB0cnVlfSlcbiAgICApO1xuICAgIHJldHVybiBtZW51O1xufSIsImltcG9ydCB7TWVudSwgUGx1Z2luLCBURmlsZX0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthZGRDb21tYW5kcywgY29tbWFuZH0gZnJvbSBcIi4vY29tbWFuZHNcIjtcbmltcG9ydCB7SGlzdG9yeSwgaW5zdGFsbEhpc3Rvcnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcbmltcG9ydCB7TmF2aWdhdG9yfSBmcm9tIFwiLi9OYXZpZ2F0b3JcIjtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGFuZVJlbGllZiBleHRlbmRzIFBsdWdpbiB7XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIGluc3RhbGxIaXN0b3J5KHRoaXMpO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlLCB7XG4gICAgICAgICAgICBkaXNwbGF5OiAnSGlzdG9yeSBkcm9wZG93bnMnLCBkZWZhdWx0TW9kOiB0cnVlXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNldHVwRGlzcGxheSgpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKFwicmVuYW1lXCIsIChmaWxlLCBvbGRQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMoXG4gICAgICAgICAgICAgICAgICAgIGxlYWYgPT4gSGlzdG9yeS5mb3JMZWFmKGxlYWYpLm9uUmVuYW1lKGZpbGUsIG9sZFBhdGgpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCAobGVhZiwgaGlzdG9yeSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChsZWFmID09PSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgdGhpcy5kaXNwbGF5KGhpc3RvcnkpO1xuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLndvcmtzcGFjZS5vbihcImFjdGl2ZS1sZWFmLWNoYW5nZVwiLCBsZWFmID0+IHRoaXMuZGlzcGxheShIaXN0b3J5LmZvckxlYWYobGVhZikpKSk7XG4gICAgICAgICAgICBpZiAodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHRoaXMuZGlzcGxheShIaXN0b3J5LmZvckxlYWYodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYWRkQ29tbWFuZHModGhpcywge1xuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLXByZXZcIiwgXCJTd2FwIHBhbmUgd2l0aCBwcmV2aW91cyBpbiBzcGxpdFwiLCAgXCJNb2QrU2hpZnQrUGFnZVVwXCIpXSAgICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKC0xKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1uZXh0XCIsIFwiU3dhcCBwYW5lIHdpdGggbmV4dCBpbiBzcGxpdFwiLCAgICAgIFwiTW9kK1NoaWZ0K1BhZ2VEb3duXCIpXSAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlciggMSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tcHJldlwiLCAgXCJDeWNsZSB0byBwcmV2aW91cyB3b3Jrc3BhY2UgcGFuZVwiLCAgIFwiTW9kK1BhZ2VVcFwiICApXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKC0xLCB0cnVlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbmV4dFwiLCAgXCJDeWNsZSB0byBuZXh0IHdvcmtzcGFjZSBwYW5lXCIsICAgICAgIFwiTW9kK1BhZ2VEb3duXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKCAxLCB0cnVlKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0xc3RcIiwgICBcIkp1bXAgdG8gMXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigwKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMm5kXCIsICAgXCJKdW1wIHRvIDJuZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTNyZFwiLCAgIFwiSnVtcCB0byAzcmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDIpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby00dGhcIiwgICBcIkp1bXAgdG8gNHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigzKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNXRoXCIsICAgXCJKdW1wIHRvIDV0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTZ0aFwiLCAgIFwiSnVtcCB0byA2dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby03dGhcIiwgICBcIkp1bXAgdG8gN3RoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig2KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tOHRoXCIsICAgXCJKdW1wIHRvIDh0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLWxhc3RcIiwgIFwiSnVtcCB0byBsYXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCBcIkFsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDk5OTk5OTk5KTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMXN0XCIsICBcIlBsYWNlIGFzIDFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDAsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTJuZFwiLCAgXCJQbGFjZSBhcyAybmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigxLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0zcmRcIiwgIFwiUGxhY2UgYXMgM3JkIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNHRoXCIsICBcIlBsYWNlIGFzIDR0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDMsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTV0aFwiLCAgXCJQbGFjZSBhcyA1dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig0LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC02dGhcIiwgIFwiUGxhY2UgYXMgNnRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtN3RoXCIsICBcIlBsYWNlIGFzIDd0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDYsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTh0aFwiLCAgXCJQbGFjZSBhcyA4dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig3LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC1sYXN0XCIsIFwiUGxhY2UgYXMgbGFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICBcIk1vZCtBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoOTk5OTk5OTksIGZhbHNlKTsgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzZXR1cERpc3BsYXkoKSB7XG4gICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5iYWNrICAgID0gbmV3IE5hdmlnYXRvcih0aGlzLmFwcCwgXCJiYWNrXCIsIC0xKSk7XG4gICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5mb3J3YXJkID0gbmV3IE5hdmlnYXRvcih0aGlzLmFwcCwgXCJmb3J3YXJkXCIsIDEpKTtcbiAgICB9XG5cbiAgICBkaXNwbGF5KGhpc3RvcnkpIHtcbiAgICAgICAgdGhpcy5iYWNrLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgICAgIHRoaXMuZm9yd2FyZC5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UudW5yZWdpc3RlckhvdmVyTGlua1NvdXJjZShOYXZpZ2F0b3IuaG92ZXJTb3VyY2UpO1xuICAgIH1cblxuICAgIGdvdG9OdGhMZWFmKG4sIHJlbGF0aXZlKSB7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9IFtdO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZVJvb3RMZWF2ZXMoKGxlYWYpID0+IChsZWF2ZXMucHVzaChsZWFmKSwgZmFsc2UpKTtcbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICBuICs9IGxlYXZlcy5pbmRleE9mKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKTtcbiAgICAgICAgICAgIG4gPSAobiArIGxlYXZlcy5sZW5ndGgpICUgbGVhdmVzLmxlbmd0aDsgIC8vIHdyYXAgYXJvdW5kXG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbGVhZiA9IGxlYXZlc1tuPj1sZWF2ZXMubGVuZ3RoID8gbGVhdmVzLmxlbmd0aC0xIDogbl07XG4gICAgICAgICFsZWFmIHx8IHRoaXMuYXBwLndvcmtzcGFjZS5zZXRBY3RpdmVMZWFmKGxlYWYsIHRydWUsIHRydWUpO1xuICAgIH1cblxuICAgIHBsYWNlTGVhZih0b1BvcywgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBjYiA9IHRoaXMubGVhZlBsYWNlcih0b1BvcywgcmVsYXRpdmUpO1xuICAgICAgICBpZiAoY2IpIGNiKCk7XG4gICAgfVxuXG4gICAgbGVhZlBsYWNlcih0b1BvcywgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWY7XG4gICAgICAgIGlmICghbGVhZikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGNvbnN0XG4gICAgICAgICAgICBwYXJlbnRTcGxpdCA9IGxlYWYucGFyZW50U3BsaXQsXG4gICAgICAgICAgICBjaGlsZHJlbiA9IHBhcmVudFNwbGl0LmNoaWxkcmVuLFxuICAgICAgICAgICAgZnJvbVBvcyA9IGNoaWxkcmVuLmluZGV4T2YobGVhZilcbiAgICAgICAgO1xuICAgICAgICBpZiAoZnJvbVBvcyA9PSAtMSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICAgICAgdG9Qb3MgKz0gZnJvbVBvcztcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDAgfHwgdG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSB0b1BvcyA9IGNoaWxkcmVuLmxlbmd0aCAtIDE7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwKSB0b1BvcyA9IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZnJvbVBvcyA9PSB0b1BvcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvdGhlciA9IGNoaWxkcmVuW3RvUG9zXTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZShmcm9tUG9zLCAxKTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZSh0b1BvcywgICAwLCBsZWFmKTtcbiAgICAgICAgICAgIGlmIChwYXJlbnRTcGxpdC5zZWxlY3RUYWIpIHtcbiAgICAgICAgICAgICAgICBwYXJlbnRTcGxpdC5zZWxlY3RUYWIobGVhZik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG90aGVyLmNvbnRhaW5lckVsLmluc2VydEFkamFjZW50RWxlbWVudChmcm9tUG9zID4gdG9Qb3MgPyBcImJlZm9yZWJlZ2luXCIgOiBcImFmdGVyZW5kXCIsIGxlYWYuY29udGFpbmVyRWwpO1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnJlY29tcHV0ZUNoaWxkcmVuRGltZW5zaW9ucygpO1xuICAgICAgICAgICAgICAgIGxlYWYub25SZXNpemUoKTtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRDaGFuZ2UoKTtcblxuICAgICAgICAgICAgICAgIC8vIEZvcmNlIGZvY3VzIGJhY2sgdG8gcGFuZTtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgZmFsc2UsIHRydWUpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbiJdLCJuYW1lcyI6WyJOb3RpY2UiLCJXb3Jrc3BhY2VMZWFmIiwiQ29tcG9uZW50IiwiS2V5bWFwIiwiTWVudSIsIlBsdWdpbiIsIlRGaWxlIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUE7QUFDQTtBQUNBLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUNwQjtBQUNPLFNBQVMsT0FBTyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsT0FBTyxDQUFDLEVBQUUsRUFBRSxHQUFHLENBQUMsRUFBRSxFQUFFO0FBQ3REO0FBQ0E7QUFDQTtBQUNBLElBQUksSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLEVBQUUsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDekQsSUFBSSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3hFO0FBQ0EsSUFBSSxPQUFPLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFTLEdBQUcsRUFBRTtBQUN4QztBQUNBLFFBQVEsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLEVBQUUsT0FBTyxHQUFHLENBQUM7QUFD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T0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsSUFBSSxtQ0FBbUMsR0FBRyxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUN6SCxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxvQ0FBb0MsRUFBRSxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRTtBQUNoSTtBQUNBLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRTtBQUNsSSxZQUFZLENBQUMsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQ0FBZ0MsTUFBTSxXQUFXLENBQUMsRUFBRSxHQUFHLEVBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFDbEksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDLE1BQU0sV0FBVyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQ2xJLFlBQVksQ0FBQyxPQUFPLENBQUMsU0FBUyxHQUFHLGdDQUFnQyxNQUFNLFdBQVcsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLE1BQU0sSUFB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
