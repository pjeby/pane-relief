'use strict';

var obsidian = require('obsidian');

// Simplified Commands Framework
const commands = {}; //new Map;
function command(id, name, hotkeys = [], cmd = {}) {
    // Allow hotkeys to be expressed as a string, array of strings,
    // object, or array of objects.  (Normalize to an array first.)
    if (typeof hotkeys === "string")
        hotkeys = [hotkeys];
    if (typeof hotkeys === "object" && hotkeys.key)
        hotkeys = [hotkeys];
    let keys = hotkeys.map(function (key) {
        // If a hotkey is an object already, no need to process it
        if (typeof key === "object")
            return key;
        // Convert strings to Obsidian's hotkey format
        let parts = key.split("+");
        return { modifiers: parts, key: parts.pop() || "+" }; // empty last part = e.g. 'Mod++'
    });
    Object.assign(cmd, { id, name, hotkeys: keys });
    // Save the command data under a unique symbol
    const sym = Symbol("cmd:" + id);
    commands[sym] = cmd;
    return sym;
}
function addCommands(plugin, cmdset) {
    // Extract command symbols from cmdset and register them, bound to the plugin for methods
    Object.getOwnPropertySymbols(cmdset).forEach(sym => {
        const cmd = commands[sym], method = cmdset[sym];
        if (cmd)
            plugin.addCommand(Object.assign({}, cmd, {
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
    get viewState() {
        return JSON.parse(this.raw.state || "{}");
    }
    setState(rawState) {
        this.raw = rawState;
        this.eState = JSON.parse(rawState.eState || "null");
        this.path = this.viewState.state?.file;
    }
    onRename(file, oldPath) {
        if (this.path === oldPath) {
            const viewState = this.viewState;
            this.path = viewState.state.file = file.path;
            this.raw.state = JSON.stringify(viewState);
        }
    }
    go(leaf) {
        let { viewState, path, eState } = this;
        let file = path && app?.vault.getAbstractFileByPath(path);
        if (path && !file) {
            new obsidian.Notice("Missing file: " + path);
            viewState = { type: "empty", state: {} };
            eState = undefined;
        }
        leaf.setViewState({ ...viewState, active: true, popstate: true }, eState);
    }
    replaceState(rawState) {
        if (rawState.state !== this.raw.state) {
            const viewState = JSON.parse(rawState.state || "{}");
            // Don't replace a file with an empty in the history
            if (viewState.type === "empty")
                return true;
            // File is different from existing file: should be a push instead
            if (this.path && this.path !== viewState?.state?.file)
                return false;
            if (viewState.type === "media-view") {
                const oldInfo = JSON.stringify(this.viewState.state.info);
                const newInfo = JSON.stringify(viewState.state.info);
                if (oldInfo !== newInfo)
                    return false;
            }
        }
        this.setState(rawState);
        return true;
    }
}
class History {
    constructor(leaf, { pos, stack } = { pos: 0, stack: [] }) {
        this.leaf = leaf;
        this.leaf = leaf;
        this.pos = pos;
        this.stack = stack.map(raw => new HistoryEntry(raw));
    }
    static current() {
        return this.forLeaf(app.workspace.activeLeaf) || new this();
    }
    static forLeaf(leaf) {
        if (leaf)
            domLeaves.set(leaf.containerEl, leaf);
        if (leaf)
            return leaf[HIST_ATTR] instanceof this ?
                leaf[HIST_ATTR] :
                leaf[HIST_ATTR] = new this(leaf, leaf[HIST_ATTR]?.serialize() || undefined);
    }
    cloneTo(leaf) {
        return leaf[HIST_ATTR] = new History(leaf, this.serialize());
    }
    onRename(file, oldPath) {
        for (const histEntry of this.stack)
            histEntry.onRename(file, oldPath);
    }
    serialize() { return { pos: this.pos, stack: this.stack.map(e => e.raw) }; }
    get state() { return this.stack[this.pos]?.raw || null; }
    get length() { return this.stack.length; }
    back() { this.go(-1); }
    forward() { this.go(1); }
    lookAhead() { return this.stack.slice(0, this.pos).reverse(); }
    lookBehind() { return this.stack.slice(this.pos + 1); }
    goto(pos) {
        if (!this.leaf)
            return;
        if (this.leaf.pinned)
            return new obsidian.Notice("Pinned pane: unpin before going forward or back"), undefined;
        if (this.leaf.working)
            return new obsidian.Notice("Pane is busy: please wait before navigating further"), undefined;
        pos = this.pos = Math.max(0, Math.min(pos, this.stack.length - 1));
        this.stack[pos]?.go(this.leaf);
        app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
    }
    go(by, force) {
        if (!this.leaf || !by)
            return; // no-op
        // prevent wraparound
        const newPos = Math.max(0, Math.min(this.pos - by, this.stack.length - 1));
        if (force || newPos !== this.pos) {
            this.goto(newPos);
        }
        else {
            new obsidian.Notice(`No more ${by < 0 ? "back" : "forward"} history for pane`);
        }
    }
    replaceState(rawState, title, url) {
        const entry = this.stack[this.pos];
        if (!entry) {
            this.stack[this.pos] = new HistoryEntry(rawState);
        }
        else if (!entry.replaceState(rawState)) {
            // replaceState was erroneously called with a new file for the same leaf;
            // force a pushState instead (fixes the issue reported here: https://forum.obsidian.md/t/18518)
            this.pushState(rawState, title, url);
        }
    }
    pushState(rawState, title, url) {
        //console.log("pushing", rawState)
        this.stack.splice(0, this.pos, new HistoryEntry(rawState));
        this.pos = 0;
        // Limit "back" to 20
        while (this.stack.length > 20)
            this.stack.pop();
        app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
    }
}
function installHistory(plugin) {
    // Monkeypatch: include history in leaf serialization (so it's persisted with the workspace)
    // and check for popstate events (to suppress them)
    plugin.register(around(obsidian.WorkspaceLeaf.prototype, {
        serialize(old) {
            return function serialize() {
                const result = old.call(this);
                if (this[HIST_ATTR])
                    result[SERIAL_PROP] = this[HIST_ATTR].serialize();
                return result;
            };
        },
        setViewState(old) {
            return function setViewState(vs, es) {
                if (vs.popstate && window.event?.type === "popstate") {
                    return Promise.resolve();
                }
                return old.call(this, vs, es);
            };
        }
    }));
    plugin.register(around(app.workspace, {
        // Monkeypatch: load history during leaf load, if present
        deserializeLayout(old) {
            return async function deserializeLayout(state, ...etc) {
                let result = await old.call(this, state, ...etc);
                if (state.type === "leaf") {
                    if (!result) {
                        // Retry loading the pane as an empty
                        state.state.type = 'empty';
                        result = await old.call(this, state, ...etc);
                        if (!result)
                            return result;
                    }
                    if (state[SERIAL_PROP])
                        result[HIST_ATTR] = new History(result, state[SERIAL_PROP]);
                }
                return result;
            };
        },
        // Monkeypatch: keep Obsidian from pushing history in setActiveLeaf
        setActiveLeaf(old) {
            return function setActiveLeaf(leaf, ...etc) {
                const unsub = around(this, {
                    recordHistory(old) {
                        return function (leaf, _push, ...args) {
                            // Always update state in place
                            return old.call(this, leaf, false, ...args);
                        };
                    }
                });
                try {
                    return old.call(this, leaf, ...etc);
                }
                finally {
                    unsub();
                }
            };
        },
    }));
    // Override default mouse history behavior.  We need this because 1) Electron will use the built-in
    // history object if we don't (instead of our wrapper), and 2) we want the click to apply to the leaf
    // that was under the mouse, rather than whichever leaf was active.
    document.addEventListener("mouseup", historyHandler, true);
    plugin.register(() => {
        document.removeEventListener("mouseup", historyHandler, true);
    });
    function historyHandler(e) {
        if (e.button !== 3 && e.button !== 4)
            return;
        e.preventDefault();
        e.stopPropagation(); // prevent default behavior
        const target = e.target.matchParent(".workspace-leaf");
        if (target && e.type === "mouseup") {
            let leaf = domLeaves.get(target);
            if (!leaf)
                app.workspace.iterateAllLeaves(l => leaf = (l.containerEl === target) ? l : leaf);
            if (!leaf)
                return false;
            if (e.button == 3) {
                History.forLeaf(leaf).back();
            }
            if (e.button == 4) {
                History.forLeaf(leaf).forward();
            }
        }
        return false;
    }
    // Proxy the window history with a wrapper that delegates to the active leaf's History object,
    const realHistory = window.history;
    plugin.register(() => window.history = realHistory);
    Object.defineProperty(window, "history", { enumerable: true, configurable: true, writable: true, value: {
            get state() { return History.current().state; },
            get length() { return History.current().length; },
            back() { this.go(-1); },
            forward() { this.go(1); },
            go(by) { History.current().go(by); },
            replaceState(state, title, url) { History.current().replaceState(state, title, url); },
            pushState(state, title, url) { History.current().pushState(state, title, url); },
            get scrollRestoration() { return realHistory.scrollRestoration; },
            set scrollRestoration(val) { realHistory.scrollRestoration = val; },
        } });
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
    constructor(plugin, kind, dir) {
        super();
        this.plugin = plugin;
        this.kind = kind;
        this.dir = dir;
        this.leaf = null;
        this.history = null;
    }
    onload() {
        this.containerEl = document.body.find(`.titlebar .titlebar-button-container.mod-left .titlebar-button.mod-${this.kind}`);
        this.count = this.containerEl.createSpan({ prepend: this.kind === "back", cls: "history-counter" });
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
    setCount(num) { this.count.textContent = "" + (num || ""); }
    setTooltip(text) {
        if (text)
            this.containerEl.setAttribute("aria-label", text || undefined);
        else
            this.containerEl.removeAttribute("aria-label");
    }
    setHistory(history = History.current()) {
        this.history = history;
        const states = this.states = history[this.dir < 0 ? "lookBehind" : "lookAhead"].call(history);
        this.setCount(states.length);
        this.setTooltip(states.length ?
            this.oldLabel + "\n" + this.formatState(states[0]).title :
            `No ${this.kind} history`);
        this.containerEl.toggleClass("mod-active", states.length > 0);
    }
    openMenu(evt) {
        if (!this.states.length)
            return;
        const menu = new obsidian.Menu();
        menu.dom.addClass("pane-relief-history-menu");
        menu.dom.on("mousedown", ".menu-item", e => { e.stopPropagation(); }, true);
        this.states.map(this.formatState.bind(this)).forEach((info, idx) => this.menuItem(info, idx, menu));
        menu.showAtPosition({ x: evt.clientX, y: evt.clientY + 20 });
        this.plugin.historyIsOpen = true;
        menu.onHide(() => { this.plugin.historyIsOpen = false; this.plugin.display(); });
    }
    menuItem(info, idx, menu) {
        const my = this;
        menu.addItem(i => { createItem(i); if (info.file)
            setupFileEvents(i.dom); });
        return;
        function createItem(i, prefix = "") {
            i.setIcon(info.icon).setTitle(prefix + info.title).onClick(e => {
                let history = my.history;
                // Check for ctrl/cmd/middle button and split leaf + copy history
                if (obsidian.Keymap.isModifier(e, "Mod") || 1 === e.button) {
                    history = history.cloneTo(app.workspace.splitActiveLeaf());
                }
                history.go((idx + 1) * my.dir, true);
            });
        }
        function setupFileEvents(dom) {
            // Hover preview
            dom.addEventListener('mouseover', e => {
                app.workspace.trigger('hover-link', {
                    event: e, source: Navigator.hoverSource,
                    hoverParent: menu.dom, targetEl: dom, linktext: info.file.path
                });
            });
            // Drag menu item to move or link file
            dom.setAttr('draggable', 'true');
            dom.addEventListener('dragstart', e => {
                const dragManager = app.dragManager;
                const dragData = dragManager.dragFile(e, info.file);
                dragManager.onDragStart(e, dragData);
            });
            dom.addEventListener('dragend', e => menu.hide());
            // File menu
            dom.addEventListener("contextmenu", e => {
                const menu = new obsidian.Menu();
                menu.addItem(i => createItem(i, `Go ${my.kind} to `)).addSeparator();
                app.workspace.trigger("file-menu", menu, info.file, "link-context-menu");
                menu.showAtPosition({ x: e.clientX, y: e.clientY });
                e.stopPropagation(); // keep the parent menu open for now
            }, true);
        }
    }
    formatState(entry) {
        const { viewState: { type, state }, eState, path } = entry;
        const file = path && app.vault.getAbstractFileByPath(path);
        const info = { icon: "", title: "", file, type, state, eState };
        if (nonFileViews[type]) {
            [info.icon, info.title] = nonFileViews[type];
        }
        else if (path && !file) {
            [info.icon, info.title] = ["trash", "Missing file " + path];
        }
        else if (file instanceof obsidian.TFile) {
            info.icon = viewtypeIcons[type] ?? "document";
            if (type === "markdown" && state.mode === "preview")
                info.icon = "lines-of-text";
            info.title = file ? file.basename + (file.extension !== "md" ? "." + file.extension : "") : "No file";
            if (type === "media-view" && !file)
                info.title = state.info?.filename ?? info.title;
        }
        app.workspace.trigger("pane-relief:format-history-item", info);
        return info;
    }
}
Navigator.hoverSource = "pane-relief:history-menu";
function onElement(el, event, selector, callback, options) {
    el.on(event, selector, callback, options);
    return () => el.off(event, selector, callback, options);
}

class PaneRelief extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.leafMap = new WeakMap();
        // Set to true while either menu is open, so we don't switch it out
        this.historyIsOpen = false;
    }
    onload() {
        installHistory(this);
        this.app.workspace.registerHoverLinkSource(Navigator.hoverSource, {
            display: 'History dropdowns', defaultMod: true
        });
        this.app.workspace.onLayoutReady(() => {
            this.setupDisplay();
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof obsidian.TFile)
                    this.app.workspace.iterateAllLeaves(leaf => History.forLeaf(leaf).onRename(file, oldPath));
            }));
            this.registerEvent(this.app.workspace.on("pane-relief:update-history", (leaf, history) => {
                this.updateLeaf(leaf);
                if (leaf === this.app.workspace.activeLeaf)
                    this.display(history);
            }));
            this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => this.display(History.forLeaf(leaf))));
            if (this.app.workspace.activeLeaf)
                this.display(History.forLeaf(this.app.workspace.activeLeaf));
            this.registerEvent(this.app.workspace.on("layout-change", this.numberPanes, this));
            this.numberPanes();
            this.register(onElement(document.body, "contextmenu", ".view-header > .view-actions > .view-action", (evt, target) => {
                const nav = ((target.matches('[class*=" app:go-forward"]') && this.forward) ||
                    (target.matches('[class*=" app:go-back"]') && this.back));
                if (!nav)
                    return;
                const leaf = this.leafMap.get(target.matchParent(".workspace-leaf"));
                if (!leaf)
                    return;
                this.display(History.forLeaf(leaf));
                nav.openMenu(evt);
                this.display();
            }, { capture: true }));
        });
        addCommands(this, {
            [command("swap-prev", "Swap pane with previous in split", "Mod+Shift+PageUp")]() { return this.leafPlacer(-1); },
            [command("swap-next", "Swap pane with next in split", "Mod+Shift+PageDown")]() { return this.leafPlacer(1); },
            [command("go-prev", "Cycle to previous workspace pane", "Mod+PageUp")]() { return () => this.gotoNthLeaf(-1, true); },
            [command("go-next", "Cycle to next workspace pane", "Mod+PageDown")]() { return () => this.gotoNthLeaf(1, true); },
            [command("go-1st", "Jump to 1st pane in the workspace", "Alt+1")]() { return () => this.gotoNthLeaf(0); },
            [command("go-2nd", "Jump to 2nd pane in the workspace", "Alt+2")]() { return () => this.gotoNthLeaf(1); },
            [command("go-3rd", "Jump to 3rd pane in the workspace", "Alt+3")]() { return () => this.gotoNthLeaf(2); },
            [command("go-4th", "Jump to 4th pane in the workspace", "Alt+4")]() { return () => this.gotoNthLeaf(3); },
            [command("go-5th", "Jump to 5th pane in the workspace", "Alt+5")]() { return () => this.gotoNthLeaf(4); },
            [command("go-6th", "Jump to 6th pane in the workspace", "Alt+6")]() { return () => this.gotoNthLeaf(5); },
            [command("go-7th", "Jump to 7th pane in the workspace", "Alt+7")]() { return () => this.gotoNthLeaf(6); },
            [command("go-8th", "Jump to 8th pane in the workspace", "Alt+8")]() { return () => this.gotoNthLeaf(7); },
            [command("go-last", "Jump to last pane in the workspace", "Alt+9")]() { return () => this.gotoNthLeaf(99999999); },
            [command("put-1st", "Place as 1st pane in the split", "Mod+Alt+1")]() { return () => this.placeLeaf(0, false); },
            [command("put-2nd", "Place as 2nd pane in the split", "Mod+Alt+2")]() { return () => this.placeLeaf(1, false); },
            [command("put-3rd", "Place as 3rd pane in the split", "Mod+Alt+3")]() { return () => this.placeLeaf(2, false); },
            [command("put-4th", "Place as 4th pane in the split", "Mod+Alt+4")]() { return () => this.placeLeaf(3, false); },
            [command("put-5th", "Place as 5th pane in the split", "Mod+Alt+5")]() { return () => this.placeLeaf(4, false); },
            [command("put-6th", "Place as 6th pane in the split", "Mod+Alt+6")]() { return () => this.placeLeaf(5, false); },
            [command("put-7th", "Place as 7th pane in the split", "Mod+Alt+7")]() { return () => this.placeLeaf(6, false); },
            [command("put-8th", "Place as 8th pane in the split", "Mod+Alt+8")]() { return () => this.placeLeaf(7, false); },
            [command("put-last", "Place as last pane in the split", "Mod+Alt+9")]() { return () => this.placeLeaf(99999999, false); }
        });
    }
    setupDisplay() {
        this.addChild(this.back = new Navigator(this, "back", -1));
        this.addChild(this.forward = new Navigator(this, "forward", 1));
    }
    display(history = History.forLeaf(this.app.workspace.activeLeaf)) {
        if (this.historyIsOpen)
            return;
        this.back.setHistory(history);
        this.forward.setHistory(history);
    }
    iterateRootLeaves(cb) {
        this.app.workspace.iterateRootLeaves(cb);
        // Support Hover Editors
        const popovers = this.app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers)
            for (const popover of popovers) {
                // More recent plugin: we can skip the scan
                if (popover.constructor.iteratePopoverLeaves)
                    return false;
                if (popover.leaf && cb(popover.leaf))
                    return true;
                if (popover.rootSplit && this.app.workspace.iterateLeaves(cb, popover.rootSplit))
                    return true;
            }
        return false;
    }
    updateLeaf(leaf) {
        const history = History.forLeaf(leaf);
        leaf.containerEl.style.setProperty("--pane-relief-forward-count", '"' + (history.lookAhead().length || "") + '"');
        leaf.containerEl.style.setProperty("--pane-relief-backward-count", '"' + (history.lookBehind().length || "") + '"');
        this.leafMap.set(leaf.containerEl, leaf);
    }
    numberPanes() {
        let count = 0, lastLeaf = null;
        this.iterateRootLeaves(leaf => {
            leaf.containerEl.style.setProperty("--pane-relief-label", ++count < 9 ? "" + count : "");
            leaf.containerEl.toggleClass("has-pane-relief-label", count < 9);
            lastLeaf = leaf;
        });
        if (count > 8) {
            lastLeaf?.containerEl.style.setProperty("--pane-relief-label", "9");
            lastLeaf?.containerEl.toggleClass("has-pane-relief-label", true);
        }
        this.app.workspace.iterateAllLeaves(leaf => this.updateLeaf(leaf));
    }
    onunload() {
        this.app.workspace.unregisterHoverLinkSource(Navigator.hoverSource);
        this.iterateRootLeaves(leaf => {
            leaf.containerEl.style.removeProperty("--pane-relief-label");
            leaf.containerEl.toggleClass("has-pane-relief-label", false);
        });
        this.app.workspace.iterateAllLeaves(leaf => {
            leaf.containerEl.style.removeProperty("--pane-relief-forward-count");
            leaf.containerEl.style.removeProperty("--pane-relief-backward-count");
        });
    }
    gotoNthLeaf(n, relative) {
        const leaves = [];
        this.iterateRootLeaves((leaf) => (leaves.push(leaf), false));
        if (relative) {
            n += leaves.indexOf(this.app.workspace.activeLeaf);
            n = (n + leaves.length) % leaves.length; // wrap around
        }
        const leaf = leaves[n >= leaves.length ? leaves.length - 1 : n];
        !leaf || this.app.workspace.setActiveLeaf(leaf, true, true);
    }
    placeLeaf(toPos, relative = true) {
        const cb = this.leafPlacer(toPos, relative);
        if (cb)
            cb();
    }
    leafPlacer(toPos, relative = true) {
        const leaf = this.app.workspace.activeLeaf;
        if (!leaf)
            return false;
        const parentSplit = leaf.parentSplit, children = parentSplit.children, fromPos = children.indexOf(leaf);
        if (fromPos == -1)
            return false;
        if (relative) {
            toPos += fromPos;
            if (toPos < 0 || toPos >= children.length)
                return false;
        }
        else {
            if (toPos >= children.length)
                toPos = children.length - 1;
            if (toPos < 0)
                toPos = 0;
        }
        if (fromPos == toPos)
            return false;
        return () => {
            const other = children[toPos];
            children.splice(fromPos, 1);
            children.splice(toPos, 0, leaf);
            if (parentSplit.selectTab) {
                parentSplit.selectTab(leaf);
            }
            else {
                other.containerEl.insertAdjacentElement(fromPos > toPos ? "beforebegin" : "afterend", leaf.containerEl);
                parentSplit.recomputeChildrenDimensions();
                leaf.onResize();
                this.app.workspace.onLayoutChange();
                // Force focus back to pane;
                this.app.workspace.activeLeaf = null;
                this.app.workspace.setActiveLeaf(leaf, false, true);
            }
        };
    }
}

