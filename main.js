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
    announce() {
        app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
    }
    goto(pos) {
        if (!this.leaf)
            return;
        if (this.leaf.pinned)
            return new obsidian.Notice("Pinned pane: unpin before going forward or back"), undefined;
        if (this.leaf.working)
            return new obsidian.Notice("Pane is busy: please wait before navigating further"), undefined;
        pos = this.pos = Math.max(0, Math.min(pos, this.stack.length - 1));
        this.stack[pos]?.go(this.leaf);
        this.announce();
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
        this.announce();
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

/**
 * Component that belongs to a plugin + window. e.g.:
 *
 *     class TitleWidget extends PerWindowComponent<MyPlugin> {
 *         onload() {
 *             // do stuff with this.plugin and this.win ...
 *         }
 *     }
 *
 *     class MyPlugin extends Plugin {
 *         titleWidgets = TitleWidget.perWindow(this);
 *         ...
 *     }
 *
 * This will automatically create a title widget for each window as it's opened, and
 * on plugin load.  The plugin's `.titleWidgets` will also be a WindowManager that can
 * look up the title widget for a given window, leaf, or view, or return a list of
 * all of them.  See WindowManager for the full API.
 *
 * If you want your components to be created on demand instead of automatically when
 * window(s) are opened, you can pass `false` as the second argument to `perWindow()`.
 */
class PerWindowComponent extends obsidian.Component {
    constructor(plugin, win, root) {
        super();
        this.plugin = plugin;
        this.win = win;
        this.root = root;
    }
    static perWindow(plugin) {
        return new WindowManager(plugin, this);
    }
}
/**
 * Manage per-window components
 */
class WindowManager extends obsidian.Component {
    constructor(plugin, factory) {
        super();
        this.plugin = plugin;
        this.factory = factory;
        this.instances = new WeakMap();
        this.watching = false;
        plugin.addChild(this);
    }
    watch() {
        // Defer watch until plugin is loaded
        if (!this._loaded)
            this.onload = () => this.watch();
        else if (!this.watching) {
            const { workspace } = app;
            this.watching = true;
            this.registerEvent(workspace.on("window-open", (_, win) => {
                workspace.onLayoutReady(() => setImmediate(() => this.forWindow(win)));
            }));
            workspace.onLayoutReady(() => setImmediate(() => this.forAll()));
        }
        return this;
    }
    forWindow(win = window.activeWindow ?? window, create = true) {
        let inst = this.instances.get(win);
        if (!inst && create) {
            inst = new this.factory(this.plugin, win, containerForWindow(win));
            if (inst) {
                this.instances.set(win, inst);
                inst.registerDomEvent(win, "beforeunload", () => {
                    this.removeChild(inst);
                    this.instances.delete(win);
                });
                this.addChild(inst);
            }
        }
        return inst || undefined;
    }
    forDom(el, create = true) {
        return this.forWindow(windowForDom(el), create);
    }
    forLeaf(leaf, create = true) {
        return this.forDom(leaf.containerEl, create);
    }
    forView(view, create = true) {
        return this.forDom(view.containerEl, create);
    }
    windows() {
        const windows = [window], { floatingSplit } = app.workspace;
        if (floatingSplit) {
            for (const split of floatingSplit.children)
                if (split.win)
                    windows.push(split.win);
        }
        return windows;
    }
    forAll(create = true) {
        return this.windows().map(win => this.forWindow(win, create)).filter(t => t);
    }
}
function windowForDom(el) {
    return (el.ownerDocument || el).defaultView;
}
function containerForWindow(win) {
    if (win === window)
        return app.workspace.rootSplit;
    const { floatingSplit } = app.workspace;
    if (floatingSplit) {
        for (const split of floatingSplit.children)
            if (win === split.win)
                return split;
    }
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
class Navigation extends PerWindowComponent {
    constructor() {
        super(...arguments);
        // Set to true while either menu is open, so we don't switch it out
        this.historyIsOpen = false;
    }
    display(leaf = this.latestLeaf()) {
        if (this.historyIsOpen)
            return;
        if (!this._loaded) {
            this.load();
            return;
        }
        const history = leaf ? History.forLeaf(leaf) : new History();
        this.back.setHistory(history);
        this.forward.setHistory(history);
    }
    leaves() {
        const leaves = [];
        const cb = (leaf) => { leaves.push(leaf); };
        app.workspace.iterateLeaves(cb, this.root);
        // Support Hover Editors
        const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers)
            for (const popover of popovers) {
                if (popover.hoverEl.ownerDocument.defaultView !== this.win)
                    continue; // must be in same window
                else if (popover.rootSplit)
                    app.workspace.iterateLeaves(cb, popover.rootSplit);
                else if (popover.leaf)
                    cb(popover.leaf);
            }
        return leaves;
    }
    latestLeaf() {
        let leaf = app.workspace.activeLeaf;
        if (leaf && this.plugin.nav.forLeaf(leaf) === this)
            return leaf;
        return this.leaves().reduce((best, leaf) => { return (!best || best.activeTime < leaf.activeTime) ? leaf : best; });
    }
    onload() {
        app.workspace.onLayoutReady(() => {
            this.addChild(this.back = new Navigator(this, "back", -1));
            this.addChild(this.forward = new Navigator(this, "forward", 1));
            this.display();
            this.numberPanes();
            this.registerEvent(app.workspace.on("layout-change", this.numberPanes, this));
            this.register(
            // Support "Customizable Page Header and Title Bar" buttons
            onElement(this.win.document.body, "contextmenu", ".view-header > .view-actions > .view-action", (evt, target) => {
                const dir = ((target.matches('[class*=" app:go-forward"]') && "forward") ||
                    (target.matches('[class*=" app:go-back"]') && "back"));
                if (!dir)
                    return;
                const el = target.matchParent(".workspace-leaf");
                const leaf = this.leaves().filter(leaf => leaf.containerEl === el).pop();
                if (!leaf)
                    return;
                evt.preventDefault();
                evt.stopImmediatePropagation();
                this.display(leaf);
                this[dir].openMenu(evt);
            }, { capture: true }));
        });
    }
    onunload() {
        this.unNumberPanes();
    }
    unNumberPanes(selector = ".workspace-leaf") {
        this.win.document.body.findAll(selector).forEach(el => {
            el.style.removeProperty("--pane-relief-label");
            el.toggleClass("has-pane-relief-label", false);
            el.style.removeProperty("--pane-relief-forward-count");
            el.style.removeProperty("--pane-relief-backward-count");
        });
    }
    updateLeaf(leaf) {
        const history = History.forLeaf(leaf);
        leaf.containerEl.style.setProperty("--pane-relief-forward-count", '"' + (history.lookAhead().length || "") + '"');
        leaf.containerEl.style.setProperty("--pane-relief-backward-count", '"' + (history.lookBehind().length || "") + '"');
    }
    numberPanes() {
        window.requestAnimationFrame(() => {
            // unnumber sidebar panes in main window, if something was moved there
            if (this.win === window)
                this.unNumberPanes(".workspace-tabs > .workspace-leaf");
            let count = 0, lastLeaf = null;
            this.leaves().forEach(leaf => {
                leaf.containerEl.style.setProperty("--pane-relief-label", ++count < 9 ? "" + count : "");
                leaf.containerEl.toggleClass("has-pane-relief-label", count < 9);
                lastLeaf = leaf;
                this.updateLeaf(leaf);
            });
            if (count > 8) {
                lastLeaf?.containerEl.style.setProperty("--pane-relief-label", "9");
                lastLeaf?.containerEl.toggleClass("has-pane-relief-label", true);
            }
        });
    }
    onUpdateHistory(leaf, history) {
        this.updateLeaf(leaf); // update leaf stats
        if (history === this.forward.history)
            this.forward.setHistory(history); // update nav arrows
        if (history === this.back.history)
            this.back.setHistory(history);
    }
}
class Navigator extends obsidian.Component {
    constructor(owner, kind, dir) {
        super();
        this.owner = owner;
        this.kind = kind;
        this.dir = dir;
        this.history = null;
    }
    onload() {
        this.containerEl = this.owner.win.document.body.find(`.titlebar .titlebar-button-container.mod-left .titlebar-button.mod-${this.kind}`);
        this.count = this.containerEl.createSpan({ prepend: this.kind === "back", cls: "history-counter" });
        this.history = null;
        this.states = [];
        this.oldLabel = this.containerEl.getAttribute("aria-label");
        this.registerDomEvent(this.containerEl, "contextmenu", this.openMenu.bind(this));
        const onClick = (e) => {
            // Don't allow Obsidian to switch window or forward the event
            e.preventDefault();
            e.stopImmediatePropagation();
            // Do the navigation
            this.history?.[this.kind]();
        };
        this.register(() => this.containerEl.removeEventListener("click", onClick, true));
        this.containerEl.addEventListener("click", onClick, true);
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
        this.owner.historyIsOpen = true;
        menu.onHide(() => { this.owner.historyIsOpen = false; this.owner.display(); });
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
        this.nav = new WindowManager(this, Navigation).watch();
    }
    onload() {
        installHistory(this);
        this.app.workspace.registerHoverLinkSource(Navigator.hoverSource, {
            display: 'History dropdowns', defaultMod: true
        });
        this.app.workspace.onLayoutReady(() => {
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof obsidian.TFile)
                    this.app.workspace.iterateAllLeaves(leaf => History.forLeaf(leaf).onRename(file, oldPath));
            }));
            this.registerEvent(app.workspace.on("active-leaf-change", leaf => this.nav.forLeaf(leaf).display(leaf)));
            this.registerEvent(app.workspace.on("pane-relief:update-history", (leaf, history) => this.nav.forLeaf(leaf).onUpdateHistory(leaf, history)));
        });
        addCommands(this, {
            [command("swap-prev", "Swap pane with previous in split", "Mod+Shift+PageUp")]() { return this.leafPlacer(-1); },
            [command("swap-next", "Swap pane with next in split", "Mod+Shift+PageDown")]() { return this.leafPlacer(1); },
            [command("go-prev", "Cycle to previous workspace pane", "Mod+PageUp")]() { return () => this.gotoNthLeaf(-1, true); },
            [command("go-next", "Cycle to next workspace pane", "Mod+PageDown")]() { return () => this.gotoNthLeaf(1, true); },
            [command("win-prev", "Cycle to previous window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(-1, true); },
            [command("win-next", "Cycle to next window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(1, true); },
            [command("go-1st", "Jump to 1st pane in the workspace", "Alt+1")]() { return () => this.gotoNthLeaf(0); },
            [command("go-2nd", "Jump to 2nd pane in the workspace", "Alt+2")]() { return () => this.gotoNthLeaf(1); },
            [command("go-3rd", "Jump to 3rd pane in the workspace", "Alt+3")]() { return () => this.gotoNthLeaf(2); },
            [command("go-4th", "Jump to 4th pane in the workspace", "Alt+4")]() { return () => this.gotoNthLeaf(3); },
            [command("go-5th", "Jump to 5th pane in the workspace", "Alt+5")]() { return () => this.gotoNthLeaf(4); },
            [command("go-6th", "Jump to 6th pane in the workspace", "Alt+6")]() { return () => this.gotoNthLeaf(5); },
            [command("go-7th", "Jump to 7th pane in the workspace", "Alt+7")]() { return () => this.gotoNthLeaf(6); },
            [command("go-8th", "Jump to 8th pane in the workspace", "Alt+8")]() { return () => this.gotoNthLeaf(7); },
            [command("go-last", "Jump to last pane in the workspace", "Alt+9")]() { return () => this.gotoNthLeaf(99999999); },
            [command("win-1st", "Switch to 1st window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(0); },
            [command("win-2nd", "Switch to 2nd window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(1); },
            [command("win-3rd", "Switch to 3rd window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(2); },
            [command("win-4th", "Switch to 4th window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(3); },
            [command("win-5th", "Switch to 5th window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(4); },
            [command("win-6th", "Switch to 6th window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(5); },
            [command("win-7th", "Switch to 7th window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(6); },
            [command("win-8th", "Switch to 8th window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(7); },
            [command("win-last", "Switch to last window", [])]() { if (app.workspace.floatingSplit?.children.length)
                return () => this.gotoNthWindow(99999999); },
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
    onunload() {
        this.app.workspace.unregisterHoverLinkSource(Navigator.hoverSource);
    }
    gotoNthLeaf(n, relative) {
        const nav = this.nav.forLeaf(app.workspace.activeLeaf);
        const leaf = gotoNth(nav.leaves(), this.app.workspace.activeLeaf, n, relative);
        !leaf || this.app.workspace.setActiveLeaf(leaf, true, true);
    }
    gotoNthWindow(n, relative) {
        const nav = gotoNth(this.nav.forAll(), this.nav.forLeaf(app.workspace.activeLeaf), n, relative);
        const leaf = nav?.latestLeaf();
        if (leaf)
            app.workspace.setActiveLeaf(leaf, true, true);
        nav?.win.require?.('electron')?.remote?.getCurrentWindow()?.focus();
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
function gotoNth(items, current, n, relative) {
    if (relative) {
        n += items.indexOf(current);
        n = (n + items.length) % items.length; // wrap around
    }
    return items[n >= items.length ? items.length - 1 : n];
}

module.exports = PaneRelief;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLnRzIiwibm9kZV9tb2R1bGVzLy5wbnBtL21vbmtleS1hcm91bmRAMi4zLjAvbm9kZV9tb2R1bGVzL21vbmtleS1hcm91bmQvbWpzL2luZGV4LmpzIiwic3JjL0hpc3RvcnkudHMiLCJzcmMvUGVyV2luZG93Q29tcG9uZW50LnRzIiwic3JjL05hdmlnYXRvci50cyIsInNyYy9wYW5lLXJlbGllZi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBTaW1wbGlmaWVkIENvbW1hbmRzIEZyYW1ld29ya1xuXG5pbXBvcnQge0NvbW1hbmQsIEhvdGtleSwgTW9kaWZpZXIsIFBsdWdpbn0gZnJvbSBcIm9ic2lkaWFuXCJcblxudHlwZSBLZXlEZWYgPSBIb3RrZXkgfCBzdHJpbmdcblxuY29uc3QgY29tbWFuZHM6IFJlY29yZDxzeW1ib2wsIENvbW1hbmQ+ID0ge307IC8vbmV3IE1hcDtcblxuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmQoaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCBob3RrZXlzOiBLZXlEZWYgfCBLZXlEZWZbXSA9IFtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgKGhvdGtleXMgYXMgSG90a2V5KS5rZXkpIGhvdGtleXMgPSBbaG90a2V5cyBhcyBIb3RrZXldO1xuXG4gICAgbGV0IGtleXM6IEhvdGtleVtdID0gKGhvdGtleXMgYXMgS2V5RGVmW10pLm1hcChmdW5jdGlvbihrZXkpOiBIb3RrZXkge1xuICAgICAgICAvLyBJZiBhIGhvdGtleSBpcyBhbiBvYmplY3QgYWxyZWFkeSwgbm8gbmVlZCB0byBwcm9jZXNzIGl0XG4gICAgICAgIGlmICh0eXBlb2Yga2V5ID09PSBcIm9iamVjdFwiKSByZXR1cm4ga2V5O1xuICAgICAgICAvLyBDb252ZXJ0IHN0cmluZ3MgdG8gT2JzaWRpYW4ncyBob3RrZXkgZm9ybWF0XG4gICAgICAgIGxldCBwYXJ0cyA9IGtleS5zcGxpdChcIitcIilcbiAgICAgICAgcmV0dXJuIHsgbW9kaWZpZXJzOiBwYXJ0cyBhcyBNb2RpZmllcltdLCBrZXk6IHBhcnRzLnBvcCgpIHx8IFwiK1wiIH0gIC8vIGVtcHR5IGxhc3QgcGFydCA9IGUuZy4gJ01vZCsrJ1xuICAgIH0pO1xuICAgIE9iamVjdC5hc3NpZ24oY21kLCB7aWQsIG5hbWUsIGhvdGtleXM6IGtleXN9KTtcblxuICAgIC8vIFNhdmUgdGhlIGNvbW1hbmQgZGF0YSB1bmRlciBhIHVuaXF1ZSBzeW1ib2xcbiAgICBjb25zdCBzeW0gPSBTeW1ib2woXCJjbWQ6XCIgKyBpZCk7XG4gICAgY29tbWFuZHNbc3ltXSA9IGNtZCBhcyBDb21tYW5kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kczxQIGV4dGVuZHMgUGx1Z2luPihcbiAgICBwbHVnaW46IFAsXG4gICAgY21kc2V0OiBSZWNvcmQ8c3ltYm9sLCAodGhpc0FyZzogUCkgPT4gYm9vbGVhbiB8ICgoKSA9PiBhbnkpPlxuKSB7XG4gICAgLy8gRXh0cmFjdCBjb21tYW5kIHN5bWJvbHMgZnJvbSBjbWRzZXQgYW5kIHJlZ2lzdGVyIHRoZW0sIGJvdW5kIHRvIHRoZSBwbHVnaW4gZm9yIG1ldGhvZHNcbiAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlTeW1ib2xzKGNtZHNldCkuZm9yRWFjaChzeW0gPT4ge1xuICAgICAgICBjb25zdCBjbWQgPSBjb21tYW5kc1tzeW1dLCBtZXRob2QgPSBjbWRzZXRbc3ltXTtcbiAgICAgICAgaWYgKGNtZCkgcGx1Z2luLmFkZENvbW1hbmQoT2JqZWN0LmFzc2lnbih7fSwgY21kLCB7XG4gICAgICAgICAgICBjaGVja0NhbGxiYWNrKGNoZWNrOiBib29sZWFuKSB7XG4gICAgICAgICAgICAgICAgLy8gQ2FsbCB0aGUgbWV0aG9kIGJvZHkgd2l0aCB0aGUgcGx1Z2luIGFzICd0aGlzJ1xuICAgICAgICAgICAgICAgIGNvbnN0IGNiID0gbWV0aG9kLmNhbGwocGx1Z2luKTtcbiAgICAgICAgICAgICAgICAvLyBJdCB0aGVuIHJldHVybnMgYSBjbG9zdXJlIGlmIHRoZSBjb21tYW5kIGlzIHJlYWR5IHRvIGV4ZWN1dGUsIGFuZFxuICAgICAgICAgICAgICAgIC8vIHdlIGNhbGwgdGhhdCBjbG9zdXJlIHVubGVzcyB0aGlzIGlzIGp1c3QgYSBjaGVjayBmb3IgYXZhaWxhYmlsaXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuIChjaGVjayB8fCB0eXBlb2YgY2IgIT09IFwiZnVuY3Rpb25cIikgPyAhIWNiIDogKGNiKCksIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgfSlcbn0iLCJleHBvcnQgZnVuY3Rpb24gYXJvdW5kKG9iaiwgZmFjdG9yaWVzKSB7XG4gICAgY29uc3QgcmVtb3ZlcnMgPSBPYmplY3Qua2V5cyhmYWN0b3JpZXMpLm1hcChrZXkgPT4gYXJvdW5kMShvYmosIGtleSwgZmFjdG9yaWVzW2tleV0pKTtcbiAgICByZXR1cm4gcmVtb3ZlcnMubGVuZ3RoID09PSAxID8gcmVtb3ZlcnNbMF0gOiBmdW5jdGlvbiAoKSB7IHJlbW92ZXJzLmZvckVhY2gociA9PiByKCkpOyB9O1xufVxuZnVuY3Rpb24gYXJvdW5kMShvYmosIG1ldGhvZCwgY3JlYXRlV3JhcHBlcikge1xuICAgIGNvbnN0IG9yaWdpbmFsID0gb2JqW21ldGhvZF0sIGhhZE93biA9IG9iai5oYXNPd25Qcm9wZXJ0eShtZXRob2QpO1xuICAgIGxldCBjdXJyZW50ID0gY3JlYXRlV3JhcHBlcihvcmlnaW5hbCk7XG4gICAgLy8gTGV0IG91ciB3cmFwcGVyIGluaGVyaXQgc3RhdGljIHByb3BzIGZyb20gdGhlIHdyYXBwaW5nIG1ldGhvZCxcbiAgICAvLyBhbmQgdGhlIHdyYXBwaW5nIG1ldGhvZCwgcHJvcHMgZnJvbSB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgaWYgKG9yaWdpbmFsKVxuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY3VycmVudCwgb3JpZ2luYWwpO1xuICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBjdXJyZW50KTtcbiAgICBvYmpbbWV0aG9kXSA9IHdyYXBwZXI7XG4gICAgLy8gUmV0dXJuIGEgY2FsbGJhY2sgdG8gYWxsb3cgc2FmZSByZW1vdmFsXG4gICAgcmV0dXJuIHJlbW92ZTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgLy8gSWYgd2UgaGF2ZSBiZWVuIGRlYWN0aXZhdGVkIGFuZCBhcmUgbm8gbG9uZ2VyIHdyYXBwZWQsIHJlbW92ZSBvdXJzZWx2ZXNcbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsICYmIG9ialttZXRob2RdID09PSB3cmFwcGVyKVxuICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgIHJldHVybiBjdXJyZW50LmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgICBmdW5jdGlvbiByZW1vdmUoKSB7XG4gICAgICAgIC8vIElmIG5vIG90aGVyIHBhdGNoZXMsIGp1c3QgZG8gYSBkaXJlY3QgcmVtb3ZhbFxuICAgICAgICBpZiAob2JqW21ldGhvZF0gPT09IHdyYXBwZXIpIHtcbiAgICAgICAgICAgIGlmIChoYWRPd24pXG4gICAgICAgICAgICAgICAgb2JqW21ldGhvZF0gPSBvcmlnaW5hbDtcbiAgICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgICAgICBkZWxldGUgb2JqW21ldGhvZF07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAvLyBFbHNlIHBhc3MgZnV0dXJlIGNhbGxzIHRocm91Z2gsIGFuZCByZW1vdmUgd3JhcHBlciBmcm9tIHRoZSBwcm90b3R5cGUgY2hhaW5cbiAgICAgICAgY3VycmVudCA9IG9yaWdpbmFsO1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgb3JpZ2luYWwgfHwgRnVuY3Rpb24pO1xuICAgIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiBkZWR1cGUoa2V5LCBvbGRGbiwgbmV3Rm4pIHtcbiAgICBjaGVja1trZXldID0ga2V5O1xuICAgIHJldHVybiBjaGVjaztcbiAgICBmdW5jdGlvbiBjaGVjayguLi5hcmdzKSB7XG4gICAgICAgIHJldHVybiAob2xkRm5ba2V5XSA9PT0ga2V5ID8gb2xkRm4gOiBuZXdGbikuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtOb3RpY2UsIFRBYnN0cmFjdEZpbGUsIFZpZXdTdGF0ZSwgV29ya3NwYWNlTGVhZn0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5pbXBvcnQgUGFuZVJlbGllZiBmcm9tIFwiLi9wYW5lLXJlbGllZlwiO1xuXG5jb25zdCBISVNUX0FUVFIgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcbmNvbnN0IFNFUklBTF9QUk9QID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCI7XG5cbmRlY2xhcmUgbW9kdWxlIFwib2JzaWRpYW5cIiB7XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZSB7XG4gICAgICAgIGRlc2VyaWFsaXplTGF5b3V0KHN0YXRlOiBhbnksIC4uLmV0YzogYW55W10pOiBQcm9taXNlPFdvcmtzcGFjZUl0ZW0+XG4gICAgfVxuXG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBbSElTVF9BVFRSXTogSGlzdG9yeVxuICAgICAgICBwaW5uZWQ6IGJvb2xlYW5cbiAgICAgICAgd29ya2luZzogYm9vbGVhblxuICAgICAgICBzZXJpYWxpemUoKTogYW55XG4gICAgfVxuXG4gICAgaW50ZXJmYWNlIFZpZXdTdGF0ZSB7XG4gICAgICAgIHBvcHN0YXRlPzogYm9vbGVhblxuICAgIH1cbn1cblxuXG5jb25zdCBkb21MZWF2ZXMgPSBuZXcgV2Vha01hcCgpO1xuXG5pbnRlcmZhY2UgUHVzaFN0YXRlIHtcbiAgICBzdGF0ZTogc3RyaW5nXG4gICAgZVN0YXRlOiBzdHJpbmdcbn1cblxuZXhwb3J0IGNsYXNzIEhpc3RvcnlFbnRyeSB7XG5cbiAgICByYXc6IFB1c2hTdGF0ZVxuICAgIGVTdGF0ZTogYW55XG4gICAgcGF0aDogc3RyaW5nXG5cbiAgICBjb25zdHJ1Y3RvcihyYXdTdGF0ZTogUHVzaFN0YXRlKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgIH1cblxuXG4gICAgZ2V0IHZpZXdTdGF0ZSgpIHtcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UodGhpcy5yYXcuc3RhdGUgfHwgXCJ7fVwiKVxuICAgIH1cblxuICAgIHNldFN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUpIHtcbiAgICAgICAgdGhpcy5yYXcgPSByYXdTdGF0ZTtcbiAgICAgICAgdGhpcy5lU3RhdGUgPSBKU09OLnBhcnNlKHJhd1N0YXRlLmVTdGF0ZSB8fCBcIm51bGxcIik7XG4gICAgICAgIHRoaXMucGF0aCA9IHRoaXMudmlld1N0YXRlLnN0YXRlPy5maWxlO1xuICAgIH1cblxuICAgIG9uUmVuYW1lKGZpbGU6IFRBYnN0cmFjdEZpbGUsIG9sZFBhdGg6IHN0cmluZykge1xuICAgICAgICBpZiAodGhpcy5wYXRoID09PSBvbGRQYXRoKSB7XG4gICAgICAgICAgICBjb25zdCB2aWV3U3RhdGUgPSB0aGlzLnZpZXdTdGF0ZVxuICAgICAgICAgICAgdGhpcy5wYXRoID0gdmlld1N0YXRlLnN0YXRlLmZpbGUgPSBmaWxlLnBhdGhcbiAgICAgICAgICAgIHRoaXMucmF3LnN0YXRlID0gSlNPTi5zdHJpbmdpZnkodmlld1N0YXRlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvKGxlYWY/OiBXb3Jrc3BhY2VMZWFmKSB7XG4gICAgICAgIGxldCB7dmlld1N0YXRlLCBwYXRoLCBlU3RhdGV9ID0gdGhpcztcbiAgICAgICAgbGV0IGZpbGUgPSBwYXRoICYmIGFwcD8udmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuICAgICAgICBpZiAocGF0aCAmJiAhZmlsZSkge1xuICAgICAgICAgICAgbmV3IE5vdGljZShcIk1pc3NpbmcgZmlsZTogXCIrcGF0aCk7XG4gICAgICAgICAgICB2aWV3U3RhdGUgPSB7dHlwZTogXCJlbXB0eVwiLCBzdGF0ZTp7fX07XG4gICAgICAgICAgICBlU3RhdGUgPSB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgbGVhZi5zZXRWaWV3U3RhdGUoey4uLnZpZXdTdGF0ZSwgYWN0aXZlOiB0cnVlLCBwb3BzdGF0ZTogdHJ1ZX0sIGVTdGF0ZSk7XG4gICAgfVxuXG4gICAgcmVwbGFjZVN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUpIHtcbiAgICAgICAgaWYgKHJhd1N0YXRlLnN0YXRlICE9PSB0aGlzLnJhdy5zdGF0ZSkge1xuICAgICAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICAgICAgLy8gRG9uJ3QgcmVwbGFjZSBhIGZpbGUgd2l0aCBhbiBlbXB0eSBpbiB0aGUgaGlzdG9yeVxuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcImVtcHR5XCIpIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgLy8gRmlsZSBpcyBkaWZmZXJlbnQgZnJvbSBleGlzdGluZyBmaWxlOiBzaG91bGQgYmUgYSBwdXNoIGluc3RlYWRcbiAgICAgICAgICAgIGlmICh0aGlzLnBhdGggJiYgdGhpcy5wYXRoICE9PSB2aWV3U3RhdGU/LnN0YXRlPy5maWxlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBpZiAodmlld1N0YXRlLnR5cGUgPT09IFwibWVkaWEtdmlld1wiKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgb2xkSW5mbyA9IEpTT04uc3RyaW5naWZ5KHRoaXMudmlld1N0YXRlLnN0YXRlLmluZm8pO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5ld0luZm8gPSBKU09OLnN0cmluZ2lmeSh2aWV3U3RhdGUuc3RhdGUuaW5mbyk7XG4gICAgICAgICAgICAgICAgaWYgKG9sZEluZm8gIT09IG5ld0luZm8pIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB0aGlzLnNldFN0YXRlKHJhd1N0YXRlKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxufVxuXG5pbnRlcmZhY2UgU2VyaWFsaXphYmxlSGlzdG9yeSB7XG4gICAgcG9zOiBudW1iZXJcbiAgICBzdGFjazogUHVzaFN0YXRlW11cbn1cblxuZXhwb3J0IGNsYXNzIEhpc3Rvcnkge1xuICAgIHN0YXRpYyBjdXJyZW50KCkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZikgfHwgbmV3IHRoaXMoKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yTGVhZihsZWFmOiBXb3Jrc3BhY2VMZWFmKSB7XG4gICAgICAgIGlmIChsZWFmKSBkb21MZWF2ZXMuc2V0KGxlYWYuY29udGFpbmVyRWwsIGxlYWYpO1xuICAgICAgICBpZiAobGVhZikgcmV0dXJuIGxlYWZbSElTVF9BVFRSXSBpbnN0YW5jZW9mIHRoaXMgP1xuICAgICAgICAgICAgbGVhZltISVNUX0FUVFJdIDpcbiAgICAgICAgICAgIGxlYWZbSElTVF9BVFRSXSA9IG5ldyB0aGlzKGxlYWYsIGxlYWZbSElTVF9BVFRSXT8uc2VyaWFsaXplKCkgfHwgdW5kZWZpbmVkKTtcbiAgICB9XG5cbiAgICBwb3M6IG51bWJlclxuICAgIHN0YWNrOiBIaXN0b3J5RW50cnlbXVxuXG4gICAgY29uc3RydWN0b3IocHVibGljIGxlYWY/OiBXb3Jrc3BhY2VMZWFmLCB7cG9zLCBzdGFja306IFNlcmlhbGl6YWJsZUhpc3RvcnkgPSB7cG9zOjAsIHN0YWNrOltdfSkge1xuICAgICAgICB0aGlzLmxlYWYgPSBsZWFmO1xuICAgICAgICB0aGlzLnBvcyA9IHBvcztcbiAgICAgICAgdGhpcy5zdGFjayA9IHN0YWNrLm1hcChyYXcgPT4gbmV3IEhpc3RvcnlFbnRyeShyYXcpKTtcbiAgICB9XG5cbiAgICBjbG9uZVRvKGxlYWY6IFdvcmtzcGFjZUxlYWYpIHtcbiAgICAgICAgcmV0dXJuIGxlYWZbSElTVF9BVFRSXSA9IG5ldyBIaXN0b3J5KGxlYWYsIHRoaXMuc2VyaWFsaXplKCkpO1xuICAgIH1cblxuICAgIG9uUmVuYW1lKGZpbGU6IFRBYnN0cmFjdEZpbGUsIG9sZFBhdGg6IHN0cmluZykge1xuICAgICAgICBmb3IoY29uc3QgaGlzdEVudHJ5IG9mIHRoaXMuc3RhY2spIGhpc3RFbnRyeS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKTtcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKTogU2VyaWFsaXphYmxlSGlzdG9yeSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2subWFwKGUgPT4gZS5yYXcpfTsgfVxuXG4gICAgZ2V0IHN0YXRlKCkgeyByZXR1cm4gdGhpcy5zdGFja1t0aGlzLnBvc10/LnJhdyB8fCBudWxsOyB9XG4gICAgZ2V0IGxlbmd0aCgpIHsgcmV0dXJuIHRoaXMuc3RhY2subGVuZ3RoOyB9XG5cbiAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfVxuICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9XG5cbiAgICBsb29rQWhlYWQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKDAsIHRoaXMucG9zKS5yZXZlcnNlKCk7IH1cbiAgICBsb29rQmVoaW5kKCkgeyByZXR1cm4gdGhpcy5zdGFjay5zbGljZSh0aGlzLnBvcysxKTsgfVxuXG4gICAgYW5ub3VuY2UoKSB7XG4gICAgICAgIGFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKTtcbiAgICB9XG5cbiAgICBnb3RvKHBvczogbnVtYmVyKTogdm9pZCB7XG4gICAgICAgIGlmICghdGhpcy5sZWFmKSByZXR1cm47XG4gICAgICAgIGlmICh0aGlzLmxlYWYucGlubmVkKSByZXR1cm4gbmV3IE5vdGljZShcIlBpbm5lZCBwYW5lOiB1bnBpbiBiZWZvcmUgZ29pbmcgZm9yd2FyZCBvciBiYWNrXCIpLCB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh0aGlzLmxlYWYud29ya2luZykgcmV0dXJuIG5ldyBOb3RpY2UoXCJQYW5lIGlzIGJ1c3k6IHBsZWFzZSB3YWl0IGJlZm9yZSBuYXZpZ2F0aW5nIGZ1cnRoZXJcIiksIHVuZGVmaW5lZDtcbiAgICAgICAgcG9zID0gdGhpcy5wb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihwb3MsIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICB0aGlzLnN0YWNrW3Bvc10/LmdvKHRoaXMubGVhZik7XG4gICAgICAgIHRoaXMuYW5ub3VuY2UoKTtcbiAgICB9XG5cbiAgICBnbyhieTogbnVtYmVyLCBmb3JjZT86IGJvb2xlYW4pIHtcbiAgICAgICAgaWYgKCF0aGlzLmxlYWYgfHwgIWJ5KSByZXR1cm47ICAvLyBuby1vcFxuICAgICAgICAvLyBwcmV2ZW50IHdyYXBhcm91bmRcbiAgICAgICAgY29uc3QgbmV3UG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odGhpcy5wb3MgLSBieSwgdGhpcy5zdGFjay5sZW5ndGggLSAxKSk7XG4gICAgICAgIGlmIChmb3JjZSB8fCBuZXdQb3MgIT09IHRoaXMucG9zKSB7XG4gICAgICAgICAgICB0aGlzLmdvdG8obmV3UG9zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYE5vIG1vcmUgJHtieSA8IDAgPyBcImJhY2tcIiA6IFwiZm9yd2FyZFwifSBoaXN0b3J5IGZvciBwYW5lYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGU6IFB1c2hTdGF0ZSwgdGl0bGU6IHN0cmluZywgdXJsOiBzdHJpbmcpe1xuICAgICAgICBjb25zdCBlbnRyeSA9IHRoaXMuc3RhY2tbdGhpcy5wb3NdO1xuICAgICAgICBpZiAoIWVudHJ5KSB7XG4gICAgICAgICAgICB0aGlzLnN0YWNrW3RoaXMucG9zXSA9IG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpO1xuICAgICAgICB9IGVsc2UgaWYgKCFlbnRyeS5yZXBsYWNlU3RhdGUocmF3U3RhdGUpKSB7XG4gICAgICAgICAgICAvLyByZXBsYWNlU3RhdGUgd2FzIGVycm9uZW91c2x5IGNhbGxlZCB3aXRoIGEgbmV3IGZpbGUgZm9yIHRoZSBzYW1lIGxlYWY7XG4gICAgICAgICAgICAvLyBmb3JjZSBhIHB1c2hTdGF0ZSBpbnN0ZWFkIChmaXhlcyB0aGUgaXNzdWUgcmVwb3J0ZWQgaGVyZTogaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90LzE4NTE4KVxuICAgICAgICAgICAgdGhpcy5wdXNoU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcHVzaFN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKSAgIHtcbiAgICAgICAgLy9jb25zb2xlLmxvZyhcInB1c2hpbmdcIiwgcmF3U3RhdGUpXG4gICAgICAgIHRoaXMuc3RhY2suc3BsaWNlKDAsIHRoaXMucG9zLCBuZXcgSGlzdG9yeUVudHJ5KHJhd1N0YXRlKSk7XG4gICAgICAgIHRoaXMucG9zID0gMDtcbiAgICAgICAgLy8gTGltaXQgXCJiYWNrXCIgdG8gMjBcbiAgICAgICAgd2hpbGUgKHRoaXMuc3RhY2subGVuZ3RoID4gMjApIHRoaXMuc3RhY2sucG9wKCk7XG4gICAgICAgIHRoaXMuYW5ub3VuY2UoKTtcbiAgICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsSGlzdG9yeShwbHVnaW46IFBhbmVSZWxpZWYpIHtcblxuICAgIC8vIE1vbmtleXBhdGNoOiBpbmNsdWRlIGhpc3RvcnkgaW4gbGVhZiBzZXJpYWxpemF0aW9uIChzbyBpdCdzIHBlcnNpc3RlZCB3aXRoIHRoZSB3b3Jrc3BhY2UpXG4gICAgLy8gYW5kIGNoZWNrIGZvciBwb3BzdGF0ZSBldmVudHMgKHRvIHN1cHByZXNzIHRoZW0pXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChXb3Jrc3BhY2VMZWFmLnByb3RvdHlwZSwge1xuICAgICAgICBzZXJpYWxpemUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXJpYWxpemUoKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgaWYgKHRoaXNbSElTVF9BVFRSXSkgcmVzdWx0W1NFUklBTF9QUk9QXSA9IHRoaXNbSElTVF9BVFRSXS5zZXJpYWxpemUoKTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19LFxuICAgICAgICBzZXRWaWV3U3RhdGUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXRWaWV3U3RhdGUodnMsIGVzKXtcbiAgICAgICAgICAgIGlmICh2cy5wb3BzdGF0ZSAmJiB3aW5kb3cuZXZlbnQ/LnR5cGUgPT09IFwicG9wc3RhdGVcIikge1xuICAgICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCB2cywgZXMpO1xuICAgICAgICB9fVxuICAgIH0pKTtcblxuICAgIHBsdWdpbi5yZWdpc3Rlcihhcm91bmQoYXBwLndvcmtzcGFjZSwge1xuICAgICAgICAvLyBNb25rZXlwYXRjaDogbG9hZCBoaXN0b3J5IGR1cmluZyBsZWFmIGxvYWQsIGlmIHByZXNlbnRcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZUxheW91dChzdGF0ZSwgLi4uZXRjOiBhbnlbXSl7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgb2xkLmNhbGwodGhpcywgc3RhdGUsIC4uLmV0Yyk7XG4gICAgICAgICAgICBpZiAoc3RhdGUudHlwZSA9PT0gXCJsZWFmXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBSZXRyeSBsb2FkaW5nIHRoZSBwYW5lIGFzIGFuIGVtcHR5XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnN0YXRlLnR5cGUgPSAnZW1wdHknO1xuICAgICAgICAgICAgICAgICAgICByZXN1bHQgPSBhd2FpdCBvbGQuY2FsbCh0aGlzLCBzdGF0ZSwgLi4uZXRjKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChzdGF0ZVtTRVJJQUxfUFJPUF0pIHJlc3VsdFtISVNUX0FUVFJdID0gbmV3IEhpc3RvcnkocmVzdWx0LCBzdGF0ZVtTRVJJQUxfUFJPUF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX0sXG4gICAgICAgIC8vIE1vbmtleXBhdGNoOiBrZWVwIE9ic2lkaWFuIGZyb20gcHVzaGluZyBoaXN0b3J5IGluIHNldEFjdGl2ZUxlYWZcbiAgICAgICAgc2V0QWN0aXZlTGVhZihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNldEFjdGl2ZUxlYWYobGVhZiwgLi4uZXRjKSB7XG4gICAgICAgICAgICBjb25zdCB1bnN1YiA9IGFyb3VuZCh0aGlzLCB7XG4gICAgICAgICAgICAgICAgcmVjb3JkSGlzdG9yeShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIChsZWFmOiBXb3Jrc3BhY2VMZWFmLCBfcHVzaDogYm9vbGVhbiwgLi4uYXJnczogYW55W10pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQWx3YXlzIHVwZGF0ZSBzdGF0ZSBpbiBwbGFjZVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgZmFsc2UsIC4uLmFyZ3MpO1xuICAgICAgICAgICAgICAgIH07IH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgLi4uZXRjKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgdW5zdWIoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfX0sXG4gICAgfSkpO1xuXG4gICAgLy8gT3ZlcnJpZGUgZGVmYXVsdCBtb3VzZSBoaXN0b3J5IGJlaGF2aW9yLiAgV2UgbmVlZCB0aGlzIGJlY2F1c2UgMSkgRWxlY3Ryb24gd2lsbCB1c2UgdGhlIGJ1aWx0LWluXG4gICAgLy8gaGlzdG9yeSBvYmplY3QgaWYgd2UgZG9uJ3QgKGluc3RlYWQgb2Ygb3VyIHdyYXBwZXIpLCBhbmQgMikgd2Ugd2FudCB0aGUgY2xpY2sgdG8gYXBwbHkgdG8gdGhlIGxlYWZcbiAgICAvLyB0aGF0IHdhcyB1bmRlciB0aGUgbW91c2UsIHJhdGhlciB0aGFuIHdoaWNoZXZlciBsZWFmIHdhcyBhY3RpdmUuXG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpO1xuICAgIHBsdWdpbi5yZWdpc3RlcigoKSA9PiB7XG4gICAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICB9KTtcbiAgICBmdW5jdGlvbiBoaXN0b3J5SGFuZGxlcihlOiBNb3VzZUV2ZW50KSB7XG4gICAgICAgIGlmIChlLmJ1dHRvbiAhPT0gMyAmJiBlLmJ1dHRvbiAhPT0gNCkgcmV0dXJuO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7ICAvLyBwcmV2ZW50IGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gKGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50KS5tYXRjaFBhcmVudChcIi53b3Jrc3BhY2UtbGVhZlwiKTtcbiAgICAgICAgaWYgKHRhcmdldCAmJiBlLnR5cGUgPT09IFwibW91c2V1cFwiKSB7XG4gICAgICAgICAgICBsZXQgbGVhZiA9IGRvbUxlYXZlcy5nZXQodGFyZ2V0KTtcbiAgICAgICAgICAgIGlmICghbGVhZikgYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKGwgPT4gbGVhZiA9IChsLmNvbnRhaW5lckVsID09PSB0YXJnZXQpID8gbCA6IGxlYWYpO1xuICAgICAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBpZiAoZS5idXR0b24gPT0gMykgeyBIaXN0b3J5LmZvckxlYWYobGVhZikuYmFjaygpOyB9XG4gICAgICAgICAgICBpZiAoZS5idXR0b24gPT0gNCkgeyBIaXN0b3J5LmZvckxlYWYobGVhZikuZm9yd2FyZCgpOyB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIFByb3h5IHRoZSB3aW5kb3cgaGlzdG9yeSB3aXRoIGEgd3JhcHBlciB0aGF0IGRlbGVnYXRlcyB0byB0aGUgYWN0aXZlIGxlYWYncyBIaXN0b3J5IG9iamVjdCxcbiAgICBjb25zdCByZWFsSGlzdG9yeSA9IHdpbmRvdy5oaXN0b3J5O1xuICAgIHBsdWdpbi5yZWdpc3RlcigoKSA9PiAod2luZG93IGFzIGFueSkuaGlzdG9yeSA9IHJlYWxIaXN0b3J5KTtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCBcImhpc3RvcnlcIiwgeyBlbnVtZXJhYmxlOiB0cnVlLCBjb25maWd1cmFibGU6IHRydWUsIHdyaXRhYmxlOiB0cnVlLCB2YWx1ZToge1xuICAgICAgICBnZXQgc3RhdGUoKSAgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudCgpLnN0YXRlOyB9LFxuICAgICAgICBnZXQgbGVuZ3RoKCkgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudCgpLmxlbmd0aDsgfSxcblxuICAgICAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfSxcbiAgICAgICAgZm9yd2FyZCgpIHsgdGhpcy5nbyggMSk7IH0sXG4gICAgICAgIGdvKGJ5OiBudW1iZXIpICAgIHsgSGlzdG9yeS5jdXJyZW50KCkuZ28oYnkpOyB9LFxuXG4gICAgICAgIHJlcGxhY2VTdGF0ZShzdGF0ZTogUHVzaFN0YXRlLCB0aXRsZTogc3RyaW5nLCB1cmw6IHN0cmluZyl7IEhpc3RvcnkuY3VycmVudCgpLnJlcGxhY2VTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG4gICAgICAgIHB1c2hTdGF0ZShzdGF0ZTogUHVzaFN0YXRlLCB0aXRsZTogc3RyaW5nLCB1cmw6IHN0cmluZykgICB7IEhpc3RvcnkuY3VycmVudCgpLnB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7IH0sXG5cbiAgICAgICAgZ2V0IHNjcm9sbFJlc3RvcmF0aW9uKCkgICAgeyByZXR1cm4gcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb247IH0sXG4gICAgICAgIHNldCBzY3JvbGxSZXN0b3JhdGlvbih2YWwpIHsgcmVhbEhpc3Rvcnkuc2Nyb2xsUmVzdG9yYXRpb24gPSB2YWw7IH0sXG4gICAgfX0pO1xuXG59XG4iLCJpbXBvcnQgeyBDb21wb25lbnQsIFBsdWdpbiwgVmlldywgV29ya3NwYWNlTGVhZiwgV29ya3NwYWNlUGFyZW50LCBXb3Jrc3BhY2VTcGxpdCwgV29ya3NwYWNlV2luZG93IH0gZnJvbSBcIm9ic2lkaWFuXCI7XG5cbi8qKlxuICogQ29tcG9uZW50IHRoYXQgYmVsb25ncyB0byBhIHBsdWdpbiArIHdpbmRvdy4gZS5nLjpcbiAqXG4gKiAgICAgY2xhc3MgVGl0bGVXaWRnZXQgZXh0ZW5kcyBQZXJXaW5kb3dDb21wb25lbnQ8TXlQbHVnaW4+IHtcbiAqICAgICAgICAgb25sb2FkKCkge1xuICogICAgICAgICAgICAgLy8gZG8gc3R1ZmYgd2l0aCB0aGlzLnBsdWdpbiBhbmQgdGhpcy53aW4gLi4uXG4gKiAgICAgICAgIH1cbiAqICAgICB9XG4gKlxuICogICAgIGNsYXNzIE15UGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAqICAgICAgICAgdGl0bGVXaWRnZXRzID0gVGl0bGVXaWRnZXQucGVyV2luZG93KHRoaXMpO1xuICogICAgICAgICAuLi5cbiAqICAgICB9XG4gKlxuICogVGhpcyB3aWxsIGF1dG9tYXRpY2FsbHkgY3JlYXRlIGEgdGl0bGUgd2lkZ2V0IGZvciBlYWNoIHdpbmRvdyBhcyBpdCdzIG9wZW5lZCwgYW5kXG4gKiBvbiBwbHVnaW4gbG9hZC4gIFRoZSBwbHVnaW4ncyBgLnRpdGxlV2lkZ2V0c2Agd2lsbCBhbHNvIGJlIGEgV2luZG93TWFuYWdlciB0aGF0IGNhblxuICogbG9vayB1cCB0aGUgdGl0bGUgd2lkZ2V0IGZvciBhIGdpdmVuIHdpbmRvdywgbGVhZiwgb3Igdmlldywgb3IgcmV0dXJuIGEgbGlzdCBvZlxuICogYWxsIG9mIHRoZW0uICBTZWUgV2luZG93TWFuYWdlciBmb3IgdGhlIGZ1bGwgQVBJLlxuICpcbiAqIElmIHlvdSB3YW50IHlvdXIgY29tcG9uZW50cyB0byBiZSBjcmVhdGVkIG9uIGRlbWFuZCBpbnN0ZWFkIG9mIGF1dG9tYXRpY2FsbHkgd2hlblxuICogd2luZG93KHMpIGFyZSBvcGVuZWQsIHlvdSBjYW4gcGFzcyBgZmFsc2VgIGFzIHRoZSBzZWNvbmQgYXJndW1lbnQgdG8gYHBlcldpbmRvdygpYC5cbiAqL1xuZXhwb3J0IGNsYXNzIFBlcldpbmRvd0NvbXBvbmVudDxQIGV4dGVuZHMgUGx1Z2luPiBleHRlbmRzIENvbXBvbmVudCB7XG5cbiAgICBjb25zdHJ1Y3RvcihwdWJsaWMgcGx1Z2luOiBQLCBwdWJsaWMgd2luOiBXaW5kb3csIHB1YmxpYyByb290OiBXb3Jrc3BhY2VXaW5kb3cgfCBXb3Jrc3BhY2VTcGxpdCkge1xuICAgICAgICBzdXBlcigpO1xuICAgIH1cblxuICAgIHN0YXRpYyBwZXJXaW5kb3c8VCBleHRlbmRzIFBlcldpbmRvd0NvbXBvbmVudDxQPiwgUCBleHRlbmRzIFBsdWdpbj4oXG4gICAgICAgIHRoaXM6IG5ldyAocGx1Z2luOiBQLCB3aW46IFdpbmRvdykgPT4gVCxcbiAgICAgICAgcGx1Z2luOiBQXG4gICAgKSB7XG4gICAgICAgIHJldHVybiBuZXcgV2luZG93TWFuYWdlcihwbHVnaW4sIHRoaXMpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBNYW5hZ2UgcGVyLXdpbmRvdyBjb21wb25lbnRzXG4gKi9cbmV4cG9ydCBjbGFzcyBXaW5kb3dNYW5hZ2VyPFQgZXh0ZW5kcyBQZXJXaW5kb3dDb21wb25lbnQ8UD4sIFAgZXh0ZW5kcyBQbHVnaW4+IGV4dGVuZHMgQ29tcG9uZW50IHtcbiAgICBpbnN0YW5jZXMgPSBuZXcgV2Vha01hcDxXaW5kb3csIFQ+KCk7XG5cbiAgICB3YXRjaGluZzogYm9vbGVhbiA9IGZhbHNlXG5cbiAgICBjb25zdHJ1Y3RvciAoXG4gICAgICAgIHB1YmxpYyBwbHVnaW46IFAsXG4gICAgICAgIHB1YmxpYyBmYWN0b3J5OiBuZXcgKHBsdWdpbjogUCwgd2luOiBXaW5kb3csIHJvb3Q6IFdvcmtzcGFjZVBhcmVudCkgPT4gVCwgIC8vIFRoZSBjbGFzcyBvZiB0aGluZyB0byBtYW5hZ2VcbiAgICApIHtcbiAgICAgICAgc3VwZXIoKTtcbiAgICAgICAgcGx1Z2luLmFkZENoaWxkKHRoaXMpO1xuICAgIH1cblxuICAgIHdhdGNoKCk6IHRoaXMge1xuICAgICAgICAvLyBEZWZlciB3YXRjaCB1bnRpbCBwbHVnaW4gaXMgbG9hZGVkXG4gICAgICAgIGlmICghdGhpcy5fbG9hZGVkKSB0aGlzLm9ubG9hZCA9ICgpID0+IHRoaXMud2F0Y2goKTtcbiAgICAgICAgZWxzZSBpZiAoIXRoaXMud2F0Y2hpbmcpIHtcbiAgICAgICAgICAgIGNvbnN0IHt3b3Jrc3BhY2V9ID0gYXBwO1xuICAgICAgICAgICAgdGhpcy53YXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICAgICAgd29ya3NwYWNlLm9uKFwid2luZG93LW9wZW5cIiwgKF8sIHdpbikgPT4ge1xuICAgICAgICAgICAgICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiBzZXRJbW1lZGlhdGUoKCkgPT4gdGhpcy5mb3JXaW5kb3cod2luKSkpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4gc2V0SW1tZWRpYXRlKCgpID0+IHRoaXMuZm9yQWxsKCkpKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBmb3JXaW5kb3coKTogVDtcbiAgICBmb3JXaW5kb3cod2luOiBXaW5kb3cpOiBUO1xuICAgIGZvcldpbmRvdyh3aW46IFdpbmRvdywgY3JlYXRlOiB0cnVlKTogVDtcbiAgICBmb3JXaW5kb3cod2luOiBXaW5kb3csIGNyZWF0ZTogYm9vbGVhbik6IFQgfCB1bmRlZmluZWQ7XG5cbiAgICBmb3JXaW5kb3cod2luOiBXaW5kb3cgPSB3aW5kb3cuYWN0aXZlV2luZG93ID8/IHdpbmRvdywgY3JlYXRlID0gdHJ1ZSk6IFQgfCB1bmRlZmluZWQge1xuICAgICAgICBsZXQgaW5zdCA9IHRoaXMuaW5zdGFuY2VzLmdldCh3aW4pO1xuICAgICAgICBpZiAoIWluc3QgJiYgY3JlYXRlKSB7XG4gICAgICAgICAgICBpbnN0ID0gbmV3IHRoaXMuZmFjdG9yeSh0aGlzLnBsdWdpbiwgd2luLCBjb250YWluZXJGb3JXaW5kb3cod2luKSk7XG4gICAgICAgICAgICBpZiAoaW5zdCkge1xuICAgICAgICAgICAgICAgIHRoaXMuaW5zdGFuY2VzLnNldCh3aW4sIGluc3QhKTtcbiAgICAgICAgICAgICAgICBpbnN0LnJlZ2lzdGVyRG9tRXZlbnQod2luLCBcImJlZm9yZXVubG9hZFwiLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucmVtb3ZlQ2hpbGQoaW5zdCEpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmluc3RhbmNlcy5kZWxldGUod2luKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB0aGlzLmFkZENoaWxkKGluc3QpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBpbnN0IHx8IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBmb3JEb20oZWw6IE5vZGUpOiBUO1xuICAgIGZvckRvbShlbDogTm9kZSwgY3JlYXRlOiB0cnVlKTogVDtcbiAgICBmb3JEb20oZWw6IE5vZGUsIGNyZWF0ZTogYm9vbGVhbik6IFQgfCB1bmRlZmluZWQ7XG5cbiAgICBmb3JEb20oZWw6IE5vZGUsIGNyZWF0ZSA9IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yV2luZG93KHdpbmRvd0ZvckRvbShlbCksIGNyZWF0ZSk7XG4gICAgfVxuXG4gICAgZm9yTGVhZihsZWFmOiBXb3Jrc3BhY2VMZWFmKTogVDtcbiAgICBmb3JMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGNyZWF0ZTogdHJ1ZSk6IFQ7XG4gICAgZm9yTGVhZihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBjcmVhdGU6IGJvb2xlYW4pOiBUIHwgdW5kZWZpbmVkO1xuXG4gICAgZm9yTGVhZihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBjcmVhdGUgPSB0cnVlKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmZvckRvbShsZWFmLmNvbnRhaW5lckVsLCBjcmVhdGUpO1xuICAgIH1cblxuICAgIGZvclZpZXcodmlldzogVmlldyk6IFQ7XG4gICAgZm9yVmlldyh2aWV3OiBWaWV3LCBjcmVhdGU6IHRydWUpOiBUO1xuICAgIGZvclZpZXcodmlldzogVmlldywgY3JlYXRlOiBib29sZWFuKTogVCB8IHVuZGVmaW5lZDtcblxuICAgIGZvclZpZXcodmlldzogVmlldywgY3JlYXRlID0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JEb20odmlldy5jb250YWluZXJFbCwgY3JlYXRlKTtcbiAgICB9XG5cbiAgICB3aW5kb3dzKCkge1xuICAgICAgICBjb25zdCB3aW5kb3dzOiBXaW5kb3dbXSA9IFt3aW5kb3ddLCB7ZmxvYXRpbmdTcGxpdH0gPSBhcHAud29ya3NwYWNlO1xuICAgICAgICBpZiAoZmxvYXRpbmdTcGxpdCkge1xuICAgICAgICAgICAgZm9yKGNvbnN0IHNwbGl0IG9mIGZsb2F0aW5nU3BsaXQuY2hpbGRyZW4pIGlmIChzcGxpdC53aW4pIHdpbmRvd3MucHVzaChzcGxpdC53aW4pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB3aW5kb3dzO1xuICAgIH1cblxuICAgIGZvckFsbChjcmVhdGUgPSB0cnVlKSB7XG4gICAgICAgIHJldHVybiB0aGlzLndpbmRvd3MoKS5tYXAod2luID0+IHRoaXMuZm9yV2luZG93KHdpbiwgY3JlYXRlKSkuZmlsdGVyKHQgPT4gdCk7XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gd2luZG93Rm9yRG9tKGVsOiBOb2RlKSB7XG4gICAgcmV0dXJuIChlbC5vd25lckRvY3VtZW50IHx8IDxEb2N1bWVudD5lbCkuZGVmYXVsdFZpZXchO1xufVxuXG5mdW5jdGlvbiBjb250YWluZXJGb3JXaW5kb3cod2luOiBXaW5kb3cpOiBXb3Jrc3BhY2VQYXJlbnQge1xuICAgIGlmICh3aW4gPT09IHdpbmRvdykgcmV0dXJuIGFwcC53b3Jrc3BhY2Uucm9vdFNwbGl0O1xuICAgIGNvbnN0IHtmbG9hdGluZ1NwbGl0fSA9IGFwcC53b3Jrc3BhY2U7XG4gICAgaWYgKGZsb2F0aW5nU3BsaXQpIHtcbiAgICAgICAgZm9yKGNvbnN0IHNwbGl0IG9mIGZsb2F0aW5nU3BsaXQuY2hpbGRyZW4pIGlmICh3aW4gPT09IHNwbGl0LndpbikgcmV0dXJuIHNwbGl0O1xuICAgIH1cbn1cblxuZGVjbGFyZSBnbG9iYWwge1xuICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgZm9yIHNpbmdsZS13aW5kb3cgT2JzaWRpYW4gKDwwLjE1KVxuICAgIGludGVyZmFjZSBXaW5kb3cge1xuICAgICAgICBhY3RpdmVXaW5kb3c/OiBXaW5kb3dcbiAgICB9XG59XG5cbmRlY2xhcmUgbW9kdWxlIFwib2JzaWRpYW5cIiB7XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZSB7XG4gICAgICAgIGZsb2F0aW5nU3BsaXQ/OiB7IGNoaWxkcmVuOiBXb3Jrc3BhY2VXaW5kb3dbXSB9O1xuICAgICAgICBvcGVuUG9wb3V0PygpOiBXb3Jrc3BhY2VTcGxpdDtcbiAgICAgICAgb3BlblBvcG91dExlYWY/KCk6IFdvcmtzcGFjZUxlYWY7XG4gICAgICAgIG9uKG5hbWU6ICd3aW5kb3ctb3BlbicsIGNhbGxiYWNrOiAod2luOiBXb3Jrc3BhY2VXaW5kb3csIHdpbmRvdzogV2luZG93KSA9PiBhbnksIGN0eD86IGFueSk6IEV2ZW50UmVmO1xuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlV2luZG93IGV4dGVuZHMgV29ya3NwYWNlUGFyZW50IHtcbiAgICAgICAgd2luOiBXaW5kb3dcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBjb250YWluZXJFbDogSFRNTERpdkVsZW1lbnQ7XG4gICAgfVxuICAgIGludGVyZmFjZSBDb21wb25lbnQge1xuICAgICAgICBfbG9hZGVkOiBib29sZWFuXG4gICAgfVxufVxuIiwiaW1wb3J0IHtNZW51LCBLZXltYXAsIENvbXBvbmVudCwgV29ya3NwYWNlTGVhZiwgVEZpbGUsIE1lbnVJdGVtfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge0hpc3RvcnksIEhpc3RvcnlFbnRyeX0gZnJvbSBcIi4vSGlzdG9yeVwiO1xuaW1wb3J0IFBhbmVSZWxpZWYgZnJvbSAnLi9wYW5lLXJlbGllZic7XG5pbXBvcnQge1BlcldpbmRvd0NvbXBvbmVudH0gZnJvbSAnLi9QZXJXaW5kb3dDb21wb25lbnQnO1xuXG5kZWNsYXJlIG1vZHVsZSBcIm9ic2lkaWFuXCIge1xuICAgIGludGVyZmFjZSBNZW51IHtcbiAgICAgICAgZG9tOiBIVE1MRWxlbWVudFxuICAgIH1cbiAgICBpbnRlcmZhY2UgTWVudUl0ZW0ge1xuICAgICAgICBkb206IEhUTUxFbGVtZW50XG4gICAgfVxuICAgIGludGVyZmFjZSBBcHAge1xuICAgICAgICBkcmFnTWFuYWdlcjogRHJhZ01hbmFnZXJcbiAgICB9XG4gICAgaW50ZXJmYWNlIERyYWdNYW5hZ2VyIHtcbiAgICAgICAgZHJhZ0ZpbGUoZXZlbnQ6IERyYWdFdmVudCwgZmlsZTogVEZpbGUpOiBEcmFnRGF0YVxuICAgICAgICBvbkRyYWdTdGFydChldmVudDogRHJhZ0V2ZW50LCBkcmFnRGF0YTogRHJhZ0RhdGEpOiB2b2lkXG4gICAgfVxuICAgIGludGVyZmFjZSBEcmFnRGF0YSB7fVxuICAgIGludGVyZmFjZSBXb3Jrc3BhY2VMZWFmIHtcbiAgICAgICAgYWN0aXZlVGltZTogbnVtYmVyXG4gICAgfVxufVxuXG5pbnRlcmZhY2UgRmlsZUluZm8ge1xuICAgIGljb246IHN0cmluZ1xuICAgIHRpdGxlOiBzdHJpbmdcbiAgICBmaWxlOiBURmlsZVxuICAgIHR5cGU6IHN0cmluZ1xuICAgIHN0YXRlOiBhbnlcbiAgICBlU3RhdGU6IGFueVxufVxuXG5cbmNvbnN0IHZpZXd0eXBlSWNvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgbWFya2Rvd246IFwiZG9jdW1lbnRcIixcbiAgICBpbWFnZTogXCJpbWFnZS1maWxlXCIsXG4gICAgYXVkaW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHZpZGVvOiBcImF1ZGlvLWZpbGVcIixcbiAgICBwZGY6IFwicGRmLWZpbGVcIixcbiAgICBsb2NhbGdyYXBoOiBcImRvdC1uZXR3b3JrXCIsXG4gICAgb3V0bGluZTogXCJidWxsZXQtbGlzdFwiLFxuICAgIGJhY2tsaW5rOiBcImxpbmtcIixcblxuICAgIC8vIHRoaXJkLXBhcnR5IHBsdWdpbnNcbiAgICBrYW5iYW46IFwiYmxvY2tzXCIsXG4gICAgZXhjYWxpZHJhdzogXCJleGNhbGlkcmF3LWljb25cIixcbiAgICBcIm1lZGlhLXZpZXdcIjogXCJhdWRpby1maWxlXCIsXG59XG5cbmNvbnN0IG5vbkZpbGVWaWV3czogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge1xuICAgIGdyYXBoOiBbXCJkb3QtbmV0d29ya1wiLCBcIkdyYXBoIFZpZXdcIl0sXG4gICAgXCJmaWxlLWV4cGxvcmVyXCI6IFtcImZvbGRlclwiLCBcIkZpbGUgRXhwbG9yZXJcIl0sXG4gICAgc3RhcnJlZDogW1wic3RhclwiLCBcIlN0YXJyZWQgRmlsZXNcIl0sXG4gICAgdGFnOiBbXCJ0YWdcIiwgXCJUYWdzIFZpZXdcIl0sXG5cbiAgICAvLyB0aGlyZC1wYXJ0eSBwbHVnaW5zXG4gICAgXCJyZWNlbnQtZmlsZXNcIjogW1wiY2xvY2tcIiwgXCJSZWNlbnQgRmlsZXNcIl0sXG4gICAgY2FsZW5kYXI6IFtcImNhbGVuZGFyLXdpdGgtY2hlY2ttYXJrXCIsIFwiQ2FsZW5kYXJcIl0sXG4gICAgZW1wdHk6IFtcImNyb3NzXCIsIFwiTm8gZmlsZVwiXVxufVxuXG5leHBvcnQgY2xhc3MgTmF2aWdhdGlvbiBleHRlbmRzIFBlcldpbmRvd0NvbXBvbmVudDxQYW5lUmVsaWVmPiB7XG4gICAgYmFjazogTmF2aWdhdG9yXG4gICAgZm9yd2FyZDogTmF2aWdhdG9yXG4gICAgLy8gU2V0IHRvIHRydWUgd2hpbGUgZWl0aGVyIG1lbnUgaXMgb3Blbiwgc28gd2UgZG9uJ3Qgc3dpdGNoIGl0IG91dFxuICAgIGhpc3RvcnlJc09wZW4gPSBmYWxzZTtcblxuICAgIGRpc3BsYXkobGVhZiA9IHRoaXMubGF0ZXN0TGVhZigpKSB7XG4gICAgICAgIGlmICh0aGlzLmhpc3RvcnlJc09wZW4pIHJldHVybjtcbiAgICAgICAgaWYgKCF0aGlzLl9sb2FkZWQpIHsgdGhpcy5sb2FkKCk7IHJldHVybjsgfVxuICAgICAgICBjb25zdCBoaXN0b3J5ID0gbGVhZiA/IEhpc3RvcnkuZm9yTGVhZihsZWFmKSA6IG5ldyBIaXN0b3J5KCk7XG4gICAgICAgIHRoaXMuYmFjay5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgICAgICB0aGlzLmZvcndhcmQuc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICB9XG5cbiAgICBsZWF2ZXMoKSB7XG4gICAgICAgIGNvbnN0IGxlYXZlczogV29ya3NwYWNlTGVhZltdID0gW107XG4gICAgICAgIGNvbnN0IGNiID0gKGxlYWY6IFdvcmtzcGFjZUxlYWYpID0+IHsgbGVhdmVzLnB1c2gobGVhZik7IH07XG4gICAgICAgIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUxlYXZlcyhjYiwgdGhpcy5yb290KTtcblxuICAgICAgICAvLyBTdXBwb3J0IEhvdmVyIEVkaXRvcnNcbiAgICAgICAgY29uc3QgcG9wb3ZlcnMgPSBhcHAucGx1Z2lucy5wbHVnaW5zW1wib2JzaWRpYW4taG92ZXItZWRpdG9yXCJdPy5hY3RpdmVQb3BvdmVycztcbiAgICAgICAgaWYgKHBvcG92ZXJzKSBmb3IgKGNvbnN0IHBvcG92ZXIgb2YgcG9wb3ZlcnMpIHtcbiAgICAgICAgICAgIGlmIChwb3BvdmVyLmhvdmVyRWwub3duZXJEb2N1bWVudC5kZWZhdWx0VmlldyAhPT0gdGhpcy53aW4pIGNvbnRpbnVlOyAvLyBtdXN0IGJlIGluIHNhbWUgd2luZG93XG4gICAgICAgICAgICBlbHNlIGlmIChwb3BvdmVyLnJvb3RTcGxpdCkgYXBwLndvcmtzcGFjZS5pdGVyYXRlTGVhdmVzKGNiLCBwb3BvdmVyLnJvb3RTcGxpdCk7XG4gICAgICAgICAgICBlbHNlIGlmIChwb3BvdmVyLmxlYWYpIGNiKHBvcG92ZXIubGVhZik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxlYXZlcztcbiAgICB9XG5cbiAgICBsYXRlc3RMZWFmKCkge1xuICAgICAgICBsZXQgbGVhZiA9IGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKGxlYWYgJiYgdGhpcy5wbHVnaW4ubmF2LmZvckxlYWYobGVhZikgPT09IHRoaXMpIHJldHVybiBsZWFmO1xuICAgICAgICByZXR1cm4gdGhpcy5sZWF2ZXMoKS5yZWR1Y2UoKGJlc3QsIGxlYWYpPT57IHJldHVybiAoIWJlc3QgfHwgYmVzdC5hY3RpdmVUaW1lIDwgbGVhZi5hY3RpdmVUaW1lKSA/IGxlYWYgOiBiZXN0OyB9KTtcbiAgICB9XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIGFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuYmFjayAgICA9IG5ldyBOYXZpZ2F0b3IodGhpcywgXCJiYWNrXCIsIC0xKSk7XG4gICAgICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuZm9yd2FyZCA9IG5ldyBOYXZpZ2F0b3IodGhpcywgXCJmb3J3YXJkXCIsIDEpKTtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheSgpO1xuICAgICAgICAgICAgdGhpcy5udW1iZXJQYW5lcygpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KGFwcC53b3Jrc3BhY2Uub24oXCJsYXlvdXQtY2hhbmdlXCIsIHRoaXMubnVtYmVyUGFuZXMsIHRoaXMpKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXIoXG4gICAgICAgICAgICAgICAgLy8gU3VwcG9ydCBcIkN1c3RvbWl6YWJsZSBQYWdlIEhlYWRlciBhbmQgVGl0bGUgQmFyXCIgYnV0dG9uc1xuICAgICAgICAgICAgICAgIG9uRWxlbWVudChcbiAgICAgICAgICAgICAgICAgICAgdGhpcy53aW4uZG9jdW1lbnQuYm9keSxcbiAgICAgICAgICAgICAgICAgICAgXCJjb250ZXh0bWVudVwiLFxuICAgICAgICAgICAgICAgICAgICBcIi52aWV3LWhlYWRlciA+IC52aWV3LWFjdGlvbnMgPiAudmlldy1hY3Rpb25cIixcbiAgICAgICAgICAgICAgICAgICAgKGV2dCwgdGFyZ2V0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkaXIgPSAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKHRhcmdldC5tYXRjaGVzKCdbY2xhc3MqPVwiIGFwcDpnby1mb3J3YXJkXCJdJykgJiYgXCJmb3J3YXJkXCIpIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKHRhcmdldC5tYXRjaGVzKCdbY2xhc3MqPVwiIGFwcDpnby1iYWNrXCJdJykgICAgJiYgXCJiYWNrXCIpXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFkaXIpIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGVsID0gdGFyZ2V0Lm1hdGNoUGFyZW50KFwiLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMubGVhdmVzKCkuZmlsdGVyKGxlYWYgPT4gbGVhZi5jb250YWluZXJFbCA9PT0gZWwpLnBvcCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFsZWFmKSByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV2dC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZGlzcGxheShsZWFmKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXNbZGlyXS5vcGVuTWVudShldnQpO1xuICAgICAgICAgICAgICAgICAgICB9LCB7Y2FwdHVyZTogdHJ1ZX1cbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy51bk51bWJlclBhbmVzKCk7XG4gICAgfVxuXG4gICAgdW5OdW1iZXJQYW5lcyhzZWxlY3RvciA9IFwiLndvcmtzcGFjZS1sZWFmXCIpIHtcbiAgICAgICAgdGhpcy53aW4uZG9jdW1lbnQuYm9keS5maW5kQWxsKHNlbGVjdG9yKS5mb3JFYWNoKGVsID0+IHtcbiAgICAgICAgICAgIGVsLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiKTtcbiAgICAgICAgICAgIGVsLnRvZ2dsZUNsYXNzKFwiaGFzLXBhbmUtcmVsaWVmLWxhYmVsXCIsIGZhbHNlKTtcbiAgICAgICAgICAgIGVsLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1mb3J3YXJkLWNvdW50XCIpO1xuICAgICAgICAgICAgZWwuc3R5bGUucmVtb3ZlUHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWJhY2t3YXJkLWNvdW50XCIpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB1cGRhdGVMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYpIHtcbiAgICAgICAgY29uc3QgaGlzdG9yeSA9IEhpc3RvcnkuZm9yTGVhZihsZWFmKTtcbiAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtZm9yd2FyZC1jb3VudFwiLCAnXCInKyhoaXN0b3J5Lmxvb2tBaGVhZCgpLmxlbmd0aCB8fCBcIlwiKSsnXCInKTtcbiAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtYmFja3dhcmQtY291bnRcIiwgJ1wiJysoaGlzdG9yeS5sb29rQmVoaW5kKCkubGVuZ3RoIHx8IFwiXCIpKydcIicpO1xuICAgIH1cblxuICAgIG51bWJlclBhbmVzKCkge1xuICAgICAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgICAgICAgIC8vIHVubnVtYmVyIHNpZGViYXIgcGFuZXMgaW4gbWFpbiB3aW5kb3csIGlmIHNvbWV0aGluZyB3YXMgbW92ZWQgdGhlcmVcbiAgICAgICAgICAgIGlmICh0aGlzLndpbiA9PT0gd2luZG93KSB0aGlzLnVuTnVtYmVyUGFuZXMoXCIud29ya3NwYWNlLXRhYnMgPiAud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgICAgICBsZXQgY291bnQgPSAwLCBsYXN0TGVhZjogV29ya3NwYWNlTGVhZiA9IG51bGw7XG4gICAgICAgICAgICB0aGlzLmxlYXZlcygpLmZvckVhY2gobGVhZiA9PiB7XG4gICAgICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtbGFiZWxcIiwgKytjb3VudCA8IDkgPyBcIlwiK2NvdW50IDogXCJcIik7XG4gICAgICAgICAgICAgICAgbGVhZi5jb250YWluZXJFbC50b2dnbGVDbGFzcyhcImhhcy1wYW5lLXJlbGllZi1sYWJlbFwiLCBjb3VudDw5KTtcbiAgICAgICAgICAgICAgICBsYXN0TGVhZiA9IGxlYWY7XG4gICAgICAgICAgICAgICAgdGhpcy51cGRhdGVMZWFmKGxlYWYpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAoY291bnQ+OCkge1xuICAgICAgICAgICAgICAgIGxhc3RMZWFmPy5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtbGFiZWxcIiwgXCI5XCIpO1xuICAgICAgICAgICAgICAgIGxhc3RMZWFmPy5jb250YWluZXJFbC50b2dnbGVDbGFzcyhcImhhcy1wYW5lLXJlbGllZi1sYWJlbFwiLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICB9XG5cbiAgICBvblVwZGF0ZUhpc3RvcnkobGVhZjogV29ya3NwYWNlTGVhZiwgaGlzdG9yeTogSGlzdG9yeSkge1xuICAgICAgICB0aGlzLnVwZGF0ZUxlYWYobGVhZik7IC8vIHVwZGF0ZSBsZWFmIHN0YXRzXG4gICAgICAgIGlmIChoaXN0b3J5ID09PSB0aGlzLmZvcndhcmQuaGlzdG9yeSkgdGhpcy5mb3J3YXJkLnNldEhpc3RvcnkoaGlzdG9yeSk7ICAvLyB1cGRhdGUgbmF2IGFycm93c1xuICAgICAgICBpZiAoaGlzdG9yeSA9PT0gdGhpcy5iYWNrLmhpc3RvcnkpICAgIHRoaXMuYmFjay5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgIH1cbn1cblxuZXhwb3J0IGNsYXNzIE5hdmlnYXRvciBleHRlbmRzIENvbXBvbmVudCB7XG5cbiAgICBzdGF0aWMgaG92ZXJTb3VyY2UgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktbWVudVwiO1xuXG4gICAgY29udGFpbmVyRWw6IEhUTUxFbGVtZW50XG4gICAgY291bnQ6IEhUTUxTcGFuRWxlbWVudFxuICAgIGhpc3Rvcnk6IEhpc3RvcnkgPSBudWxsO1xuICAgIHN0YXRlczogSGlzdG9yeUVudHJ5W107XG4gICAgb2xkTGFiZWw6IHN0cmluZ1xuXG4gICAgY29uc3RydWN0b3IocHVibGljIG93bmVyOiBOYXZpZ2F0aW9uLCBwdWJsaWMga2luZDogJ2ZvcndhcmQnfCdiYWNrJywgcHVibGljIGRpcjogbnVtYmVyKSAge1xuICAgICAgICBzdXBlcigpO1xuICAgIH1cblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgdGhpcy5jb250YWluZXJFbCA9IHRoaXMub3duZXIud2luLmRvY3VtZW50LmJvZHkuZmluZChcbiAgICAgICAgICAgIGAudGl0bGViYXIgLnRpdGxlYmFyLWJ1dHRvbi1jb250YWluZXIubW9kLWxlZnQgLnRpdGxlYmFyLWJ1dHRvbi5tb2QtJHt0aGlzLmtpbmR9YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvdW50ID0gdGhpcy5jb250YWluZXJFbC5jcmVhdGVTcGFuKHtwcmVwZW5kOiB0aGlzLmtpbmQgPT09IFwiYmFja1wiLCBjbHM6IFwiaGlzdG9yeS1jb3VudGVyXCJ9KTtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gbnVsbDtcbiAgICAgICAgdGhpcy5zdGF0ZXMgPSBbXTtcbiAgICAgICAgdGhpcy5vbGRMYWJlbCA9IHRoaXMuY29udGFpbmVyRWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckRvbUV2ZW50KHRoaXMuY29udGFpbmVyRWwsIFwiY29udGV4dG1lbnVcIiwgdGhpcy5vcGVuTWVudS5iaW5kKHRoaXMpKTtcbiAgICAgICAgY29uc3Qgb25DbGljayA9IChlOiBNb3VzZUV2ZW50KSA9PiB7XG4gICAgICAgICAgICAvLyBEb24ndCBhbGxvdyBPYnNpZGlhbiB0byBzd2l0Y2ggd2luZG93IG9yIGZvcndhcmQgdGhlIGV2ZW50XG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAvLyBEbyB0aGUgbmF2aWdhdGlvblxuICAgICAgICAgICAgdGhpcy5oaXN0b3J5Py5bdGhpcy5raW5kXSgpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoKCkgPT4gdGhpcy5jb250YWluZXJFbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25DbGljaywgdHJ1ZSkpO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkNsaWNrLCB0cnVlKTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHRoaXMub2xkTGFiZWwpO1xuICAgICAgICB0aGlzLmNvdW50LmRldGFjaCgpO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc2V0Q291bnQobnVtOiBudW1iZXIpIHsgdGhpcy5jb3VudC50ZXh0Q29udGVudCA9IFwiXCIgKyAobnVtIHx8IFwiXCIpOyB9XG5cbiAgICBzZXRUb29sdGlwKHRleHQ6IHN0cmluZykge1xuICAgICAgICBpZiAodGV4dCkgdGhpcy5jb250YWluZXJFbC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIHRleHQgfHwgdW5kZWZpbmVkKTtcbiAgICAgICAgZWxzZSB0aGlzLmNvbnRhaW5lckVsLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIik7XG4gICAgfVxuXG4gICAgc2V0SGlzdG9yeShoaXN0b3J5ID0gSGlzdG9yeS5jdXJyZW50KCkpIHtcbiAgICAgICAgdGhpcy5oaXN0b3J5ID0gaGlzdG9yeTtcbiAgICAgICAgY29uc3Qgc3RhdGVzID0gdGhpcy5zdGF0ZXMgPSBoaXN0b3J5W3RoaXMuZGlyIDwgMCA/IFwibG9va0JlaGluZFwiIDogXCJsb29rQWhlYWRcIl0uY2FsbChoaXN0b3J5KTtcbiAgICAgICAgdGhpcy5zZXRDb3VudChzdGF0ZXMubGVuZ3RoKTtcbiAgICAgICAgdGhpcy5zZXRUb29sdGlwKHN0YXRlcy5sZW5ndGggP1xuICAgICAgICAgICAgdGhpcy5vbGRMYWJlbCArIFwiXFxuXCIgKyB0aGlzLmZvcm1hdFN0YXRlKHN0YXRlc1swXSkudGl0bGUgOlxuICAgICAgICAgICAgYE5vICR7dGhpcy5raW5kfSBoaXN0b3J5YFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBzdGF0ZXMubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgb3Blbk1lbnUoZXZ0OiB7Y2xpZW50WDogbnVtYmVyLCBjbGllbnRZOiBudW1iZXJ9KSB7XG4gICAgICAgIGlmICghdGhpcy5zdGF0ZXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudSgpO1xuICAgICAgICBtZW51LmRvbS5hZGRDbGFzcyhcInBhbmUtcmVsaWVmLWhpc3RvcnktbWVudVwiKTtcbiAgICAgICAgbWVudS5kb20ub24oXCJtb3VzZWRvd25cIiwgXCIubWVudS1pdGVtXCIsIGUgPT4ge2Uuc3RvcFByb3BhZ2F0aW9uKCk7fSwgdHJ1ZSk7XG4gICAgICAgIHRoaXMuc3RhdGVzLm1hcCh0aGlzLmZvcm1hdFN0YXRlLmJpbmQodGhpcykpLmZvckVhY2goXG4gICAgICAgICAgICAoaW5mbzogRmlsZUluZm8sIGlkeCkgPT4gdGhpcy5tZW51SXRlbShpbmZvLCBpZHgsIG1lbnUpXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGV2dC5jbGllbnRYLCB5OiBldnQuY2xpZW50WSArIDIwfSk7XG4gICAgICAgIHRoaXMub3duZXIuaGlzdG9yeUlzT3BlbiA9IHRydWU7XG4gICAgICAgIG1lbnUub25IaWRlKCgpID0+IHsgdGhpcy5vd25lci5oaXN0b3J5SXNPcGVuID0gZmFsc2U7IHRoaXMub3duZXIuZGlzcGxheSgpOyB9KTtcbiAgICB9XG5cbiAgICBtZW51SXRlbShpbmZvOiBGaWxlSW5mbywgaWR4OiBudW1iZXIsIG1lbnU6IE1lbnUpIHtcbiAgICAgICAgY29uc3QgbXkgPSB0aGlzO1xuICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiB7IGNyZWF0ZUl0ZW0oaSk7IGlmIChpbmZvLmZpbGUpIHNldHVwRmlsZUV2ZW50cyhpLmRvbSk7IH0pO1xuICAgICAgICByZXR1cm47XG5cbiAgICAgICAgZnVuY3Rpb24gY3JlYXRlSXRlbShpOiBNZW51SXRlbSwgcHJlZml4PVwiXCIpIHtcbiAgICAgICAgICAgIGkuc2V0SWNvbihpbmZvLmljb24pLnNldFRpdGxlKHByZWZpeCArIGluZm8udGl0bGUpLm9uQ2xpY2soZSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGhpc3RvcnkgPSBteS5oaXN0b3J5O1xuICAgICAgICAgICAgICAgIC8vIENoZWNrIGZvciBjdHJsL2NtZC9taWRkbGUgYnV0dG9uIGFuZCBzcGxpdCBsZWFmICsgY29weSBoaXN0b3J5XG4gICAgICAgICAgICAgICAgaWYgKEtleW1hcC5pc01vZGlmaWVyKGUsIFwiTW9kXCIpIHx8IDEgPT09IChlIGFzIE1vdXNlRXZlbnQpLmJ1dHRvbikge1xuICAgICAgICAgICAgICAgICAgICBoaXN0b3J5ID0gaGlzdG9yeS5jbG9uZVRvKGFwcC53b3Jrc3BhY2Uuc3BsaXRBY3RpdmVMZWFmKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBoaXN0b3J5LmdvKChpZHgrMSkgKiBteS5kaXIsIHRydWUpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXR1cEZpbGVFdmVudHMoZG9tOiBIVE1MRWxlbWVudCkge1xuICAgICAgICAgICAgLy8gSG92ZXIgcHJldmlld1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlb3ZlcicsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGFwcC53b3Jrc3BhY2UudHJpZ2dlcignaG92ZXItbGluaycsIHtcbiAgICAgICAgICAgICAgICAgICAgZXZlbnQ6IGUsIHNvdXJjZTogTmF2aWdhdG9yLmhvdmVyU291cmNlLFxuICAgICAgICAgICAgICAgICAgICBob3ZlclBhcmVudDogbWVudS5kb20sIHRhcmdldEVsOiBkb20sIGxpbmt0ZXh0OiBpbmZvLmZpbGUucGF0aFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIERyYWcgbWVudSBpdGVtIHRvIG1vdmUgb3IgbGluayBmaWxlXG4gICAgICAgICAgICBkb20uc2V0QXR0cignZHJhZ2dhYmxlJywgJ3RydWUnKTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBkcmFnTWFuYWdlciA9IGFwcC5kcmFnTWFuYWdlcjtcbiAgICAgICAgICAgICAgICBjb25zdCBkcmFnRGF0YSA9IGRyYWdNYW5hZ2VyLmRyYWdGaWxlKGUsIGluZm8uZmlsZSk7XG4gICAgICAgICAgICAgICAgZHJhZ01hbmFnZXIub25EcmFnU3RhcnQoZSwgZHJhZ0RhdGEpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsIGUgPT4gbWVudS5oaWRlKCkpO1xuXG4gICAgICAgICAgICAvLyBGaWxlIG1lbnVcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKFwiY29udGV4dG1lbnVcIiwgZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgICAgICAgICAgbWVudS5hZGRJdGVtKGkgPT4gY3JlYXRlSXRlbShpLCBgR28gJHtteS5raW5kfSB0byBgKSkuYWRkU2VwYXJhdG9yKCk7XG4gICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS50cmlnZ2VyKFxuICAgICAgICAgICAgICAgICAgICBcImZpbGUtbWVudVwiLCBtZW51LCBpbmZvLmZpbGUsIFwibGluay1jb250ZXh0LW1lbnVcIlxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgbWVudS5zaG93QXRQb3NpdGlvbih7eDogZS5jbGllbnRYLCB5OiBlLmNsaWVudFl9KTtcbiAgICAgICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOyAvLyBrZWVwIHRoZSBwYXJlbnQgbWVudSBvcGVuIGZvciBub3dcbiAgICAgICAgICAgIH0sIHRydWUpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZm9ybWF0U3RhdGUoZW50cnk6IEhpc3RvcnlFbnRyeSk6IEZpbGVJbmZvIHtcbiAgICAgICAgY29uc3Qge3ZpZXdTdGF0ZToge3R5cGUsIHN0YXRlfSwgZVN0YXRlLCBwYXRofSA9IGVudHJ5O1xuICAgICAgICBjb25zdCBmaWxlID0gcGF0aCAmJiBhcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpIGFzIFRGaWxlO1xuICAgICAgICBjb25zdCBpbmZvID0ge2ljb246IFwiXCIsIHRpdGxlOiBcIlwiLCBmaWxlLCB0eXBlLCBzdGF0ZSwgZVN0YXRlfTtcblxuICAgICAgICBpZiAobm9uRmlsZVZpZXdzW3R5cGVdKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IG5vbkZpbGVWaWV3c1t0eXBlXTtcbiAgICAgICAgfSBlbHNlIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IFtcInRyYXNoXCIsIFwiTWlzc2luZyBmaWxlIFwiK3BhdGhdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xuICAgICAgICAgICAgaW5mby5pY29uID0gdmlld3R5cGVJY29uc1t0eXBlXSA/PyBcImRvY3VtZW50XCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtYXJrZG93blwiICYmIHN0YXRlLm1vZGUgPT09IFwicHJldmlld1wiKSBpbmZvLmljb24gPSBcImxpbmVzLW9mLXRleHRcIjtcbiAgICAgICAgICAgIGluZm8udGl0bGUgPSBmaWxlID8gZmlsZS5iYXNlbmFtZSArIChmaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiID8gXCIuXCIrZmlsZS5leHRlbnNpb24gOiBcIlwiKSA6IFwiTm8gZmlsZVwiO1xuICAgICAgICAgICAgaWYgKHR5cGUgPT09IFwibWVkaWEtdmlld1wiICYmICFmaWxlKSBpbmZvLnRpdGxlID0gc3RhdGUuaW5mbz8uZmlsZW5hbWUgPz8gaW5mby50aXRsZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFwcC53b3Jrc3BhY2UudHJpZ2dlcihcInBhbmUtcmVsaWVmOmZvcm1hdC1oaXN0b3J5LWl0ZW1cIiwgaW5mbyk7XG4gICAgICAgIHJldHVybiBpbmZvO1xuICAgIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uRWxlbWVudDxLIGV4dGVuZHMga2V5b2YgSFRNTEVsZW1lbnRFdmVudE1hcD4oXG4gICAgZWw6IEhUTUxFbGVtZW50LFxuICAgIGV2ZW50OiBLLFxuICAgIHNlbGVjdG9yOiBzdHJpbmcsXG4gICAgY2FsbGJhY2s6ICh0aGlzOiBIVE1MRWxlbWVudCwgZXY6IEhUTUxFbGVtZW50RXZlbnRNYXBbS10sIGRlbGVnYXRlVGFyZ2V0OiBIVE1MRWxlbWVudCkgPT4gYW55LFxuICAgIG9wdGlvbnM/OiBib29sZWFuIHwgQWRkRXZlbnRMaXN0ZW5lck9wdGlvbnNcbikge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn0iLCJpbXBvcnQge1BsdWdpbiwgVEZpbGUsIFdvcmtzcGFjZUxlYWYsIFdvcmtzcGFjZVNwbGl0LCBXb3Jrc3BhY2VUYWJzfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2FkZENvbW1hbmRzLCBjb21tYW5kfSBmcm9tIFwiLi9jb21tYW5kc1wiO1xuaW1wb3J0IHtIaXN0b3J5LCBpbnN0YWxsSGlzdG9yeX0gZnJvbSBcIi4vSGlzdG9yeVwiO1xuaW1wb3J0IHtOYXZpZ2F0aW9uLCBOYXZpZ2F0b3IsIG9uRWxlbWVudH0gZnJvbSBcIi4vTmF2aWdhdG9yXCI7XG5pbXBvcnQge1dpbmRvd01hbmFnZXJ9IGZyb20gJy4vUGVyV2luZG93Q29tcG9uZW50JztcblxuZGVjbGFyZSBtb2R1bGUgXCJvYnNpZGlhblwiIHtcbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlIHtcbiAgICAgICAgb24odHlwZTogXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCBjYWxsYmFjazogKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGhpc3Rvcnk6IEhpc3RvcnkpID0+IGFueSwgY3R4PzogYW55KTogRXZlbnRSZWY7XG4gICAgICAgIHJlZ2lzdGVySG92ZXJMaW5rU291cmNlKHNvdXJjZTogc3RyaW5nLCBpbmZvOiB7ZGlzcGxheTogc3RyaW5nLCBkZWZhdWx0TW9kPzogYm9vbGVhbn0pOiB2b2lkXG4gICAgICAgIHVucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2Uoc291cmNlOiBzdHJpbmcpOiB2b2lkXG4gICAgICAgIGl0ZXJhdGVMZWF2ZXMoY2FsbGJhY2s6IChpdGVtOiBXb3Jrc3BhY2VMZWFmKSA9PiB1bmtub3duLCBpdGVtOiBXb3Jrc3BhY2VQYXJlbnQpOiBib29sZWFuO1xuICAgICAgICBvbkxheW91dENoYW5nZSgpOiB2b2lkXG4gICAgfVxuICAgIGludGVyZmFjZSBBcHAge1xuICAgICAgICBwbHVnaW5zOiB7XG4gICAgICAgICAgICBwbHVnaW5zOiB7XG4gICAgICAgICAgICAgICAgXCJvYnNpZGlhbi1ob3Zlci1lZGl0b3JcIjoge1xuICAgICAgICAgICAgICAgICAgICBhY3RpdmVQb3BvdmVyczogSG92ZXJQb3BvdmVyW11cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUl0ZW0ge1xuICAgICAgICBjb250YWluZXJFbDogSFRNTERpdkVsZW1lbnRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZVBhcmVudCB7XG4gICAgICAgIGNoaWxkcmVuOiBXb3Jrc3BhY2VJdGVtW11cbiAgICAgICAgcmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZVRhYnMgZXh0ZW5kcyBXb3Jrc3BhY2VQYXJlbnQge1xuICAgICAgICBzZWxlY3RUYWIobGVhZjogV29ya3NwYWNlTGVhZik6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBwYXJlbnRTcGxpdDogV29ya3NwYWNlUGFyZW50XG4gICAgfVxuICAgIGludGVyZmFjZSBIb3ZlclBvcG92ZXIge1xuICAgICAgICBsZWFmPzogV29ya3NwYWNlTGVhZlxuICAgICAgICByb290U3BsaXQ/OiBXb3Jrc3BhY2VTcGxpdFxuICAgICAgICBob3ZlckVsOiBIVE1MRWxlbWVudFxuICAgIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGFuZVJlbGllZiBleHRlbmRzIFBsdWdpbiB7XG5cbiAgICBuYXYgPSBuZXcgV2luZG93TWFuYWdlcih0aGlzLCBOYXZpZ2F0aW9uKS53YXRjaCgpO1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBpbnN0YWxsSGlzdG9yeSh0aGlzKTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKE5hdmlnYXRvci5ob3ZlclNvdXJjZSwge1xuICAgICAgICAgICAgZGlzcGxheTogJ0hpc3RvcnkgZHJvcGRvd25zJywgZGVmYXVsdE1vZDogdHJ1ZVxuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKFwicmVuYW1lXCIsIChmaWxlLCBvbGRQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMoXG4gICAgICAgICAgICAgICAgICAgIGxlYWYgPT4gSGlzdG9yeS5mb3JMZWFmKGxlYWYpLm9uUmVuYW1lKGZpbGUsIG9sZFBhdGgpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgICAgICAgICAgICBhcHAud29ya3NwYWNlLm9uKFwiYWN0aXZlLWxlYWYtY2hhbmdlXCIsIGxlYWYgPT4gdGhpcy5uYXYuZm9yTGVhZihsZWFmKS5kaXNwbGF5KGxlYWYpKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgICAgICAgICAgICBhcHAud29ya3NwYWNlLm9uKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgKGxlYWYsIGhpc3RvcnkpID0+IHRoaXMubmF2LmZvckxlYWYobGVhZikub25VcGRhdGVIaXN0b3J5KGxlYWYsIGhpc3RvcnkpKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYWRkQ29tbWFuZHModGhpcywge1xuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLXByZXZcIiwgXCJTd2FwIHBhbmUgd2l0aCBwcmV2aW91cyBpbiBzcGxpdFwiLCAgXCJNb2QrU2hpZnQrUGFnZVVwXCIpXSAgICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKC0xKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1uZXh0XCIsIFwiU3dhcCBwYW5lIHdpdGggbmV4dCBpbiBzcGxpdFwiLCAgICAgIFwiTW9kK1NoaWZ0K1BhZ2VEb3duXCIpXSAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlciggMSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tcHJldlwiLCAgXCJDeWNsZSB0byBwcmV2aW91cyB3b3Jrc3BhY2UgcGFuZVwiLCAgIFwiTW9kK1BhZ2VVcFwiICApXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKC0xLCB0cnVlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbmV4dFwiLCAgXCJDeWNsZSB0byBuZXh0IHdvcmtzcGFjZSBwYW5lXCIsICAgICAgIFwiTW9kK1BhZ2VEb3duXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKCAxLCB0cnVlKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tcHJldlwiLCBcIkN5Y2xlIHRvIHByZXZpb3VzIHdpbmRvd1wiLCBbXSApXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdygtMSwgdHJ1ZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi1uZXh0XCIsIFwiQ3ljbGUgdG8gbmV4dCB3aW5kb3dcIiwgICAgIFtdICldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KCAxLCB0cnVlKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0xc3RcIiwgICBcIkp1bXAgdG8gMXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigwKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMm5kXCIsICAgXCJKdW1wIHRvIDJuZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTNyZFwiLCAgIFwiSnVtcCB0byAzcmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDIpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby00dGhcIiwgICBcIkp1bXAgdG8gNHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigzKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNXRoXCIsICAgXCJKdW1wIHRvIDV0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTZ0aFwiLCAgIFwiSnVtcCB0byA2dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby03dGhcIiwgICBcIkp1bXAgdG8gN3RoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig2KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tOHRoXCIsICAgXCJKdW1wIHRvIDh0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLWxhc3RcIiwgIFwiSnVtcCB0byBsYXN0IHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCBcIkFsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDk5OTk5OTk5KTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tMXN0XCIsICAgXCJTd2l0Y2ggdG8gMXN0IHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdygwKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTJuZFwiLCAgIFwiU3dpdGNoIHRvIDJuZCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi0zcmRcIiwgICBcIlN3aXRjaCB0byAzcmQgd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDIpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tNHRoXCIsICAgXCJTd2l0Y2ggdG8gNHRoIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdygzKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTV0aFwiLCAgIFwiU3dpdGNoIHRvIDV0aCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coNCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi02dGhcIiwgICBcIlN3aXRjaCB0byA2dGggd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tN3RoXCIsICAgXCJTd2l0Y2ggdG8gN3RoIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdyg2KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTh0aFwiLCAgIFwiU3dpdGNoIHRvIDh0aCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coNyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi1sYXN0XCIsICBcIlN3aXRjaCB0byBsYXN0IHdpbmRvd1wiLCBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDk5OTk5OTk5KTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMXN0XCIsICBcIlBsYWNlIGFzIDFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDAsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTJuZFwiLCAgXCJQbGFjZSBhcyAybmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigxLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0zcmRcIiwgIFwiUGxhY2UgYXMgM3JkIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNHRoXCIsICBcIlBsYWNlIGFzIDR0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDMsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTV0aFwiLCAgXCJQbGFjZSBhcyA1dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig0LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC02dGhcIiwgIFwiUGxhY2UgYXMgNnRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtN3RoXCIsICBcIlBsYWNlIGFzIDd0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDYsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTh0aFwiLCAgXCJQbGFjZSBhcyA4dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig3LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC1sYXN0XCIsIFwiUGxhY2UgYXMgbGFzdCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICBcIk1vZCtBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoOTk5OTk5OTksIGZhbHNlKTsgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnVucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlKTtcbiAgICB9XG5cbiAgICBnb3RvTnRoTGVhZihuOiBudW1iZXIsIHJlbGF0aXZlOiBib29sZWFuKSB7XG4gICAgICAgIGNvbnN0IG5hdiA9IHRoaXMubmF2LmZvckxlYWYoYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKTtcbiAgICAgICAgY29uc3QgbGVhZiA9IGdvdG9OdGgobmF2LmxlYXZlcygpLCB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZiwgbiwgcmVsYXRpdmUpO1xuICAgICAgICAhbGVhZiB8fCB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCB0cnVlLCB0cnVlKTtcbiAgICB9XG5cbiAgICBnb3RvTnRoV2luZG93KG46IG51bWJlciwgcmVsYXRpdmU6IGJvb2xlYW4pIHtcbiAgICAgICAgY29uc3QgbmF2ID0gZ290b050aCh0aGlzLm5hdi5mb3JBbGwoKSwgdGhpcy5uYXYuZm9yTGVhZihhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpLCBuLCByZWxhdGl2ZSk7XG4gICAgICAgIGNvbnN0IGxlYWYgPSBuYXY/LmxhdGVzdExlYWYoKTtcbiAgICAgICAgaWYgKGxlYWYpIGFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCB0cnVlLCB0cnVlKTtcbiAgICAgICAgKG5hdj8ud2luIGFzIGFueSkucmVxdWlyZT8uKCdlbGVjdHJvbicpPy5yZW1vdGU/LmdldEN1cnJlbnRXaW5kb3coKT8uZm9jdXMoKTtcbiAgICB9XG5cbiAgICBwbGFjZUxlYWYodG9Qb3M6IG51bWJlciwgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBjYiA9IHRoaXMubGVhZlBsYWNlcih0b1BvcywgcmVsYXRpdmUpO1xuICAgICAgICBpZiAoY2IpIGNiKCk7XG4gICAgfVxuXG4gICAgbGVhZlBsYWNlcih0b1BvczogbnVtYmVyLCByZWxhdGl2ZT10cnVlKSB7XG4gICAgICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgY29uc3RcbiAgICAgICAgICAgIHBhcmVudFNwbGl0ID0gbGVhZi5wYXJlbnRTcGxpdCxcbiAgICAgICAgICAgIGNoaWxkcmVuID0gcGFyZW50U3BsaXQuY2hpbGRyZW4sXG4gICAgICAgICAgICBmcm9tUG9zID0gY2hpbGRyZW4uaW5kZXhPZihsZWFmKVxuICAgICAgICA7XG4gICAgICAgIGlmIChmcm9tUG9zID09IC0xKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgaWYgKHJlbGF0aXZlKSB7XG4gICAgICAgICAgICB0b1BvcyArPSBmcm9tUG9zO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCB8fCB0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0b1BvcyA+PSBjaGlsZHJlbi5sZW5ndGgpIHRvUG9zID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDApIHRvUG9zID0gMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmcm9tUG9zID09IHRvUG9zKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG90aGVyID0gY2hpbGRyZW5bdG9Qb3NdO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKGZyb21Qb3MsIDEpO1xuICAgICAgICAgICAgY2hpbGRyZW4uc3BsaWNlKHRvUG9zLCAgIDAsIGxlYWYpO1xuICAgICAgICAgICAgaWYgKChwYXJlbnRTcGxpdCBhcyBXb3Jrc3BhY2VUYWJzKS5zZWxlY3RUYWIpIHtcbiAgICAgICAgICAgICAgICAocGFyZW50U3BsaXQgYXMgV29ya3NwYWNlVGFicykuc2VsZWN0VGFiKGxlYWYpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvdGhlci5jb250YWluZXJFbC5pbnNlcnRBZGphY2VudEVsZW1lbnQoZnJvbVBvcyA+IHRvUG9zID8gXCJiZWZvcmViZWdpblwiIDogXCJhZnRlcmVuZFwiLCBsZWFmLmNvbnRhaW5lckVsKTtcbiAgICAgICAgICAgICAgICBwYXJlbnRTcGxpdC5yZWNvbXB1dGVDaGlsZHJlbkRpbWVuc2lvbnMoKTtcbiAgICAgICAgICAgICAgICBsZWFmLm9uUmVzaXplKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uTGF5b3V0Q2hhbmdlKCk7XG5cbiAgICAgICAgICAgICAgICAvLyBGb3JjZSBmb2N1cyBiYWNrIHRvIHBhbmU7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5zZXRBY3RpdmVMZWFmKGxlYWYsIGZhbHNlLCB0cnVlKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG5mdW5jdGlvbiBnb3RvTnRoPFQ+KGl0ZW1zOiBUW10sIGN1cnJlbnQ6IFQsIG46IG51bWJlciwgcmVsYXRpdmU6IGJvb2xlYW4pOiBUIHtcbiAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgbiArPSBpdGVtcy5pbmRleE9mKGN1cnJlbnQpO1xuICAgICAgICBuID0gKG4gKyBpdGVtcy5sZW5ndGgpICUgaXRlbXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICB9XG4gICAgcmV0dXJuIGl0ZW1zW24gPj0gaXRlbXMubGVuZ3RoID8gaXRlbXMubGVuZ3RoLTEgOiBuXTtcbn0iXSwibmFtZXMiOlsiTm90aWNlIiwiV29ya3NwYWNlTGVh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aEosWUFBQSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUksc0JBQXNCLEVBQUcsRUFBRSxDQUFDLENBQUMsS0FBTSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFLFFBQVEsQ0FBQyxNQUFNO2dCQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDaEosWUFBQSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUksc0JBQXNCLEVBQUcsRUFBRSxDQUFDLENBQUMsS0FBTSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFLFFBQVEsQ0FBQyxNQUFNO2dCQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDaEosWUFBQSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUksc0JBQXNCLEVBQUcsRUFBRSxDQUFDLENBQUMsS0FBTSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFLFFBQVEsQ0FBQyxNQUFNO2dCQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDaEosWUFBQSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUksc0JBQXNCLEVBQUcsRUFBRSxDQUFDLENBQUMsS0FBTSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFLFFBQVEsQ0FBQyxNQUFNO2dCQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDaEosWUFBQSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUksc0JBQXNCLEVBQUcsRUFBRSxDQUFDLENBQUMsS0FBTSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFLFFBQVEsQ0FBQyxNQUFNO2dCQUFFLE9BQU8sTUFBTSxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFDaEosWUFBQSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVB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
