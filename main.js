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
            if (viewState.type === "media-view") {
                const oldInfo = JSON.stringify(this.viewState.state.info);
                const newInfo = JSON.stringify(viewState.state.info);
                if (oldInfo !== newInfo) return false;
            }
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
        if (this.leaf.working) return new obsidian.Notice("Pane is busy: please wait before navigating further"), undefined;
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

    plugin.register(around(app.workspace, {
        // Monkeypatch: load history during leaf load, if present
        deserializeLayout(old) { return async function deserializeLayout(state, ...etc){
            let result = await old.call(this, state, ...etc);
            if (state.type === "leaf") {
                if (!result) {
                    // Retry loading the pane as an empty
                    state.state.type = 'empty';
                    result = await old.call(this, state, ...etc);
                    if (!result) return result;
                }
                if (state[SERIAL_PROP]) result[HIST_ATTR] = new History(result, state[SERIAL_PROP]);
            }
            return result;
        }},
        // Monkeypatch: keep Obsidian from pushing history in setActiveLeaf
        setActiveLeaf(old) { return function setActiveLeaf(leaf, ...etc) {
            const unsub = around(this, {
                recordHistory(old) { return function (leaf, _push, ...args) {
                    // Always update state in place
                    return old.call(this, leaf, false, ...args);
                }; }
            });
            try {
                return old.call(this, leaf, ...etc);
            } finally {
                unsub();
            }
        }},
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
    video: "audio-file",
    pdf: "pdf-file",
    localgraph: "dot-network",
    outline: "bullet-list",
    backlink: "link",

    // third-party plugins
    kanban: "blocks",
    excalidraw: "excalidraw-icon",
    "media-view": "audio-file",
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
        menu.dom.on("mousedown", ".menu-item", e => {e.stopPropagation();}, true);
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
            if (type === "media-view" && !file) info.title = state.info?.filename ?? info.title;
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
            this.registerEvent(this.app.workspace.on("layout-change", this.numberPanes, this));
            this.numberPanes();
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

    numberPanes() {
        let count = 0, lastLeaf = null;
        this.app.workspace.iterateRootLeaves(leaf => {
            leaf.containerEl.style.setProperty("--pane-relief-label", ++count < 9 ? count : "");
            leaf.containerEl.toggleClass("has-pane-relief-label", count<9);
            lastLeaf = leaf;
        });
        if (count>8) {
            lastLeaf?.containerEl.style.setProperty("--pane-relief-label", "9");
            lastLeaf?.containerEl.toggleClass("has-pane-relief-label", true);
        }
    }

    onunload() {
        this.app.workspace.unregisterHoverLinkSource(Navigator.hoverSource);
        this.app.workspace.iterateRootLeaves(leaf => {
            leaf.containerEl.style.removeProperty("--pane-relief-label");
            leaf.containerEl.toggleClass("has-pane-relief-label", false);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4yLjAtMGI2YTA1MjY3MC0zMDk0NjdiNDQ1LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9OYXZpZ2F0b3IuanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmNvbnN0IGNvbW1hbmRzID0ge307XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kKGlkLCBuYW1lLCBob3RrZXlzPVtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgaG90a2V5cy5rZXkpIGhvdGtleXMgPSBbaG90a2V5c107XG5cbiAgICBob3RrZXlzID0gaG90a2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAga2V5ID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IGtleSwga2V5OiBrZXkucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kcyhwbHVnaW4sIGNtZHNldCkge1xuICAgIC8vIEV4dHJhY3QgY29tbWFuZCBzeW1ib2xzIGZyb20gY21kc2V0IGFuZCByZWdpc3RlciB0aGVtLCBib3VuZCB0byB0aGUgcGx1Z2luIGZvciBtZXRob2RzXG4gICAgT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scyhjbWRzZXQpLmZvckVhY2goc3ltID0+IHtcbiAgICAgICAgY29uc3QgY21kID0gY29tbWFuZHNbc3ltXSwgbWV0aG9kID0gY21kc2V0W3N5bV07XG4gICAgICAgIGlmIChjbWQpIHBsdWdpbi5hZGRDb21tYW5kKE9iamVjdC5hc3NpZ24oe30sIGNtZCwge1xuICAgICAgICAgICAgY2hlY2tDYWxsYmFjayhjaGVjaykge1xuICAgICAgICAgICAgICAgIC8vIENhbGwgdGhlIG1ldGhvZCBib2R5IHdpdGggdGhlIHBsdWdpbiBhcyAndGhpcydcbiAgICAgICAgICAgICAgICBjb25zdCBjYiA9IG1ldGhvZC5jYWxsKHBsdWdpbik7XG4gICAgICAgICAgICAgICAgLy8gSXQgdGhlbiByZXR1cm5zIGEgY2xvc3VyZSBpZiB0aGUgY29tbWFuZCBpcyByZWFkeSB0byBleGVjdXRlLCBhbmRcbiAgICAgICAgICAgICAgICAvLyB3ZSBjYWxsIHRoYXQgY2xvc3VyZSB1bmxlc3MgdGhpcyBpcyBqdXN0IGEgY2hlY2sgZm9yIGF2YWlsYWJpbGl0eVxuICAgICAgICAgICAgICAgIHJldHVybiAoY2hlY2sgfHwgdHlwZW9mIGNiICE9PSBcImZ1bmN0aW9uXCIpID8gISFjYiA6IChjYigpLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH0pXG59IiwiZXhwb3J0IGZ1bmN0aW9uIGFyb3VuZChvYmosIGZhY3Rvcmllcykge1xuICAgIGNvbnN0IHJlbW92ZXJzID0gT2JqZWN0LmtleXMoZmFjdG9yaWVzKS5tYXAoa2V5ID0+IGFyb3VuZDEob2JqLCBrZXksIGZhY3Rvcmllc1trZXldKSk7XG4gICAgcmV0dXJuIHJlbW92ZXJzLmxlbmd0aCA9PT0gMSA/IHJlbW92ZXJzWzBdIDogZnVuY3Rpb24gKCkgeyByZW1vdmVycy5mb3JFYWNoKHIgPT4gcigpKTsgfTtcbn1cbmZ1bmN0aW9uIGFyb3VuZDEob2JqLCBtZXRob2QsIGNyZWF0ZVdyYXBwZXIpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG9ialttZXRob2RdLCBoYWRPd24gPSBvYmouaGFzT3duUHJvcGVydHkobWV0aG9kKTtcbiAgICBsZXQgY3VycmVudCA9IGNyZWF0ZVdyYXBwZXIob3JpZ2luYWwpO1xuICAgIC8vIExldCBvdXIgd3JhcHBlciBpbmhlcml0IHN0YXRpYyBwcm9wcyBmcm9tIHRoZSB3cmFwcGluZyBtZXRob2QsXG4gICAgLy8gYW5kIHRoZSB3cmFwcGluZyBtZXRob2QsIHByb3BzIGZyb20gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgIGlmIChvcmlnaW5hbClcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGN1cnJlbnQsIG9yaWdpbmFsKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgY3VycmVudCk7XG4gICAgb2JqW21ldGhvZF0gPSB3cmFwcGVyO1xuICAgIC8vIFJldHVybiBhIGNhbGxiYWNrIHRvIGFsbG93IHNhZmUgcmVtb3ZhbFxuICAgIHJldHVybiByZW1vdmU7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBkZWFjdGl2YXRlZCBhbmQgYXJlIG5vIGxvbmdlciB3cmFwcGVkLCByZW1vdmUgb3Vyc2VsdmVzXG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbCAmJiBvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcilcbiAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICByZXR1cm4gY3VycmVudC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuICAgICAgICAvLyBJZiBubyBvdGhlciBwYXRjaGVzLCBqdXN0IGRvIGEgZGlyZWN0IHJlbW92YWxcbiAgICAgICAgaWYgKG9ialttZXRob2RdID09PSB3cmFwcGVyKSB7XG4gICAgICAgICAgICBpZiAoaGFkT3duKVxuICAgICAgICAgICAgICAgIG9ialttZXRob2RdID0gb3JpZ2luYWw7XG4gICAgICAgICAgICBlbHNlXG4gICAgICAgICAgICAgICAgZGVsZXRlIG9ialttZXRob2RdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbClcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgLy8gRWxzZSBwYXNzIGZ1dHVyZSBjYWxscyB0aHJvdWdoLCBhbmQgcmVtb3ZlIHdyYXBwZXIgZnJvbSB0aGUgcHJvdG90eXBlIGNoYWluXG4gICAgICAgIGN1cnJlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIG9yaWdpbmFsIHx8IEZ1bmN0aW9uKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXIocHJvbWlzZSwgY2IpIHtcbiAgICByZXR1cm4gcHJvbWlzZS50aGVuKGNiLCBjYik7XG59XG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplKGFzeW5jRnVuY3Rpb24pIHtcbiAgICBsZXQgbGFzdFJ1biA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4ge1xuICAgICAgICAgICAgYWZ0ZXIobGFzdFJ1biwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGFzeW5jRnVuY3Rpb24uYXBwbHkodGhpcywgYXJncykudGhlbihyZXMsIHJlaik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdyYXBwZXIuYWZ0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGFmdGVyKGxhc3RSdW4sIHJlcyk7IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHdyYXBwZXI7XG59XG4iLCJpbXBvcnQge05vdGljZSwgV29ya3NwYWNlTGVhZn0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmNvbnN0IEhJU1RfQVRUUiA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuY29uc3QgU0VSSUFMX1BST1AgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcblxuZnVuY3Rpb24gcGFyc2Uoc3RhdGUpIHtcbiAgICBpZiAodHlwZW9mIHN0YXRlLnN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5zdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGUuc3RhdGUpO1xuICAgIGlmICh0eXBlb2Ygc3RhdGUuZVN0YXRlID09PSBcInN0cmluZ1wiKSBzdGF0ZS5lU3RhdGUgPSBKU09OLnBhcnNlKHN0YXRlLmVTdGF0ZSk7XG4gICAgcmV0dXJuIHN0YXRlO1xufVxuXG5jbGFzcyBIaXN0b3J5RW50cnkge1xuICAgIGNvbnN0cnVjdG9yKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgIH1cblxuICAgIHNldFN0YXRlKHJhd1N0YXRlKSB7XG4gICAgICAgIHRoaXMucmF3ID0gcmF3U3RhdGU7XG4gICAgICAgIHRoaXMudmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICB0aGlzLmVTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuZVN0YXRlIHx8IFwibnVsbFwiKTtcbiAgICAgICAgdGhpcy5wYXRoID0gdGhpcy52aWV3U3RhdGUuc3RhdGU/LmZpbGU7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZSwgb2xkUGF0aCkge1xuICAgICAgICBpZiAodGhpcy5wYXRoID09PSBvbGRQYXRoKSB7XG4gICAgICAgICAgICB0aGlzLnBhdGggPSB0aGlzLnZpZXdTdGF0ZS5zdGF0ZS5maWxlID0gZmlsZS5wYXRoXG4gICAgICAgICAgICB0aGlzLnJhdy5zdGF0ZSA9IEpTT04uc3RyaW5naWZ5KHRoaXMudmlld1N0YXRlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvKGxlYWYpIHtcbiAgICAgICAgbGV0IHt2aWV3U3RhdGUsIHBhdGgsIGVTdGF0ZX0gPSB0aGlzO1xuICAgICAgICBsZXQgZmlsZSA9IHBhdGggJiYgbGVhZj8uYXBwPy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiTWlzc2luZyBmaWxlOiBcIitwYXRoKTtcbiAgICAgICAgICAgIHZpZXdTdGF0ZSA9IHt0eXBlOiBcImVtcHR5XCIsIHN0YXRlOnt9fTtcbiAgICAgICAgICAgIGVTdGF0ZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBsZWFmLnNldFZpZXdTdGF0ZSh7Li4udmlld1N0YXRlLCBhY3RpdmU6IHRydWUsIHBvcHN0YXRlOiB0cnVlfSwgZVN0YXRlKTtcbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGUpIHtcbiAgICAgICAgaWYgKHJhd1N0YXRlLnN0YXRlICE9PSB0aGlzLnJhdy5zdGF0ZSkge1xuICAgICAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgLy8gRG9uJ3QgcmVwbGFjZSBhIGZpbGUgd2l0aCBhbiBlbXB0eSBpbiB0aGUgaGlzdG9yeVxuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcImVtcHR5XCIpIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgLy8gRmlsZSBpcyBkaWZmZXJlbnQgZnJvbSBleGlzdGluZyBmaWxlOiBzaG91bGQgYmUgYSBwdXNoIGluc3RlYWRcbiAgICAgICAgICAgIGlmICh0aGlzLnBhdGggJiYgdGhpcy5wYXRoICE9PSB2aWV3U3RhdGU/LnN0YXRlPy5maWxlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBpZiAodmlld1N0YXRlLnR5cGUgPT09IFwibWVkaWEtdmlld1wiKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgb2xkSW5mbyA9IEpTT04uc3RyaW5naWZ5KHRoaXMudmlld1N0YXRlLnN0YXRlLmluZm8pO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5ld0luZm8gPSBKU09OLnN0cmluZ2lmeSh2aWV3U3RhdGUuc3RhdGUuaW5mbyk7XG4gICAgICAgICAgICAgICAgaWYgKG9sZEluZm8gIT09IG5ld0luZm8pIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB0aGlzLnNldFN0YXRlKHJhd1N0YXRlKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxufVxuXG5leHBvcnQgY2xhc3MgSGlzdG9yeSB7XG4gICAgc3RhdGljIGN1cnJlbnQoYXBwKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmZvckxlYWYoYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB8fCBuZXcgdGhpcygpO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JMZWFmKGxlYWYpIHtcbiAgICAgICAgaWYgKGxlYWYpIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gaW5zdGFuY2VvZiB0aGlzID9cbiAgICAgICAgICAgIGxlYWZbSElTVF9BVFRSXSA6XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcyhsZWFmLCBsZWFmW0hJU1RfQVRUUl0/LnNlcmlhbGl6ZSgpIHx8IHVuZGVmaW5lZCk7XG4gICAgfVxuXG4gICAgY29uc3RydWN0b3IobGVhZiwge3Bvcywgc3RhY2t9ID0ge3BvczowLCBzdGFjazpbXX0pIHtcbiAgICAgICAgdGhpcy5sZWFmID0gbGVhZjtcbiAgICAgICAgdGhpcy5wb3MgPSBwb3M7XG4gICAgICAgIHRoaXMuc3RhY2sgPSBzdGFjay5tYXAocmF3ID0+IG5ldyBIaXN0b3J5RW50cnkocmF3KSk7XG4gICAgfVxuXG4gICAgY2xvbmVUbyhsZWFmKSB7XG4gICAgICAgIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcy5jb25zdHJ1Y3RvcihsZWFmLCB0aGlzLnNlcmlhbGl6ZSgpKTtcbiAgICB9XG5cbiAgICBvblJlbmFtZShmaWxlLCBvbGRQYXRoKSB7XG4gICAgICAgIGZvcihjb25zdCBoaXN0RW50cnkgb2YgdGhpcy5zdGFjaykgaGlzdEVudHJ5Lm9uUmVuYW1lKGZpbGUsIG9sZFBhdGgpO1xuICAgIH1cblxuICAgIHNlcmlhbGl6ZSgpIHsgcmV0dXJuIHtwb3M6IHRoaXMucG9zLCBzdGFjazogdGhpcy5zdGFjay5tYXAoZSA9PiBlLnJhdyl9OyB9XG5cbiAgICBnZXQgc3RhdGUoKSB7IHJldHVybiB0aGlzLnN0YWNrW3RoaXMucG9zXT8ucmF3IHx8IG51bGw7IH1cbiAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gdGhpcy5zdGFjay5sZW5ndGg7IH1cblxuICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9XG4gICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH1cblxuICAgIGxvb2tBaGVhZCgpIHsgcmV0dXJuIHRoaXMuc3RhY2suc2xpY2UoMCwgdGhpcy5wb3MpLnJldmVyc2UoKTsgfVxuICAgIGxvb2tCZWhpbmQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKHRoaXMucG9zKzEpOyB9XG5cbiAgICBnb3RvKHBvcykge1xuICAgICAgICBpZiAoIXRoaXMubGVhZikgcmV0dXJuO1xuICAgICAgICBpZiAodGhpcy5sZWFmLnBpbm5lZCkgcmV0dXJuIG5ldyBOb3RpY2UoXCJQaW5uZWQgcGFuZTogdW5waW4gYmVmb3JlIGdvaW5nIGZvcndhcmQgb3IgYmFja1wiKSwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAodGhpcy5sZWFmLndvcmtpbmcpIHJldHVybiBuZXcgTm90aWNlKFwiUGFuZSBpcyBidXN5OiBwbGVhc2Ugd2FpdCBiZWZvcmUgbmF2aWdhdGluZyBmdXJ0aGVyXCIpLCB1bmRlZmluZWQ7XG4gICAgICAgIHBvcyA9IHRoaXMucG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4ocG9zLCB0aGlzLnN0YWNrLmxlbmd0aCAtIDEpKTtcbiAgICAgICAgdGhpcy5zdGFja1twb3NdPy5nbyh0aGlzLmxlYWYpO1xuICAgICAgICB0aGlzLmxlYWYuYXBwPy53b3Jrc3BhY2U/LnRyaWdnZXIoXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCB0aGlzLmxlYWYsIHRoaXMpO1xuICAgIH1cblxuICAgIGdvKGJ5LCBmb3JjZSkge1xuICAgICAgICBpZiAoIXRoaXMubGVhZiB8fCAhYnkpIHJldHVybjsgIC8vIG5vLW9wXG4gICAgICAgIC8vIHByZXZlbnQgd3JhcGFyb3VuZFxuICAgICAgICBjb25zdCBuZXdQb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbih0aGlzLnBvcyAtIGJ5LCB0aGlzLnN0YWNrLmxlbmd0aCAtIDEpKTtcbiAgICAgICAgaWYgKGZvcmNlIHx8IG5ld1BvcyAhPT0gdGhpcy5wb3MpIHtcbiAgICAgICAgICAgIHRoaXMuZ290byhuZXdQb3MpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbmV3IE5vdGljZShgTm8gbW9yZSAke2J5IDwgMCA/IFwiYmFja1wiIDogXCJmb3J3YXJkXCJ9IGhpc3RvcnkgZm9yIHBhbmVgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlcGxhY2VTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCl7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5zdGFja1t0aGlzLnBvc107XG4gICAgICAgIGlmICghZW50cnkpIHtcbiAgICAgICAgICAgIHRoaXMuc3RhY2tbdGhpcy5wb3NdID0gbmV3IEhpc3RvcnlFbnRyeShyYXdTdGF0ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWVudHJ5LnJlcGxhY2VTdGF0ZShyYXdTdGF0ZSkpIHtcbiAgICAgICAgICAgIC8vIHJlcGxhY2VTdGF0ZSB3YXMgZXJyb25lb3VzbHkgY2FsbGVkIHdpdGggYSBuZXcgZmlsZSBmb3IgdGhlIHNhbWUgbGVhZjtcbiAgICAgICAgICAgIC8vIGZvcmNlIGEgcHVzaFN0YXRlIGluc3RlYWQgKGZpeGVzIHRoZSBpc3N1ZSByZXBvcnRlZCBoZXJlOiBodHRwczovL2ZvcnVtLm9ic2lkaWFuLm1kL3QvMTg1MTgpXG4gICAgICAgICAgICB0aGlzLnB1c2hTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBwdXNoU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpICAge1xuICAgICAgICAvL2NvbnNvbGUubG9nKFwicHVzaGluZ1wiLCByYXdTdGF0ZSlcbiAgICAgICAgdGhpcy5zdGFjay5zcGxpY2UoMCwgdGhpcy5wb3MsIG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpKTtcbiAgICAgICAgdGhpcy5wb3MgPSAwO1xuICAgICAgICAvLyBMaW1pdCBcImJhY2tcIiB0byAyMFxuICAgICAgICB3aGlsZSAodGhpcy5zdGFjay5sZW5ndGggPiAyMCkgdGhpcy5zdGFjay5wb3AoKTtcbiAgICAgICAgdGhpcy5sZWFmLmFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKVxuICAgIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxIaXN0b3J5KHBsdWdpbikge1xuXG4gICAgY29uc3QgYXBwID0gcGx1Z2luLmFwcDtcblxuICAgIC8vIE1vbmtleXBhdGNoOiBpbmNsdWRlIGhpc3RvcnkgaW4gbGVhZiBzZXJpYWxpemF0aW9uIChzbyBpdCdzIHBlcnNpc3RlZCB3aXRoIHRoZSB3b3Jrc3BhY2UpXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChXb3Jrc3BhY2VMZWFmLnByb3RvdHlwZSwge1xuICAgICAgICBzZXJpYWxpemUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXJpYWxpemUoKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgaWYgKHRoaXNbSElTVF9BVFRSXSkgcmVzdWx0W1NFUklBTF9QUk9QXSA9IHRoaXNbSElTVF9BVFRSXS5zZXJpYWxpemUoKTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19XG4gICAgfSkpO1xuXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChhcHAud29ya3NwYWNlLCB7XG4gICAgICAgIC8vIE1vbmtleXBhdGNoOiBsb2FkIGhpc3RvcnkgZHVyaW5nIGxlYWYgbG9hZCwgaWYgcHJlc2VudFxuICAgICAgICBkZXNlcmlhbGl6ZUxheW91dChvbGQpIHsgcmV0dXJuIGFzeW5jIGZ1bmN0aW9uIGRlc2VyaWFsaXplTGF5b3V0KHN0YXRlLCAuLi5ldGMpe1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gUmV0cnkgbG9hZGluZyB0aGUgcGFuZSBhcyBhbiBlbXB0eVxuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5zdGF0ZS50eXBlID0gJ2VtcHR5JztcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgb2xkLmNhbGwodGhpcywgc3RhdGUsIC4uLmV0Yyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghcmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoc3RhdGVbU0VSSUFMX1BST1BdKSByZXN1bHRbSElTVF9BVFRSXSA9IG5ldyBIaXN0b3J5KHJlc3VsdCwgc3RhdGVbU0VSSUFMX1BST1BdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19LFxuICAgICAgICAvLyBNb25rZXlwYXRjaDoga2VlcCBPYnNpZGlhbiBmcm9tIHB1c2hpbmcgaGlzdG9yeSBpbiBzZXRBY3RpdmVMZWFmXG4gICAgICAgIHNldEFjdGl2ZUxlYWYob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXRBY3RpdmVMZWFmKGxlYWYsIC4uLmV0Yykge1xuICAgICAgICAgICAgY29uc3QgdW5zdWIgPSBhcm91bmQodGhpcywge1xuICAgICAgICAgICAgICAgIHJlY29yZEhpc3Rvcnkob2xkKSB7IHJldHVybiBmdW5jdGlvbiAobGVhZiwgX3B1c2gsIC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQWx3YXlzIHVwZGF0ZSBzdGF0ZSBpbiBwbGFjZVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgZmFsc2UsIC4uLmFyZ3MpO1xuICAgICAgICAgICAgICAgIH07IH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgLi4uZXRjKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgdW5zdWIoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfX0sXG4gICAgfSkpO1xuXG4gICAgLy8gT3ZlcnJpZGUgZGVmYXVsdCBtb3VzZSBoaXN0b3J5IGJlaGF2aW9yLiAgV2UgbmVlZCB0aGlzIGJlY2F1c2UgMSkgRWxlY3Ryb24gd2lsbCB1c2UgdGhlIGJ1aWx0LWluXG4gICAgLy8gaGlzdG9yeSBvYmplY3QgaWYgd2UgZG9uJ3QgKGluc3RlYWQgb2Ygb3VyIHdyYXBwZXIpLCBhbmQgMikgd2Ugd2FudCB0aGUgY2xpY2sgdG8gYXBwbHkgdG8gdGhlIGxlYWZcbiAgICAvLyB0aGF0IHdhcyB1bmRlciB0aGUgbW91c2UsIHJhdGhlciB0aGFuIHdoaWNoZXZlciBsZWFmIHdhcyBhY3RpdmUuXG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoICgpID0+IHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSkgKTtcbiAgICBmdW5jdGlvbiBoaXN0b3J5SGFuZGxlcihlKSB7XG4gICAgICAgIGlmIChlLmJ1dHRvbiAhPT0gMyAmJiBlLmJ1dHRvbiAhPT0gNCkgcmV0dXJuO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7ICAvLyBwcmV2ZW50IGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQubWF0Y2hQYXJlbnQoXCIud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgIGlmICh0YXJnZXQpIHtcbiAgICAgICAgICAgIGxldCBsZWFmO1xuICAgICAgICAgICAgYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKGwgPT4gbGVhZiA9IChsLmNvbnRhaW5lckVsID09PSB0YXJnZXQpID8gbCA6IGxlYWYpO1xuICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDMpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmJhY2soKTsgfVxuICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDQpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmZvcndhcmQoKTsgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBQcm94eSB0aGUgd2luZG93IGhpc3Rvcnkgd2l0aCBhIHdyYXBwZXIgdGhhdCBkZWxlZ2F0ZXMgdG8gdGhlIGFjdGl2ZSBsZWFmJ3MgSGlzdG9yeSBvYmplY3QsXG4gICAgY29uc3QgcmVhbEhpc3RvcnkgPSB3aW5kb3cuaGlzdG9yeTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoKCkgPT4gd2luZG93Lmhpc3RvcnkgPSByZWFsSGlzdG9yeSk7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJoaXN0b3J5XCIsIHsgZW51bWVyYWJsZTogdHJ1ZSwgY29uZmlndXJhYmxlOiB0cnVlLCB3cml0YWJsZTogdHJ1ZSwgdmFsdWU6IHtcbiAgICAgICAgZ2V0IHN0YXRlKCkgICAgICB7IHJldHVybiBIaXN0b3J5LmN1cnJlbnQoYXBwKS5zdGF0ZTsgfSxcbiAgICAgICAgZ2V0IGxlbmd0aCgpICAgICB7IHJldHVybiBIaXN0b3J5LmN1cnJlbnQoYXBwKS5sZW5ndGg7IH0sXG5cbiAgICAgICAgYmFjaygpICAgIHsgdGhpcy5nbygtMSk7IH0sXG4gICAgICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9LFxuICAgICAgICBnbyhieSkgICAgeyBIaXN0b3J5LmN1cnJlbnQoYXBwKS5nbyhieSk7IH0sXG5cbiAgICAgICAgcmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKXsgSGlzdG9yeS5jdXJyZW50KGFwcCkucmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcbiAgICAgICAgcHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKSAgIHsgSGlzdG9yeS5jdXJyZW50KGFwcCkucHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcblxuICAgICAgICBnZXQgc2Nyb2xsUmVzdG9yYXRpb24oKSAgICB7IHJldHVybiByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbjsgfSxcbiAgICAgICAgc2V0IHNjcm9sbFJlc3RvcmF0aW9uKHZhbCkgeyByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbiA9IHZhbDsgfSxcbiAgICB9fSk7XG5cbn1cbiIsImltcG9ydCB7TWVudSwgS2V5bWFwLCBDb21wb25lbnR9IGZyb20gJ29ic2lkaWFuJztcblxuY29uc3Qgdmlld3R5cGVJY29ucyA9IHtcbiAgICBtYXJrZG93bjogXCJkb2N1bWVudFwiLFxuICAgIGltYWdlOiBcImltYWdlLWZpbGVcIixcbiAgICBhdWRpbzogXCJhdWRpby1maWxlXCIsXG4gICAgdmlkZW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHBkZjogXCJwZGYtZmlsZVwiLFxuICAgIGxvY2FsZ3JhcGg6IFwiZG90LW5ldHdvcmtcIixcbiAgICBvdXRsaW5lOiBcImJ1bGxldC1saXN0XCIsXG4gICAgYmFja2xpbms6IFwibGlua1wiLFxuXG4gICAgLy8gdGhpcmQtcGFydHkgcGx1Z2luc1xuICAgIGthbmJhbjogXCJibG9ja3NcIixcbiAgICBleGNhbGlkcmF3OiBcImV4Y2FsaWRyYXctaWNvblwiLFxuICAgIFwibWVkaWEtdmlld1wiOiBcImF1ZGlvLWZpbGVcIixcbn1cblxuY29uc3Qgbm9uRmlsZVZpZXdzID0ge1xuICAgIGdyYXBoOiBbXCJkb3QtbmV0d29ya1wiLCBcIkdyYXBoIFZpZXdcIl0sXG4gICAgXCJmaWxlLWV4cGxvcmVyXCI6IFtcImZvbGRlclwiLCBcIkZpbGUgRXhwbG9yZXJcIl0sXG4gICAgc3RhcnJlZDogW1wic3RhclwiLCBcIlN0YXJyZWQgRmlsZXNcIl0sXG4gICAgdGFnOiBbXCJ0YWdcIiwgXCJUYWdzIFZpZXdcIl0sXG5cbiAgICAvLyB0aGlyZC1wYXJ0eSBwbHVnaW5zXG4gICAgXCJyZWNlbnQtZmlsZXNcIjogW1wiY2xvY2tcIiwgXCJSZWNlbnQgRmlsZXNcIl0sXG4gICAgY2FsZW5kYXI6IFtcImNhbGVuZGFyLXdpdGgtY2hlY2ttYXJrXCIsIFwiQ2FsZW5kYXJcIl0sXG4gICAgZW1wdHk6IFtcImNyb3NzXCIsIFwiTm8gZmlsZVwiXVxufVxuXG5leHBvcnQgY2xhc3MgTmF2aWdhdG9yIGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIHN0YXRpYyBob3ZlclNvdXJjZSA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS1tZW51XCI7XG5cbiAgICBjb25zdHJ1Y3RvcihhcHAsIGtpbmQsIGRpcikgIHtcbiAgICAgICAgc3VwZXIoKTtcbiAgICAgICAgdGhpcy5hcHAgPSBhcHA7XG4gICAgICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgICAgIHRoaXMuZGlyID0gZGlyO1xuICAgIH1cblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgdGhpcy5jb250YWluZXJFbCA9IGRvY3VtZW50LmJvZHkuZmluZChcbiAgICAgICAgICAgIGAudGl0bGViYXIgLnRpdGxlYmFyLWJ1dHRvbi1jb250YWluZXIubW9kLWxlZnQgLnRpdGxlYmFyLWJ1dHRvbi5tb2QtJHt0aGlzLmtpbmR9YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvdW50ID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVTcGFuKHtwcmVwZW5kOiB0aGlzLmtpbmQgPT09IFwiYmFja1wiLCBjbHM6IFwiaGlzdG9yeS1jb3VudGVyXCJ9KTtcbiAgICAgICAgdGhpcy5sZWFmID0gbnVsbDtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gbnVsbDtcbiAgICAgICAgdGhpcy5zdGF0ZXMgPSBbXTtcbiAgICAgICAgdGhpcy5vbGRMYWJlbCA9IHRoaXMuY29udGFpbmVyRWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckRvbUV2ZW50KHRoaXMuY29udGFpbmVyRWwsIFwiY29udGV4dG1lbnVcIiwgdGhpcy5vcGVuTWVudS5iaW5kKHRoaXMpKTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHRoaXMub2xkTGFiZWwpO1xuICAgICAgICB0aGlzLmNvdW50LmRldGFjaCgpO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc2V0Q291bnQobnVtKSB7IHRoaXMuY291bnQudGV4dENvbnRlbnQgPSBudW0gfHwgXCJcIjsgfVxuXG4gICAgc2V0VG9vbHRpcCh0ZXh0KSB7XG4gICAgICAgIGlmICh0ZXh0KSB0aGlzLmNvbnRhaW5lckVsLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdGV4dCB8fCB1bmRlZmluZWQpO1xuICAgICAgICBlbHNlIHRoaXMuY29udGFpbmVyRWwucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICB9XG5cbiAgICBzZXRIaXN0b3J5KGhpc3RvcnkpIHtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gaGlzdG9yeTtcbiAgICAgICAgY29uc3Qgc3RhdGVzID0gdGhpcy5zdGF0ZXMgPSBoaXN0b3J5W3RoaXMuZGlyIDwgMCA/IFwibG9va0JlaGluZFwiIDogXCJsb29rQWhlYWRcIl0uY2FsbChoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5zZXRDb3VudChzdGF0ZXMubGVuZ3RoKTtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHN0YXRlcy5sZW5ndGggP1xuICAgICAgICAgICAgdGhpcy5vbGRMYWJlbCArIFwiXFxuXCIgKyB0aGlzLmZvcm1hdFN0YXRlKHN0YXRlc1swXSkudGl0bGUgOlxuICAgICAgICAgICAgYE5vICR7dGhpcy5raW5kfSBoaXN0b3J5YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBzdGF0ZXMubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgb3Blbk1lbnUoZXZ0KSB7XG4gICAgICAgIGlmICghdGhpcy5zdGF0ZXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIGNvbnN0IG1lbnUgPSBjcmVhdGVNZW51KHRoaXMuYXBwKTtcbiAgICAgICAgbWVudS5kb20uc3R5bGUuc2V0UHJvcGVydHkoXG4gICAgICAgICAgICAvLyBBbGxvdyBwb3BvdmVycyAoaG92ZXIgcHJldmlldykgdG8gb3ZlcmxheSB0aGlzIG1lbnVcbiAgICAgICAgICAgIFwiLS1sYXllci1tZW51XCIsIGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuZ2V0UHJvcGVydHlWYWx1ZShcIi0tbGF5ZXItcG9wb3ZlclwiKS0xXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuZG9tLm9uKFwibW91c2Vkb3duXCIsIFwiLm1lbnUtaXRlbVwiLCBlID0+IHtlLnN0b3BQcm9wYWdhdGlvbigpO30sIHRydWUpO1xuICAgICAgICB0aGlzLnN0YXRlcy5tYXAodGhpcy5mb3JtYXRTdGF0ZS5iaW5kKHRoaXMpKS5mb3JFYWNoKFxuICAgICAgICAgICAgKGluZm8sIGlkeCkgPT4gdGhpcy5tZW51SXRlbShpbmZvLCBpZHgsIG1lbnUpXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGV2dC5jbGllbnRYLCB5OiBldnQuY2xpZW50WSArIDIwfSk7XG4gICAgfVxuXG4gICAgbWVudUl0ZW0oaW5mbywgaWR4LCBtZW51KSB7XG4gICAgICAgIGNvbnN0IG15ID0gdGhpcztcbiAgICAgICAgbWVudS5hZGRJdGVtKGkgPT4geyBjcmVhdGVJdGVtKGkpOyBpZiAoaW5mby5maWxlKSBzZXR1cEZpbGVFdmVudHMoaS5kb20pOyB9KTtcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAgIGZ1bmN0aW9uIGNyZWF0ZUl0ZW0oaSwgcHJlZml4PVwiXCIpIHtcbiAgICAgICAgICAgIGkuc2V0SWNvbihpbmZvLmljb24pLnNldFRpdGxlKHByZWZpeCArIGluZm8udGl0bGUpLm9uQ2xpY2soZSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGhpc3RvcnkgPSBteS5oaXN0b3J5O1xuICAgICAgICAgICAgICAgIC8vIENoZWNrIGZvciBjdHJsL2NtZC9taWRkbGUgYnV0dG9uIGFuZCBzcGxpdCBsZWFmICsgY29weSBoaXN0b3J5XG4gICAgICAgICAgICAgICAgaWYgKEtleW1hcC5pc01vZGlmaWVyKGUsIFwiTW9kXCIpIHx8IDEgPT09IGUuYnV0dG9uKSB7XG4gICAgICAgICAgICAgICAgICAgIGhpc3RvcnkgPSBoaXN0b3J5LmNsb25lVG8obXkuYXBwLndvcmtzcGFjZS5zcGxpdEFjdGl2ZUxlYWYoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGhpc3RvcnkuZ28oKGlkeCsxKSAqIG15LmRpciwgdHJ1ZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwRmlsZUV2ZW50cyhkb20pIHtcbiAgICAgICAgICAgIC8vIEhvdmVyIHByZXZpZXdcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW92ZXInLCBlID0+IHtcbiAgICAgICAgICAgICAgICBteS5hcHAud29ya3NwYWNlLnRyaWdnZXIoJ2hvdmVyLWxpbmsnLCB7XG4gICAgICAgICAgICAgICAgICAgIGV2ZW50OiBlLCBzb3VyY2U6IE5hdmlnYXRvci5ob3ZlclNvdXJjZSxcbiAgICAgICAgICAgICAgICAgICAgaG92ZXJQYXJlbnQ6IG1lbnUuZG9tLCB0YXJnZXRFbDogZG9tLCBsaW5rdGV4dDogaW5mby5maWxlLnBhdGhcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBEcmFnIG1lbnUgaXRlbSB0byBtb3ZlIG9yIGxpbmsgZmlsZVxuICAgICAgICAgICAgZG9tLnNldEF0dHIoJ2RyYWdnYWJsZScsICd0cnVlJyk7XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgZHJhZ01hbmFnZXIgPSBteS5hcHAuZHJhZ01hbmFnZXI7XG4gICAgICAgICAgICAgICAgY29uc3QgZHJhZ0RhdGEgPSBkcmFnTWFuYWdlci5kcmFnRmlsZShlLCBpbmZvLmZpbGUpO1xuICAgICAgICAgICAgICAgIGRyYWdNYW5hZ2VyLm9uRHJhZ1N0YXJ0KGUsIGRyYWdEYXRhKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdlbmQnLCBlID0+IG1lbnUuaGlkZSgpKTtcblxuICAgICAgICAgICAgLy8gRmlsZSBtZW51XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcihcImNvbnRleHRtZW51XCIsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IG1lbnUgPSBjcmVhdGVNZW51KG15LmFwcCk7XG4gICAgICAgICAgICAgICAgbWVudS5hZGRJdGVtKGkgPT4gY3JlYXRlSXRlbShpLCBgR28gJHtteS5raW5kfSB0byBgKSkuYWRkU2VwYXJhdG9yKCk7XG4gICAgICAgICAgICAgICAgbXkuYXBwLndvcmtzcGFjZS50cmlnZ2VyKFxuICAgICAgICAgICAgICAgICAgICBcImZpbGUtbWVudVwiLCBtZW51LCBpbmZvLmZpbGUsIFwibGluay1jb250ZXh0LW1lbnVcIlxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgbWVudS5zaG93QXRQb3NpdGlvbih7eDogZS5jbGllbnRYLCB5OiBlLmNsaWVudFl9KTtcbiAgICAgICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOyAvLyBrZWVwIHRoZSBwYXJlbnQgbWVudSBvcGVuIGZvciBub3dcbiAgICAgICAgICAgIH0sIHRydWUpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZm9ybWF0U3RhdGUoZW50cnkpIHtcbiAgICAgICAgY29uc3Qge3ZpZXdTdGF0ZToge3R5cGUsIHN0YXRlfSwgZVN0YXRlLCBwYXRofSA9IGVudHJ5O1xuICAgICAgICBjb25zdCBmaWxlID0gcGF0aCAmJiB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGNvbnN0IGluZm8gPSB7aWNvbjogXCJcIiwgdGl0bGU6IFwiXCIsIGZpbGUsIHR5cGUsIHN0YXRlLCBlU3RhdGV9O1xuXG4gICAgICAgIGlmIChub25GaWxlVmlld3NbdHlwZV0pIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gbm9uRmlsZVZpZXdzW3R5cGVdO1xuICAgICAgICB9IGVsc2UgaWYgKHBhdGggJiYgIWZpbGUpIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gW1widHJhc2hcIiwgXCJNaXNzaW5nIGZpbGUgXCIrcGF0aF07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpbmZvLmljb24gPSB2aWV3dHlwZUljb25zW3R5cGVdID8/IFwiZG9jdW1lbnRcIjtcbiAgICAgICAgICAgIGlmICh0eXBlID09PSBcIm1hcmtkb3duXCIgJiYgc3RhdGUubW9kZSA9PT0gXCJwcmV2aWV3XCIpIGluZm8uaWNvbiA9IFwibGluZXMtb2YtdGV4dFwiO1xuICAgICAgICAgICAgaW5mby50aXRsZSA9IGZpbGUgPyBmaWxlLmJhc2VuYW1lICsgKGZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIgPyBcIi5cIitmaWxlLmV4dGVuc2lvbiA6IFwiXCIpIDogXCJObyBmaWxlXCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtZWRpYS12aWV3XCIgJiYgIWZpbGUpIGluZm8udGl0bGUgPSBzdGF0ZS5pbmZvPy5maWxlbmFtZSA/PyBpbmZvLnRpdGxlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnRyaWdnZXIoXCJwYW5lLXJlbGllZjpmb3JtYXQtaGlzdG9yeS1pdGVtXCIsIGluZm8pO1xuICAgICAgICByZXR1cm4gaW5mbztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIG9uRWxlbWVudChlbCwgZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucykge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWVudShhcHApIHtcbiAgICBjb25zdCBtZW51ID0gbmV3IE1lbnUoYXBwKTtcbiAgICBtZW51LnJlZ2lzdGVyKFxuICAgICAgICAvLyBYWFggdGhpcyByZWFsbHkgc2hvdWxkIGJlIGEgc2NvcGUgcHVzaFxuICAgICAgICBvbkVsZW1lbnQoZG9jdW1lbnQsIFwia2V5ZG93blwiLCBcIipcIiwgZSA9PiB7XG4gICAgICAgICAgICBpZiAoZS5rZXk9PT1cIkVzY2FwZVwiKSB7XG4gICAgICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgbWVudS5oaWRlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHtjYXB0dXJlOiB0cnVlfSlcbiAgICApO1xuICAgIHJldHVybiBtZW51O1xufSIsImltcG9ydCB7TWVudSwgUGx1Z2luLCBURmlsZX0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthZGRDb21tYW5kcywgY29tbWFuZH0gZnJvbSBcIi4vY29tbWFuZHNcIjtcbmltcG9ydCB7SGlzdG9yeSwgaW5zdGFsbEhpc3Rvcnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcbmltcG9ydCB7TmF2aWdhdG9yfSBmcm9tIFwiLi9OYXZpZ2F0b3JcIjtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGFuZVJlbGllZiBleHRlbmRzIFBsdWdpbiB7XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIGluc3RhbGxIaXN0b3J5KHRoaXMpO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlLCB7XG4gICAgICAgICAgICBkaXNwbGF5OiAnSGlzdG9yeSBkcm9wZG93bnMnLCBkZWZhdWx0TW9kOiB0cnVlXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnNldHVwRGlzcGxheSgpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKFwicmVuYW1lXCIsIChmaWxlLCBvbGRQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMoXG4gICAgICAgICAgICAgICAgICAgIGxlYWYgPT4gSGlzdG9yeS5mb3JMZWFmKGxlYWYpLm9uUmVuYW1lKGZpbGUsIG9sZFBhdGgpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCAobGVhZiwgaGlzdG9yeSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChsZWFmID09PSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgdGhpcy5kaXNwbGF5KGhpc3RvcnkpO1xuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLndvcmtzcGFjZS5vbihcImFjdGl2ZS1sZWFmLWNoYW5nZVwiLCBsZWFmID0+IHRoaXMuZGlzcGxheShIaXN0b3J5LmZvckxlYWYobGVhZikpKSk7XG4gICAgICAgICAgICBpZiAodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHRoaXMuZGlzcGxheShIaXN0b3J5LmZvckxlYWYodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oXCJsYXlvdXQtY2hhbmdlXCIsIHRoaXMubnVtYmVyUGFuZXMsIHRoaXMpKTtcbiAgICAgICAgICAgIHRoaXMubnVtYmVyUGFuZXMoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYWRkQ29tbWFuZHModGhpcywge1xuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLXByZXZcIiwgXCJTd2FwIHBhbmUgd2l0aCBwcmV2aW91cyBpbiBzcGxpdFwiLCAgXCJNb2QrU2hpZnQrUGFnZVVwXCIpXSAgICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKC0xKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1uZXh0XCIsIFwiU3dhcCBwYW5lIHdpdGggbmV4dCBpbiBzcGxpdFwiLCAgICAgIFwiTW9kK1NoaWZ0K1BhZ2VEb3duXCIpXSAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlciggMSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tcHJldlwiLCAgXCJDeWNsZSB0byBwcmV2aW91cyB3b3Jrc3BhY2UgcGFuZVwiLCAgIFwiTW9kK1BhZ2VVcFwiICApXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKC0xLCB0cnVlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbmV4dFwiLCAgXCJDeWNsZSB0byBuZXh0IHdvcmtzcGFjZSBwYW5lXCIsICAgICAgIFwiTW9kK1BhZ2VEb3duXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKCAxLCB0cnVlKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0xc3RcIiwgICBcIkp1bXAgdG8gMXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigwKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMm5kXCIsICAgXCJKdW1wIHRvIDJuZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTNyZFwiLCAgIFwiSnVtcCB0byAzcmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDIpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby00dGhcIiwgICBcIkp1bXAgdG8gNHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigzKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNXRoXCIsICAgXCJKdW1wIHRvIDV0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTZ0aFwiLCAgIFwiSnVtcCB0byA2dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby03dGhcIiwgICBcIkp1bXAgdG8gN3RoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig2KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tOHRoXCIsICAgXCJKdW1wIHRvIDh0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLWxhc3RcIiwgIFwiSnVtcCB0byBsYXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCBcIkFsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDk5OTk5OTk5KTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMXN0XCIsICBcIlBsYWNlIGFzIDFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDAsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTJuZFwiLCAgXCJQbGFjZSBhcyAybmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigxLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0zcmRcIiwgIFwiUGxhY2UgYXMgM3JkIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNHRoXCIsICBcIlBsYWNlIGFzIDR0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDMsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTV0aFwiLCAgXCJQbGFjZSBhcyA1dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig0LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC02dGhcIiwgIFwiUGxhY2UgYXMgNnRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtN3RoXCIsICBcIlBsYWNlIGFzIDd0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDYsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTh0aFwiLCAgXCJQbGFjZSBhcyA4dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig3LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC1sYXN0XCIsIFwiUGxhY2UgYXMgbGFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICBcIk1vZCtBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoOTk5OTk5OTksIGZhbHNlKTsgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzZXR1cERpc3BsYXkoKSB7XG4gICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5iYWNrICAgID0gbmV3IE5hdmlnYXRvcih0aGlzLmFwcCwgXCJiYWNrXCIsIC0xKSk7XG4gICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5mb3J3YXJkID0gbmV3IE5hdmlnYXRvcih0aGlzLmFwcCwgXCJmb3J3YXJkXCIsIDEpKTtcbiAgICB9XG5cbiAgICBkaXNwbGF5KGhpc3RvcnkpIHtcbiAgICAgICAgdGhpcy5iYWNrLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgICAgIHRoaXMuZm9yd2FyZC5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgIH1cblxuICAgIG51bWJlclBhbmVzKCkge1xuICAgICAgICBsZXQgY291bnQgPSAwLCBsYXN0TGVhZiA9IG51bGw7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlUm9vdExlYXZlcyhsZWFmID0+IHtcbiAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwuc3R5bGUuc2V0UHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWxhYmVsXCIsICsrY291bnQgPCA5ID8gY291bnQgOiBcIlwiKTtcbiAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgY291bnQ8OSk7XG4gICAgICAgICAgICBsYXN0TGVhZiA9IGxlYWY7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoY291bnQ+OCkge1xuICAgICAgICAgICAgbGFzdExlYWY/LmNvbnRhaW5lckVsLnN0eWxlLnNldFByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiLCBcIjlcIik7XG4gICAgICAgICAgICBsYXN0TGVhZj8uY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnVucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlKTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVSb290TGVhdmVzKGxlYWYgPT4ge1xuICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5yZW1vdmVQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtbGFiZWxcIik7XG4gICAgICAgICAgICBsZWFmLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwiaGFzLXBhbmUtcmVsaWVmLWxhYmVsXCIsIGZhbHNlKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZ290b050aExlYWYobiwgcmVsYXRpdmUpIHtcbiAgICAgICAgY29uc3QgbGVhdmVzID0gW107XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlUm9vdExlYXZlcygobGVhZikgPT4gKGxlYXZlcy5wdXNoKGxlYWYpLCBmYWxzZSkpO1xuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIG4gKz0gbGVhdmVzLmluZGV4T2YodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpO1xuICAgICAgICAgICAgbiA9IChuICsgbGVhdmVzLmxlbmd0aCkgJSBsZWF2ZXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBsZWFmID0gbGVhdmVzW24+PWxlYXZlcy5sZW5ndGggPyBsZWF2ZXMubGVuZ3RoLTEgOiBuXTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGNiID0gdGhpcy5sZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZSk7XG4gICAgICAgIGlmIChjYikgY2IoKTtcbiAgICB9XG5cbiAgICBsZWFmUGxhY2VyKHRvUG9zLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgY29uc3RcbiAgICAgICAgICAgIHBhcmVudFNwbGl0ID0gbGVhZi5wYXJlbnRTcGxpdCxcbiAgICAgICAgICAgIGNoaWxkcmVuID0gcGFyZW50U3BsaXQuY2hpbGRyZW4sXG4gICAgICAgICAgICBmcm9tUG9zID0gY2hpbGRyZW4uaW5kZXhPZihsZWFmKVxuICAgICAgICA7XG4gICAgICAgIGlmIChmcm9tUG9zID09IC0xKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICB0b1BvcyArPSBmcm9tUG9zO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCB8fCB0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHRvUG9zID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDApIHRvUG9zID0gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmcm9tUG9zID09IHRvUG9zKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG90aGVyID0gY2hpbGRyZW5bdG9Qb3NdO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKGZyb21Qb3MsIDEpO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKHRvUG9zLCAgIDAsIGxlYWYpO1xuICAgICAgICAgICAgaWYgKHBhcmVudFNwbGl0LnNlbGVjdFRhYikge1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnNlbGVjdFRhYihsZWFmKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb3RoZXIuY29udGFpbmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KGZyb21Qb3MgPiB0b1BvcyA/IFwiYmVmb3JlYmVnaW5cIiA6IFwiYWZ0ZXJlbmRcIiwgbGVhZi5jb250YWluZXJFbCk7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQucmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk7XG4gICAgICAgICAgICAgICAgbGVhZi5vblJlc2l6ZSgpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dENoYW5nZSgpO1xuXG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgZm9jdXMgYmFjayB0byBwYW5lO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCBmYWxzZSwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuIl0sIm5hbWVzIjpbIk5vdGljZSIsIldvcmtzcGFjZUxlYWYiLCJDb21wb25lbnQiLCJLZXltYXAiLCJNZW51IiwiUGx1Z2luIiwiVEZpbGUiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQTtBQUNBO0FBQ0EsTUFBTSxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQ3BCO0FBQ08sU0FBUyxPQUFPLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFLEVBQUU7QUFDdEQ7QUFDQTtBQUNBO0FBQ0EsSUFBSSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsRUFBRSxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN6RCxJQUFJLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDeEU7QUFDQSxJQUFJLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsR0FBRyxFQUFFO0FBQ3hDO0FBQ0EsUUFBUSxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxPQUFPLEdBQUcsQ0FBQztBQUNoRDtBQUNBLFFBQVEsR0FBRyxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFDO0FBQzVCLFFBQVEsT0FBTyxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxHQUFHLEVBQUU7QUFDeEQsS0FBSyxDQUFDLENBQUM7QUFDUCxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQzVDO0FBQ0E7QUFDQSxJQUFJLE1BQU0sR0FBRyxHQUFHLE1BQU0s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O0FBQ0EsSUFBSSxXQUFXLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLEVBQUU7QUFDeEQsUUFBUSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztBQUN6QixRQUFRLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO0FBQ3ZCLFFBQVEsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxJQUFJLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzdELEtBQUs7QUFDTDtBQUNBLElBQUksT0FBTyxDQUFDLElBQUksRUFBRTtBQUNsQixRQUFRLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLENBQUM7QUFDOUUsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUM1QixRQUFRLElBQUksTUFBTSxTQUFTLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztBQUM3RSxLQUFLO0FBQ0w7QUFDQSxJQUFJLFNBQVMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUU7QUFDQSxJQUFJLElBQUksS0FBSyxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxHQUFHLElBQUksSUFBSSxDQUFDLEVBQUU7QUFDN0QsSUFBSSxJQUFJLE1BQU0sR0FBRyxFQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRTtBQUM5QztBQUNBLElBQUksSUFBSSxNQUFNLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUIsSUFBSSxPQUFPLEdBQUcsRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUI7QUFDQSxJQUFJLFNBQVMsR0FBRyxFQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxFQUFFO0FBQ25FLElBQUksVUFBVSxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekQ7QUFDQSxJQUFJLElBQUksQ0FBQyxHQUFHLEVBQUU7QUFDZCxRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU87QUFDL0IsUUFBUSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLE9BQU8sSUFBSUEsZUFBTSxDQUFDLGlEQUFpRCxDQUFDLEVBQUUsU0FBUyxDQUFDO0FBQzlHLFFBQVEsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxPQUFPLElBQUlBLGVBQU0sQ0FBQyxxREFBcUQsQ0FBQyxFQUFFLFNBQVMsQ0FBQztBQUNuSCxRQUFRLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0UsUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFD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QUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEVBQUU7QUFDdkksWUFBWSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsOEJBQThCLFFBQVEsY0FBYyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFO0FBQ3ZJO0FBQ0EsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDekgsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksbUNBQW1DLEdBQUcsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLE9BQU8s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
