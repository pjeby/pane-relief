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

const domLeaves = new WeakMap();

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
        if (leaf) domLeaves.set(leaf.containerEl, leaf);
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
            let leaf = domLeaves.get(target);
            if (!leaf) app.workspace.iterateAllLeaves(l => leaf = (l.containerEl === target) ? l : leaf);
            if (!leaf) return false;
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

    constructor(plugin, kind, dir)  {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
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

    setHistory(history = History.current(this.app)) {
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
        menu.dom.addClass("pane-relief-history-menu");
        menu.dom.on("mousedown", ".menu-item", e => {e.stopPropagation();}, true);
        this.states.map(this.formatState.bind(this)).forEach(
            (info, idx) => this.menuItem(info, idx, menu)
        );
        menu.showAtPosition({x: evt.clientX, y: evt.clientY + 20});
        this.plugin.historyIsOpen = true;
        menu.onHide(() => { this.plugin.historyIsOpen = false; this.setHistory(); });
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
        this.addChild(this.back    = new Navigator(this, "back", -1));
        this.addChild(this.forward = new Navigator(this, "forward", 1));
    }

    // Set to true while either menu is open, so we don't switch it out
    historyIsOpen = false;

    display(history) {
        if (this.historyIsOpen) return;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLmpzIiwiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4zLjAtOWYxZGEwYTM5OS1jYWYyYTI2NTc5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvSGlzdG9yeS5qcyIsInNyYy9OYXZpZ2F0b3IuanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmNvbnN0IGNvbW1hbmRzID0ge307XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kKGlkLCBuYW1lLCBob3RrZXlzPVtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgaG90a2V5cy5rZXkpIGhvdGtleXMgPSBbaG90a2V5c107XG5cbiAgICBob3RrZXlzID0gaG90a2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAga2V5ID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IGtleSwga2V5OiBrZXkucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kcyhwbHVnaW4sIGNtZHNldCkge1xuICAgIC8vIEV4dHJhY3QgY29tbWFuZCBzeW1ib2xzIGZyb20gY21kc2V0IGFuZCByZWdpc3RlciB0aGVtLCBib3VuZCB0byB0aGUgcGx1Z2luIGZvciBtZXRob2RzXG4gICAgT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scyhjbWRzZXQpLmZvckVhY2goc3ltID0+IHtcbiAgICAgICAgY29uc3QgY21kID0gY29tbWFuZHNbc3ltXSwgbWV0aG9kID0gY21kc2V0W3N5bV07XG4gICAgICAgIGlmIChjbWQpIHBsdWdpbi5hZGRDb21tYW5kKE9iamVjdC5hc3NpZ24oe30sIGNtZCwge1xuICAgICAgICAgICAgY2hlY2tDYWxsYmFjayhjaGVjaykge1xuICAgICAgICAgICAgICAgIC8vIENhbGwgdGhlIG1ldGhvZCBib2R5IHdpdGggdGhlIHBsdWdpbiBhcyAndGhpcydcbiAgICAgICAgICAgICAgICBjb25zdCBjYiA9IG1ldGhvZC5jYWxsKHBsdWdpbik7XG4gICAgICAgICAgICAgICAgLy8gSXQgdGhlbiByZXR1cm5zIGEgY2xvc3VyZSBpZiB0aGUgY29tbWFuZCBpcyByZWFkeSB0byBleGVjdXRlLCBhbmRcbiAgICAgICAgICAgICAgICAvLyB3ZSBjYWxsIHRoYXQgY2xvc3VyZSB1bmxlc3MgdGhpcyBpcyBqdXN0IGEgY2hlY2sgZm9yIGF2YWlsYWJpbGl0eVxuICAgICAgICAgICAgICAgIHJldHVybiAoY2hlY2sgfHwgdHlwZW9mIGNiICE9PSBcImZ1bmN0aW9uXCIpID8gISFjYiA6IChjYigpLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH0pXG59IiwiZXhwb3J0IGZ1bmN0aW9uIGFyb3VuZChvYmosIGZhY3Rvcmllcykge1xuICAgIGNvbnN0IHJlbW92ZXJzID0gT2JqZWN0LmtleXMoZmFjdG9yaWVzKS5tYXAoa2V5ID0+IGFyb3VuZDEob2JqLCBrZXksIGZhY3Rvcmllc1trZXldKSk7XG4gICAgcmV0dXJuIHJlbW92ZXJzLmxlbmd0aCA9PT0gMSA/IHJlbW92ZXJzWzBdIDogZnVuY3Rpb24gKCkgeyByZW1vdmVycy5mb3JFYWNoKHIgPT4gcigpKTsgfTtcbn1cbmZ1bmN0aW9uIGFyb3VuZDEob2JqLCBtZXRob2QsIGNyZWF0ZVdyYXBwZXIpIHtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG9ialttZXRob2RdLCBoYWRPd24gPSBvYmouaGFzT3duUHJvcGVydHkobWV0aG9kKTtcbiAgICBsZXQgY3VycmVudCA9IGNyZWF0ZVdyYXBwZXIob3JpZ2luYWwpO1xuICAgIC8vIExldCBvdXIgd3JhcHBlciBpbmhlcml0IHN0YXRpYyBwcm9wcyBmcm9tIHRoZSB3cmFwcGluZyBtZXRob2QsXG4gICAgLy8gYW5kIHRoZSB3cmFwcGluZyBtZXRob2QsIHByb3BzIGZyb20gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgIGlmIChvcmlnaW5hbClcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGN1cnJlbnQsIG9yaWdpbmFsKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgY3VycmVudCk7XG4gICAgb2JqW21ldGhvZF0gPSB3cmFwcGVyO1xuICAgIC8vIFJldHVybiBhIGNhbGxiYWNrIHRvIGFsbG93IHNhZmUgcmVtb3ZhbFxuICAgIHJldHVybiByZW1vdmU7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIC8vIElmIHdlIGhhdmUgYmVlbiBkZWFjdGl2YXRlZCBhbmQgYXJlIG5vIGxvbmdlciB3cmFwcGVkLCByZW1vdmUgb3Vyc2VsdmVzXG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbCAmJiBvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcilcbiAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICByZXR1cm4gY3VycmVudC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gcmVtb3ZlKCkge1xuICAgICAgICAvLyBJZiBubyBvdGhlciBwYXRjaGVzLCBqdXN0IGRvIGEgZGlyZWN0IHJlbW92YWxcbiAgICAgICAgaWYgKG9ialttZXRob2RdID09PSB3cmFwcGVyKSB7XG4gICAgICAgICAgICBpZiAoaGFkT3duKVxuICAgICAgICAgICAgICAgIG9ialttZXRob2RdID0gb3JpZ2luYWw7XG4gICAgICAgICAgICBlbHNlXG4gICAgICAgICAgICAgICAgZGVsZXRlIG9ialttZXRob2RdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50ID09PSBvcmlnaW5hbClcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgLy8gRWxzZSBwYXNzIGZ1dHVyZSBjYWxscyB0aHJvdWdoLCBhbmQgcmVtb3ZlIHdyYXBwZXIgZnJvbSB0aGUgcHJvdG90eXBlIGNoYWluXG4gICAgICAgIGN1cnJlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIG9yaWdpbmFsIHx8IEZ1bmN0aW9uKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gZGVkdXBlKGtleSwgb2xkRm4sIG5ld0ZuKSB7XG4gICAgY2hlY2tba2V5XSA9IGtleTtcbiAgICByZXR1cm4gY2hlY2s7XG4gICAgZnVuY3Rpb24gY2hlY2soLi4uYXJncykge1xuICAgICAgICByZXR1cm4gKG9sZEZuW2tleV0gPT09IGtleSA/IG9sZEZuIDogbmV3Rm4pLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiBhZnRlcihwcm9taXNlLCBjYikge1xuICAgIHJldHVybiBwcm9taXNlLnRoZW4oY2IsIGNiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBzZXJpYWxpemUoYXN5bmNGdW5jdGlvbikge1xuICAgIGxldCBsYXN0UnVuID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgZnVuY3Rpb24gd3JhcHBlciguLi5hcmdzKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7XG4gICAgICAgICAgICBhZnRlcihsYXN0UnVuLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgYXN5bmNGdW5jdGlvbi5hcHBseSh0aGlzLCBhcmdzKS50aGVuKHJlcywgcmVqKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgd3JhcHBlci5hZnRlciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHsgYWZ0ZXIobGFzdFJ1biwgcmVzKTsgfSk7XG4gICAgfTtcbiAgICByZXR1cm4gd3JhcHBlcjtcbn1cbiIsImltcG9ydCB7Tm90aWNlLCBXb3Jrc3BhY2VMZWFmfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcblxuY29uc3QgSElTVF9BVFRSID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCI7XG5jb25zdCBTRVJJQUxfUFJPUCA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuXG5jb25zdCBkb21MZWF2ZXMgPSBuZXcgV2Vha01hcCgpO1xuXG5mdW5jdGlvbiBwYXJzZShzdGF0ZSkge1xuICAgIGlmICh0eXBlb2Ygc3RhdGUuc3RhdGUgPT09IFwic3RyaW5nXCIpIHN0YXRlLnN0YXRlID0gSlNPTi5wYXJzZShzdGF0ZS5zdGF0ZSk7XG4gICAgaWYgKHR5cGVvZiBzdGF0ZS5lU3RhdGUgPT09IFwic3RyaW5nXCIpIHN0YXRlLmVTdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGUuZVN0YXRlKTtcbiAgICByZXR1cm4gc3RhdGU7XG59XG5cbmNsYXNzIEhpc3RvcnlFbnRyeSB7XG4gICAgY29uc3RydWN0b3IocmF3U3RhdGUpIHtcbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgfVxuXG4gICAgc2V0U3RhdGUocmF3U3RhdGUpIHtcbiAgICAgICAgdGhpcy5yYXcgPSByYXdTdGF0ZTtcbiAgICAgICAgdGhpcy52aWV3U3RhdGUgPSBKU09OLnBhcnNlKHJhd1N0YXRlLnN0YXRlIHx8IFwie31cIik7XG4gICAgICAgIHRoaXMuZVN0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5lU3RhdGUgfHwgXCJudWxsXCIpO1xuICAgICAgICB0aGlzLnBhdGggPSB0aGlzLnZpZXdTdGF0ZS5zdGF0ZT8uZmlsZTtcbiAgICB9XG5cbiAgICBvblJlbmFtZShmaWxlLCBvbGRQYXRoKSB7XG4gICAgICAgIGlmICh0aGlzLnBhdGggPT09IG9sZFBhdGgpIHtcbiAgICAgICAgICAgIHRoaXMucGF0aCA9IHRoaXMudmlld1N0YXRlLnN0YXRlLmZpbGUgPSBmaWxlLnBhdGhcbiAgICAgICAgICAgIHRoaXMucmF3LnN0YXRlID0gSlNPTi5zdHJpbmdpZnkodGhpcy52aWV3U3RhdGUpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ28obGVhZikge1xuICAgICAgICBsZXQge3ZpZXdTdGF0ZSwgcGF0aCwgZVN0YXRlfSA9IHRoaXM7XG4gICAgICAgIGxldCBmaWxlID0gcGF0aCAmJiBsZWFmPy5hcHA/LnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcbiAgICAgICAgaWYgKHBhdGggJiYgIWZpbGUpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoXCJNaXNzaW5nIGZpbGU6IFwiK3BhdGgpO1xuICAgICAgICAgICAgdmlld1N0YXRlID0ge3R5cGU6IFwiZW1wdHlcIiwgc3RhdGU6e319O1xuICAgICAgICAgICAgZVN0YXRlID0gdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGxlYWYuc2V0Vmlld1N0YXRlKHsuLi52aWV3U3RhdGUsIGFjdGl2ZTogdHJ1ZSwgcG9wc3RhdGU6IHRydWV9LCBlU3RhdGUpO1xuICAgIH1cblxuICAgIHJlcGxhY2VTdGF0ZShyYXdTdGF0ZSkge1xuICAgICAgICBpZiAocmF3U3RhdGUuc3RhdGUgIT09IHRoaXMucmF3LnN0YXRlKSB7XG4gICAgICAgICAgICBjb25zdCB2aWV3U3RhdGUgPSBKU09OLnBhcnNlKHJhd1N0YXRlLnN0YXRlIHx8IFwie31cIik7XG4gICAgICAgICAgICAvLyBEb24ndCByZXBsYWNlIGEgZmlsZSB3aXRoIGFuIGVtcHR5IGluIHRoZSBoaXN0b3J5XG4gICAgICAgICAgICBpZiAodmlld1N0YXRlLnR5cGUgPT09IFwiZW1wdHlcIikgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAvLyBGaWxlIGlzIGRpZmZlcmVudCBmcm9tIGV4aXN0aW5nIGZpbGU6IHNob3VsZCBiZSBhIHB1c2ggaW5zdGVhZFxuICAgICAgICAgICAgaWYgKHRoaXMucGF0aCAmJiB0aGlzLnBhdGggIT09IHZpZXdTdGF0ZT8uc3RhdGU/LmZpbGUpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGlmICh2aWV3U3RhdGUudHlwZSA9PT0gXCJtZWRpYS12aWV3XCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBvbGRJbmZvID0gSlNPTi5zdHJpbmdpZnkodGhpcy52aWV3U3RhdGUuc3RhdGUuaW5mbyk7XG4gICAgICAgICAgICAgICAgY29uc3QgbmV3SW5mbyA9IEpTT04uc3RyaW5naWZ5KHZpZXdTdGF0ZS5zdGF0ZS5pbmZvKTtcbiAgICAgICAgICAgICAgICBpZiAob2xkSW5mbyAhPT0gbmV3SW5mbykgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG59XG5cbmV4cG9ydCBjbGFzcyBIaXN0b3J5IHtcbiAgICBzdGF0aWMgY3VycmVudChhcHApIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yTGVhZihhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHx8IG5ldyB0aGlzKCk7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvckxlYWYobGVhZikge1xuICAgICAgICBpZiAobGVhZikgZG9tTGVhdmVzLnNldChsZWFmLmNvbnRhaW5lckVsLCBsZWFmKTtcbiAgICAgICAgaWYgKGxlYWYpIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gaW5zdGFuY2VvZiB0aGlzID9cbiAgICAgICAgICAgIGxlYWZbSElTVF9BVFRSXSA6XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcyhsZWFmLCBsZWFmW0hJU1RfQVRUUl0/LnNlcmlhbGl6ZSgpIHx8IHVuZGVmaW5lZCk7XG4gICAgfVxuXG4gICAgY29uc3RydWN0b3IobGVhZiwge3Bvcywgc3RhY2t9ID0ge3BvczowLCBzdGFjazpbXX0pIHtcbiAgICAgICAgdGhpcy5sZWFmID0gbGVhZjtcbiAgICAgICAgdGhpcy5wb3MgPSBwb3M7XG4gICAgICAgIHRoaXMuc3RhY2sgPSBzdGFjay5tYXAocmF3ID0+IG5ldyBIaXN0b3J5RW50cnkocmF3KSk7XG4gICAgfVxuXG4gICAgY2xvbmVUbyhsZWFmKSB7XG4gICAgICAgIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcy5jb25zdHJ1Y3RvcihsZWFmLCB0aGlzLnNlcmlhbGl6ZSgpKTtcbiAgICB9XG5cbiAgICBvblJlbmFtZShmaWxlLCBvbGRQYXRoKSB7XG4gICAgICAgIGZvcihjb25zdCBoaXN0RW50cnkgb2YgdGhpcy5zdGFjaykgaGlzdEVudHJ5Lm9uUmVuYW1lKGZpbGUsIG9sZFBhdGgpO1xuICAgIH1cblxuICAgIHNlcmlhbGl6ZSgpIHsgcmV0dXJuIHtwb3M6IHRoaXMucG9zLCBzdGFjazogdGhpcy5zdGFjay5tYXAoZSA9PiBlLnJhdyl9OyB9XG5cbiAgICBnZXQgc3RhdGUoKSB7IHJldHVybiB0aGlzLnN0YWNrW3RoaXMucG9zXT8ucmF3IHx8IG51bGw7IH1cbiAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gdGhpcy5zdGFjay5sZW5ndGg7IH1cblxuICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9XG4gICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH1cblxuICAgIGxvb2tBaGVhZCgpIHsgcmV0dXJuIHRoaXMuc3RhY2suc2xpY2UoMCwgdGhpcy5wb3MpLnJldmVyc2UoKTsgfVxuICAgIGxvb2tCZWhpbmQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKHRoaXMucG9zKzEpOyB9XG5cbiAgICBnb3RvKHBvcykge1xuICAgICAgICBpZiAoIXRoaXMubGVhZikgcmV0dXJuO1xuICAgICAgICBpZiAodGhpcy5sZWFmLnBpbm5lZCkgcmV0dXJuIG5ldyBOb3RpY2UoXCJQaW5uZWQgcGFuZTogdW5waW4gYmVmb3JlIGdvaW5nIGZvcndhcmQgb3IgYmFja1wiKSwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAodGhpcy5sZWFmLndvcmtpbmcpIHJldHVybiBuZXcgTm90aWNlKFwiUGFuZSBpcyBidXN5OiBwbGVhc2Ugd2FpdCBiZWZvcmUgbmF2aWdhdGluZyBmdXJ0aGVyXCIpLCB1bmRlZmluZWQ7XG4gICAgICAgIHBvcyA9IHRoaXMucG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4ocG9zLCB0aGlzLnN0YWNrLmxlbmd0aCAtIDEpKTtcbiAgICAgICAgdGhpcy5zdGFja1twb3NdPy5nbyh0aGlzLmxlYWYpO1xuICAgICAgICB0aGlzLmxlYWYuYXBwPy53b3Jrc3BhY2U/LnRyaWdnZXIoXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCB0aGlzLmxlYWYsIHRoaXMpO1xuICAgIH1cblxuICAgIGdvKGJ5LCBmb3JjZSkge1xuICAgICAgICBpZiAoIXRoaXMubGVhZiB8fCAhYnkpIHJldHVybjsgIC8vIG5vLW9wXG4gICAgICAgIC8vIHByZXZlbnQgd3JhcGFyb3VuZFxuICAgICAgICBjb25zdCBuZXdQb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbih0aGlzLnBvcyAtIGJ5LCB0aGlzLnN0YWNrLmxlbmd0aCAtIDEpKTtcbiAgICAgICAgaWYgKGZvcmNlIHx8IG5ld1BvcyAhPT0gdGhpcy5wb3MpIHtcbiAgICAgICAgICAgIHRoaXMuZ290byhuZXdQb3MpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbmV3IE5vdGljZShgTm8gbW9yZSAke2J5IDwgMCA/IFwiYmFja1wiIDogXCJmb3J3YXJkXCJ9IGhpc3RvcnkgZm9yIHBhbmVgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlcGxhY2VTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCl7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5zdGFja1t0aGlzLnBvc107XG4gICAgICAgIGlmICghZW50cnkpIHtcbiAgICAgICAgICAgIHRoaXMuc3RhY2tbdGhpcy5wb3NdID0gbmV3IEhpc3RvcnlFbnRyeShyYXdTdGF0ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWVudHJ5LnJlcGxhY2VTdGF0ZShyYXdTdGF0ZSkpIHtcbiAgICAgICAgICAgIC8vIHJlcGxhY2VTdGF0ZSB3YXMgZXJyb25lb3VzbHkgY2FsbGVkIHdpdGggYSBuZXcgZmlsZSBmb3IgdGhlIHNhbWUgbGVhZjtcbiAgICAgICAgICAgIC8vIGZvcmNlIGEgcHVzaFN0YXRlIGluc3RlYWQgKGZpeGVzIHRoZSBpc3N1ZSByZXBvcnRlZCBoZXJlOiBodHRwczovL2ZvcnVtLm9ic2lkaWFuLm1kL3QvMTg1MTgpXG4gICAgICAgICAgICB0aGlzLnB1c2hTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBwdXNoU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpICAge1xuICAgICAgICAvL2NvbnNvbGUubG9nKFwicHVzaGluZ1wiLCByYXdTdGF0ZSlcbiAgICAgICAgdGhpcy5zdGFjay5zcGxpY2UoMCwgdGhpcy5wb3MsIG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpKTtcbiAgICAgICAgdGhpcy5wb3MgPSAwO1xuICAgICAgICAvLyBMaW1pdCBcImJhY2tcIiB0byAyMFxuICAgICAgICB3aGlsZSAodGhpcy5zdGFjay5sZW5ndGggPiAyMCkgdGhpcy5zdGFjay5wb3AoKTtcbiAgICAgICAgdGhpcy5sZWFmLmFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKVxuICAgIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxIaXN0b3J5KHBsdWdpbikge1xuXG4gICAgY29uc3QgYXBwID0gcGx1Z2luLmFwcDtcblxuICAgIC8vIE1vbmtleXBhdGNoOiBpbmNsdWRlIGhpc3RvcnkgaW4gbGVhZiBzZXJpYWxpemF0aW9uIChzbyBpdCdzIHBlcnNpc3RlZCB3aXRoIHRoZSB3b3Jrc3BhY2UpXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChXb3Jrc3BhY2VMZWFmLnByb3RvdHlwZSwge1xuICAgICAgICBzZXJpYWxpemUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXJpYWxpemUoKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgaWYgKHRoaXNbSElTVF9BVFRSXSkgcmVzdWx0W1NFUklBTF9QUk9QXSA9IHRoaXNbSElTVF9BVFRSXS5zZXJpYWxpemUoKTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19XG4gICAgfSkpO1xuXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChhcHAud29ya3NwYWNlLCB7XG4gICAgICAgIC8vIE1vbmtleXBhdGNoOiBsb2FkIGhpc3RvcnkgZHVyaW5nIGxlYWYgbG9hZCwgaWYgcHJlc2VudFxuICAgICAgICBkZXNlcmlhbGl6ZUxheW91dChvbGQpIHsgcmV0dXJuIGFzeW5jIGZ1bmN0aW9uIGRlc2VyaWFsaXplTGF5b3V0KHN0YXRlLCAuLi5ldGMpe1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gUmV0cnkgbG9hZGluZyB0aGUgcGFuZSBhcyBhbiBlbXB0eVxuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5zdGF0ZS50eXBlID0gJ2VtcHR5JztcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgb2xkLmNhbGwodGhpcywgc3RhdGUsIC4uLmV0Yyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghcmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoc3RhdGVbU0VSSUFMX1BST1BdKSByZXN1bHRbSElTVF9BVFRSXSA9IG5ldyBIaXN0b3J5KHJlc3VsdCwgc3RhdGVbU0VSSUFMX1BST1BdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19LFxuICAgICAgICAvLyBNb25rZXlwYXRjaDoga2VlcCBPYnNpZGlhbiBmcm9tIHB1c2hpbmcgaGlzdG9yeSBpbiBzZXRBY3RpdmVMZWFmXG4gICAgICAgIHNldEFjdGl2ZUxlYWYob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXRBY3RpdmVMZWFmKGxlYWYsIC4uLmV0Yykge1xuICAgICAgICAgICAgY29uc3QgdW5zdWIgPSBhcm91bmQodGhpcywge1xuICAgICAgICAgICAgICAgIHJlY29yZEhpc3Rvcnkob2xkKSB7IHJldHVybiBmdW5jdGlvbiAobGVhZiwgX3B1c2gsIC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQWx3YXlzIHVwZGF0ZSBzdGF0ZSBpbiBwbGFjZVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgZmFsc2UsIC4uLmFyZ3MpO1xuICAgICAgICAgICAgICAgIH07IH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgLi4uZXRjKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgdW5zdWIoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfX0sXG4gICAgfSkpO1xuXG4gICAgLy8gT3ZlcnJpZGUgZGVmYXVsdCBtb3VzZSBoaXN0b3J5IGJlaGF2aW9yLiAgV2UgbmVlZCB0aGlzIGJlY2F1c2UgMSkgRWxlY3Ryb24gd2lsbCB1c2UgdGhlIGJ1aWx0LWluXG4gICAgLy8gaGlzdG9yeSBvYmplY3QgaWYgd2UgZG9uJ3QgKGluc3RlYWQgb2Ygb3VyIHdyYXBwZXIpLCBhbmQgMikgd2Ugd2FudCB0aGUgY2xpY2sgdG8gYXBwbHkgdG8gdGhlIGxlYWZcbiAgICAvLyB0aGF0IHdhcyB1bmRlciB0aGUgbW91c2UsIHJhdGhlciB0aGFuIHdoaWNoZXZlciBsZWFmIHdhcyBhY3RpdmUuXG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICBwbHVnaW4ucmVnaXN0ZXIoICgpID0+IHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSkgKTtcbiAgICBmdW5jdGlvbiBoaXN0b3J5SGFuZGxlcihlKSB7XG4gICAgICAgIGlmIChlLmJ1dHRvbiAhPT0gMyAmJiBlLmJ1dHRvbiAhPT0gNCkgcmV0dXJuO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7ICAvLyBwcmV2ZW50IGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQubWF0Y2hQYXJlbnQoXCIud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgIGlmICh0YXJnZXQpIHtcbiAgICAgICAgICAgIGxldCBsZWFmID0gZG9tTGVhdmVzLmdldCh0YXJnZXQpO1xuICAgICAgICAgICAgaWYgKCFsZWFmKSBhcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMobCA9PiBsZWFmID0gKGwuY29udGFpbmVyRWwgPT09IHRhcmdldCkgPyBsIDogbGVhZik7XG4gICAgICAgICAgICBpZiAoIWxlYWYpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSAzKSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5iYWNrKCk7IH1cbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSA0KSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5mb3J3YXJkKCk7IH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUHJveHkgdGhlIHdpbmRvdyBoaXN0b3J5IHdpdGggYSB3cmFwcGVyIHRoYXQgZGVsZWdhdGVzIHRvIHRoZSBhY3RpdmUgbGVhZidzIEhpc3Rvcnkgb2JqZWN0LFxuICAgIGNvbnN0IHJlYWxIaXN0b3J5ID0gd2luZG93Lmhpc3Rvcnk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+IHdpbmRvdy5oaXN0b3J5ID0gcmVhbEhpc3RvcnkpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiaGlzdG9yeVwiLCB7IGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUsIHZhbHVlOiB7XG4gICAgICAgIGdldCBzdGF0ZSgpICAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkuc3RhdGU7IH0sXG4gICAgICAgIGdldCBsZW5ndGgoKSAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KGFwcCkubGVuZ3RoOyB9LFxuXG4gICAgICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9LFxuICAgICAgICBmb3J3YXJkKCkgeyB0aGlzLmdvKCAxKTsgfSxcbiAgICAgICAgZ28oYnkpICAgIHsgSGlzdG9yeS5jdXJyZW50KGFwcCkuZ28oYnkpOyB9LFxuXG4gICAgICAgIHJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCl7IEhpc3RvcnkuY3VycmVudChhcHApLnJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG4gICAgICAgIHB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCkgICB7IEhpc3RvcnkuY3VycmVudChhcHApLnB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG5cbiAgICAgICAgZ2V0IHNjcm9sbFJlc3RvcmF0aW9uKCkgICAgeyByZXR1cm4gcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb247IH0sXG4gICAgICAgIHNldCBzY3JvbGxSZXN0b3JhdGlvbih2YWwpIHsgcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb24gPSB2YWw7IH0sXG4gICAgfX0pO1xuXG59XG4iLCJpbXBvcnQge01lbnUsIEtleW1hcCwgQ29tcG9uZW50fSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge0hpc3Rvcnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcblxuY29uc3Qgdmlld3R5cGVJY29ucyA9IHtcbiAgICBtYXJrZG93bjogXCJkb2N1bWVudFwiLFxuICAgIGltYWdlOiBcImltYWdlLWZpbGVcIixcbiAgICBhdWRpbzogXCJhdWRpby1maWxlXCIsXG4gICAgdmlkZW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHBkZjogXCJwZGYtZmlsZVwiLFxuICAgIGxvY2FsZ3JhcGg6IFwiZG90LW5ldHdvcmtcIixcbiAgICBvdXRsaW5lOiBcImJ1bGxldC1saXN0XCIsXG4gICAgYmFja2xpbms6IFwibGlua1wiLFxuXG4gICAgLy8gdGhpcmQtcGFydHkgcGx1Z2luc1xuICAgIGthbmJhbjogXCJibG9ja3NcIixcbiAgICBleGNhbGlkcmF3OiBcImV4Y2FsaWRyYXctaWNvblwiLFxuICAgIFwibWVkaWEtdmlld1wiOiBcImF1ZGlvLWZpbGVcIixcbn1cblxuY29uc3Qgbm9uRmlsZVZpZXdzID0ge1xuICAgIGdyYXBoOiBbXCJkb3QtbmV0d29ya1wiLCBcIkdyYXBoIFZpZXdcIl0sXG4gICAgXCJmaWxlLWV4cGxvcmVyXCI6IFtcImZvbGRlclwiLCBcIkZpbGUgRXhwbG9yZXJcIl0sXG4gICAgc3RhcnJlZDogW1wic3RhclwiLCBcIlN0YXJyZWQgRmlsZXNcIl0sXG4gICAgdGFnOiBbXCJ0YWdcIiwgXCJUYWdzIFZpZXdcIl0sXG5cbiAgICAvLyB0aGlyZC1wYXJ0eSBwbHVnaW5zXG4gICAgXCJyZWNlbnQtZmlsZXNcIjogW1wiY2xvY2tcIiwgXCJSZWNlbnQgRmlsZXNcIl0sXG4gICAgY2FsZW5kYXI6IFtcImNhbGVuZGFyLXdpdGgtY2hlY2ttYXJrXCIsIFwiQ2FsZW5kYXJcIl0sXG4gICAgZW1wdHk6IFtcImNyb3NzXCIsIFwiTm8gZmlsZVwiXVxufVxuXG5leHBvcnQgY2xhc3MgTmF2aWdhdG9yIGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIHN0YXRpYyBob3ZlclNvdXJjZSA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS1tZW51XCI7XG5cbiAgICBjb25zdHJ1Y3RvcihwbHVnaW4sIGtpbmQsIGRpcikgIHtcbiAgICAgICAgc3VwZXIoKTtcbiAgICAgICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gICAgICAgIHRoaXMuYXBwID0gcGx1Z2luLmFwcDtcbiAgICAgICAgdGhpcy5raW5kID0ga2luZDtcbiAgICAgICAgdGhpcy5kaXIgPSBkaXI7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gZG9jdW1lbnQuYm9keS5maW5kKFxuICAgICAgICAgICAgYC50aXRsZWJhciAudGl0bGViYXItYnV0dG9uLWNvbnRhaW5lci5tb2QtbGVmdCAudGl0bGViYXItYnV0dG9uLm1vZC0ke3RoaXMua2luZH1gXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY291bnQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZVNwYW4oe3ByZXBlbmQ6IHRoaXMua2luZCA9PT0gXCJiYWNrXCIsIGNsczogXCJoaXN0b3J5LWNvdW50ZXJcIn0pO1xuICAgICAgICB0aGlzLmxlYWYgPSBudWxsO1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBudWxsO1xuICAgICAgICB0aGlzLnN0YXRlcyA9IFtdO1xuICAgICAgICB0aGlzLm9sZExhYmVsID0gdGhpcy5jb250YWluZXJFbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQodGhpcy5jb250YWluZXJFbCwgXCJjb250ZXh0bWVudVwiLCB0aGlzLm9wZW5NZW51LmJpbmQodGhpcykpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAodGhpcy5vbGRMYWJlbCk7XG4gICAgICAgIHRoaXMuY291bnQuZGV0YWNoKCk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzZXRDb3VudChudW0pIHsgdGhpcy5jb3VudC50ZXh0Q29udGVudCA9IG51bSB8fCBcIlwiOyB9XG5cbiAgICBzZXRUb29sdGlwKHRleHQpIHtcbiAgICAgICAgaWYgKHRleHQpIHRoaXMuY29udGFpbmVyRWwuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCB0ZXh0IHx8IHVuZGVmaW5lZCk7XG4gICAgICAgIGVsc2UgdGhpcy5jb250YWluZXJFbC5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgIH1cblxuICAgIHNldEhpc3RvcnkoaGlzdG9yeSA9IEhpc3RvcnkuY3VycmVudCh0aGlzLmFwcCkpIHtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gaGlzdG9yeTtcbiAgICAgICAgY29uc3Qgc3RhdGVzID0gdGhpcy5zdGF0ZXMgPSBoaXN0b3J5W3RoaXMuZGlyIDwgMCA/IFwibG9va0JlaGluZFwiIDogXCJsb29rQWhlYWRcIl0uY2FsbChoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5zZXRDb3VudChzdGF0ZXMubGVuZ3RoKTtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHN0YXRlcy5sZW5ndGggP1xuICAgICAgICAgICAgdGhpcy5vbGRMYWJlbCArIFwiXFxuXCIgKyB0aGlzLmZvcm1hdFN0YXRlKHN0YXRlc1swXSkudGl0bGUgOlxuICAgICAgICAgICAgYE5vICR7dGhpcy5raW5kfSBoaXN0b3J5YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBzdGF0ZXMubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgb3Blbk1lbnUoZXZ0KSB7XG4gICAgICAgIGlmICghdGhpcy5zdGF0ZXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIGNvbnN0IG1lbnUgPSBjcmVhdGVNZW51KHRoaXMuYXBwKTtcbiAgICAgICAgbWVudS5kb20uYWRkQ2xhc3MoXCJwYW5lLXJlbGllZi1oaXN0b3J5LW1lbnVcIik7XG4gICAgICAgIG1lbnUuZG9tLm9uKFwibW91c2Vkb3duXCIsIFwiLm1lbnUtaXRlbVwiLCBlID0+IHtlLnN0b3BQcm9wYWdhdGlvbigpO30sIHRydWUpO1xuICAgICAgICB0aGlzLnN0YXRlcy5tYXAodGhpcy5mb3JtYXRTdGF0ZS5iaW5kKHRoaXMpKS5mb3JFYWNoKFxuICAgICAgICAgICAgKGluZm8sIGlkeCkgPT4gdGhpcy5tZW51SXRlbShpbmZvLCBpZHgsIG1lbnUpXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGV2dC5jbGllbnRYLCB5OiBldnQuY2xpZW50WSArIDIwfSk7XG4gICAgICAgIHRoaXMucGx1Z2luLmhpc3RvcnlJc09wZW4gPSB0cnVlO1xuICAgICAgICBtZW51Lm9uSGlkZSgoKSA9PiB7IHRoaXMucGx1Z2luLmhpc3RvcnlJc09wZW4gPSBmYWxzZTsgdGhpcy5zZXRIaXN0b3J5KCk7IH0pO1xuICAgIH1cblxuICAgIG1lbnVJdGVtKGluZm8sIGlkeCwgbWVudSkge1xuICAgICAgICBjb25zdCBteSA9IHRoaXM7XG4gICAgICAgIG1lbnUuYWRkSXRlbShpID0+IHsgY3JlYXRlSXRlbShpKTsgaWYgKGluZm8uZmlsZSkgc2V0dXBGaWxlRXZlbnRzKGkuZG9tKTsgfSk7XG4gICAgICAgIHJldHVybjtcblxuICAgICAgICBmdW5jdGlvbiBjcmVhdGVJdGVtKGksIHByZWZpeD1cIlwiKSB7XG4gICAgICAgICAgICBpLnNldEljb24oaW5mby5pY29uKS5zZXRUaXRsZShwcmVmaXggKyBpbmZvLnRpdGxlKS5vbkNsaWNrKGUgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBoaXN0b3J5ID0gbXkuaGlzdG9yeTtcbiAgICAgICAgICAgICAgICAvLyBDaGVjayBmb3IgY3RybC9jbWQvbWlkZGxlIGJ1dHRvbiBhbmQgc3BsaXQgbGVhZiArIGNvcHkgaGlzdG9yeVxuICAgICAgICAgICAgICAgIGlmIChLZXltYXAuaXNNb2RpZmllcihlLCBcIk1vZFwiKSB8fCAxID09PSBlLmJ1dHRvbikge1xuICAgICAgICAgICAgICAgICAgICBoaXN0b3J5ID0gaGlzdG9yeS5jbG9uZVRvKG15LmFwcC53b3Jrc3BhY2Uuc3BsaXRBY3RpdmVMZWFmKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBoaXN0b3J5LmdvKChpZHgrMSkgKiBteS5kaXIsIHRydWUpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXR1cEZpbGVFdmVudHMoZG9tKSB7XG4gICAgICAgICAgICAvLyBIb3ZlciBwcmV2aWV3XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VvdmVyJywgZSA9PiB7XG4gICAgICAgICAgICAgICAgbXkuYXBwLndvcmtzcGFjZS50cmlnZ2VyKCdob3Zlci1saW5rJywge1xuICAgICAgICAgICAgICAgICAgICBldmVudDogZSwgc291cmNlOiBOYXZpZ2F0b3IuaG92ZXJTb3VyY2UsXG4gICAgICAgICAgICAgICAgICAgIGhvdmVyUGFyZW50OiBtZW51LmRvbSwgdGFyZ2V0RWw6IGRvbSwgbGlua3RleHQ6IGluZm8uZmlsZS5wYXRoXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRHJhZyBtZW51IGl0ZW0gdG8gbW92ZSBvciBsaW5rIGZpbGVcbiAgICAgICAgICAgIGRvbS5zZXRBdHRyKCdkcmFnZ2FibGUnLCAndHJ1ZScpO1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdNYW5hZ2VyID0gbXkuYXBwLmRyYWdNYW5hZ2VyO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdEYXRhID0gZHJhZ01hbmFnZXIuZHJhZ0ZpbGUoZSwgaW5mby5maWxlKTtcbiAgICAgICAgICAgICAgICBkcmFnTWFuYWdlci5vbkRyYWdTdGFydChlLCBkcmFnRGF0YSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgZSA9PiBtZW51LmhpZGUoKSk7XG5cbiAgICAgICAgICAgIC8vIEZpbGUgbWVudVxuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoXCJjb250ZXh0bWVudVwiLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZW51ID0gY3JlYXRlTWVudShteS5hcHApO1xuICAgICAgICAgICAgICAgIG1lbnUuYWRkSXRlbShpID0+IGNyZWF0ZUl0ZW0oaSwgYEdvICR7bXkua2luZH0gdG8gYCkpLmFkZFNlcGFyYXRvcigpO1xuICAgICAgICAgICAgICAgIG15LmFwcC53b3Jrc3BhY2UudHJpZ2dlcihcbiAgICAgICAgICAgICAgICAgICAgXCJmaWxlLW1lbnVcIiwgbWVudSwgaW5mby5maWxlLCBcImxpbmstY29udGV4dC1tZW51XCJcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGUuY2xpZW50WCwgeTogZS5jbGllbnRZfSk7XG4gICAgICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsgLy8ga2VlcCB0aGUgcGFyZW50IG1lbnUgb3BlbiBmb3Igbm93XG4gICAgICAgICAgICB9LCB0cnVlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZvcm1hdFN0YXRlKGVudHJ5KSB7XG4gICAgICAgIGNvbnN0IHt2aWV3U3RhdGU6IHt0eXBlLCBzdGF0ZX0sIGVTdGF0ZSwgcGF0aH0gPSBlbnRyeTtcbiAgICAgICAgY29uc3QgZmlsZSA9IHBhdGggJiYgdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuICAgICAgICBjb25zdCBpbmZvID0ge2ljb246IFwiXCIsIHRpdGxlOiBcIlwiLCBmaWxlLCB0eXBlLCBzdGF0ZSwgZVN0YXRlfTtcblxuICAgICAgICBpZiAobm9uRmlsZVZpZXdzW3R5cGVdKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IG5vbkZpbGVWaWV3c1t0eXBlXTtcbiAgICAgICAgfSBlbHNlIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IFtcInRyYXNoXCIsIFwiTWlzc2luZyBmaWxlIFwiK3BhdGhdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaW5mby5pY29uID0gdmlld3R5cGVJY29uc1t0eXBlXSA/PyBcImRvY3VtZW50XCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtYXJrZG93blwiICYmIHN0YXRlLm1vZGUgPT09IFwicHJldmlld1wiKSBpbmZvLmljb24gPSBcImxpbmVzLW9mLXRleHRcIjtcbiAgICAgICAgICAgIGluZm8udGl0bGUgPSBmaWxlID8gZmlsZS5iYXNlbmFtZSArIChmaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiID8gXCIuXCIrZmlsZS5leHRlbnNpb24gOiBcIlwiKSA6IFwiTm8gZmlsZVwiO1xuICAgICAgICAgICAgaWYgKHR5cGUgPT09IFwibWVkaWEtdmlld1wiICYmICFmaWxlKSBpbmZvLnRpdGxlID0gc3RhdGUuaW5mbz8uZmlsZW5hbWUgPz8gaW5mby50aXRsZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS50cmlnZ2VyKFwicGFuZS1yZWxpZWY6Zm9ybWF0LWhpc3RvcnktaXRlbVwiLCBpbmZvKTtcbiAgICAgICAgcmV0dXJuIGluZm87XG4gICAgfVxufVxuXG5mdW5jdGlvbiBvbkVsZW1lbnQoZWwsIGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpIHtcbiAgICBlbC5vbihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKVxuICAgIHJldHVybiAoKSA9PiBlbC5vZmYoZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucyk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1lbnUoYXBwKSB7XG4gICAgY29uc3QgbWVudSA9IG5ldyBNZW51KGFwcCk7XG4gICAgbWVudS5yZWdpc3RlcihcbiAgICAgICAgLy8gWFhYIHRoaXMgcmVhbGx5IHNob3VsZCBiZSBhIHNjb3BlIHB1c2hcbiAgICAgICAgb25FbGVtZW50KGRvY3VtZW50LCBcImtleWRvd25cIiwgXCIqXCIsIGUgPT4ge1xuICAgICAgICAgICAgaWYgKGUua2V5PT09XCJFc2NhcGVcIikge1xuICAgICAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICAgICAgICAgIG1lbnUuaGlkZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCB7Y2FwdHVyZTogdHJ1ZX0pXG4gICAgKTtcbiAgICByZXR1cm4gbWVudTtcbn0iLCJpbXBvcnQge01lbnUsIFBsdWdpbiwgVEZpbGV9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7YWRkQ29tbWFuZHMsIGNvbW1hbmR9IGZyb20gXCIuL2NvbW1hbmRzXCI7XG5pbXBvcnQge0hpc3RvcnksIGluc3RhbGxIaXN0b3J5fSBmcm9tIFwiLi9IaXN0b3J5XCI7XG5pbXBvcnQge05hdmlnYXRvcn0gZnJvbSBcIi4vTmF2aWdhdG9yXCI7XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBhbmVSZWxpZWYgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBpbnN0YWxsSGlzdG9yeSh0aGlzKTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKE5hdmlnYXRvci5ob3ZlclNvdXJjZSwge1xuICAgICAgICAgICAgZGlzcGxheTogJ0hpc3RvcnkgZHJvcGRvd25zJywgZGVmYXVsdE1vZDogdHJ1ZVxuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zZXR1cERpc3BsYXkoKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC52YXVsdC5vbihcInJlbmFtZVwiLCAoZmlsZSwgb2xkUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKFxuICAgICAgICAgICAgICAgICAgICBsZWFmID0+IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgKGxlYWYsIGhpc3RvcnkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAobGVhZiA9PT0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHRoaXMuZGlzcGxheShoaXN0b3J5KTtcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oXCJhY3RpdmUtbGVhZi1jaGFuZ2VcIiwgbGVhZiA9PiB0aGlzLmRpc3BsYXkoSGlzdG9yeS5mb3JMZWFmKGxlYWYpKSkpO1xuICAgICAgICAgICAgaWYgKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB0aGlzLmRpc3BsYXkoSGlzdG9yeS5mb3JMZWFmKHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwibGF5b3V0LWNoYW5nZVwiLCB0aGlzLm51bWJlclBhbmVzLCB0aGlzKSk7XG4gICAgICAgICAgICB0aGlzLm51bWJlclBhbmVzKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGFkZENvbW1hbmRzKHRoaXMsIHtcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1wcmV2XCIsIFwiU3dhcCBwYW5lIHdpdGggcHJldmlvdXMgaW4gc3BsaXRcIiwgIFwiTW9kK1NoaWZ0K1BhZ2VVcFwiKV0gICAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlcigtMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtbmV4dFwiLCBcIlN3YXAgcGFuZSB3aXRoIG5leHQgaW4gc3BsaXRcIiwgICAgICBcIk1vZCtTaGlmdCtQYWdlRG93blwiKV0gKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoIDEpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLXByZXZcIiwgIFwiQ3ljbGUgdG8gcHJldmlvdXMgd29ya3NwYWNlIHBhbmVcIiwgICBcIk1vZCtQYWdlVXBcIiAgKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigtMSwgdHJ1ZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLW5leHRcIiwgIFwiQ3ljbGUgdG8gbmV4dCB3b3Jrc3BhY2UgcGFuZVwiLCAgICAgICBcIk1vZCtQYWdlRG93blwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZiggMSwgdHJ1ZSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMXN0XCIsICAgXCJKdW1wIHRvIDFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTJuZFwiLCAgIFwiSnVtcCB0byAybmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0zcmRcIiwgICBcIkp1bXAgdG8gM3JkIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigyKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNHRoXCIsICAgXCJKdW1wIHRvIDR0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTV0aFwiLCAgIFwiSnVtcCB0byA1dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDQpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby02dGhcIiwgICBcIkp1bXAgdG8gNnRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig1KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tN3RoXCIsICAgXCJKdW1wIHRvIDd0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTh0aFwiLCAgIFwiSnVtcCB0byA4dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDcpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1sYXN0XCIsICBcIkp1bXAgdG8gbGFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgXCJBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig5OTk5OTk5OSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTFzdFwiLCAgXCJQbGFjZSBhcyAxc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigwLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0ybmRcIiwgIFwiUGxhY2UgYXMgMm5kIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtM3JkXCIsICBcIlBsYWNlIGFzIDNyZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDIsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTR0aFwiLCAgXCJQbGFjZSBhcyA0dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigzLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC01dGhcIiwgIFwiUGxhY2UgYXMgNXRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNnRoXCIsICBcIlBsYWNlIGFzIDZ0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDUsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTd0aFwiLCAgXCJQbGFjZSBhcyA3dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig2LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC04dGhcIiwgIFwiUGxhY2UgYXMgOHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtbGFzdFwiLCBcIlBsYWNlIGFzIGxhc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgXCJNb2QrQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDk5OTk5OTk5LCBmYWxzZSk7IH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc2V0dXBEaXNwbGF5KCkge1xuICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuYmFjayAgICA9IG5ldyBOYXZpZ2F0b3IodGhpcywgXCJiYWNrXCIsIC0xKSk7XG4gICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5mb3J3YXJkID0gbmV3IE5hdmlnYXRvcih0aGlzLCBcImZvcndhcmRcIiwgMSkpO1xuICAgIH1cblxuICAgIC8vIFNldCB0byB0cnVlIHdoaWxlIGVpdGhlciBtZW51IGlzIG9wZW4sIHNvIHdlIGRvbid0IHN3aXRjaCBpdCBvdXRcbiAgICBoaXN0b3J5SXNPcGVuID0gZmFsc2U7XG5cbiAgICBkaXNwbGF5KGhpc3RvcnkpIHtcbiAgICAgICAgaWYgKHRoaXMuaGlzdG9yeUlzT3BlbikgcmV0dXJuO1xuICAgICAgICB0aGlzLmJhY2suc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5mb3J3YXJkLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgfVxuXG4gICAgbnVtYmVyUGFuZXMoKSB7XG4gICAgICAgIGxldCBjb3VudCA9IDAsIGxhc3RMZWFmID0gbnVsbDtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVSb290TGVhdmVzKGxlYWYgPT4ge1xuICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtbGFiZWxcIiwgKytjb3VudCA8IDkgPyBjb3VudCA6IFwiXCIpO1xuICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC50b2dnbGVDbGFzcyhcImhhcy1wYW5lLXJlbGllZi1sYWJlbFwiLCBjb3VudDw5KTtcbiAgICAgICAgICAgIGxhc3RMZWFmID0gbGVhZjtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChjb3VudD44KSB7XG4gICAgICAgICAgICBsYXN0TGVhZj8uY29udGFpbmVyRWwuc3R5bGUuc2V0UHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWxhYmVsXCIsIFwiOVwiKTtcbiAgICAgICAgICAgIGxhc3RMZWFmPy5jb250YWluZXJFbC50b2dnbGVDbGFzcyhcImhhcy1wYW5lLXJlbGllZi1sYWJlbFwiLCB0cnVlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UudW5yZWdpc3RlckhvdmVyTGlua1NvdXJjZShOYXZpZ2F0b3IuaG92ZXJTb3VyY2UpO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZVJvb3RMZWF2ZXMobGVhZiA9PiB7XG4gICAgICAgICAgICBsZWFmLmNvbnRhaW5lckVsLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiKTtcbiAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgZmFsc2UpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBnb3RvTnRoTGVhZihuLCByZWxhdGl2ZSkge1xuICAgICAgICBjb25zdCBsZWF2ZXMgPSBbXTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVSb290TGVhdmVzKChsZWFmKSA9PiAobGVhdmVzLnB1c2gobGVhZiksIGZhbHNlKSk7XG4gICAgICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICAgICAgbiArPSBsZWF2ZXMuaW5kZXhPZih0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZik7XG4gICAgICAgICAgICBuID0gKG4gKyBsZWF2ZXMubGVuZ3RoKSAlIGxlYXZlcy5sZW5ndGg7ICAvLyB3cmFwIGFyb3VuZFxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGxlYWYgPSBsZWF2ZXNbbj49bGVhdmVzLmxlbmd0aCA/IGxlYXZlcy5sZW5ndGgtMSA6IG5dO1xuICAgICAgICAhbGVhZiB8fCB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCB0cnVlLCB0cnVlKTtcbiAgICB9XG5cbiAgICBwbGFjZUxlYWYodG9Qb3MsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgY2IgPSB0aGlzLmxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlKTtcbiAgICAgICAgaWYgKGNiKSBjYigpO1xuICAgIH1cblxuICAgIGxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmO1xuICAgICAgICBpZiAoIWxlYWYpIHJldHVybiBmYWxzZTtcblxuICAgICAgICBjb25zdFxuICAgICAgICAgICAgcGFyZW50U3BsaXQgPSBsZWFmLnBhcmVudFNwbGl0LFxuICAgICAgICAgICAgY2hpbGRyZW4gPSBwYXJlbnRTcGxpdC5jaGlsZHJlbixcbiAgICAgICAgICAgIGZyb21Qb3MgPSBjaGlsZHJlbi5pbmRleE9mKGxlYWYpXG4gICAgICAgIDtcbiAgICAgICAgaWYgKGZyb21Qb3MgPT0gLTEpIHJldHVybiBmYWxzZTtcblxuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIHRvUG9zICs9IGZyb21Qb3M7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwIHx8IHRvUG9zID49IGNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRvUG9zID49IGNoaWxkcmVuLmxlbmd0aCkgdG9Qb3MgPSBjaGlsZHJlbi5sZW5ndGggLSAxO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCkgdG9Qb3MgPSAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZyb21Qb3MgPT0gdG9Qb3MpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3RoZXIgPSBjaGlsZHJlblt0b1Bvc107XG4gICAgICAgICAgICBjaGlsZHJlbi5zcGxpY2UoZnJvbVBvcywgMSk7XG4gICAgICAgICAgICBjaGlsZHJlbi5zcGxpY2UodG9Qb3MsICAgMCwgbGVhZik7XG4gICAgICAgICAgICBpZiAocGFyZW50U3BsaXQuc2VsZWN0VGFiKSB7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQuc2VsZWN0VGFiKGxlYWYpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvdGhlci5jb250YWluZXJFbC5pbnNlcnRBZGphY2VudEVsZW1lbnQoZnJvbVBvcyA+IHRvUG9zID8gXCJiZWZvcmViZWdpblwiIDogXCJhZnRlcmVuZFwiLCBsZWFmLmNvbnRhaW5lckVsKTtcbiAgICAgICAgICAgICAgICBwYXJlbnRTcGxpdC5yZWNvbXB1dGVDaGlsZHJlbkRpbWVuc2lvbnMoKTtcbiAgICAgICAgICAgICAgICBsZWFmLm9uUmVzaXplKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0Q2hhbmdlKCk7XG5cbiAgICAgICAgICAgICAgICAvLyBGb3JjZSBmb2N1cyBiYWNrIHRvIHBhbmU7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5zZXRBY3RpdmVMZWFmKGxlYWYsIGZhbHNlLCB0cnVlKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG4iXSwibmFtZXMiOlsiTm90aWNlIiwiV29ya3NwYWNlTGVhZiIsIkNvbXBvbmVudCIsIktleW1hcCIsIk1lbnUiLCJQbHVnaW4iLCJURmlsZSJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBO0FBQ0E7QUFDQSxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEI7QUFDTyxTQUFTLE9BQU8sQ0FBQyxFQUFFLEVBQUUsSUFBSSxFQUFFLE9BQU8sQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRTtBQUN0RDtBQUNB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LENBQUM7QUFPaEM7QUFDQSxNQUFNLFlBQVksQ0FBQztBQUNuQixJQUFJLFdBQVcsQ0FBQyxRQUFRLEVBQUU7QUFDMUIsUUFBUSxJQUFJLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ2hDLEtBQUs7QUFDTDtBQUNBLElBQUksUUFBUSxDQUFDLFFBQVEsRUFBRTtBQUN2QixRQUFRLElBQUksQ0FBQyxHQUFHLEdBQUcsUUFBUSxDQUFDO0FBQzVCLFFBQVEsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLENBQUM7QUFDNUQsUUFBUSxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsQ0FBQztBQUM1RCxRQUFRLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDO0FBQy9DLEtBQUs7QUFDTDtBQUNBLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7QUFDNUIsUUFBUSxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTyxFQUFFO0FBQ25DLFlBQVksSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUk7QUFDN0QsWUFBWSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUM1RCxTQUFTO0FBQ1QsS0FBSztBQUNMO0FBQ0EsSUFBSSxFQUFFLENBQUMsSUFBSSxFQUFFO0FBQ2IsUUFBUSxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUM7QUFDN0MsUUFBUSxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksSUFBSSxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMs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Q3ZCLFFBQVEsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxJQUFJLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzdELEtBQUs7QUFDTDtBQUNBLElBQUksT0FBTyxDQUFDLElBQUksRUFBRTtBQUNsQixRQUFRLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLENBQUM7QUFDOUUsS0FBSztBQUNMO0FBQ0EsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtBQUM1QixRQUFRLElBQUksTUFBTSxTQUFTLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztBQUM3RSxLQUFLO0FBQ0w7QUFDQSxJQUFJLFNBQVMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUU7QUFDQSxJQUFJLElBQUksS0FBSyxHQUFHLEVBQUUsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxHQUFHLElBQUksSUFBSSxDQUFDLEVBQUU7QUFDN0QsSUFBSSxJQUFJLE1BQU0sR0FBRyxFQUFFLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRTtBQUM5QztBQUNBLElBQUksSUFBSSxNQUFNLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUIsSUFBSSxPQUFPLEdBQUcsRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDOUI7QUFDQSxJ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LENBQUMsQ0FBQztBQUM1RCxLQUFLO0FBQ0w7QUFDQSxJQUFJLFVBQVUsQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUU7QUFDcEQsUUFBUSxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztBQUMvQixRQUFRLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLFlBQVksR0FBRyxXQUFXLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDdEcsUUFBUSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUNyQyxRQUFRLElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLE1BQU07QUFDckMsWUFBWSxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUs7QUFDcEUsWUFBWSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQztBQUNyQyxTQUFTLENBQUM7QUFDVixRQUFRLElBQUksQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDLFlBQVksRUFBRSxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3RFLEtBQUs7QUFDTDtBQUNBLElBQUksUUFBUSxDQUFDLEdBQUcsRUFBRTtBQUNsQixRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sRUFBRSxPQUFPO0FBQ3hDLFFBQVEsTUFBTSxJQUFJLEdBQUcsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUMxQyxRQUFRLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLDBCQUEwQixDQUFDLENBQUM7QUFDdEQsUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxXQUFX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