module.exports = PaneRelief;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLnRzIiwibm9kZV9tb2R1bGVzLy5wbnBtL21vbmtleS1hcm91bmRAMi4zLjAvbm9kZV9tb2R1bGVzL21vbmtleS1hcm91bmQvbWpzL2luZGV4LmpzIiwic3JjL0hpc3RvcnkudHMiLCJzcmMvTmF2aWdhdG9yLnRzIiwic3JjL3BhbmUtcmVsaWVmLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmltcG9ydCB7Q29tbWFuZCwgSG90a2V5LCBNb2RpZmllciwgUGx1Z2lufSBmcm9tIFwib2JzaWRpYW5cIlxuXG50eXBlIEtleURlZiA9IEhvdGtleSB8IHN0cmluZ1xuXG5jb25zdCBjb21tYW5kczogUmVjb3JkPHN5bWJvbCwgQ29tbWFuZD4gPSB7fTsgLy9uZXcgTWFwO1xuXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZChpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGhvdGtleXM6IEtleURlZiB8IEtleURlZltdID0gW10sIGNtZD17fSkge1xuXG4gICAgLy8gQWxsb3cgaG90a2V5cyB0byBiZSBleHByZXNzZWQgYXMgYSBzdHJpbmcsIGFycmF5IG9mIHN0cmluZ3MsXG4gICAgLy8gb2JqZWN0LCBvciBhcnJheSBvZiBvYmplY3RzLiAgKE5vcm1hbGl6ZSB0byBhbiBhcnJheSBmaXJzdC4pXG4gICAgaWYgKHR5cGVvZiBob3RrZXlzID09PSBcInN0cmluZ1wiKSBob3RrZXlzID0gW2hvdGtleXNdO1xuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJvYmplY3RcIiAmJiAoaG90a2V5cyBhcyBIb3RrZXkpLmtleSkgaG90a2V5cyA9IFtob3RrZXlzIGFzIEhvdGtleV07XG5cbiAgICBsZXQga2V5czogSG90a2V5W10gPSAoaG90a2V5cyBhcyBLZXlEZWZbXSkubWFwKGZ1bmN0aW9uKGtleSk6IEhvdGtleSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAgbGV0IHBhcnRzID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IHBhcnRzIGFzIE1vZGlmaWVyW10sIGtleTogcGFydHMucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5czoga2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kIGFzIENvbW1hbmQ7XG4gICAgcmV0dXJuIHN5bTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbW1hbmRzPFAgZXh0ZW5kcyBQbHVnaW4+KFxuICAgIHBsdWdpbjogUCxcbiAgICBjbWRzZXQ6IFJlY29yZDxzeW1ib2wsICh0aGlzQXJnOiBQKSA9PiBib29sZWFuIHwgKCgpID0+IGFueSk+XG4pIHtcbiAgICAvLyBFeHRyYWN0IGNvbW1hbmQgc3ltYm9scyBmcm9tIGNtZHNldCBhbmQgcmVnaXN0ZXIgdGhlbSwgYm91bmQgdG8gdGhlIHBsdWdpbiBmb3IgbWV0aG9kc1xuICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eVN5bWJvbHMoY21kc2V0KS5mb3JFYWNoKHN5bSA9PiB7XG4gICAgICAgIGNvbnN0IGNtZCA9IGNvbW1hbmRzW3N5bV0sIG1ldGhvZCA9IGNtZHNldFtzeW1dO1xuICAgICAgICBpZiAoY21kKSBwbHVnaW4uYWRkQ29tbWFuZChPYmplY3QuYXNzaWduKHt9LCBjbWQsIHtcbiAgICAgICAgICAgIGNoZWNrQ2FsbGJhY2soY2hlY2s6IGJvb2xlYW4pIHtcbiAgICAgICAgICAgICAgICAvLyBDYWxsIHRoZSBtZXRob2QgYm9keSB3aXRoIHRoZSBwbHVnaW4gYXMgJ3RoaXMnXG4gICAgICAgICAgICAgICAgY29uc3QgY2IgPSBtZXRob2QuY2FsbChwbHVnaW4pO1xuICAgICAgICAgICAgICAgIC8vIEl0IHRoZW4gcmV0dXJucyBhIGNsb3N1cmUgaWYgdGhlIGNvbW1hbmQgaXMgcmVhZHkgdG8gZXhlY3V0ZSwgYW5kXG4gICAgICAgICAgICAgICAgLy8gd2UgY2FsbCB0aGF0IGNsb3N1cmUgdW5sZXNzIHRoaXMgaXMganVzdCBhIGNoZWNrIGZvciBhdmFpbGFiaWxpdHlcbiAgICAgICAgICAgICAgICByZXR1cm4gKGNoZWNrIHx8IHR5cGVvZiBjYiAhPT0gXCJmdW5jdGlvblwiKSA/ICEhY2IgOiAoY2IoKSwgdHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pKTtcbiAgICB9KVxufSIsImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGRlZHVwZShrZXksIG9sZEZuLCBuZXdGbikge1xuICAgIGNoZWNrW2tleV0gPSBrZXk7XG4gICAgcmV0dXJuIGNoZWNrO1xuICAgIGZ1bmN0aW9uIGNoZWNrKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIChvbGRGbltrZXldID09PSBrZXkgPyBvbGRGbiA6IG5ld0ZuKS5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXIocHJvbWlzZSwgY2IpIHtcbiAgICByZXR1cm4gcHJvbWlzZS50aGVuKGNiLCBjYik7XG59XG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplKGFzeW5jRnVuY3Rpb24pIHtcbiAgICBsZXQgbGFzdFJ1biA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4ge1xuICAgICAgICAgICAgYWZ0ZXIobGFzdFJ1biwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGFzeW5jRnVuY3Rpb24uYXBwbHkodGhpcywgYXJncykudGhlbihyZXMsIHJlaik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdyYXBwZXIuYWZ0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGFmdGVyKGxhc3RSdW4sIHJlcyk7IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHdyYXBwZXI7XG59XG4iLCJpbXBvcnQge05vdGljZSwgVEFic3RyYWN0RmlsZSwgVmlld1N0YXRlLCBXb3Jrc3BhY2VMZWFmfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcbmltcG9ydCBQYW5lUmVsaWVmIGZyb20gXCIuL3BhbmUtcmVsaWVmXCI7XG5cbmNvbnN0IEhJU1RfQVRUUiA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuY29uc3QgU0VSSUFMX1BST1AgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcblxuZGVjbGFyZSBtb2R1bGUgXCJvYnNpZGlhblwiIHtcbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlIHtcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQoc3RhdGU6IGFueSwgLi4uZXRjOiBhbnlbXSk6IFByb21pc2U8V29ya3NwYWNlSXRlbT5cbiAgICB9XG5cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlTGVhZiB7XG4gICAgICAgIFtISVNUX0FUVFJdOiBIaXN0b3J5XG4gICAgICAgIHBpbm5lZDogYm9vbGVhblxuICAgICAgICB3b3JraW5nOiBib29sZWFuXG4gICAgICAgIHNlcmlhbGl6ZSgpOiBhbnlcbiAgICB9XG5cbiAgICBpbnRlcmZhY2UgVmlld1N0YXRlIHtcbiAgICAgICAgcG9wc3RhdGU/OiBib29sZWFuXG4gICAgfVxufVxuXG5cbmNvbnN0IGRvbUxlYXZlcyA9IG5ldyBXZWFrTWFwKCk7XG5cbmludGVyZmFjZSBQdXNoU3RhdGUge1xuICAgIHN0YXRlOiBzdHJpbmdcbiAgICBlU3RhdGU6IHN0cmluZ1xufVxuXG5leHBvcnQgY2xhc3MgSGlzdG9yeUVudHJ5IHtcblxuICAgIHJhdzogUHVzaFN0YXRlXG4gICAgZVN0YXRlOiBhbnlcbiAgICBwYXRoOiBzdHJpbmdcblxuICAgIGNvbnN0cnVjdG9yKHJhd1N0YXRlOiBQdXNoU3RhdGUpIHtcbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgfVxuXG5cbiAgICBnZXQgdmlld1N0YXRlKCkge1xuICAgICAgICByZXR1cm4gSlNPTi5wYXJzZSh0aGlzLnJhdy5zdGF0ZSB8fCBcInt9XCIpXG4gICAgfVxuXG4gICAgc2V0U3RhdGUocmF3U3RhdGU6IFB1c2hTdGF0ZSkge1xuICAgICAgICB0aGlzLnJhdyA9IHJhd1N0YXRlO1xuICAgICAgICB0aGlzLmVTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuZVN0YXRlIHx8IFwibnVsbFwiKTtcbiAgICAgICAgdGhpcy5wYXRoID0gdGhpcy52aWV3U3RhdGUuc3RhdGU/LmZpbGU7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZTogVEFic3RyYWN0RmlsZSwgb2xkUGF0aDogc3RyaW5nKSB7XG4gICAgICAgIGlmICh0aGlzLnBhdGggPT09IG9sZFBhdGgpIHtcbiAgICAgICAgICAgIGNvbnN0IHZpZXdTdGF0ZSA9IHRoaXMudmlld1N0YXRlXG4gICAgICAgICAgICB0aGlzLnBhdGggPSB2aWV3U3RhdGUuc3RhdGUuZmlsZSA9IGZpbGUucGF0aFxuICAgICAgICAgICAgdGhpcy5yYXcuc3RhdGUgPSBKU09OLnN0cmluZ2lmeSh2aWV3U3RhdGUpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ28obGVhZj86IFdvcmtzcGFjZUxlYWYpIHtcbiAgICAgICAgbGV0IHt2aWV3U3RhdGUsIHBhdGgsIGVTdGF0ZX0gPSB0aGlzO1xuICAgICAgICBsZXQgZmlsZSA9IHBhdGggJiYgYXBwPy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICAgIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiTWlzc2luZyBmaWxlOiBcIitwYXRoKTtcbiAgICAgICAgICAgIHZpZXdTdGF0ZSA9IHt0eXBlOiBcImVtcHR5XCIsIHN0YXRlOnt9fTtcbiAgICAgICAgICAgIGVTdGF0ZSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBsZWFmLnNldFZpZXdTdGF0ZSh7Li4udmlld1N0YXRlLCBhY3RpdmU6IHRydWUsIHBvcHN0YXRlOiB0cnVlfSwgZVN0YXRlKTtcbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGU6IFB1c2hTdGF0ZSkge1xuICAgICAgICBpZiAocmF3U3RhdGUuc3RhdGUgIT09IHRoaXMucmF3LnN0YXRlKSB7XG4gICAgICAgICAgICBjb25zdCB2aWV3U3RhdGUgPSBKU09OLnBhcnNlKHJhd1N0YXRlLnN0YXRlIHx8IFwie31cIik7XG4gICAgICAgICAgICAvLyBEb24ndCByZXBsYWNlIGEgZmlsZSB3aXRoIGFuIGVtcHR5IGluIHRoZSBoaXN0b3J5XG4gICAgICAgICAgICBpZiAodmlld1N0YXRlLnR5cGUgPT09IFwiZW1wdHlcIikgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAvLyBGaWxlIGlzIGRpZmZlcmVudCBmcm9tIGV4aXN0aW5nIGZpbGU6IHNob3VsZCBiZSBhIHB1c2ggaW5zdGVhZFxuICAgICAgICAgICAgaWYgKHRoaXMucGF0aCAmJiB0aGlzLnBhdGggIT09IHZpZXdTdGF0ZT8uc3RhdGU/LmZpbGUpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGlmICh2aWV3U3RhdGUudHlwZSA9PT0gXCJtZWRpYS12aWV3XCIpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBvbGRJbmZvID0gSlNPTi5zdHJpbmdpZnkodGhpcy52aWV3U3RhdGUuc3RhdGUuaW5mbyk7XG4gICAgICAgICAgICAgICAgY29uc3QgbmV3SW5mbyA9IEpTT04uc3RyaW5naWZ5KHZpZXdTdGF0ZS5zdGF0ZS5pbmZvKTtcbiAgICAgICAgICAgICAgICBpZiAob2xkSW5mbyAhPT0gbmV3SW5mbykgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG59XG5cbmludGVyZmFjZSBTZXJpYWxpemFibGVIaXN0b3J5IHtcbiAgICBwb3M6IG51bWJlclxuICAgIHN0YWNrOiBQdXNoU3RhdGVbXVxufVxuXG5leHBvcnQgY2xhc3MgSGlzdG9yeSB7XG4gICAgc3RhdGljIGN1cnJlbnQoKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmZvckxlYWYoYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB8fCBuZXcgdGhpcygpO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYpIHtcbiAgICAgICAgaWYgKGxlYWYpIGRvbUxlYXZlcy5zZXQobGVhZi5jb250YWluZXJFbCwgbGVhZik7XG4gICAgICAgIGlmIChsZWFmKSByZXR1cm4gbGVhZltISVNUX0FUVFJdIGluc3RhbmNlb2YgdGhpcyA/XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gOlxuICAgICAgICAgICAgbGVhZltISVNUX0FUVFJdID0gbmV3IHRoaXMobGVhZiwgbGVhZltISVNUX0FUVFJdPy5zZXJpYWxpemUoKSB8fCB1bmRlZmluZWQpO1xuICAgIH1cblxuICAgIHBvczogbnVtYmVyXG4gICAgc3RhY2s6IEhpc3RvcnlFbnRyeVtdXG5cbiAgICBjb25zdHJ1Y3RvcihwdWJsaWMgbGVhZj86IFdvcmtzcGFjZUxlYWYsIHtwb3MsIHN0YWNrfTogU2VyaWFsaXphYmxlSGlzdG9yeSA9IHtwb3M6MCwgc3RhY2s6W119KSB7XG4gICAgICAgIHRoaXMubGVhZiA9IGxlYWY7XG4gICAgICAgIHRoaXMucG9zID0gcG9zO1xuICAgICAgICB0aGlzLnN0YWNrID0gc3RhY2subWFwKHJhdyA9PiBuZXcgSGlzdG9yeUVudHJ5KHJhdykpO1xuICAgIH1cblxuICAgIGNsb25lVG8obGVhZjogV29ya3NwYWNlTGVhZikge1xuICAgICAgICByZXR1cm4gbGVhZltISVNUX0FUVFJdID0gbmV3IEhpc3RvcnkobGVhZiwgdGhpcy5zZXJpYWxpemUoKSk7XG4gICAgfVxuXG4gICAgb25SZW5hbWUoZmlsZTogVEFic3RyYWN0RmlsZSwgb2xkUGF0aDogc3RyaW5nKSB7XG4gICAgICAgIGZvcihjb25zdCBoaXN0RW50cnkgb2YgdGhpcy5zdGFjaykgaGlzdEVudHJ5Lm9uUmVuYW1lKGZpbGUsIG9sZFBhdGgpO1xuICAgIH1cblxuICAgIHNlcmlhbGl6ZSgpOiBTZXJpYWxpemFibGVIaXN0b3J5IHsgcmV0dXJuIHtwb3M6IHRoaXMucG9zLCBzdGFjazogdGhpcy5zdGFjay5tYXAoZSA9PiBlLnJhdyl9OyB9XG5cbiAgICBnZXQgc3RhdGUoKSB7IHJldHVybiB0aGlzLnN0YWNrW3RoaXMucG9zXT8ucmF3IHx8IG51bGw7IH1cbiAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gdGhpcy5zdGFjay5sZW5ndGg7IH1cblxuICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9XG4gICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH1cblxuICAgIGxvb2tBaGVhZCgpIHsgcmV0dXJuIHRoaXMuc3RhY2suc2xpY2UoMCwgdGhpcy5wb3MpLnJldmVyc2UoKTsgfVxuICAgIGxvb2tCZWhpbmQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKHRoaXMucG9zKzEpOyB9XG5cbiAgICBnb3RvKHBvczogbnVtYmVyKTogdm9pZCB7XG4gICAgICAgIGlmICghdGhpcy5sZWFmKSByZXR1cm47XG4gICAgICAgIGlmICh0aGlzLmxlYWYucGlubmVkKSByZXR1cm4gbmV3IE5vdGljZShcIlBpbm5lZCBwYW5lOiB1bnBpbiBiZWZvcmUgZ29pbmcgZm9yd2FyZCBvciBiYWNrXCIpLCB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh0aGlzLmxlYWYud29ya2luZykgcmV0dXJuIG5ldyBOb3RpY2UoXCJQYW5lIGlzIGJ1c3k6IHBsZWFzZSB3YWl0IGJlZm9yZSBuYXZpZ2F0aW5nIGZ1cnRoZXJcIiksIHVuZGVmaW5lZDtcbiAgICAgICAgcG9zID0gdGhpcy5wb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihwb3MsIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICB0aGlzLnN0YWNrW3Bvc10/LmdvKHRoaXMubGVhZik7XG4gICAgICAgIGFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKTtcbiAgICB9XG5cbiAgICBnbyhieTogbnVtYmVyLCBmb3JjZT86IGJvb2xlYW4pIHtcbiAgICAgICAgaWYgKCF0aGlzLmxlYWYgfHwgIWJ5KSByZXR1cm47ICAvLyBuby1vcFxuICAgICAgICAvLyBwcmV2ZW50IHdyYXBhcm91bmRcbiAgICAgICAgY29uc3QgbmV3UG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odGhpcy5wb3MgLSBieSwgdGhpcy5zdGFjay5sZW5ndGggLSAxKSk7XG4gICAgICAgIGlmIChmb3JjZSB8fCBuZXdQb3MgIT09IHRoaXMucG9zKSB7XG4gICAgICAgICAgICB0aGlzLmdvdG8obmV3UG9zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYE5vIG1vcmUgJHtieSA8IDAgPyBcImJhY2tcIiA6IFwiZm9yd2FyZFwifSBoaXN0b3J5IGZvciBwYW5lYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGU6IFB1c2hTdGF0ZSwgdGl0bGU6IHN0cmluZywgdXJsOiBzdHJpbmcpe1xuICAgICAgICBjb25zdCBlbnRyeSA9IHRoaXMuc3RhY2tbdGhpcy5wb3NdO1xuICAgICAgICBpZiAoIWVudHJ5KSB7XG4gICAgICAgICAgICB0aGlzLnN0YWNrW3RoaXMucG9zXSA9IG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpO1xuICAgICAgICB9IGVsc2UgaWYgKCFlbnRyeS5yZXBsYWNlU3RhdGUocmF3U3RhdGUpKSB7XG4gICAgICAgICAgICAvLyByZXBsYWNlU3RhdGUgd2FzIGVycm9uZW91c2x5IGNhbGxlZCB3aXRoIGEgbmV3IGZpbGUgZm9yIHRoZSBzYW1lIGxlYWY7XG4gICAgICAgICAgICAvLyBmb3JjZSBhIHB1c2hTdGF0ZSBpbnN0ZWFkIChmaXhlcyB0aGUgaXNzdWUgcmVwb3J0ZWQgaGVyZTogaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90LzE4NTE4KVxuICAgICAgICAgICAgdGhpcy5wdXNoU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcHVzaFN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKSAgIHtcbiAgICAgICAgLy9jb25zb2xlLmxvZyhcInB1c2hpbmdcIiwgcmF3U3RhdGUpXG4gICAgICAgIHRoaXMuc3RhY2suc3BsaWNlKDAsIHRoaXMucG9zLCBuZXcgSGlzdG9yeUVudHJ5KHJhd1N0YXRlKSk7XG4gICAgICAgIHRoaXMucG9zID0gMDtcbiAgICAgICAgLy8gTGltaXQgXCJiYWNrXCIgdG8gMjBcbiAgICAgICAgd2hpbGUgKHRoaXMuc3RhY2subGVuZ3RoID4gMjApIHRoaXMuc3RhY2sucG9wKCk7XG4gICAgICAgIGFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKVxuICAgIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxIaXN0b3J5KHBsdWdpbjogUGFuZVJlbGllZikge1xuXG4gICAgLy8gTW9ua2V5cGF0Y2g6IGluY2x1ZGUgaGlzdG9yeSBpbiBsZWFmIHNlcmlhbGl6YXRpb24gKHNvIGl0J3MgcGVyc2lzdGVkIHdpdGggdGhlIHdvcmtzcGFjZSlcbiAgICAvLyBhbmQgY2hlY2sgZm9yIHBvcHN0YXRlIGV2ZW50cyAodG8gc3VwcHJlc3MgdGhlbSlcbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKFdvcmtzcGFjZUxlYWYucHJvdG90eXBlLCB7XG4gICAgICAgIHNlcmlhbGl6ZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNlcmlhbGl6ZSgpe1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICBpZiAodGhpc1tISVNUX0FUVFJdKSByZXN1bHRbU0VSSUFMX1BST1BdID0gdGhpc1tISVNUX0FUVFJdLnNlcmlhbGl6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX0sXG4gICAgICAgIHNldFZpZXdTdGF0ZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNldFZpZXdTdGF0ZSh2cywgZXMpe1xuICAgICAgICAgICAgaWYgKHZzLnBvcHN0YXRlICYmIHdpbmRvdy5ldmVudD8udHlwZSA9PT0gXCJwb3BzdGF0ZVwiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMsIHZzLCBlcyk7XG4gICAgICAgIH19XG4gICAgfSkpO1xuXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChhcHAud29ya3NwYWNlLCB7XG4gICAgICAgIC8vIE1vbmtleXBhdGNoOiBsb2FkIGhpc3RvcnkgZHVyaW5nIGxlYWYgbG9hZCwgaWYgcHJlc2VudFxuICAgICAgICBkZXNlcmlhbGl6ZUxheW91dChvbGQpIHsgcmV0dXJuIGFzeW5jIGZ1bmN0aW9uIGRlc2VyaWFsaXplTGF5b3V0KHN0YXRlLCAuLi5ldGM6IGFueVtdKXtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBvbGQuY2FsbCh0aGlzLCBzdGF0ZSwgLi4uZXRjKTtcbiAgICAgICAgICAgIGlmIChzdGF0ZS50eXBlID09PSBcImxlYWZcIikge1xuICAgICAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFJldHJ5IGxvYWRpbmcgdGhlIHBhbmUgYXMgYW4gZW1wdHlcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUuc3RhdGUudHlwZSA9ICdlbXB0eSc7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXJlc3VsdCkgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlW1NFUklBTF9QUk9QXSkgcmVzdWx0W0hJU1RfQVRUUl0gPSBuZXcgSGlzdG9yeShyZXN1bHQsIHN0YXRlW1NFUklBTF9QUk9QXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9fSxcbiAgICAgICAgLy8gTW9ua2V5cGF0Y2g6IGtlZXAgT2JzaWRpYW4gZnJvbSBwdXNoaW5nIGhpc3RvcnkgaW4gc2V0QWN0aXZlTGVhZlxuICAgICAgICBzZXRBY3RpdmVMZWFmKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24gc2V0QWN0aXZlTGVhZihsZWFmLCAuLi5ldGMpIHtcbiAgICAgICAgICAgIGNvbnN0IHVuc3ViID0gYXJvdW5kKHRoaXMsIHtcbiAgICAgICAgICAgICAgICByZWNvcmRIaXN0b3J5KG9sZCkgeyByZXR1cm4gZnVuY3Rpb24gKGxlYWY6IFdvcmtzcGFjZUxlYWYsIF9wdXNoOiBib29sZWFuLCAuLi5hcmdzOiBhbnlbXSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBBbHdheXMgdXBkYXRlIHN0YXRlIGluIHBsYWNlXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBsZWFmLCBmYWxzZSwgLi4uYXJncyk7XG4gICAgICAgICAgICAgICAgfTsgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBsZWFmLCAuLi5ldGMpO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICB1bnN1YigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9fSxcbiAgICB9KSk7XG5cbiAgICAvLyBPdmVycmlkZSBkZWZhdWx0IG1vdXNlIGhpc3RvcnkgYmVoYXZpb3IuICBXZSBuZWVkIHRoaXMgYmVjYXVzZSAxKSBFbGVjdHJvbiB3aWxsIHVzZSB0aGUgYnVpbHQtaW5cbiAgICAvLyBoaXN0b3J5IG9iamVjdCBpZiB3ZSBkb24ndCAoaW5zdGVhZCBvZiBvdXIgd3JhcHBlciksIGFuZCAyKSB3ZSB3YW50IHRoZSBjbGljayB0byBhcHBseSB0byB0aGUgbGVhZlxuICAgIC8vIHRoYXQgd2FzIHVuZGVyIHRoZSBtb3VzZSwgcmF0aGVyIHRoYW4gd2hpY2hldmVyIGxlYWYgd2FzIGFjdGl2ZS5cbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+IHtcbiAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpO1xuICAgIH0pO1xuICAgIGZ1bmN0aW9uIGhpc3RvcnlIYW5kbGVyKGU6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgaWYgKGUuYnV0dG9uICE9PSAzICYmIGUuYnV0dG9uICE9PSA0KSByZXR1cm47XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wUHJvcGFnYXRpb24oKTsgIC8vIHByZXZlbnQgZGVmYXVsdCBiZWhhdmlvclxuICAgICAgICBjb25zdCB0YXJnZXQgPSAoZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQpLm1hdGNoUGFyZW50KFwiLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICBpZiAodGFyZ2V0ICYmIGUudHlwZSA9PT0gXCJtb3VzZXVwXCIpIHtcbiAgICAgICAgICAgIGxldCBsZWFmID0gZG9tTGVhdmVzLmdldCh0YXJnZXQpO1xuICAgICAgICAgICAgaWYgKCFsZWFmKSBhcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMobCA9PiBsZWFmID0gKGwuY29udGFpbmVyRWwgPT09IHRhcmdldCkgPyBsIDogbGVhZik7XG4gICAgICAgICAgICBpZiAoIWxlYWYpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSAzKSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5iYWNrKCk7IH1cbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSA0KSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5mb3J3YXJkKCk7IH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUHJveHkgdGhlIHdpbmRvdyBoaXN0b3J5IHdpdGggYSB3cmFwcGVyIHRoYXQgZGVsZWdhdGVzIHRvIHRoZSBhY3RpdmUgbGVhZidzIEhpc3Rvcnkgb2JqZWN0LFxuICAgIGNvbnN0IHJlYWxIaXN0b3J5ID0gd2luZG93Lmhpc3Rvcnk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+ICh3aW5kb3cgYXMgYW55KS5oaXN0b3J5ID0gcmVhbEhpc3RvcnkpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiaGlzdG9yeVwiLCB7IGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUsIHZhbHVlOiB7XG4gICAgICAgIGdldCBzdGF0ZSgpICAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KCkuc3RhdGU7IH0sXG4gICAgICAgIGdldCBsZW5ndGgoKSAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KCkubGVuZ3RoOyB9LFxuXG4gICAgICAgIGJhY2soKSAgICB7IHRoaXMuZ28oLTEpOyB9LFxuICAgICAgICBmb3J3YXJkKCkgeyB0aGlzLmdvKCAxKTsgfSxcbiAgICAgICAgZ28oYnk6IG51bWJlcikgICAgeyBIaXN0b3J5LmN1cnJlbnQoKS5nbyhieSk7IH0sXG5cbiAgICAgICAgcmVwbGFjZVN0YXRlKHN0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKXsgSGlzdG9yeS5jdXJyZW50KCkucmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcbiAgICAgICAgcHVzaFN0YXRlKHN0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKSAgIHsgSGlzdG9yeS5jdXJyZW50KCkucHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcblxuICAgICAgICBnZXQgc2Nyb2xsUmVzdG9yYXRpb24oKSAgICB7IHJldHVybiByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbjsgfSxcbiAgICAgICAgc2V0IHNjcm9sbFJlc3RvcmF0aW9uKHZhbCkgeyByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbiA9IHZhbDsgfSxcbiAgICB9fSk7XG5cbn1cbiIsImltcG9ydCB7TWVudSwgS2V5bWFwLCBDb21wb25lbnQsIFdvcmtzcGFjZUxlYWYsIFRGaWxlLCBUQWJzdHJhY3RGaWxlLCBNZW51SXRlbX0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHtIaXN0b3J5LCBIaXN0b3J5RW50cnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcbmltcG9ydCBQYW5lUmVsaWVmIGZyb20gJy4vcGFuZS1yZWxpZWYnO1xuXG5kZWNsYXJlIG1vZHVsZSBcIm9ic2lkaWFuXCIge1xuICAgIGludGVyZmFjZSBNZW51IHtcbiAgICAgICAgZG9tOiBIVE1MRWxlbWVudFxuICAgIH1cbiAgICBpbnRlcmZhY2UgTWVudUl0ZW0ge1xuICAgICAgICBkb206IEhUTUxFbGVtZW50XG4gICAgfVxuICAgIGludGVyZmFjZSBBcHAge1xuICAgICAgICBkcmFnTWFuYWdlcjogRHJhZ01hbmFnZXJcbiAgICB9XG4gICAgaW50ZXJmYWNlIERyYWdNYW5hZ2VyIHtcbiAgICAgICAgZHJhZ0ZpbGUoZXZlbnQ6IERyYWdFdmVudCwgZmlsZTogVEZpbGUpOiBEcmFnRGF0YVxuICAgICAgICBvbkRyYWdTdGFydChldmVudDogRHJhZ0V2ZW50LCBkcmFnRGF0YTogRHJhZ0RhdGEpOiB2b2lkXG4gICAgfVxuICAgIGludGVyZmFjZSBEcmFnRGF0YSB7fVxufVxuXG5pbnRlcmZhY2UgRmlsZUluZm8ge1xuICAgIGljb246IHN0cmluZ1xuICAgIHRpdGxlOiBzdHJpbmdcbiAgICBmaWxlOiBURmlsZVxuICAgIHR5cGU6IHN0cmluZ1xuICAgIHN0YXRlOiBhbnlcbiAgICBlU3RhdGU6IGFueVxufVxuXG5cbmNvbnN0IHZpZXd0eXBlSWNvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgbWFya2Rvd246IFwiZG9jdW1lbnRcIixcbiAgICBpbWFnZTogXCJpbWFnZS1maWxlXCIsXG4gICAgYXVkaW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHZpZGVvOiBcImF1ZGlvLWZpbGVcIixcbiAgICBwZGY6IFwicGRmLWZpbGVcIixcbiAgICBsb2NhbGdyYXBoOiBcImRvdC1uZXR3b3JrXCIsXG4gICAgb3V0bGluZTogXCJidWxsZXQtbGlzdFwiLFxuICAgIGJhY2tsaW5rOiBcImxpbmtcIixcblxuICAgIC8vIHRoaXJkLXBhcnR5IHBsdWdpbnNcbiAgICBrYW5iYW46IFwiYmxvY2tzXCIsXG4gICAgZXhjYWxpZHJhdzogXCJleGNhbGlkcmF3LWljb25cIixcbiAgICBcIm1lZGlhLXZpZXdcIjogXCJhdWRpby1maWxlXCIsXG59XG5cbmNvbnN0IG5vbkZpbGVWaWV3czogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge1xuICAgIGdyYXBoOiBbXCJkb3QtbmV0d29ya1wiLCBcIkdyYXBoIFZpZXdcIl0sXG4gICAgXCJmaWxlLWV4cGxvcmVyXCI6IFtcImZvbGRlclwiLCBcIkZpbGUgRXhwbG9yZXJcIl0sXG4gICAgc3RhcnJlZDogW1wic3RhclwiLCBcIlN0YXJyZWQgRmlsZXNcIl0sXG4gICAgdGFnOiBbXCJ0YWdcIiwgXCJUYWdzIFZpZXdcIl0sXG5cbiAgICAvLyB0aGlyZC1wYXJ0eSBwbHVnaW5zXG4gICAgXCJyZWNlbnQtZmlsZXNcIjogW1wiY2xvY2tcIiwgXCJSZWNlbnQgRmlsZXNcIl0sXG4gICAgY2FsZW5kYXI6IFtcImNhbGVuZGFyLXdpdGgtY2hlY2ttYXJrXCIsIFwiQ2FsZW5kYXJcIl0sXG4gICAgZW1wdHk6IFtcImNyb3NzXCIsIFwiTm8gZmlsZVwiXVxufVxuXG5leHBvcnQgY2xhc3MgTmF2aWdhdG9yIGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIHN0YXRpYyBob3ZlclNvdXJjZSA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS1tZW51XCI7XG5cbiAgICBjb250YWluZXJFbDogSFRNTEVsZW1lbnRcbiAgICBjb3VudDogSFRNTFNwYW5FbGVtZW50XG4gICAgbGVhZjogV29ya3NwYWNlTGVhZiA9IG51bGw7XG4gICAgaGlzdG9yeTogSGlzdG9yeSA9IG51bGw7XG4gICAgc3RhdGVzOiBIaXN0b3J5RW50cnlbXTtcbiAgICBvbGRMYWJlbDogc3RyaW5nXG5cbiAgICBjb25zdHJ1Y3RvcihwdWJsaWMgcGx1Z2luOiBQYW5lUmVsaWVmLCBwdWJsaWMga2luZDogc3RyaW5nLCBwdWJsaWMgZGlyOiBudW1iZXIpICB7XG4gICAgICAgIHN1cGVyKCk7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gZG9jdW1lbnQuYm9keS5maW5kKFxuICAgICAgICAgICAgYC50aXRsZWJhciAudGl0bGViYXItYnV0dG9uLWNvbnRhaW5lci5tb2QtbGVmdCAudGl0bGViYXItYnV0dG9uLm1vZC0ke3RoaXMua2luZH1gXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY291bnQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZVNwYW4oe3ByZXBlbmQ6IHRoaXMua2luZCA9PT0gXCJiYWNrXCIsIGNsczogXCJoaXN0b3J5LWNvdW50ZXJcIn0pO1xuICAgICAgICB0aGlzLmxlYWYgPSBudWxsO1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBudWxsO1xuICAgICAgICB0aGlzLnN0YXRlcyA9IFtdO1xuICAgICAgICB0aGlzLm9sZExhYmVsID0gdGhpcy5jb250YWluZXJFbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQodGhpcy5jb250YWluZXJFbCwgXCJjb250ZXh0bWVudVwiLCB0aGlzLm9wZW5NZW51LmJpbmQodGhpcykpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAodGhpcy5vbGRMYWJlbCk7XG4gICAgICAgIHRoaXMuY291bnQuZGV0YWNoKCk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzZXRDb3VudChudW06IG51bWJlcikgeyB0aGlzLmNvdW50LnRleHRDb250ZW50ID0gXCJcIiArIChudW0gfHwgXCJcIik7IH1cblxuICAgIHNldFRvb2x0aXAodGV4dDogc3RyaW5nKSB7XG4gICAgICAgIGlmICh0ZXh0KSB0aGlzLmNvbnRhaW5lckVsLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdGV4dCB8fCB1bmRlZmluZWQpO1xuICAgICAgICBlbHNlIHRoaXMuY29udGFpbmVyRWwucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICB9XG5cbiAgICBzZXRIaXN0b3J5KGhpc3RvcnkgPSBIaXN0b3J5LmN1cnJlbnQoKSkge1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBoaXN0b3J5O1xuICAgICAgICBjb25zdCBzdGF0ZXMgPSB0aGlzLnN0YXRlcyA9IGhpc3RvcnlbdGhpcy5kaXIgPCAwID8gXCJsb29rQmVoaW5kXCIgOiBcImxvb2tBaGVhZFwiXS5jYWxsKGhpc3RvcnkpO1xuICAgICAgICB0aGlzLnNldENvdW50KHN0YXRlcy5sZW5ndGgpO1xuICAgICAgICB0aGlzLnNldFRvb2x0aXAoc3RhdGVzLmxlbmd0aCA/XG4gICAgICAgICAgICB0aGlzLm9sZExhYmVsICsgXCJcXG5cIiArIHRoaXMuZm9ybWF0U3RhdGUoc3RhdGVzWzBdKS50aXRsZSA6XG4gICAgICAgICAgICBgTm8gJHt0aGlzLmtpbmR9IGhpc3RvcnlgXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIHN0YXRlcy5sZW5ndGggPiAwKTtcbiAgICB9XG5cbiAgICBvcGVuTWVudShldnQ6IHtjbGllbnRYOiBudW1iZXIsIGNsaWVudFk6IG51bWJlcn0pIHtcbiAgICAgICAgaWYgKCF0aGlzLnN0YXRlcy5sZW5ndGgpIHJldHVybjtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIG1lbnUuZG9tLmFkZENsYXNzKFwicGFuZS1yZWxpZWYtaGlzdG9yeS1tZW51XCIpO1xuICAgICAgICBtZW51LmRvbS5vbihcIm1vdXNlZG93blwiLCBcIi5tZW51LWl0ZW1cIiwgZSA9PiB7ZS5zdG9wUHJvcGFnYXRpb24oKTt9LCB0cnVlKTtcbiAgICAgICAgdGhpcy5zdGF0ZXMubWFwKHRoaXMuZm9ybWF0U3RhdGUuYmluZCh0aGlzKSkuZm9yRWFjaChcbiAgICAgICAgICAgIChpbmZvOiBGaWxlSW5mbywgaWR4KSA9PiB0aGlzLm1lbnVJdGVtKGluZm8sIGlkeCwgbWVudSlcbiAgICAgICAgKTtcbiAgICAgICAgbWVudS5zaG93QXRQb3NpdGlvbih7eDogZXZ0LmNsaWVudFgsIHk6IGV2dC5jbGllbnRZICsgMjB9KTtcbiAgICAgICAgdGhpcy5wbHVnaW4uaGlzdG9yeUlzT3BlbiA9IHRydWU7XG4gICAgICAgIG1lbnUub25IaWRlKCgpID0+IHsgdGhpcy5wbHVnaW4uaGlzdG9yeUlzT3BlbiA9IGZhbHNlOyB0aGlzLnBsdWdpbi5kaXNwbGF5KCk7IH0pO1xuICAgIH1cblxuICAgIG1lbnVJdGVtKGluZm86IEZpbGVJbmZvLCBpZHg6IG51bWJlciwgbWVudTogTWVudSkge1xuICAgICAgICBjb25zdCBteSA9IHRoaXM7XG4gICAgICAgIG1lbnUuYWRkSXRlbShpID0+IHsgY3JlYXRlSXRlbShpKTsgaWYgKGluZm8uZmlsZSkgc2V0dXBGaWxlRXZlbnRzKGkuZG9tKTsgfSk7XG4gICAgICAgIHJldHVybjtcblxuICAgICAgICBmdW5jdGlvbiBjcmVhdGVJdGVtKGk6IE1lbnVJdGVtLCBwcmVmaXg9XCJcIikge1xuICAgICAgICAgICAgaS5zZXRJY29uKGluZm8uaWNvbikuc2V0VGl0bGUocHJlZml4ICsgaW5mby50aXRsZSkub25DbGljayhlID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgaGlzdG9yeSA9IG15Lmhpc3Rvcnk7XG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgZm9yIGN0cmwvY21kL21pZGRsZSBidXR0b24gYW5kIHNwbGl0IGxlYWYgKyBjb3B5IGhpc3RvcnlcbiAgICAgICAgICAgICAgICBpZiAoS2V5bWFwLmlzTW9kaWZpZXIoZSwgXCJNb2RcIikgfHwgMSA9PT0gKGUgYXMgTW91c2VFdmVudCkuYnV0dG9uKSB7XG4gICAgICAgICAgICAgICAgICAgIGhpc3RvcnkgPSBoaXN0b3J5LmNsb25lVG8oYXBwLndvcmtzcGFjZS5zcGxpdEFjdGl2ZUxlYWYoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGhpc3RvcnkuZ28oKGlkeCsxKSAqIG15LmRpciwgdHJ1ZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwRmlsZUV2ZW50cyhkb206IEhUTUxFbGVtZW50KSB7XG4gICAgICAgICAgICAvLyBIb3ZlciBwcmV2aWV3XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VvdmVyJywgZSA9PiB7XG4gICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS50cmlnZ2VyKCdob3Zlci1saW5rJywge1xuICAgICAgICAgICAgICAgICAgICBldmVudDogZSwgc291cmNlOiBOYXZpZ2F0b3IuaG92ZXJTb3VyY2UsXG4gICAgICAgICAgICAgICAgICAgIGhvdmVyUGFyZW50OiBtZW51LmRvbSwgdGFyZ2V0RWw6IGRvbSwgbGlua3RleHQ6IGluZm8uZmlsZS5wYXRoXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRHJhZyBtZW51IGl0ZW0gdG8gbW92ZSBvciBsaW5rIGZpbGVcbiAgICAgICAgICAgIGRvbS5zZXRBdHRyKCdkcmFnZ2FibGUnLCAndHJ1ZScpO1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdNYW5hZ2VyID0gYXBwLmRyYWdNYW5hZ2VyO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdEYXRhID0gZHJhZ01hbmFnZXIuZHJhZ0ZpbGUoZSwgaW5mby5maWxlKTtcbiAgICAgICAgICAgICAgICBkcmFnTWFuYWdlci5vbkRyYWdTdGFydChlLCBkcmFnRGF0YSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgZSA9PiBtZW51LmhpZGUoKSk7XG5cbiAgICAgICAgICAgIC8vIEZpbGUgbWVudVxuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoXCJjb250ZXh0bWVudVwiLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZW51ID0gbmV3IE1lbnUoKTtcbiAgICAgICAgICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiBjcmVhdGVJdGVtKGksIGBHbyAke215LmtpbmR9IHRvIGApKS5hZGRTZXBhcmF0b3IoKTtcbiAgICAgICAgICAgICAgICBhcHAud29ya3NwYWNlLnRyaWdnZXIoXG4gICAgICAgICAgICAgICAgICAgIFwiZmlsZS1tZW51XCIsIG1lbnUsIGluZm8uZmlsZSwgXCJsaW5rLWNvbnRleHQtbWVudVwiXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBtZW51LnNob3dBdFBvc2l0aW9uKHt4OiBlLmNsaWVudFgsIHk6IGUuY2xpZW50WX0pO1xuICAgICAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7IC8vIGtlZXAgdGhlIHBhcmVudCBtZW51IG9wZW4gZm9yIG5vd1xuICAgICAgICAgICAgfSwgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmb3JtYXRTdGF0ZShlbnRyeTogSGlzdG9yeUVudHJ5KTogRmlsZUluZm8ge1xuICAgICAgICBjb25zdCB7dmlld1N0YXRlOiB7dHlwZSwgc3RhdGV9LCBlU3RhdGUsIHBhdGh9ID0gZW50cnk7XG4gICAgICAgIGNvbnN0IGZpbGUgPSBwYXRoICYmIGFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCkgYXMgVEZpbGU7XG4gICAgICAgIGNvbnN0IGluZm8gPSB7aWNvbjogXCJcIiwgdGl0bGU6IFwiXCIsIGZpbGUsIHR5cGUsIHN0YXRlLCBlU3RhdGV9O1xuXG4gICAgICAgIGlmIChub25GaWxlVmlld3NbdHlwZV0pIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gbm9uRmlsZVZpZXdzW3R5cGVdO1xuICAgICAgICB9IGVsc2UgaWYgKHBhdGggJiYgIWZpbGUpIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gW1widHJhc2hcIiwgXCJNaXNzaW5nIGZpbGUgXCIrcGF0aF07XG4gICAgICAgIH0gZWxzZSBpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB7XG4gICAgICAgICAgICBpbmZvLmljb24gPSB2aWV3dHlwZUljb25zW3R5cGVdID8/IFwiZG9jdW1lbnRcIjtcbiAgICAgICAgICAgIGlmICh0eXBlID09PSBcIm1hcmtkb3duXCIgJiYgc3RhdGUubW9kZSA9PT0gXCJwcmV2aWV3XCIpIGluZm8uaWNvbiA9IFwibGluZXMtb2YtdGV4dFwiO1xuICAgICAgICAgICAgaW5mby50aXRsZSA9IGZpbGUgPyBmaWxlLmJhc2VuYW1lICsgKGZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIgPyBcIi5cIitmaWxlLmV4dGVuc2lvbiA6IFwiXCIpIDogXCJObyBmaWxlXCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtZWRpYS12aWV3XCIgJiYgIWZpbGUpIGluZm8udGl0bGUgPSBzdGF0ZS5pbmZvPy5maWxlbmFtZSA/PyBpbmZvLnRpdGxlO1xuICAgICAgICB9XG5cbiAgICAgICAgYXBwLndvcmtzcGFjZS50cmlnZ2VyKFwicGFuZS1yZWxpZWY6Zm9ybWF0LWhpc3RvcnktaXRlbVwiLCBpbmZvKTtcbiAgICAgICAgcmV0dXJuIGluZm87XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gb25FbGVtZW50PEsgZXh0ZW5kcyBrZXlvZiBIVE1MRWxlbWVudEV2ZW50TWFwPihcbiAgICBlbDogSFRNTEVsZW1lbnQsXG4gICAgZXZlbnQ6IEssXG4gICAgc2VsZWN0b3I6IHN0cmluZyxcbiAgICBjYWxsYmFjazogKHRoaXM6IEhUTUxFbGVtZW50LCBldjogSFRNTEVsZW1lbnRFdmVudE1hcFtLXSwgZGVsZWdhdGVUYXJnZXQ6IEhUTUxFbGVtZW50KSA9PiBhbnksXG4gICAgb3B0aW9ucz86IGJvb2xlYW4gfCBBZGRFdmVudExpc3RlbmVyT3B0aW9uc1xuKSB7XG4gICAgZWwub24oZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucylcbiAgICByZXR1cm4gKCkgPT4gZWwub2ZmKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpO1xufSIsImltcG9ydCB7IGFyb3VuZCB9IGZyb20gJ21vbmtleS1hcm91bmQnO1xuaW1wb3J0IHtQbHVnaW4sIFRGaWxlLCBXb3Jrc3BhY2VMZWFmLCBXb3Jrc3BhY2VTcGxpdCwgV29ya3NwYWNlVGFic30gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthZGRDb21tYW5kcywgY29tbWFuZH0gZnJvbSBcIi4vY29tbWFuZHNcIjtcbmltcG9ydCB7SGlzdG9yeSwgaW5zdGFsbEhpc3Rvcnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcbmltcG9ydCB7TmF2aWdhdG9yLCBvbkVsZW1lbnR9IGZyb20gXCIuL05hdmlnYXRvclwiO1xuXG5kZWNsYXJlIG1vZHVsZSBcIm9ic2lkaWFuXCIge1xuICAgIGludGVyZmFjZSBXb3Jrc3BhY2Uge1xuICAgICAgICBvbih0eXBlOiBcInBhbmUtcmVsaWVmOnVwZGF0ZS1oaXN0b3J5XCIsIGNhbGxiYWNrOiAobGVhZjogV29ya3NwYWNlTGVhZiwgaGlzdG9yeTogSGlzdG9yeSkgPT4gYW55LCBjdHg/OiBhbnkpOiBFdmVudFJlZjtcbiAgICAgICAgcmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2Uoc291cmNlOiBzdHJpbmcsIGluZm86IHtkaXNwbGF5OiBzdHJpbmcsIGRlZmF1bHRNb2Q/OiBib29sZWFufSk6IHZvaWRcbiAgICAgICAgdW5yZWdpc3RlckhvdmVyTGlua1NvdXJjZShzb3VyY2U6IHN0cmluZyk6IHZvaWRcbiAgICAgICAgaXRlcmF0ZUxlYXZlcyhjYWxsYmFjazogKGl0ZW06IFdvcmtzcGFjZUxlYWYpID0+IHVua25vd24sIGl0ZW06IFdvcmtzcGFjZVBhcmVudCk6IGJvb2xlYW47XG4gICAgICAgIG9uTGF5b3V0Q2hhbmdlKCk6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIEFwcCB7XG4gICAgICAgIHBsdWdpbnM6IHtcbiAgICAgICAgICAgIHBsdWdpbnM6IHtcbiAgICAgICAgICAgICAgICBcIm9ic2lkaWFuLWhvdmVyLWVkaXRvclwiOiB7XG4gICAgICAgICAgICAgICAgICAgIGFjdGl2ZVBvcG92ZXJzOiBIb3ZlclBvcG92ZXJbXVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlSXRlbSB7XG4gICAgICAgIGNvbnRhaW5lckVsOiBIVE1MRGl2RWxlbWVudFxuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlUGFyZW50IHtcbiAgICAgICAgY2hpbGRyZW46IFdvcmtzcGFjZUl0ZW1bXVxuICAgICAgICByZWNvbXB1dGVDaGlsZHJlbkRpbWVuc2lvbnMoKTogdm9pZFxuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlVGFicyBleHRlbmRzIFdvcmtzcGFjZVBhcmVudCB7XG4gICAgICAgIHNlbGVjdFRhYihsZWFmOiBXb3Jrc3BhY2VMZWFmKTogdm9pZFxuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlTGVhZiB7XG4gICAgICAgIHBhcmVudFNwbGl0OiBXb3Jrc3BhY2VQYXJlbnRcbiAgICB9XG4gICAgaW50ZXJmYWNlIEhvdmVyUG9wb3ZlciB7XG4gICAgICAgIHRhcmdldEVsOiBIVE1MRWxlbWVudDtcbiAgICAgICAgaG92ZXJFbDogSFRNTEVsZW1lbnQ7XG4gICAgICAgIGxlYWY/OiBXb3Jrc3BhY2VMZWFmXG4gICAgICAgIHJvb3RTcGxpdD86IFdvcmtzcGFjZVNwbGl0XG4gICAgICAgIGhpZGUoKTogdm9pZDtcbiAgICAgICAgc2hvdygpOiB2b2lkO1xuICAgICAgICBzaG91bGRTaG93U2VsZigpOiBib29sZWFuO1xuICAgICAgICB0aW1lcjogbnVtYmVyO1xuICAgICAgICB3YWl0VGltZTogbnVtYmVyO1xuICAgICAgICBzaG91bGRTaG93KCk6IGJvb2xlYW47XG4gICAgICAgIHRyYW5zaXRpb24oKTogdm9pZDtcbiAgICAgIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGFuZVJlbGllZiBleHRlbmRzIFBsdWdpbiB7XG5cbiAgICBsZWFmTWFwID0gbmV3IFdlYWtNYXAoKVxuICAgIGJhY2s6IE5hdmlnYXRvclxuICAgIGZvcndhcmQ6IE5hdmlnYXRvclxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBpbnN0YWxsSGlzdG9yeSh0aGlzKTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKE5hdmlnYXRvci5ob3ZlclNvdXJjZSwge1xuICAgICAgICAgICAgZGlzcGxheTogJ0hpc3RvcnkgZHJvcGRvd25zJywgZGVmYXVsdE1vZDogdHJ1ZVxuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5zZXR1cERpc3BsYXkoKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC52YXVsdC5vbihcInJlbmFtZVwiLCAoZmlsZSwgb2xkUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKFxuICAgICAgICAgICAgICAgICAgICBsZWFmID0+IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgKGxlYWYsIGhpc3RvcnkpID0+IHtcbiAgICAgICAgICAgICAgICB0aGlzLnVwZGF0ZUxlYWYobGVhZik7XG4gICAgICAgICAgICAgICAgaWYgKGxlYWYgPT09IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB0aGlzLmRpc3BsYXkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKFwiYWN0aXZlLWxlYWYtY2hhbmdlXCIsIGxlYWYgPT4gdGhpcy5kaXNwbGF5KEhpc3RvcnkuZm9yTGVhZihsZWFmKSkpKTtcbiAgICAgICAgICAgIGlmICh0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgdGhpcy5kaXNwbGF5KEhpc3RvcnkuZm9yTGVhZih0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLndvcmtzcGFjZS5vbihcImxheW91dC1jaGFuZ2VcIiwgdGhpcy5udW1iZXJQYW5lcywgdGhpcykpO1xuICAgICAgICAgICAgdGhpcy5udW1iZXJQYW5lcygpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlcihcbiAgICAgICAgICAgICAgICBvbkVsZW1lbnQoXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmJvZHksIFwiY29udGV4dG1lbnVcIiwgXCIudmlldy1oZWFkZXIgPiAudmlldy1hY3Rpb25zID4gLnZpZXctYWN0aW9uXCIsIChldnQsIHRhcmdldCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmF2ID0gKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICh0YXJnZXQubWF0Y2hlcygnW2NsYXNzKj1cIiBhcHA6Z28tZm9yd2FyZFwiXScpICYmIHRoaXMuZm9yd2FyZCkgfHxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAodGFyZ2V0Lm1hdGNoZXMoJ1tjbGFzcyo9XCIgYXBwOmdvLWJhY2tcIl0nKSAgICAmJiB0aGlzLmJhY2spXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFuYXYpIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGxlYWYgPSB0aGlzLmxlYWZNYXAuZ2V0KHRhcmdldC5tYXRjaFBhcmVudChcIi53b3Jrc3BhY2UtbGVhZlwiKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWxlYWYpIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZGlzcGxheShIaXN0b3J5LmZvckxlYWYobGVhZikpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbmF2Lm9wZW5NZW51KGV2dCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmRpc3BsYXkoKTtcbiAgICAgICAgICAgICAgICAgICAgfSwge2NhcHR1cmU6IHRydWV9XG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYWRkQ29tbWFuZHModGhpcywge1xuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLXByZXZcIiwgXCJTd2FwIHBhbmUgd2l0aCBwcmV2aW91cyBpbiBzcGxpdFwiLCAgXCJNb2QrU2hpZnQrUGFnZVVwXCIpXSAgICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKC0xKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1uZXh0XCIsIFwiU3dhcCBwYW5lIHdpdGggbmV4dCBpbiBzcGxpdFwiLCAgICAgIFwiTW9kK1NoaWZ0K1BhZ2VEb3duXCIpXSAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlciggMSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tcHJldlwiLCAgXCJDeWNsZSB0byBwcmV2aW91cyB3b3Jrc3BhY2UgcGFuZVwiLCAgIFwiTW9kK1BhZ2VVcFwiICApXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKC0xLCB0cnVlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbmV4dFwiLCAgXCJDeWNsZSB0byBuZXh0IHdvcmtzcGFjZSBwYW5lXCIsICAgICAgIFwiTW9kK1BhZ2VEb3duXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKCAxLCB0cnVlKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0xc3RcIiwgICBcIkp1bXAgdG8gMXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigwKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMm5kXCIsICAgXCJKdW1wIHRvIDJuZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTNyZFwiLCAgIFwiSnVtcCB0byAzcmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDIpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby00dGhcIiwgICBcIkp1bXAgdG8gNHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigzKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNXRoXCIsICAgXCJKdW1wIHRvIDV0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTZ0aFwiLCAgIFwiSnVtcCB0byA2dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby03dGhcIiwgICBcIkp1bXAgdG8gN3RoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig2KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tOHRoXCIsICAgXCJKdW1wIHRvIDh0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLWxhc3RcIiwgIFwiSnVtcCB0byBsYXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCBcIkFsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDk5OTk5OTk5KTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMXN0XCIsICBcIlBsYWNlIGFzIDFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDAsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTJuZFwiLCAgXCJQbGFjZSBhcyAybmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigxLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0zcmRcIiwgIFwiUGxhY2UgYXMgM3JkIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNHRoXCIsICBcIlBsYWNlIGFzIDR0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDMsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTV0aFwiLCAgXCJQbGFjZSBhcyA1dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig0LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC02dGhcIiwgIFwiUGxhY2UgYXMgNnRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtN3RoXCIsICBcIlBsYWNlIGFzIDd0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDYsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTh0aFwiLCAgXCJQbGFjZSBhcyA4dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig3LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC1sYXN0XCIsIFwiUGxhY2UgYXMgbGFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICBcIk1vZCtBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoOTk5OTk5OTksIGZhbHNlKTsgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzZXR1cERpc3BsYXkoKSB7XG4gICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5iYWNrICAgID0gbmV3IE5hdmlnYXRvcih0aGlzLCBcImJhY2tcIiwgLTEpKTtcbiAgICAgICAgdGhpcy5hZGRDaGlsZCh0aGlzLmZvcndhcmQgPSBuZXcgTmF2aWdhdG9yKHRoaXMsIFwiZm9yd2FyZFwiLCAxKSk7XG4gICAgfVxuXG4gICAgLy8gU2V0IHRvIHRydWUgd2hpbGUgZWl0aGVyIG1lbnUgaXMgb3Blbiwgc28gd2UgZG9uJ3Qgc3dpdGNoIGl0IG91dFxuICAgIGhpc3RvcnlJc09wZW4gPSBmYWxzZTtcblxuICAgIGRpc3BsYXkoaGlzdG9yeSA9IEhpc3RvcnkuZm9yTGVhZih0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikpIHtcbiAgICAgICAgaWYgKHRoaXMuaGlzdG9yeUlzT3BlbikgcmV0dXJuO1xuICAgICAgICB0aGlzLmJhY2suc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5mb3J3YXJkLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgfVxuXG4gICAgaXRlcmF0ZVJvb3RMZWF2ZXMoY2I6IChsZWFmOiBXb3Jrc3BhY2VMZWFmKSA9PiB2b2lkIHwgYm9vbGVhbikge1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZVJvb3RMZWF2ZXMoY2IpO1xuXG4gICAgICAgIC8vIFN1cHBvcnQgSG92ZXIgRWRpdG9yc1xuICAgICAgICBjb25zdCBwb3BvdmVycyA9IHRoaXMuYXBwLnBsdWdpbnMucGx1Z2luc1tcIm9ic2lkaWFuLWhvdmVyLWVkaXRvclwiXT8uYWN0aXZlUG9wb3ZlcnM7XG4gICAgICAgIGlmIChwb3BvdmVycykgZm9yIChjb25zdCBwb3BvdmVyIG9mIHBvcG92ZXJzKSB7XG4gICAgICAgICAgICAvLyBNb3JlIHJlY2VudCBwbHVnaW46IHdlIGNhbiBza2lwIHRoZSBzY2FuXG4gICAgICAgICAgICBpZiAoKHBvcG92ZXIuY29uc3RydWN0b3IgYXMgYW55KS5pdGVyYXRlUG9wb3ZlckxlYXZlcykgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgaWYgKHBvcG92ZXIubGVhZiAmJiBjYihwb3BvdmVyLmxlYWYpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIGlmIChwb3BvdmVyLnJvb3RTcGxpdCAmJiB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZUxlYXZlcyhjYiwgcG9wb3Zlci5yb290U3BsaXQpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICB1cGRhdGVMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYpIHtcbiAgICAgICAgY29uc3QgaGlzdG9yeSA9IEhpc3RvcnkuZm9yTGVhZihsZWFmKTtcbiAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtZm9yd2FyZC1jb3VudFwiLCAnXCInKyhoaXN0b3J5Lmxvb2tBaGVhZCgpLmxlbmd0aCB8fCBcIlwiKSsnXCInKTtcbiAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtYmFja3dhcmQtY291bnRcIiwgJ1wiJysoaGlzdG9yeS5sb29rQmVoaW5kKCkubGVuZ3RoIHx8IFwiXCIpKydcIicpO1xuICAgICAgICB0aGlzLmxlYWZNYXAuc2V0KGxlYWYuY29udGFpbmVyRWwsIGxlYWYpO1xuICAgIH1cblxuICAgIG51bWJlclBhbmVzKCkge1xuICAgICAgICBsZXQgY291bnQgPSAwLCBsYXN0TGVhZjogV29ya3NwYWNlTGVhZiA9IG51bGw7XG4gICAgICAgIHRoaXMuaXRlcmF0ZVJvb3RMZWF2ZXMobGVhZiA9PiB7XG4gICAgICAgICAgICBsZWFmLmNvbnRhaW5lckVsLnN0eWxlLnNldFByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiLCArK2NvdW50IDwgOSA/IFwiXCIrY291bnQgOiBcIlwiKTtcbiAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgY291bnQ8OSk7XG4gICAgICAgICAgICBsYXN0TGVhZiA9IGxlYWY7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoY291bnQ+OCkge1xuICAgICAgICAgICAgbGFzdExlYWY/LmNvbnRhaW5lckVsLnN0eWxlLnNldFByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiLCBcIjlcIik7XG4gICAgICAgICAgICBsYXN0TGVhZj8uY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMobGVhZiA9PiB0aGlzLnVwZGF0ZUxlYWYobGVhZikpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UudW5yZWdpc3RlckhvdmVyTGlua1NvdXJjZShOYXZpZ2F0b3IuaG92ZXJTb3VyY2UpO1xuICAgICAgICB0aGlzLml0ZXJhdGVSb290TGVhdmVzKGxlYWYgPT4ge1xuICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5yZW1vdmVQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtbGFiZWxcIik7XG4gICAgICAgICAgICBsZWFmLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwiaGFzLXBhbmUtcmVsaWVmLWxhYmVsXCIsIGZhbHNlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKGxlYWYgPT4ge1xuICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5yZW1vdmVQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtZm9yd2FyZC1jb3VudFwiKTtcbiAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwuc3R5bGUucmVtb3ZlUHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWJhY2t3YXJkLWNvdW50XCIpO1xuICAgICAgICB9KVxuICAgIH1cblxuICAgIGdvdG9OdGhMZWFmKG46IG51bWJlciwgcmVsYXRpdmU6IGJvb2xlYW4pIHtcbiAgICAgICAgY29uc3QgbGVhdmVzOiBXb3Jrc3BhY2VMZWFmW10gPSBbXTtcbiAgICAgICAgdGhpcy5pdGVyYXRlUm9vdExlYXZlcygobGVhZikgPT4gKGxlYXZlcy5wdXNoKGxlYWYpLCBmYWxzZSkpO1xuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIG4gKz0gbGVhdmVzLmluZGV4T2YodGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpO1xuICAgICAgICAgICAgbiA9IChuICsgbGVhdmVzLmxlbmd0aCkgJSBsZWF2ZXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBsZWFmID0gbGVhdmVzW24+PWxlYXZlcy5sZW5ndGggPyBsZWF2ZXMubGVuZ3RoLTEgOiBuXTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zOiBudW1iZXIsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgY2IgPSB0aGlzLmxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlKTtcbiAgICAgICAgaWYgKGNiKSBjYigpO1xuICAgIH1cblxuICAgIGxlYWZQbGFjZXIodG9Qb3M6IG51bWJlciwgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWY7XG4gICAgICAgIGlmICghbGVhZikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGNvbnN0XG4gICAgICAgICAgICBwYXJlbnRTcGxpdCA9IGxlYWYucGFyZW50U3BsaXQsXG4gICAgICAgICAgICBjaGlsZHJlbiA9IHBhcmVudFNwbGl0LmNoaWxkcmVuLFxuICAgICAgICAgICAgZnJvbVBvcyA9IGNoaWxkcmVuLmluZGV4T2YobGVhZilcbiAgICAgICAgO1xuICAgICAgICBpZiAoZnJvbVBvcyA9PSAtMSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICAgICAgdG9Qb3MgKz0gZnJvbVBvcztcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDAgfHwgdG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSB0b1BvcyA9IGNoaWxkcmVuLmxlbmd0aCAtIDE7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwKSB0b1BvcyA9IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZnJvbVBvcyA9PSB0b1BvcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvdGhlciA9IGNoaWxkcmVuW3RvUG9zXTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZShmcm9tUG9zLCAxKTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZSh0b1BvcywgICAwLCBsZWFmKTtcbiAgICAgICAgICAgIGlmICgocGFyZW50U3BsaXQgYXMgV29ya3NwYWNlVGFicykuc2VsZWN0VGFiKSB7XG4gICAgICAgICAgICAgICAgKHBhcmVudFNwbGl0IGFzIFdvcmtzcGFjZVRhYnMpLnNlbGVjdFRhYihsZWFmKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb3RoZXIuY29udGFpbmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KGZyb21Qb3MgPiB0b1BvcyA/IFwiYmVmb3JlYmVnaW5cIiA6IFwiYWZ0ZXJlbmRcIiwgbGVhZi5jb250YWluZXJFbCk7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQucmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk7XG4gICAgICAgICAgICAgICAgbGVhZi5vblJlc2l6ZSgpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dENoYW5nZSgpO1xuXG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgZm9jdXMgYmFjayB0byBwYW5lO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCBmYWxzZSwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuIl0sIm5hbWVzIjpbIk5vdGljZSIsIldvcmtzcGFjZUxlYWYiLCJDb21wb25lbnQiLCJNZW51IiwiS2V5bWFwIiwiVEZpbGUiLCJQbHVnaW4iXSwibWFwcGluZ3MiOiI7Ozs7QUFBQTtBQU1BLE1BQU0sUUFBUSxHQUE0QixFQUFFLENBQUM7QUFFN0IsU0FBQSxPQUFPLENBQUMsRUFBVSxFQUFFLElBQVksRUFBRSxPQUFBLEdBQTZCLEVBQUUsRUFBRSxHQUFHLEdBQUMsRUFBRSxFQUFBOzs7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V0FBVyxDQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFO1lBRTNILENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBSSxtQ0FBbUMsRUFBRyxPQUFPLENBQUMsQ0FBQyxHQUFNLEVBQUEsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUM3RyxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUksbUNBQW1DLEVBQUcsT0FBTyxDQUFDLENBQUMsR0FBTSxFQUFBLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7WUFDN0csQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFJLG1DQUFtQyxFQUFHLE9BQU8sQ0FBQyxDQUFDLEdBQU0sRUFBQSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO1lBQzdHLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBSSxtQ0FBbUMsRUFBRyxPQUFPLENBQUMsQ0FBQyxHQUFNLEVBQUEsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUM3RyxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUksbUNBQW1DLEVBQUcsT0FBTyxDQUFDLENBQUMsR0FBTSxFQUFBLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7WUFDN0csQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFJLG1DQUFtQyxFQUFHLE9BQU8sQ0FBQyxDQUFDLEdBQU0sRUFBQSxPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO1lBQzdHLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBSSxtQ0FBbUMsRUFBRyxPQUFPLENBQUMsQ0FBQyxHQUFNLEVBQUEsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUM3RyxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUksbUNB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
