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
    // Proxy the window history with a wrapper that delegates to the active leaf's History object,
    const realHistory = window.history;
    plugin.register(() => window.history = realHistory);
    Object.defineProperty(window, "history", { enumerable: true, configurable: true, writable: true, value: {
            get state() { return History.current().state; },
            get length() { return History.current().length; },
            back() { if (!plugin.isSyntheticHistoryEvent(3))
                this.go(-1); },
            forward() { if (!plugin.isSyntheticHistoryEvent(4))
                this.go(1); },
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
    constructor(plugin, win) {
        super();
        this.plugin = plugin;
        this.win = win;
    }
    get root() {
        return containerForWindow(this.win);
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
            inst = new this.factory(this.plugin, win);
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
        return this.forLeaf(view.leaf, create);
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
        this.win.requestAnimationFrame(() => {
            const history = leaf ? History.forLeaf(leaf) : new History();
            this.back.setHistory(history);
            this.forward.setHistory(history);
            this.updateLeaf(leaf, history);
        });
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
        return this.leaves().reduce((best, leaf) => { return (!best || best.activeTime < leaf.activeTime) ? leaf : best; }, null);
    }
    onload() {
        // Override default mouse history behavior.  We need this because 1) Electron will use the built-in
        // history object if we don't (instead of our wrapper), and 2) we want the click to apply to the leaf
        // that was under the mouse, rather than whichever leaf was active.
        const { document } = this.win;
        document.addEventListener("mouseup", historyHandler, true);
        document.addEventListener("mousedown", historyHandler, true);
        this.register(() => {
            document.removeEventListener("mouseup", historyHandler, true);
            document.removeEventListener("mousedown", historyHandler, true);
        });
        function historyHandler(e) {
            if (e.button !== 3 && e.button !== 4)
                return;
            debugger;
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
        this.win.document.body.findAll(".workspace-leaf").forEach(leafEl => {
            // Restore CPHATB button labels
            const actions = leafEl.find(".view-header > .view-actions");
            const fwd = actions?.find('.view-action[class*=" app:go-forward"]');
            const back = actions?.find('.view-action[class*=" app:go-back"]');
            if (fwd)
                setTooltip(fwd, this.forward.oldLabel);
            if (back)
                setTooltip(fwd, this.back.oldLabel);
        });
    }
    unNumberPanes(selector = ".workspace-leaf") {
        this.win.document.body.findAll(selector).forEach(el => {
            el.style.removeProperty("--pane-relief-label");
            el.toggleClass("has-pane-relief-label", false);
            el.style.removeProperty("--pane-relief-forward-count");
            el.style.removeProperty("--pane-relief-backward-count");
        });
    }
    updateLeaf(leaf, history = History.forLeaf(leaf)) {
        leaf.containerEl.style.setProperty("--pane-relief-forward-count", '"' + (history.lookAhead().length || "") + '"');
        leaf.containerEl.style.setProperty("--pane-relief-backward-count", '"' + (history.lookBehind().length || "") + '"');
        // Add labels for CPHATB nav buttons
        const actions = leaf.containerEl.find(".view-header > .view-actions");
        const fwd = actions?.find('.view-action[class*=" app:go-forward"]');
        const back = actions?.find('.view-action[class*=" app:go-back"]');
        if (fwd)
            this.forward.updateDisplay(history, fwd);
        if (back)
            this.back.updateDisplay(history, back);
    }
    numberPanes() {
        this.win.requestAnimationFrame(() => {
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
        this.win.requestAnimationFrame(() => {
            this.updateLeaf(leaf); // update leaf's stats and buttons
            // update window's nav arrows
            if (history === this.forward.history)
                this.forward.setHistory(history);
            if (history === this.back.history)
                this.back.setHistory(history);
        });
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
        setTooltip(this.containerEl, this.oldLabel);
        this.count.detach();
        this.containerEl.toggleClass("mod-active", false);
    }
    setCount(num) { this.count.textContent = "" + (num || ""); }
    setHistory(history = History.current()) {
        this.updateDisplay(this.history = history);
    }
    updateDisplay(history, el = this.containerEl) {
        const states = this.states = history[this.dir < 0 ? "lookBehind" : "lookAhead"]();
        if (el === this.containerEl)
            this.setCount(states.length);
        setTooltip(el, states.length ?
            this.oldLabel + "\n" + this.formatState(states[0]).title :
            `No ${this.kind} history`);
        el.toggleClass("mod-active", states.length > 0);
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
function setTooltip(el, text) {
    if (text)
        el.setAttribute("aria-label", text || undefined);
    else
        el.removeAttribute("aria-label");
}

class PaneRelief extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.nav = Navigation.perWindow(this).watch();
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
    isSyntheticHistoryEvent(button) {
        const win = this.nav.windows().filter(win => win.event && win.event.button === button).pop();
        if (win && win.event.type === "mousedown") {
            win.event.preventDefault();
            win.event.stopImmediatePropagation();
            return true;
        }
        return false;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLnRzIiwibm9kZV9tb2R1bGVzLy5wbnBtL21vbmtleS1hcm91bmRAMi4zLjAvbm9kZV9tb2R1bGVzL21vbmtleS1hcm91bmQvbWpzL2luZGV4LmpzIiwic3JjL0hpc3RvcnkudHMiLCJzcmMvUGVyV2luZG93Q29tcG9uZW50LnRzIiwic3JjL05hdmlnYXRvci50cyIsInNyYy9wYW5lLXJlbGllZi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBTaW1wbGlmaWVkIENvbW1hbmRzIEZyYW1ld29ya1xuXG5pbXBvcnQge0NvbW1hbmQsIEhvdGtleSwgTW9kaWZpZXIsIFBsdWdpbn0gZnJvbSBcIm9ic2lkaWFuXCJcblxudHlwZSBLZXlEZWYgPSBIb3RrZXkgfCBzdHJpbmdcblxuY29uc3QgY29tbWFuZHM6IFJlY29yZDxzeW1ib2wsIENvbW1hbmQ+ID0ge307IC8vbmV3IE1hcDtcblxuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmQoaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCBob3RrZXlzOiBLZXlEZWYgfCBLZXlEZWZbXSA9IFtdLCBjbWQ9e30pIHtcblxuICAgIC8vIEFsbG93IGhvdGtleXMgdG8gYmUgZXhwcmVzc2VkIGFzIGEgc3RyaW5nLCBhcnJheSBvZiBzdHJpbmdzLFxuICAgIC8vIG9iamVjdCwgb3IgYXJyYXkgb2Ygb2JqZWN0cy4gIChOb3JtYWxpemUgdG8gYW4gYXJyYXkgZmlyc3QuKVxuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJzdHJpbmdcIikgaG90a2V5cyA9IFtob3RrZXlzXTtcbiAgICBpZiAodHlwZW9mIGhvdGtleXMgPT09IFwib2JqZWN0XCIgJiYgKGhvdGtleXMgYXMgSG90a2V5KS5rZXkpIGhvdGtleXMgPSBbaG90a2V5cyBhcyBIb3RrZXldO1xuXG4gICAgbGV0IGtleXM6IEhvdGtleVtdID0gKGhvdGtleXMgYXMgS2V5RGVmW10pLm1hcChmdW5jdGlvbihrZXkpOiBIb3RrZXkge1xuICAgICAgICAvLyBJZiBhIGhvdGtleSBpcyBhbiBvYmplY3QgYWxyZWFkeSwgbm8gbmVlZCB0byBwcm9jZXNzIGl0XG4gICAgICAgIGlmICh0eXBlb2Yga2V5ID09PSBcIm9iamVjdFwiKSByZXR1cm4ga2V5O1xuICAgICAgICAvLyBDb252ZXJ0IHN0cmluZ3MgdG8gT2JzaWRpYW4ncyBob3RrZXkgZm9ybWF0XG4gICAgICAgIGxldCBwYXJ0cyA9IGtleS5zcGxpdChcIitcIilcbiAgICAgICAgcmV0dXJuIHsgbW9kaWZpZXJzOiBwYXJ0cyBhcyBNb2RpZmllcltdLCBrZXk6IHBhcnRzLnBvcCgpIHx8IFwiK1wiIH0gIC8vIGVtcHR5IGxhc3QgcGFydCA9IGUuZy4gJ01vZCsrJ1xuICAgIH0pO1xuICAgIE9iamVjdC5hc3NpZ24oY21kLCB7aWQsIG5hbWUsIGhvdGtleXM6IGtleXN9KTtcblxuICAgIC8vIFNhdmUgdGhlIGNvbW1hbmQgZGF0YSB1bmRlciBhIHVuaXF1ZSBzeW1ib2xcbiAgICBjb25zdCBzeW0gPSBTeW1ib2woXCJjbWQ6XCIgKyBpZCk7XG4gICAgY29tbWFuZHNbc3ltXSA9IGNtZCBhcyBDb21tYW5kO1xuICAgIHJldHVybiBzeW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRDb21tYW5kczxQIGV4dGVuZHMgUGx1Z2luPihcbiAgICBwbHVnaW46IFAsXG4gICAgY21kc2V0OiBSZWNvcmQ8c3ltYm9sLCAodGhpc0FyZzogUCkgPT4gYm9vbGVhbiB8ICgoKSA9PiBhbnkpPlxuKSB7XG4gICAgLy8gRXh0cmFjdCBjb21tYW5kIHN5bWJvbHMgZnJvbSBjbWRzZXQgYW5kIHJlZ2lzdGVyIHRoZW0sIGJvdW5kIHRvIHRoZSBwbHVnaW4gZm9yIG1ldGhvZHNcbiAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlTeW1ib2xzKGNtZHNldCkuZm9yRWFjaChzeW0gPT4ge1xuICAgICAgICBjb25zdCBjbWQgPSBjb21tYW5kc1tzeW1dLCBtZXRob2QgPSBjbWRzZXRbc3ltXTtcbiAgICAgICAgaWYgKGNtZCkgcGx1Z2luLmFkZENvbW1hbmQoT2JqZWN0LmFzc2lnbih7fSwgY21kLCB7XG4gICAgICAgICAgICBjaGVja0NhbGxiYWNrKGNoZWNrOiBib29sZWFuKSB7XG4gICAgICAgICAgICAgICAgLy8gQ2FsbCB0aGUgbWV0aG9kIGJvZHkgd2l0aCB0aGUgcGx1Z2luIGFzICd0aGlzJ1xuICAgICAgICAgICAgICAgIGNvbnN0IGNiID0gbWV0aG9kLmNhbGwocGx1Z2luKTtcbiAgICAgICAgICAgICAgICAvLyBJdCB0aGVuIHJldHVybnMgYSBjbG9zdXJlIGlmIHRoZSBjb21tYW5kIGlzIHJlYWR5IHRvIGV4ZWN1dGUsIGFuZFxuICAgICAgICAgICAgICAgIC8vIHdlIGNhbGwgdGhhdCBjbG9zdXJlIHVubGVzcyB0aGlzIGlzIGp1c3QgYSBjaGVjayBmb3IgYXZhaWxhYmlsaXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuIChjaGVjayB8fCB0eXBlb2YgY2IgIT09IFwiZnVuY3Rpb25cIikgPyAhIWNiIDogKGNiKCksIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgfSlcbn0iLCJleHBvcnQgZnVuY3Rpb24gYXJvdW5kKG9iaiwgZmFjdG9yaWVzKSB7XG4gICAgY29uc3QgcmVtb3ZlcnMgPSBPYmplY3Qua2V5cyhmYWN0b3JpZXMpLm1hcChrZXkgPT4gYXJvdW5kMShvYmosIGtleSwgZmFjdG9yaWVzW2tleV0pKTtcbiAgICByZXR1cm4gcmVtb3ZlcnMubGVuZ3RoID09PSAxID8gcmVtb3ZlcnNbMF0gOiBmdW5jdGlvbiAoKSB7IHJlbW92ZXJzLmZvckVhY2gociA9PiByKCkpOyB9O1xufVxuZnVuY3Rpb24gYXJvdW5kMShvYmosIG1ldGhvZCwgY3JlYXRlV3JhcHBlcikge1xuICAgIGNvbnN0IG9yaWdpbmFsID0gb2JqW21ldGhvZF0sIGhhZE93biA9IG9iai5oYXNPd25Qcm9wZXJ0eShtZXRob2QpO1xuICAgIGxldCBjdXJyZW50ID0gY3JlYXRlV3JhcHBlcihvcmlnaW5hbCk7XG4gICAgLy8gTGV0IG91ciB3cmFwcGVyIGluaGVyaXQgc3RhdGljIHByb3BzIGZyb20gdGhlIHdyYXBwaW5nIG1ldGhvZCxcbiAgICAvLyBhbmQgdGhlIHdyYXBwaW5nIG1ldGhvZCwgcHJvcHMgZnJvbSB0aGUgb3JpZ2luYWwgbWV0aG9kXG4gICAgaWYgKG9yaWdpbmFsKVxuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY3VycmVudCwgb3JpZ2luYWwpO1xuICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBjdXJyZW50KTtcbiAgICBvYmpbbWV0aG9kXSA9IHdyYXBwZXI7XG4gICAgLy8gUmV0dXJuIGEgY2FsbGJhY2sgdG8gYWxsb3cgc2FmZSByZW1vdmFsXG4gICAgcmV0dXJuIHJlbW92ZTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgLy8gSWYgd2UgaGF2ZSBiZWVuIGRlYWN0aXZhdGVkIGFuZCBhcmUgbm8gbG9uZ2VyIHdyYXBwZWQsIHJlbW92ZSBvdXJzZWx2ZXNcbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsICYmIG9ialttZXRob2RdID09PSB3cmFwcGVyKVxuICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgIHJldHVybiBjdXJyZW50LmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgICBmdW5jdGlvbiByZW1vdmUoKSB7XG4gICAgICAgIC8vIElmIG5vIG90aGVyIHBhdGNoZXMsIGp1c3QgZG8gYSBkaXJlY3QgcmVtb3ZhbFxuICAgICAgICBpZiAob2JqW21ldGhvZF0gPT09IHdyYXBwZXIpIHtcbiAgICAgICAgICAgIGlmIChoYWRPd24pXG4gICAgICAgICAgICAgICAgb2JqW21ldGhvZF0gPSBvcmlnaW5hbDtcbiAgICAgICAgICAgIGVsc2VcbiAgICAgICAgICAgICAgICBkZWxldGUgb2JqW21ldGhvZF07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGN1cnJlbnQgPT09IG9yaWdpbmFsKVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAvLyBFbHNlIHBhc3MgZnV0dXJlIGNhbGxzIHRocm91Z2gsIGFuZCByZW1vdmUgd3JhcHBlciBmcm9tIHRoZSBwcm90b3R5cGUgY2hhaW5cbiAgICAgICAgY3VycmVudCA9IG9yaWdpbmFsO1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2Yod3JhcHBlciwgb3JpZ2luYWwgfHwgRnVuY3Rpb24pO1xuICAgIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiBkZWR1cGUoa2V5LCBvbGRGbiwgbmV3Rm4pIHtcbiAgICBjaGVja1trZXldID0ga2V5O1xuICAgIHJldHVybiBjaGVjaztcbiAgICBmdW5jdGlvbiBjaGVjayguLi5hcmdzKSB7XG4gICAgICAgIHJldHVybiAob2xkRm5ba2V5XSA9PT0ga2V5ID8gb2xkRm4gOiBuZXdGbikuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtOb3RpY2UsIFRBYnN0cmFjdEZpbGUsIFZpZXdTdGF0ZSwgV29ya3NwYWNlTGVhZn0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5pbXBvcnQgUGFuZVJlbGllZiBmcm9tIFwiLi9wYW5lLXJlbGllZlwiO1xuXG5jb25zdCBISVNUX0FUVFIgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcbmNvbnN0IFNFUklBTF9QUk9QID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LXYxXCI7XG5cbmRlY2xhcmUgbW9kdWxlIFwib2JzaWRpYW5cIiB7XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZSB7XG4gICAgICAgIGRlc2VyaWFsaXplTGF5b3V0KHN0YXRlOiBhbnksIC4uLmV0YzogYW55W10pOiBQcm9taXNlPFdvcmtzcGFjZUl0ZW0+XG4gICAgfVxuXG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBbSElTVF9BVFRSXTogSGlzdG9yeVxuICAgICAgICBwaW5uZWQ6IGJvb2xlYW5cbiAgICAgICAgd29ya2luZzogYm9vbGVhblxuICAgICAgICBzZXJpYWxpemUoKTogYW55XG4gICAgfVxuXG4gICAgaW50ZXJmYWNlIFZpZXdTdGF0ZSB7XG4gICAgICAgIHBvcHN0YXRlPzogYm9vbGVhblxuICAgIH1cbn1cblxuXG5leHBvcnQgY29uc3QgZG9tTGVhdmVzID0gbmV3IFdlYWtNYXAoKTtcblxuaW50ZXJmYWNlIFB1c2hTdGF0ZSB7XG4gICAgc3RhdGU6IHN0cmluZ1xuICAgIGVTdGF0ZTogc3RyaW5nXG59XG5cbmV4cG9ydCBjbGFzcyBIaXN0b3J5RW50cnkge1xuXG4gICAgcmF3OiBQdXNoU3RhdGVcbiAgICBlU3RhdGU6IGFueVxuICAgIHBhdGg6IHN0cmluZ1xuXG4gICAgY29uc3RydWN0b3IocmF3U3RhdGU6IFB1c2hTdGF0ZSkge1xuICAgICAgICB0aGlzLnNldFN0YXRlKHJhd1N0YXRlKTtcbiAgICB9XG5cblxuICAgIGdldCB2aWV3U3RhdGUoKSB7XG4gICAgICAgIHJldHVybiBKU09OLnBhcnNlKHRoaXMucmF3LnN0YXRlIHx8IFwie31cIilcbiAgICB9XG5cbiAgICBzZXRTdGF0ZShyYXdTdGF0ZTogUHVzaFN0YXRlKSB7XG4gICAgICAgIHRoaXMucmF3ID0gcmF3U3RhdGU7XG4gICAgICAgIHRoaXMuZVN0YXRlID0gSlNPTi5wYXJzZShyYXdTdGF0ZS5lU3RhdGUgfHwgXCJudWxsXCIpO1xuICAgICAgICB0aGlzLnBhdGggPSB0aGlzLnZpZXdTdGF0ZS5zdGF0ZT8uZmlsZTtcbiAgICB9XG5cbiAgICBvblJlbmFtZShmaWxlOiBUQWJzdHJhY3RGaWxlLCBvbGRQYXRoOiBzdHJpbmcpIHtcbiAgICAgICAgaWYgKHRoaXMucGF0aCA9PT0gb2xkUGF0aCkge1xuICAgICAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gdGhpcy52aWV3U3RhdGVcbiAgICAgICAgICAgIHRoaXMucGF0aCA9IHZpZXdTdGF0ZS5zdGF0ZS5maWxlID0gZmlsZS5wYXRoXG4gICAgICAgICAgICB0aGlzLnJhdy5zdGF0ZSA9IEpTT04uc3RyaW5naWZ5KHZpZXdTdGF0ZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBnbyhsZWFmPzogV29ya3NwYWNlTGVhZikge1xuICAgICAgICBsZXQge3ZpZXdTdGF0ZSwgcGF0aCwgZVN0YXRlfSA9IHRoaXM7XG4gICAgICAgIGxldCBmaWxlID0gcGF0aCAmJiBhcHA/LnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcbiAgICAgICAgaWYgKHBhdGggJiYgIWZpbGUpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoXCJNaXNzaW5nIGZpbGU6IFwiK3BhdGgpO1xuICAgICAgICAgICAgdmlld1N0YXRlID0ge3R5cGU6IFwiZW1wdHlcIiwgc3RhdGU6e319O1xuICAgICAgICAgICAgZVN0YXRlID0gdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGxlYWYuc2V0Vmlld1N0YXRlKHsuLi52aWV3U3RhdGUsIGFjdGl2ZTogdHJ1ZSwgcG9wc3RhdGU6IHRydWV9LCBlU3RhdGUpO1xuICAgIH1cblxuICAgIHJlcGxhY2VTdGF0ZShyYXdTdGF0ZTogUHVzaFN0YXRlKSB7XG4gICAgICAgIGlmIChyYXdTdGF0ZS5zdGF0ZSAhPT0gdGhpcy5yYXcuc3RhdGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHZpZXdTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuc3RhdGUgfHwgXCJ7fVwiKTtcbiAgICAgICAgICAgIC8vIERvbid0IHJlcGxhY2UgYSBmaWxlIHdpdGggYW4gZW1wdHkgaW4gdGhlIGhpc3RvcnlcbiAgICAgICAgICAgIGlmICh2aWV3U3RhdGUudHlwZSA9PT0gXCJlbXB0eVwiKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIC8vIEZpbGUgaXMgZGlmZmVyZW50IGZyb20gZXhpc3RpbmcgZmlsZTogc2hvdWxkIGJlIGEgcHVzaCBpbnN0ZWFkXG4gICAgICAgICAgICBpZiAodGhpcy5wYXRoICYmIHRoaXMucGF0aCAhPT0gdmlld1N0YXRlPy5zdGF0ZT8uZmlsZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcIm1lZGlhLXZpZXdcIikge1xuICAgICAgICAgICAgICAgIGNvbnN0IG9sZEluZm8gPSBKU09OLnN0cmluZ2lmeSh0aGlzLnZpZXdTdGF0ZS5zdGF0ZS5pbmZvKTtcbiAgICAgICAgICAgICAgICBjb25zdCBuZXdJbmZvID0gSlNPTi5zdHJpbmdpZnkodmlld1N0YXRlLnN0YXRlLmluZm8pO1xuICAgICAgICAgICAgICAgIGlmIChvbGRJbmZvICE9PSBuZXdJbmZvKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuaW50ZXJmYWNlIFNlcmlhbGl6YWJsZUhpc3Rvcnkge1xuICAgIHBvczogbnVtYmVyXG4gICAgc3RhY2s6IFB1c2hTdGF0ZVtdXG59XG5cbmV4cG9ydCBjbGFzcyBIaXN0b3J5IHtcbiAgICBzdGF0aWMgY3VycmVudCgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yTGVhZihhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHx8IG5ldyB0aGlzKCk7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZikge1xuICAgICAgICBpZiAobGVhZikgZG9tTGVhdmVzLnNldChsZWFmLmNvbnRhaW5lckVsLCBsZWFmKTtcbiAgICAgICAgaWYgKGxlYWYpIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gaW5zdGFuY2VvZiB0aGlzID9cbiAgICAgICAgICAgIGxlYWZbSElTVF9BVFRSXSA6XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcyhsZWFmLCBsZWFmW0hJU1RfQVRUUl0/LnNlcmlhbGl6ZSgpIHx8IHVuZGVmaW5lZCk7XG4gICAgfVxuXG4gICAgcG9zOiBudW1iZXJcbiAgICBzdGFjazogSGlzdG9yeUVudHJ5W11cblxuICAgIGNvbnN0cnVjdG9yKHB1YmxpYyBsZWFmPzogV29ya3NwYWNlTGVhZiwge3Bvcywgc3RhY2t9OiBTZXJpYWxpemFibGVIaXN0b3J5ID0ge3BvczowLCBzdGFjazpbXX0pIHtcbiAgICAgICAgdGhpcy5sZWFmID0gbGVhZjtcbiAgICAgICAgdGhpcy5wb3MgPSBwb3M7XG4gICAgICAgIHRoaXMuc3RhY2sgPSBzdGFjay5tYXAocmF3ID0+IG5ldyBIaXN0b3J5RW50cnkocmF3KSk7XG4gICAgfVxuXG4gICAgY2xvbmVUbyhsZWFmOiBXb3Jrc3BhY2VMZWFmKSB7XG4gICAgICAgIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgSGlzdG9yeShsZWFmLCB0aGlzLnNlcmlhbGl6ZSgpKTtcbiAgICB9XG5cbiAgICBvblJlbmFtZShmaWxlOiBUQWJzdHJhY3RGaWxlLCBvbGRQYXRoOiBzdHJpbmcpIHtcbiAgICAgICAgZm9yKGNvbnN0IGhpc3RFbnRyeSBvZiB0aGlzLnN0YWNrKSBoaXN0RW50cnkub25SZW5hbWUoZmlsZSwgb2xkUGF0aCk7XG4gICAgfVxuXG4gICAgc2VyaWFsaXplKCk6IFNlcmlhbGl6YWJsZUhpc3RvcnkgeyByZXR1cm4ge3BvczogdGhpcy5wb3MsIHN0YWNrOiB0aGlzLnN0YWNrLm1hcChlID0+IGUucmF3KX07IH1cblxuICAgIGdldCBzdGF0ZSgpIHsgcmV0dXJuIHRoaXMuc3RhY2tbdGhpcy5wb3NdPy5yYXcgfHwgbnVsbDsgfVxuICAgIGdldCBsZW5ndGgoKSB7IHJldHVybiB0aGlzLnN0YWNrLmxlbmd0aDsgfVxuXG4gICAgYmFjaygpICAgIHsgdGhpcy5nbygtMSk7IH1cbiAgICBmb3J3YXJkKCkgeyB0aGlzLmdvKCAxKTsgfVxuXG4gICAgbG9va0FoZWFkKCkgeyByZXR1cm4gdGhpcy5zdGFjay5zbGljZSgwLCB0aGlzLnBvcykucmV2ZXJzZSgpOyB9XG4gICAgbG9va0JlaGluZCgpIHsgcmV0dXJuIHRoaXMuc3RhY2suc2xpY2UodGhpcy5wb3MrMSk7IH1cblxuICAgIGFubm91bmNlKCkge1xuICAgICAgICBhcHA/LndvcmtzcGFjZT8udHJpZ2dlcihcInBhbmUtcmVsaWVmOnVwZGF0ZS1oaXN0b3J5XCIsIHRoaXMubGVhZiwgdGhpcyk7XG4gICAgfVxuXG4gICAgZ290byhwb3M6IG51bWJlcik6IHZvaWQge1xuICAgICAgICBpZiAoIXRoaXMubGVhZikgcmV0dXJuO1xuICAgICAgICBpZiAodGhpcy5sZWFmLnBpbm5lZCkgcmV0dXJuIG5ldyBOb3RpY2UoXCJQaW5uZWQgcGFuZTogdW5waW4gYmVmb3JlIGdvaW5nIGZvcndhcmQgb3IgYmFja1wiKSwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAodGhpcy5sZWFmLndvcmtpbmcpIHJldHVybiBuZXcgTm90aWNlKFwiUGFuZSBpcyBidXN5OiBwbGVhc2Ugd2FpdCBiZWZvcmUgbmF2aWdhdGluZyBmdXJ0aGVyXCIpLCB1bmRlZmluZWQ7XG4gICAgICAgIHBvcyA9IHRoaXMucG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4ocG9zLCB0aGlzLnN0YWNrLmxlbmd0aCAtIDEpKTtcbiAgICAgICAgdGhpcy5zdGFja1twb3NdPy5nbyh0aGlzLmxlYWYpO1xuICAgICAgICB0aGlzLmFubm91bmNlKCk7XG4gICAgfVxuXG4gICAgZ28oYnk6IG51bWJlciwgZm9yY2U/OiBib29sZWFuKSB7XG4gICAgICAgIGlmICghdGhpcy5sZWFmIHx8ICFieSkgcmV0dXJuOyAgLy8gbm8tb3BcbiAgICAgICAgLy8gcHJldmVudCB3cmFwYXJvdW5kXG4gICAgICAgIGNvbnN0IG5ld1BvcyA9IE1hdGgubWF4KDAsIE1hdGgubWluKHRoaXMucG9zIC0gYnksIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICBpZiAoZm9yY2UgfHwgbmV3UG9zICE9PSB0aGlzLnBvcykge1xuICAgICAgICAgICAgdGhpcy5nb3RvKG5ld1Bvcyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBObyBtb3JlICR7YnkgPCAwID8gXCJiYWNrXCIgOiBcImZvcndhcmRcIn0gaGlzdG9yeSBmb3IgcGFuZWApO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmVwbGFjZVN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKXtcbiAgICAgICAgY29uc3QgZW50cnkgPSB0aGlzLnN0YWNrW3RoaXMucG9zXTtcbiAgICAgICAgaWYgKCFlbnRyeSkge1xuICAgICAgICAgICAgdGhpcy5zdGFja1t0aGlzLnBvc10gPSBuZXcgSGlzdG9yeUVudHJ5KHJhd1N0YXRlKTtcbiAgICAgICAgfSBlbHNlIGlmICghZW50cnkucmVwbGFjZVN0YXRlKHJhd1N0YXRlKSkge1xuICAgICAgICAgICAgLy8gcmVwbGFjZVN0YXRlIHdhcyBlcnJvbmVvdXNseSBjYWxsZWQgd2l0aCBhIG5ldyBmaWxlIGZvciB0aGUgc2FtZSBsZWFmO1xuICAgICAgICAgICAgLy8gZm9yY2UgYSBwdXNoU3RhdGUgaW5zdGVhZCAoZml4ZXMgdGhlIGlzc3VlIHJlcG9ydGVkIGhlcmU6IGh0dHBzOi8vZm9ydW0ub2JzaWRpYW4ubWQvdC8xODUxOClcbiAgICAgICAgICAgIHRoaXMucHVzaFN0YXRlKHJhd1N0YXRlLCB0aXRsZSwgdXJsKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHB1c2hTdGF0ZShyYXdTdGF0ZTogUHVzaFN0YXRlLCB0aXRsZTogc3RyaW5nLCB1cmw6IHN0cmluZykgICB7XG4gICAgICAgIC8vY29uc29sZS5sb2coXCJwdXNoaW5nXCIsIHJhd1N0YXRlKVxuICAgICAgICB0aGlzLnN0YWNrLnNwbGljZSgwLCB0aGlzLnBvcywgbmV3IEhpc3RvcnlFbnRyeShyYXdTdGF0ZSkpO1xuICAgICAgICB0aGlzLnBvcyA9IDA7XG4gICAgICAgIC8vIExpbWl0IFwiYmFja1wiIHRvIDIwXG4gICAgICAgIHdoaWxlICh0aGlzLnN0YWNrLmxlbmd0aCA+IDIwKSB0aGlzLnN0YWNrLnBvcCgpO1xuICAgICAgICB0aGlzLmFubm91bmNlKCk7XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbEhpc3RvcnkocGx1Z2luOiBQYW5lUmVsaWVmKSB7XG5cbiAgICAvLyBNb25rZXlwYXRjaDogaW5jbHVkZSBoaXN0b3J5IGluIGxlYWYgc2VyaWFsaXphdGlvbiAoc28gaXQncyBwZXJzaXN0ZWQgd2l0aCB0aGUgd29ya3NwYWNlKVxuICAgIC8vIGFuZCBjaGVjayBmb3IgcG9wc3RhdGUgZXZlbnRzICh0byBzdXBwcmVzcyB0aGVtKVxuICAgIHBsdWdpbi5yZWdpc3Rlcihhcm91bmQoV29ya3NwYWNlTGVhZi5wcm90b3R5cGUsIHtcbiAgICAgICAgc2VyaWFsaXplKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24gc2VyaWFsaXplKCl7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBvbGQuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgIGlmICh0aGlzW0hJU1RfQVRUUl0pIHJlc3VsdFtTRVJJQUxfUFJPUF0gPSB0aGlzW0hJU1RfQVRUUl0uc2VyaWFsaXplKCk7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9fSxcbiAgICAgICAgc2V0Vmlld1N0YXRlKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24gc2V0Vmlld1N0YXRlKHZzLCBlcyl7XG4gICAgICAgICAgICBpZiAodnMucG9wc3RhdGUgJiYgd2luZG93LmV2ZW50Py50eXBlID09PSBcInBvcHN0YXRlXCIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgdnMsIGVzKTtcbiAgICAgICAgfX1cbiAgICB9KSk7XG5cbiAgICBwbHVnaW4ucmVnaXN0ZXIoYXJvdW5kKGFwcC53b3Jrc3BhY2UsIHtcbiAgICAgICAgLy8gTW9ua2V5cGF0Y2g6IGxvYWQgaGlzdG9yeSBkdXJpbmcgbGVhZiBsb2FkLCBpZiBwcmVzZW50XG4gICAgICAgIGRlc2VyaWFsaXplTGF5b3V0KG9sZCkgeyByZXR1cm4gYXN5bmMgZnVuY3Rpb24gZGVzZXJpYWxpemVMYXlvdXQoc3RhdGUsIC4uLmV0YzogYW55W10pe1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIHN0YXRlLCAuLi5ldGMpO1xuICAgICAgICAgICAgaWYgKHN0YXRlLnR5cGUgPT09IFwibGVhZlwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gUmV0cnkgbG9hZGluZyB0aGUgcGFuZSBhcyBhbiBlbXB0eVxuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5zdGF0ZS50eXBlID0gJ2VtcHR5JztcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgb2xkLmNhbGwodGhpcywgc3RhdGUsIC4uLmV0Yyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghcmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoc3RhdGVbU0VSSUFMX1BST1BdKSByZXN1bHRbSElTVF9BVFRSXSA9IG5ldyBIaXN0b3J5KHJlc3VsdCwgc3RhdGVbU0VSSUFMX1BST1BdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19LFxuICAgICAgICAvLyBNb25rZXlwYXRjaDoga2VlcCBPYnNpZGlhbiBmcm9tIHB1c2hpbmcgaGlzdG9yeSBpbiBzZXRBY3RpdmVMZWFmXG4gICAgICAgIHNldEFjdGl2ZUxlYWYob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXRBY3RpdmVMZWFmKGxlYWYsIC4uLmV0Yykge1xuICAgICAgICAgICAgY29uc3QgdW5zdWIgPSBhcm91bmQodGhpcywge1xuICAgICAgICAgICAgICAgIHJlY29yZEhpc3Rvcnkob2xkKSB7IHJldHVybiBmdW5jdGlvbiAobGVhZjogV29ya3NwYWNlTGVhZiwgX3B1c2g6IGJvb2xlYW4sIC4uLmFyZ3M6IGFueVtdKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEFsd2F5cyB1cGRhdGUgc3RhdGUgaW4gcGxhY2VcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMsIGxlYWYsIGZhbHNlLCAuLi5hcmdzKTtcbiAgICAgICAgICAgICAgICB9OyB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMsIGxlYWYsIC4uLmV0Yyk7XG4gICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIHVuc3ViKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH19LFxuICAgIH0pKTtcblxuICAgIC8vIFByb3h5IHRoZSB3aW5kb3cgaGlzdG9yeSB3aXRoIGEgd3JhcHBlciB0aGF0IGRlbGVnYXRlcyB0byB0aGUgYWN0aXZlIGxlYWYncyBIaXN0b3J5IG9iamVjdCxcbiAgICBjb25zdCByZWFsSGlzdG9yeSA9IHdpbmRvdy5oaXN0b3J5O1xuICAgIHBsdWdpbi5yZWdpc3RlcigoKSA9PiAod2luZG93IGFzIGFueSkuaGlzdG9yeSA9IHJlYWxIaXN0b3J5KTtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCBcImhpc3RvcnlcIiwgeyBlbnVtZXJhYmxlOiB0cnVlLCBjb25maWd1cmFibGU6IHRydWUsIHdyaXRhYmxlOiB0cnVlLCB2YWx1ZToge1xuICAgICAgICBnZXQgc3RhdGUoKSAgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudCgpLnN0YXRlOyB9LFxuICAgICAgICBnZXQgbGVuZ3RoKCkgICAgIHsgcmV0dXJuIEhpc3RvcnkuY3VycmVudCgpLmxlbmd0aDsgfSxcblxuICAgICAgICBiYWNrKCkgICAgeyBpZiAoIXBsdWdpbi5pc1N5bnRoZXRpY0hpc3RvcnlFdmVudCgzKSkgdGhpcy5nbygtMSk7IH0sXG4gICAgICAgIGZvcndhcmQoKSB7IGlmICghcGx1Z2luLmlzU3ludGhldGljSGlzdG9yeUV2ZW50KDQpKSB0aGlzLmdvKCAxKTsgfSxcbiAgICAgICAgZ28oYnk6IG51bWJlcikgICAgeyBIaXN0b3J5LmN1cnJlbnQoKS5nbyhieSk7IH0sXG5cbiAgICAgICAgcmVwbGFjZVN0YXRlKHN0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKXsgSGlzdG9yeS5jdXJyZW50KCkucmVwbGFjZVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcbiAgICAgICAgcHVzaFN0YXRlKHN0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKSAgIHsgSGlzdG9yeS5jdXJyZW50KCkucHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTsgfSxcblxuICAgICAgICBnZXQgc2Nyb2xsUmVzdG9yYXRpb24oKSAgICB7IHJldHVybiByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbjsgfSxcbiAgICAgICAgc2V0IHNjcm9sbFJlc3RvcmF0aW9uKHZhbCkgeyByZWFsSGlzdG9yeS5zY3JvbGxSZXN0b3JhdGlvbiA9IHZhbDsgfSxcbiAgICB9fSk7XG5cbn1cbiIsImltcG9ydCB7IENvbXBvbmVudCwgUGx1Z2luLCBWaWV3LCBXb3Jrc3BhY2VMZWFmLCBXb3Jrc3BhY2VQYXJlbnQsIFdvcmtzcGFjZVNwbGl0LCBXb3Jrc3BhY2VXaW5kb3cgfSBmcm9tIFwib2JzaWRpYW5cIjtcblxuLyoqXG4gKiBDb21wb25lbnQgdGhhdCBiZWxvbmdzIHRvIGEgcGx1Z2luICsgd2luZG93LiBlLmcuOlxuICpcbiAqICAgICBjbGFzcyBUaXRsZVdpZGdldCBleHRlbmRzIFBlcldpbmRvd0NvbXBvbmVudDxNeVBsdWdpbj4ge1xuICogICAgICAgICBvbmxvYWQoKSB7XG4gKiAgICAgICAgICAgICAvLyBkbyBzdHVmZiB3aXRoIHRoaXMucGx1Z2luIGFuZCB0aGlzLndpbiAuLi5cbiAqICAgICAgICAgfVxuICogICAgIH1cbiAqXG4gKiAgICAgY2xhc3MgTXlQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICogICAgICAgICB0aXRsZVdpZGdldHMgPSBUaXRsZVdpZGdldC5wZXJXaW5kb3codGhpcyk7XG4gKiAgICAgICAgIC4uLlxuICogICAgIH1cbiAqXG4gKiBUaGlzIHdpbGwgYXV0b21hdGljYWxseSBjcmVhdGUgYSB0aXRsZSB3aWRnZXQgZm9yIGVhY2ggd2luZG93IGFzIGl0J3Mgb3BlbmVkLCBhbmRcbiAqIG9uIHBsdWdpbiBsb2FkLiAgVGhlIHBsdWdpbidzIGAudGl0bGVXaWRnZXRzYCB3aWxsIGFsc28gYmUgYSBXaW5kb3dNYW5hZ2VyIHRoYXQgY2FuXG4gKiBsb29rIHVwIHRoZSB0aXRsZSB3aWRnZXQgZm9yIGEgZ2l2ZW4gd2luZG93LCBsZWFmLCBvciB2aWV3LCBvciByZXR1cm4gYSBsaXN0IG9mXG4gKiBhbGwgb2YgdGhlbS4gIFNlZSBXaW5kb3dNYW5hZ2VyIGZvciB0aGUgZnVsbCBBUEkuXG4gKlxuICogSWYgeW91IHdhbnQgeW91ciBjb21wb25lbnRzIHRvIGJlIGNyZWF0ZWQgb24gZGVtYW5kIGluc3RlYWQgb2YgYXV0b21hdGljYWxseSB3aGVuXG4gKiB3aW5kb3cocykgYXJlIG9wZW5lZCwgeW91IGNhbiBwYXNzIGBmYWxzZWAgYXMgdGhlIHNlY29uZCBhcmd1bWVudCB0byBgcGVyV2luZG93KClgLlxuICovXG5leHBvcnQgY2xhc3MgUGVyV2luZG93Q29tcG9uZW50PFAgZXh0ZW5kcyBQbHVnaW4+IGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIGdldCByb290KCk6IFdvcmtzcGFjZVBhcmVudCB7XG4gICAgICAgIHJldHVybiBjb250YWluZXJGb3JXaW5kb3codGhpcy53aW4pO1xuICAgIH1cblxuICAgIGNvbnN0cnVjdG9yKHB1YmxpYyBwbHVnaW46IFAsIHB1YmxpYyB3aW46IFdpbmRvdykge1xuICAgICAgICBzdXBlcigpO1xuICAgIH1cblxuICAgIHN0YXRpYyBwZXJXaW5kb3c8VCBleHRlbmRzIFBlcldpbmRvd0NvbXBvbmVudDxQPiwgUCBleHRlbmRzIFBsdWdpbj4oXG4gICAgICAgIHRoaXM6IG5ldyAocGx1Z2luOiBQLCB3aW46IFdpbmRvdykgPT4gVCxcbiAgICAgICAgcGx1Z2luOiBQXG4gICAgKSB7XG4gICAgICAgIHJldHVybiBuZXcgV2luZG93TWFuYWdlcihwbHVnaW4sIHRoaXMpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBNYW5hZ2UgcGVyLXdpbmRvdyBjb21wb25lbnRzXG4gKi9cbmV4cG9ydCBjbGFzcyBXaW5kb3dNYW5hZ2VyPFQgZXh0ZW5kcyBQZXJXaW5kb3dDb21wb25lbnQ8UD4sIFAgZXh0ZW5kcyBQbHVnaW4+IGV4dGVuZHMgQ29tcG9uZW50IHtcbiAgICBpbnN0YW5jZXMgPSBuZXcgV2Vha01hcDxXaW5kb3csIFQ+KCk7XG5cbiAgICB3YXRjaGluZzogYm9vbGVhbiA9IGZhbHNlXG5cbiAgICBjb25zdHJ1Y3RvciAoXG4gICAgICAgIHB1YmxpYyBwbHVnaW46IFAsXG4gICAgICAgIHB1YmxpYyBmYWN0b3J5OiBuZXcgKHBsdWdpbjogUCwgd2luOiBXaW5kb3cpID0+IFQsICAvLyBUaGUgY2xhc3Mgb2YgdGhpbmcgdG8gbWFuYWdlXG4gICAgKSB7XG4gICAgICAgIHN1cGVyKCk7XG4gICAgICAgIHBsdWdpbi5hZGRDaGlsZCh0aGlzKTtcbiAgICB9XG5cbiAgICB3YXRjaCgpOiB0aGlzIHtcbiAgICAgICAgLy8gRGVmZXIgd2F0Y2ggdW50aWwgcGx1Z2luIGlzIGxvYWRlZFxuICAgICAgICBpZiAoIXRoaXMuX2xvYWRlZCkgdGhpcy5vbmxvYWQgPSAoKSA9PiB0aGlzLndhdGNoKCk7XG4gICAgICAgIGVsc2UgaWYgKCF0aGlzLndhdGNoaW5nKSB7XG4gICAgICAgICAgICBjb25zdCB7d29ya3NwYWNlfSA9IGFwcDtcbiAgICAgICAgICAgIHRoaXMud2F0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgICAgIHdvcmtzcGFjZS5vbihcIndpbmRvdy1vcGVuXCIsIChfLCB3aW4pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4gc2V0SW1tZWRpYXRlKCgpID0+IHRoaXMuZm9yV2luZG93KHdpbikpKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHdvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHNldEltbWVkaWF0ZSgoKSA9PiB0aGlzLmZvckFsbCgpKSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgZm9yV2luZG93KCk6IFQ7XG4gICAgZm9yV2luZG93KHdpbjogV2luZG93KTogVDtcbiAgICBmb3JXaW5kb3cod2luOiBXaW5kb3csIGNyZWF0ZTogdHJ1ZSk6IFQ7XG4gICAgZm9yV2luZG93KHdpbjogV2luZG93LCBjcmVhdGU6IGJvb2xlYW4pOiBUIHwgdW5kZWZpbmVkO1xuXG4gICAgZm9yV2luZG93KHdpbjogV2luZG93ID0gd2luZG93LmFjdGl2ZVdpbmRvdyA/PyB3aW5kb3csIGNyZWF0ZSA9IHRydWUpOiBUIHwgdW5kZWZpbmVkIHtcbiAgICAgICAgbGV0IGluc3QgPSB0aGlzLmluc3RhbmNlcy5nZXQod2luKTtcbiAgICAgICAgaWYgKCFpbnN0ICYmIGNyZWF0ZSkge1xuICAgICAgICAgICAgaW5zdCA9IG5ldyB0aGlzLmZhY3RvcnkodGhpcy5wbHVnaW4sIHdpbik7XG4gICAgICAgICAgICBpZiAoaW5zdCkge1xuICAgICAgICAgICAgICAgIHRoaXMuaW5zdGFuY2VzLnNldCh3aW4sIGluc3QhKTtcbiAgICAgICAgICAgICAgICBpbnN0LnJlZ2lzdGVyRG9tRXZlbnQod2luLCBcImJlZm9yZXVubG9hZFwiLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucmVtb3ZlQ2hpbGQoaW5zdCEpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmluc3RhbmNlcy5kZWxldGUod2luKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB0aGlzLmFkZENoaWxkKGluc3QpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBpbnN0IHx8IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBmb3JEb20oZWw6IEhUTUxFbGVtZW50KTogVDtcbiAgICBmb3JEb20oZWw6IEhUTUxFbGVtZW50LCBjcmVhdGU6IHRydWUpOiBUO1xuICAgIGZvckRvbShlbDogSFRNTEVsZW1lbnQsIGNyZWF0ZTogYm9vbGVhbik6IFQgfCB1bmRlZmluZWQ7XG5cbiAgICBmb3JEb20oZWw6IEhUTUxFbGVtZW50LCBjcmVhdGUgPSB0cnVlKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmZvcldpbmRvdyh3aW5kb3dGb3JEb20oZWwpLCBjcmVhdGUpO1xuICAgIH1cblxuICAgIGZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZik6IFQ7XG4gICAgZm9yTGVhZihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBjcmVhdGU6IHRydWUpOiBUO1xuICAgIGZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZiwgY3JlYXRlOiBib29sZWFuKTogVCB8IHVuZGVmaW5lZDtcblxuICAgIGZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZiwgY3JlYXRlID0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JEb20obGVhZi5jb250YWluZXJFbCwgY3JlYXRlKTtcbiAgICB9XG5cbiAgICBmb3JWaWV3KHZpZXc6IFZpZXcpOiBUO1xuICAgIGZvclZpZXcodmlldzogVmlldywgY3JlYXRlOiB0cnVlKTogVDtcbiAgICBmb3JWaWV3KHZpZXc6IFZpZXcsIGNyZWF0ZTogYm9vbGVhbik6IFQgfCB1bmRlZmluZWQ7XG5cbiAgICBmb3JWaWV3KHZpZXc6IFZpZXcsIGNyZWF0ZSA9IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yTGVhZih2aWV3LmxlYWYsIGNyZWF0ZSk7XG4gICAgfVxuXG4gICAgd2luZG93cygpIHtcbiAgICAgICAgY29uc3Qgd2luZG93czogV2luZG93W10gPSBbd2luZG93XSwge2Zsb2F0aW5nU3BsaXR9ID0gYXBwLndvcmtzcGFjZTtcbiAgICAgICAgaWYgKGZsb2F0aW5nU3BsaXQpIHtcbiAgICAgICAgICAgIGZvcihjb25zdCBzcGxpdCBvZiBmbG9hdGluZ1NwbGl0LmNoaWxkcmVuKSBpZiAoc3BsaXQud2luKSB3aW5kb3dzLnB1c2goc3BsaXQud2luKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gd2luZG93cztcbiAgICB9XG5cbiAgICBmb3JBbGwoY3JlYXRlID0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gdGhpcy53aW5kb3dzKCkubWFwKHdpbiA9PiB0aGlzLmZvcldpbmRvdyh3aW4sIGNyZWF0ZSkpLmZpbHRlcih0ID0+IHQpO1xuICAgIH1cbn1cblxuZXhwb3J0IGNsYXNzIFJvb3RNYW5hZ2VyPFQgZXh0ZW5kcyBQZXJXaW5kb3dDb21wb25lbnQ8UD4sIFAgZXh0ZW5kcyBQbHVnaW4+IGV4dGVuZHMgV2luZG93TWFuYWdlcjxULFA+IHtcbiAgICBpbnN0YW5jZXM6IFdlYWtNYXA8V2luZG93fFdvcmtzcGFjZVBhcmVudCwgVD47XG5cbiAgICBmb3JEb20oZWw6IEhUTUxFbGVtZW50LCBjcmVhdGUgPSB0cnVlKSB7XG4gICAgICAgIGNvbnN0IHBvcG92ZXJFbCA9IGVsLm1hdGNoUGFyZW50KFwiLmhvdmVyLXBvcG92ZXJcIik7XG4gICAgICAgIGlmICghcG9wb3ZlckVsKSByZXR1cm4gdGhpcy5mb3JXaW5kb3cod2luZG93Rm9yRG9tKGVsKSwgY3JlYXRlKTtcbiAgICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3aW5kb3dGb3JEb20oZWw6IE5vZGUpIHtcbiAgICByZXR1cm4gKGVsLm93bmVyRG9jdW1lbnQgfHwgPERvY3VtZW50PmVsKS5kZWZhdWx0VmlldyE7XG59XG5cbmZ1bmN0aW9uIGNvbnRhaW5lckZvcldpbmRvdyh3aW46IFdpbmRvdyk6IFdvcmtzcGFjZVBhcmVudCB7XG4gICAgaWYgKHdpbiA9PT0gd2luZG93KSByZXR1cm4gYXBwLndvcmtzcGFjZS5yb290U3BsaXQ7XG4gICAgY29uc3Qge2Zsb2F0aW5nU3BsaXR9ID0gYXBwLndvcmtzcGFjZTtcbiAgICBpZiAoZmxvYXRpbmdTcGxpdCkge1xuICAgICAgICBmb3IoY29uc3Qgc3BsaXQgb2YgZmxvYXRpbmdTcGxpdC5jaGlsZHJlbikgaWYgKHdpbiA9PT0gc3BsaXQud2luKSByZXR1cm4gc3BsaXQ7XG4gICAgfVxufVxuXG5kZWNsYXJlIGdsb2JhbCB7XG4gICAgLy8gQmFja3dhcmQgY29tcGF0aWJpbGl0eSBmb3Igc2luZ2xlLXdpbmRvdyBPYnNpZGlhbiAoPDAuMTUpXG4gICAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgICAgIGFjdGl2ZVdpbmRvdz86IFdpbmRvd1xuICAgIH1cbn1cblxuZGVjbGFyZSBtb2R1bGUgXCJvYnNpZGlhblwiIHtcbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlIHtcbiAgICAgICAgZmxvYXRpbmdTcGxpdD86IHsgY2hpbGRyZW46IFdvcmtzcGFjZVdpbmRvd1tdIH07XG4gICAgICAgIG9wZW5Qb3BvdXQ/KCk6IFdvcmtzcGFjZVNwbGl0O1xuICAgICAgICBvcGVuUG9wb3V0TGVhZj8oKTogV29ya3NwYWNlTGVhZjtcbiAgICAgICAgb24obmFtZTogJ3dpbmRvdy1vcGVuJywgY2FsbGJhY2s6ICh3aW46IFdvcmtzcGFjZVdpbmRvdywgd2luZG93OiBXaW5kb3cpID0+IGFueSwgY3R4PzogYW55KTogRXZlbnRSZWY7XG4gICAgfVxuICAgIGludGVyZmFjZSBXb3Jrc3BhY2VXaW5kb3cgZXh0ZW5kcyBXb3Jrc3BhY2VQYXJlbnQge1xuICAgICAgICB3aW46IFdpbmRvd1xuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlTGVhZiB7XG4gICAgICAgIGNvbnRhaW5lckVsOiBIVE1MRGl2RWxlbWVudDtcbiAgICB9XG4gICAgaW50ZXJmYWNlIENvbXBvbmVudCB7XG4gICAgICAgIF9sb2FkZWQ6IGJvb2xlYW5cbiAgICB9XG59XG4iLCJpbXBvcnQge01lbnUsIEtleW1hcCwgQ29tcG9uZW50LCBXb3Jrc3BhY2VMZWFmLCBURmlsZSwgTWVudUl0ZW19IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7ZG9tTGVhdmVzLCBIaXN0b3J5LCBIaXN0b3J5RW50cnl9IGZyb20gXCIuL0hpc3RvcnlcIjtcbmltcG9ydCBQYW5lUmVsaWVmIGZyb20gJy4vcGFuZS1yZWxpZWYnO1xuaW1wb3J0IHtQZXJXaW5kb3dDb21wb25lbnR9IGZyb20gJy4vUGVyV2luZG93Q29tcG9uZW50JztcblxuZGVjbGFyZSBtb2R1bGUgXCJvYnNpZGlhblwiIHtcbiAgICBpbnRlcmZhY2UgTWVudSB7XG4gICAgICAgIGRvbTogSFRNTEVsZW1lbnRcbiAgICB9XG4gICAgaW50ZXJmYWNlIE1lbnVJdGVtIHtcbiAgICAgICAgZG9tOiBIVE1MRWxlbWVudFxuICAgIH1cbiAgICBpbnRlcmZhY2UgQXBwIHtcbiAgICAgICAgZHJhZ01hbmFnZXI6IERyYWdNYW5hZ2VyXG4gICAgfVxuICAgIGludGVyZmFjZSBEcmFnTWFuYWdlciB7XG4gICAgICAgIGRyYWdGaWxlKGV2ZW50OiBEcmFnRXZlbnQsIGZpbGU6IFRGaWxlKTogRHJhZ0RhdGFcbiAgICAgICAgb25EcmFnU3RhcnQoZXZlbnQ6IERyYWdFdmVudCwgZHJhZ0RhdGE6IERyYWdEYXRhKTogdm9pZFxuICAgIH1cbiAgICBpbnRlcmZhY2UgRHJhZ0RhdGEge31cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlTGVhZiB7XG4gICAgICAgIGFjdGl2ZVRpbWU6IG51bWJlclxuICAgIH1cbn1cblxuaW50ZXJmYWNlIEZpbGVJbmZvIHtcbiAgICBpY29uOiBzdHJpbmdcbiAgICB0aXRsZTogc3RyaW5nXG4gICAgZmlsZTogVEZpbGVcbiAgICB0eXBlOiBzdHJpbmdcbiAgICBzdGF0ZTogYW55XG4gICAgZVN0YXRlOiBhbnlcbn1cblxuXG5jb25zdCB2aWV3dHlwZUljb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIG1hcmtkb3duOiBcImRvY3VtZW50XCIsXG4gICAgaW1hZ2U6IFwiaW1hZ2UtZmlsZVwiLFxuICAgIGF1ZGlvOiBcImF1ZGlvLWZpbGVcIixcbiAgICB2aWRlbzogXCJhdWRpby1maWxlXCIsXG4gICAgcGRmOiBcInBkZi1maWxlXCIsXG4gICAgbG9jYWxncmFwaDogXCJkb3QtbmV0d29ya1wiLFxuICAgIG91dGxpbmU6IFwiYnVsbGV0LWxpc3RcIixcbiAgICBiYWNrbGluazogXCJsaW5rXCIsXG5cbiAgICAvLyB0aGlyZC1wYXJ0eSBwbHVnaW5zXG4gICAga2FuYmFuOiBcImJsb2Nrc1wiLFxuICAgIGV4Y2FsaWRyYXc6IFwiZXhjYWxpZHJhdy1pY29uXCIsXG4gICAgXCJtZWRpYS12aWV3XCI6IFwiYXVkaW8tZmlsZVwiLFxufVxuXG5jb25zdCBub25GaWxlVmlld3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHtcbiAgICBncmFwaDogW1wiZG90LW5ldHdvcmtcIiwgXCJHcmFwaCBWaWV3XCJdLFxuICAgIFwiZmlsZS1leHBsb3JlclwiOiBbXCJmb2xkZXJcIiwgXCJGaWxlIEV4cGxvcmVyXCJdLFxuICAgIHN0YXJyZWQ6IFtcInN0YXJcIiwgXCJTdGFycmVkIEZpbGVzXCJdLFxuICAgIHRhZzogW1widGFnXCIsIFwiVGFncyBWaWV3XCJdLFxuXG4gICAgLy8gdGhpcmQtcGFydHkgcGx1Z2luc1xuICAgIFwicmVjZW50LWZpbGVzXCI6IFtcImNsb2NrXCIsIFwiUmVjZW50IEZpbGVzXCJdLFxuICAgIGNhbGVuZGFyOiBbXCJjYWxlbmRhci13aXRoLWNoZWNrbWFya1wiLCBcIkNhbGVuZGFyXCJdLFxuICAgIGVtcHR5OiBbXCJjcm9zc1wiLCBcIk5vIGZpbGVcIl1cbn1cblxuZXhwb3J0IGNsYXNzIE5hdmlnYXRpb24gZXh0ZW5kcyBQZXJXaW5kb3dDb21wb25lbnQ8UGFuZVJlbGllZj4ge1xuICAgIGJhY2s6IE5hdmlnYXRvclxuICAgIGZvcndhcmQ6IE5hdmlnYXRvclxuICAgIC8vIFNldCB0byB0cnVlIHdoaWxlIGVpdGhlciBtZW51IGlzIG9wZW4sIHNvIHdlIGRvbid0IHN3aXRjaCBpdCBvdXRcbiAgICBoaXN0b3J5SXNPcGVuID0gZmFsc2U7XG5cbiAgICBkaXNwbGF5KGxlYWYgPSB0aGlzLmxhdGVzdExlYWYoKSkge1xuICAgICAgICBpZiAodGhpcy5oaXN0b3J5SXNPcGVuKSByZXR1cm47XG4gICAgICAgIGlmICghdGhpcy5fbG9hZGVkKSB7IHRoaXMubG9hZCgpOyByZXR1cm47IH1cbiAgICAgICAgdGhpcy53aW4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGhpc3RvcnkgPSBsZWFmID8gSGlzdG9yeS5mb3JMZWFmKGxlYWYpIDogbmV3IEhpc3RvcnkoKTtcbiAgICAgICAgICAgIHRoaXMuYmFjay5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgICAgICAgICAgdGhpcy5mb3J3YXJkLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZUxlYWYobGVhZiwgaGlzdG9yeSlcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgbGVhdmVzKCkge1xuICAgICAgICBjb25zdCBsZWF2ZXM6IFdvcmtzcGFjZUxlYWZbXSA9IFtdO1xuICAgICAgICBjb25zdCBjYiA9IChsZWFmOiBXb3Jrc3BhY2VMZWFmKSA9PiB7IGxlYXZlcy5wdXNoKGxlYWYpOyB9O1xuICAgICAgICBhcHAud29ya3NwYWNlLml0ZXJhdGVMZWF2ZXMoY2IsIHRoaXMucm9vdCk7XG5cbiAgICAgICAgLy8gU3VwcG9ydCBIb3ZlciBFZGl0b3JzXG4gICAgICAgIGNvbnN0IHBvcG92ZXJzID0gYXBwLnBsdWdpbnMucGx1Z2luc1tcIm9ic2lkaWFuLWhvdmVyLWVkaXRvclwiXT8uYWN0aXZlUG9wb3ZlcnM7XG4gICAgICAgIGlmIChwb3BvdmVycykgZm9yIChjb25zdCBwb3BvdmVyIG9mIHBvcG92ZXJzKSB7XG4gICAgICAgICAgICBpZiAocG9wb3Zlci5ob3ZlckVsLm93bmVyRG9jdW1lbnQuZGVmYXVsdFZpZXcgIT09IHRoaXMud2luKSBjb250aW51ZTsgLy8gbXVzdCBiZSBpbiBzYW1lIHdpbmRvd1xuICAgICAgICAgICAgZWxzZSBpZiAocG9wb3Zlci5yb290U3BsaXQpIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUxlYXZlcyhjYiwgcG9wb3Zlci5yb290U3BsaXQpO1xuICAgICAgICAgICAgZWxzZSBpZiAocG9wb3Zlci5sZWFmKSBjYihwb3BvdmVyLmxlYWYpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsZWF2ZXM7XG4gICAgfVxuXG4gICAgbGF0ZXN0TGVhZigpIHtcbiAgICAgICAgbGV0IGxlYWYgPSBhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWY7XG4gICAgICAgIGlmIChsZWFmICYmIHRoaXMucGx1Z2luLm5hdi5mb3JMZWFmKGxlYWYpID09PSB0aGlzKSByZXR1cm4gbGVhZjtcbiAgICAgICAgcmV0dXJuIHRoaXMubGVhdmVzKCkucmVkdWNlKChiZXN0LCBsZWFmKT0+eyByZXR1cm4gKCFiZXN0IHx8IGJlc3QuYWN0aXZlVGltZSA8IGxlYWYuYWN0aXZlVGltZSkgPyBsZWFmIDogYmVzdDsgfSwgbnVsbCk7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICAvLyBPdmVycmlkZSBkZWZhdWx0IG1vdXNlIGhpc3RvcnkgYmVoYXZpb3IuICBXZSBuZWVkIHRoaXMgYmVjYXVzZSAxKSBFbGVjdHJvbiB3aWxsIHVzZSB0aGUgYnVpbHQtaW5cbiAgICAgICAgLy8gaGlzdG9yeSBvYmplY3QgaWYgd2UgZG9uJ3QgKGluc3RlYWQgb2Ygb3VyIHdyYXBwZXIpLCBhbmQgMikgd2Ugd2FudCB0aGUgY2xpY2sgdG8gYXBwbHkgdG8gdGhlIGxlYWZcbiAgICAgICAgLy8gdGhhdCB3YXMgdW5kZXIgdGhlIG1vdXNlLCByYXRoZXIgdGhhbiB3aGljaGV2ZXIgbGVhZiB3YXMgYWN0aXZlLlxuICAgICAgICBjb25zdCB7ZG9jdW1lbnR9ID0gdGhpcy53aW47XG4gICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZG93blwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoKCkgPT4ge1xuICAgICAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpO1xuICAgICAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNlZG93blwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBmdW5jdGlvbiBoaXN0b3J5SGFuZGxlcihlOiBNb3VzZUV2ZW50KSB7XG4gICAgICAgICAgICBpZiAoZS5idXR0b24gIT09IDMgJiYgZS5idXR0b24gIT09IDQpIHJldHVybjtcbiAgICAgICAgICAgIGRlYnVnZ2VyXG4gICAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7IGUuc3RvcFByb3BhZ2F0aW9uKCk7ICAvLyBwcmV2ZW50IGRlZmF1bHQgYmVoYXZpb3JcbiAgICAgICAgICAgIGNvbnN0IHRhcmdldCA9IChlLnRhcmdldCBhcyBIVE1MRWxlbWVudCkubWF0Y2hQYXJlbnQoXCIud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgICAgICBpZiAodGFyZ2V0ICYmIGUudHlwZSA9PT0gXCJtb3VzZXVwXCIpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVhZiA9IGRvbUxlYXZlcy5nZXQodGFyZ2V0KTtcbiAgICAgICAgICAgICAgICBpZiAoIWxlYWYpIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcyhsID0+IGxlYWYgPSAobC5jb250YWluZXJFbCA9PT0gdGFyZ2V0KSA/IGwgOiBsZWFmKTtcbiAgICAgICAgICAgICAgICBpZiAoIWxlYWYpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICBpZiAoZS5idXR0b24gPT0gMykgeyBIaXN0b3J5LmZvckxlYWYobGVhZikuYmFjaygpOyB9XG4gICAgICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDQpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmZvcndhcmQoKTsgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgYXBwLndvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5iYWNrICAgID0gbmV3IE5hdmlnYXRvcih0aGlzLCBcImJhY2tcIiwgLTEpKTtcbiAgICAgICAgICAgIHRoaXMuYWRkQ2hpbGQodGhpcy5mb3J3YXJkID0gbmV3IE5hdmlnYXRvcih0aGlzLCBcImZvcndhcmRcIiwgMSkpO1xuICAgICAgICAgICAgdGhpcy5kaXNwbGF5KCk7XG4gICAgICAgICAgICB0aGlzLm51bWJlclBhbmVzKCk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoYXBwLndvcmtzcGFjZS5vbihcImxheW91dC1jaGFuZ2VcIiwgdGhpcy5udW1iZXJQYW5lcywgdGhpcykpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlcihcbiAgICAgICAgICAgICAgICAvLyBTdXBwb3J0IFwiQ3VzdG9taXphYmxlIFBhZ2UgSGVhZGVyIGFuZCBUaXRsZSBCYXJcIiBidXR0b25zXG4gICAgICAgICAgICAgICAgb25FbGVtZW50KFxuICAgICAgICAgICAgICAgICAgICB0aGlzLndpbi5kb2N1bWVudC5ib2R5LFxuICAgICAgICAgICAgICAgICAgICBcImNvbnRleHRtZW51XCIsXG4gICAgICAgICAgICAgICAgICAgIFwiLnZpZXctaGVhZGVyID4gLnZpZXctYWN0aW9ucyA+IC52aWV3LWFjdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAoZXZ0LCB0YXJnZXQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGRpciA9IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAodGFyZ2V0Lm1hdGNoZXMoJ1tjbGFzcyo9XCIgYXBwOmdvLWZvcndhcmRcIl0nKSAmJiBcImZvcndhcmRcIikgfHxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAodGFyZ2V0Lm1hdGNoZXMoJ1tjbGFzcyo9XCIgYXBwOmdvLWJhY2tcIl0nKSAgICAmJiBcImJhY2tcIilcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWRpcikgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZWwgPSB0YXJnZXQubWF0Y2hQYXJlbnQoXCIud29ya3NwYWNlLWxlYWZcIik7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsZWFmID0gdGhpcy5sZWF2ZXMoKS5maWx0ZXIobGVhZiA9PiBsZWFmLmNvbnRhaW5lckVsID09PSBlbCkucG9wKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWxlYWYpIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV2dC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZXZ0LnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5kaXNwbGF5KGxlYWYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpc1tkaXJdLm9wZW5NZW51KGV2dCk7XG4gICAgICAgICAgICAgICAgICAgIH0sIHtjYXB0dXJlOiB0cnVlfVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICB0aGlzLnVuTnVtYmVyUGFuZXMoKTtcbiAgICAgICAgdGhpcy53aW4uZG9jdW1lbnQuYm9keS5maW5kQWxsKFwiLndvcmtzcGFjZS1sZWFmXCIpLmZvckVhY2gobGVhZkVsID0+IHtcbiAgICAgICAgICAgIC8vIFJlc3RvcmUgQ1BIQVRCIGJ1dHRvbiBsYWJlbHNcbiAgICAgICAgICAgIGNvbnN0IGFjdGlvbnMgPSBsZWFmRWwuZmluZChcIi52aWV3LWhlYWRlciA+IC52aWV3LWFjdGlvbnNcIik7XG4gICAgICAgICAgICBjb25zdCBmd2QgPSBhY3Rpb25zPy5maW5kKCcudmlldy1hY3Rpb25bY2xhc3MqPVwiIGFwcDpnby1mb3J3YXJkXCJdJyk7XG4gICAgICAgICAgICBjb25zdCBiYWNrID0gYWN0aW9ucz8uZmluZCgnLnZpZXctYWN0aW9uW2NsYXNzKj1cIiBhcHA6Z28tYmFja1wiXScpO1xuICAgICAgICAgICAgaWYgKGZ3ZCkgIHNldFRvb2x0aXAoZndkLCB0aGlzLmZvcndhcmQub2xkTGFiZWwpO1xuICAgICAgICAgICAgaWYgKGJhY2spIHNldFRvb2x0aXAoZndkLCB0aGlzLmJhY2sub2xkTGFiZWwpO1xuICAgICAgICB9KVxuICAgIH1cblxuICAgIHVuTnVtYmVyUGFuZXMoc2VsZWN0b3IgPSBcIi53b3Jrc3BhY2UtbGVhZlwiKSB7XG4gICAgICAgIHRoaXMud2luLmRvY3VtZW50LmJvZHkuZmluZEFsbChzZWxlY3RvcikuZm9yRWFjaChlbCA9PiB7XG4gICAgICAgICAgICBlbC5zdHlsZS5yZW1vdmVQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtbGFiZWxcIik7XG4gICAgICAgICAgICBlbC50b2dnbGVDbGFzcyhcImhhcy1wYW5lLXJlbGllZi1sYWJlbFwiLCBmYWxzZSk7XG4gICAgICAgICAgICBlbC5zdHlsZS5yZW1vdmVQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtZm9yd2FyZC1jb3VudFwiKTtcbiAgICAgICAgICAgIGVsLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1iYWNrd2FyZC1jb3VudFwiKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdXBkYXRlTGVhZihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBoaXN0b3J5OiBIaXN0b3J5ID0gSGlzdG9yeS5mb3JMZWFmKGxlYWYpKSB7XG4gICAgICAgIGxlYWYuY29udGFpbmVyRWwuc3R5bGUuc2V0UHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWZvcndhcmQtY291bnRcIiwgJ1wiJysoaGlzdG9yeS5sb29rQWhlYWQoKS5sZW5ndGggfHwgXCJcIikrJ1wiJyk7XG4gICAgICAgIGxlYWYuY29udGFpbmVyRWwuc3R5bGUuc2V0UHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWJhY2t3YXJkLWNvdW50XCIsICdcIicrKGhpc3RvcnkubG9va0JlaGluZCgpLmxlbmd0aCB8fCBcIlwiKSsnXCInKTtcblxuICAgICAgICAvLyBBZGQgbGFiZWxzIGZvciBDUEhBVEIgbmF2IGJ1dHRvbnNcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGxlYWYuY29udGFpbmVyRWwuZmluZChcIi52aWV3LWhlYWRlciA+IC52aWV3LWFjdGlvbnNcIik7XG4gICAgICAgIGNvbnN0IGZ3ZCA9IGFjdGlvbnM/LmZpbmQoJy52aWV3LWFjdGlvbltjbGFzcyo9XCIgYXBwOmdvLWZvcndhcmRcIl0nKTtcbiAgICAgICAgY29uc3QgYmFjayA9IGFjdGlvbnM/LmZpbmQoJy52aWV3LWFjdGlvbltjbGFzcyo9XCIgYXBwOmdvLWJhY2tcIl0nKTtcbiAgICAgICAgaWYgKGZ3ZCkgdGhpcy5mb3J3YXJkLnVwZGF0ZURpc3BsYXkoaGlzdG9yeSwgZndkKTtcbiAgICAgICAgaWYgKGJhY2spIHRoaXMuYmFjay51cGRhdGVEaXNwbGF5KGhpc3RvcnksIGJhY2spO1xuICAgIH1cblxuICAgIG51bWJlclBhbmVzKCkge1xuICAgICAgICB0aGlzLndpbi5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgICAgICAgICAgLy8gdW5udW1iZXIgc2lkZWJhciBwYW5lcyBpbiBtYWluIHdpbmRvdywgaWYgc29tZXRoaW5nIHdhcyBtb3ZlZCB0aGVyZVxuICAgICAgICAgICAgaWYgKHRoaXMud2luID09PSB3aW5kb3cpIHRoaXMudW5OdW1iZXJQYW5lcyhcIi53b3Jrc3BhY2UtdGFicyA+IC53b3Jrc3BhY2UtbGVhZlwiKTtcbiAgICAgICAgICAgIGxldCBjb3VudCA9IDAsIGxhc3RMZWFmOiBXb3Jrc3BhY2VMZWFmID0gbnVsbDtcbiAgICAgICAgICAgIHRoaXMubGVhdmVzKCkuZm9yRWFjaChsZWFmID0+IHtcbiAgICAgICAgICAgICAgICBsZWFmLmNvbnRhaW5lckVsLnN0eWxlLnNldFByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiLCArK2NvdW50IDwgOSA/IFwiXCIrY291bnQgOiBcIlwiKTtcbiAgICAgICAgICAgICAgICBsZWFmLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwiaGFzLXBhbmUtcmVsaWVmLWxhYmVsXCIsIGNvdW50PDkpO1xuICAgICAgICAgICAgICAgIGxhc3RMZWFmID0gbGVhZjtcbiAgICAgICAgICAgICAgICB0aGlzLnVwZGF0ZUxlYWYobGVhZik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmIChjb3VudD44KSB7XG4gICAgICAgICAgICAgICAgbGFzdExlYWY/LmNvbnRhaW5lckVsLnN0eWxlLnNldFByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiLCBcIjlcIik7XG4gICAgICAgICAgICAgICAgbGFzdExlYWY/LmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwiaGFzLXBhbmUtcmVsaWVmLWxhYmVsXCIsIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuICAgIH1cblxuICAgIG9uVXBkYXRlSGlzdG9yeShsZWFmOiBXb3Jrc3BhY2VMZWFmLCBoaXN0b3J5OiBIaXN0b3J5KSB7XG4gICAgICAgIHRoaXMud2luLnJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZUxlYWYobGVhZik7IC8vIHVwZGF0ZSBsZWFmJ3Mgc3RhdHMgYW5kIGJ1dHRvbnNcbiAgICAgICAgICAgIC8vIHVwZGF0ZSB3aW5kb3cncyBuYXYgYXJyb3dzXG4gICAgICAgICAgICBpZiAoaGlzdG9yeSA9PT0gdGhpcy5mb3J3YXJkLmhpc3RvcnkpIHRoaXMuZm9yd2FyZC5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgICAgICAgICAgaWYgKGhpc3RvcnkgPT09IHRoaXMuYmFjay5oaXN0b3J5KSAgICB0aGlzLmJhY2suc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5leHBvcnQgY2xhc3MgTmF2aWdhdG9yIGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIHN0YXRpYyBob3ZlclNvdXJjZSA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS1tZW51XCI7XG5cbiAgICBjb250YWluZXJFbDogSFRNTEVsZW1lbnRcbiAgICBjb3VudDogSFRNTFNwYW5FbGVtZW50XG4gICAgaGlzdG9yeTogSGlzdG9yeSA9IG51bGw7XG4gICAgc3RhdGVzOiBIaXN0b3J5RW50cnlbXTtcbiAgICBvbGRMYWJlbDogc3RyaW5nXG5cbiAgICBjb25zdHJ1Y3RvcihwdWJsaWMgb3duZXI6IE5hdmlnYXRpb24sIHB1YmxpYyBraW5kOiAnZm9yd2FyZCd8J2JhY2snLCBwdWJsaWMgZGlyOiBudW1iZXIpICB7XG4gICAgICAgIHN1cGVyKCk7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gdGhpcy5vd25lci53aW4uZG9jdW1lbnQuYm9keS5maW5kKFxuICAgICAgICAgICAgYC50aXRsZWJhciAudGl0bGViYXItYnV0dG9uLWNvbnRhaW5lci5tb2QtbGVmdCAudGl0bGViYXItYnV0dG9uLm1vZC0ke3RoaXMua2luZH1gXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY291bnQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZVNwYW4oe3ByZXBlbmQ6IHRoaXMua2luZCA9PT0gXCJiYWNrXCIsIGNsczogXCJoaXN0b3J5LWNvdW50ZXJcIn0pO1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBudWxsO1xuICAgICAgICB0aGlzLnN0YXRlcyA9IFtdO1xuICAgICAgICB0aGlzLm9sZExhYmVsID0gdGhpcy5jb250YWluZXJFbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQodGhpcy5jb250YWluZXJFbCwgXCJjb250ZXh0bWVudVwiLCB0aGlzLm9wZW5NZW51LmJpbmQodGhpcykpO1xuICAgICAgICBjb25zdCBvbkNsaWNrID0gKGU6IE1vdXNlRXZlbnQpID0+IHtcbiAgICAgICAgICAgIC8vIERvbid0IGFsbG93IE9ic2lkaWFuIHRvIHN3aXRjaCB3aW5kb3cgb3IgZm9yd2FyZCB0aGUgZXZlbnRcbiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgIC8vIERvIHRoZSBuYXZpZ2F0aW9uXG4gICAgICAgICAgICB0aGlzLmhpc3Rvcnk/Llt0aGlzLmtpbmRdKCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5yZWdpc3RlcigoKSA9PiB0aGlzLmNvbnRhaW5lckVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkNsaWNrLCB0cnVlKSk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uQ2xpY2ssIHRydWUpO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCkge1xuICAgICAgICBzZXRUb29sdGlwKHRoaXMuY29udGFpbmVyRWwsIHRoaXMub2xkTGFiZWwpO1xuICAgICAgICB0aGlzLmNvdW50LmRldGFjaCgpO1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc2V0Q291bnQobnVtOiBudW1iZXIpIHsgdGhpcy5jb3VudC50ZXh0Q29udGVudCA9IFwiXCIgKyAobnVtIHx8IFwiXCIpOyB9XG5cbiAgICBzZXRIaXN0b3J5KGhpc3RvcnkgPSBIaXN0b3J5LmN1cnJlbnQoKSkge1xuICAgICAgICB0aGlzLnVwZGF0ZURpc3BsYXkodGhpcy5oaXN0b3J5ID0gaGlzdG9yeSk7XG4gICAgfVxuXG4gICAgdXBkYXRlRGlzcGxheShoaXN0b3J5OiBIaXN0b3J5LCBlbCA9IHRoaXMuY29udGFpbmVyRWwpIHtcbiAgICAgICAgY29uc3Qgc3RhdGVzID0gdGhpcy5zdGF0ZXMgPSBoaXN0b3J5W3RoaXMuZGlyIDwgMCA/IFwibG9va0JlaGluZFwiIDogXCJsb29rQWhlYWRcIl0oKTtcbiAgICAgICAgaWYgKGVsPT09dGhpcy5jb250YWluZXJFbCkgdGhpcy5zZXRDb3VudChzdGF0ZXMubGVuZ3RoKTtcbiAgICAgICAgc2V0VG9vbHRpcChlbCwgc3RhdGVzLmxlbmd0aCA/XG4gICAgICAgICAgICB0aGlzLm9sZExhYmVsICsgXCJcXG5cIiArIHRoaXMuZm9ybWF0U3RhdGUoc3RhdGVzWzBdKS50aXRsZSA6XG4gICAgICAgICAgICBgTm8gJHt0aGlzLmtpbmR9IGhpc3RvcnlgXG4gICAgICAgICk7XG4gICAgICAgIGVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBzdGF0ZXMubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgb3Blbk1lbnUoZXZ0OiB7Y2xpZW50WDogbnVtYmVyLCBjbGllbnRZOiBudW1iZXJ9KSB7XG4gICAgICAgIGlmICghdGhpcy5zdGF0ZXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIGNvbnN0IG1lbnUgPSBuZXcgTWVudSgpO1xuICAgICAgICBtZW51LmRvbS5hZGRDbGFzcyhcInBhbmUtcmVsaWVmLWhpc3RvcnktbWVudVwiKTtcbiAgICAgICAgbWVudS5kb20ub24oXCJtb3VzZWRvd25cIiwgXCIubWVudS1pdGVtXCIsIGUgPT4ge2Uuc3RvcFByb3BhZ2F0aW9uKCk7fSwgdHJ1ZSk7XG4gICAgICAgIHRoaXMuc3RhdGVzLm1hcCh0aGlzLmZvcm1hdFN0YXRlLmJpbmQodGhpcykpLmZvckVhY2goXG4gICAgICAgICAgICAoaW5mbzogRmlsZUluZm8sIGlkeCkgPT4gdGhpcy5tZW51SXRlbShpbmZvLCBpZHgsIG1lbnUpXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGV2dC5jbGllbnRYLCB5OiBldnQuY2xpZW50WSArIDIwfSk7XG4gICAgICAgIHRoaXMub3duZXIuaGlzdG9yeUlzT3BlbiA9IHRydWU7XG4gICAgICAgIG1lbnUub25IaWRlKCgpID0+IHsgdGhpcy5vd25lci5oaXN0b3J5SXNPcGVuID0gZmFsc2U7IHRoaXMub3duZXIuZGlzcGxheSgpOyB9KTtcbiAgICB9XG5cbiAgICBtZW51SXRlbShpbmZvOiBGaWxlSW5mbywgaWR4OiBudW1iZXIsIG1lbnU6IE1lbnUpIHtcbiAgICAgICAgY29uc3QgbXkgPSB0aGlzO1xuICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiB7IGNyZWF0ZUl0ZW0oaSk7IGlmIChpbmZvLmZpbGUpIHNldHVwRmlsZUV2ZW50cyhpLmRvbSk7IH0pO1xuICAgICAgICByZXR1cm47XG5cbiAgICAgICAgZnVuY3Rpb24gY3JlYXRlSXRlbShpOiBNZW51SXRlbSwgcHJlZml4PVwiXCIpIHtcbiAgICAgICAgICAgIGkuc2V0SWNvbihpbmZvLmljb24pLnNldFRpdGxlKHByZWZpeCArIGluZm8udGl0bGUpLm9uQ2xpY2soZSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGhpc3RvcnkgPSBteS5oaXN0b3J5O1xuICAgICAgICAgICAgICAgIC8vIENoZWNrIGZvciBjdHJsL2NtZC9taWRkbGUgYnV0dG9uIGFuZCBzcGxpdCBsZWFmICsgY29weSBoaXN0b3J5XG4gICAgICAgICAgICAgICAgaWYgKEtleW1hcC5pc01vZGlmaWVyKGUsIFwiTW9kXCIpIHx8IDEgPT09IChlIGFzIE1vdXNlRXZlbnQpLmJ1dHRvbikge1xuICAgICAgICAgICAgICAgICAgICBoaXN0b3J5ID0gaGlzdG9yeS5jbG9uZVRvKGFwcC53b3Jrc3BhY2Uuc3BsaXRBY3RpdmVMZWFmKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBoaXN0b3J5LmdvKChpZHgrMSkgKiBteS5kaXIsIHRydWUpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBzZXR1cEZpbGVFdmVudHMoZG9tOiBIVE1MRWxlbWVudCkge1xuICAgICAgICAgICAgLy8gSG92ZXIgcHJldmlld1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlb3ZlcicsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGFwcC53b3Jrc3BhY2UudHJpZ2dlcignaG92ZXItbGluaycsIHtcbiAgICAgICAgICAgICAgICAgICAgZXZlbnQ6IGUsIHNvdXJjZTogTmF2aWdhdG9yLmhvdmVyU291cmNlLFxuICAgICAgICAgICAgICAgICAgICBob3ZlclBhcmVudDogbWVudS5kb20sIHRhcmdldEVsOiBkb20sIGxpbmt0ZXh0OiBpbmZvLmZpbGUucGF0aFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIERyYWcgbWVudSBpdGVtIHRvIG1vdmUgb3IgbGluayBmaWxlXG4gICAgICAgICAgICBkb20uc2V0QXR0cignZHJhZ2dhYmxlJywgJ3RydWUnKTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBkcmFnTWFuYWdlciA9IGFwcC5kcmFnTWFuYWdlcjtcbiAgICAgICAgICAgICAgICBjb25zdCBkcmFnRGF0YSA9IGRyYWdNYW5hZ2VyLmRyYWdGaWxlKGUsIGluZm8uZmlsZSk7XG4gICAgICAgICAgICAgICAgZHJhZ01hbmFnZXIub25EcmFnU3RhcnQoZSwgZHJhZ0RhdGEpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsIGUgPT4gbWVudS5oaWRlKCkpO1xuXG4gICAgICAgICAgICAvLyBGaWxlIG1lbnVcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKFwiY29udGV4dG1lbnVcIiwgZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgICAgICAgICAgbWVudS5hZGRJdGVtKGkgPT4gY3JlYXRlSXRlbShpLCBgR28gJHtteS5raW5kfSB0byBgKSkuYWRkU2VwYXJhdG9yKCk7XG4gICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS50cmlnZ2VyKFxuICAgICAgICAgICAgICAgICAgICBcImZpbGUtbWVudVwiLCBtZW51LCBpbmZvLmZpbGUsIFwibGluay1jb250ZXh0LW1lbnVcIlxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgbWVudS5zaG93QXRQb3NpdGlvbih7eDogZS5jbGllbnRYLCB5OiBlLmNsaWVudFl9KTtcbiAgICAgICAgICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOyAvLyBrZWVwIHRoZSBwYXJlbnQgbWVudSBvcGVuIGZvciBub3dcbiAgICAgICAgICAgIH0sIHRydWUpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZm9ybWF0U3RhdGUoZW50cnk6IEhpc3RvcnlFbnRyeSk6IEZpbGVJbmZvIHtcbiAgICAgICAgY29uc3Qge3ZpZXdTdGF0ZToge3R5cGUsIHN0YXRlfSwgZVN0YXRlLCBwYXRofSA9IGVudHJ5O1xuICAgICAgICBjb25zdCBmaWxlID0gcGF0aCAmJiBhcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpIGFzIFRGaWxlO1xuICAgICAgICBjb25zdCBpbmZvID0ge2ljb246IFwiXCIsIHRpdGxlOiBcIlwiLCBmaWxlLCB0eXBlLCBzdGF0ZSwgZVN0YXRlfTtcblxuICAgICAgICBpZiAobm9uRmlsZVZpZXdzW3R5cGVdKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IG5vbkZpbGVWaWV3c1t0eXBlXTtcbiAgICAgICAgfSBlbHNlIGlmIChwYXRoICYmICFmaWxlKSB7XG4gICAgICAgICAgICBbaW5mby5pY29uLCBpbmZvLnRpdGxlXSA9IFtcInRyYXNoXCIsIFwiTWlzc2luZyBmaWxlIFwiK3BhdGhdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xuICAgICAgICAgICAgaW5mby5pY29uID0gdmlld3R5cGVJY29uc1t0eXBlXSA/PyBcImRvY3VtZW50XCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtYXJrZG93blwiICYmIHN0YXRlLm1vZGUgPT09IFwicHJldmlld1wiKSBpbmZvLmljb24gPSBcImxpbmVzLW9mLXRleHRcIjtcbiAgICAgICAgICAgIGluZm8udGl0bGUgPSBmaWxlID8gZmlsZS5iYXNlbmFtZSArIChmaWxlLmV4dGVuc2lvbiAhPT0gXCJtZFwiID8gXCIuXCIrZmlsZS5leHRlbnNpb24gOiBcIlwiKSA6IFwiTm8gZmlsZVwiO1xuICAgICAgICAgICAgaWYgKHR5cGUgPT09IFwibWVkaWEtdmlld1wiICYmICFmaWxlKSBpbmZvLnRpdGxlID0gc3RhdGUuaW5mbz8uZmlsZW5hbWUgPz8gaW5mby50aXRsZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFwcC53b3Jrc3BhY2UudHJpZ2dlcihcInBhbmUtcmVsaWVmOmZvcm1hdC1oaXN0b3J5LWl0ZW1cIiwgaW5mbyk7XG4gICAgICAgIHJldHVybiBpbmZvO1xuICAgIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uRWxlbWVudDxLIGV4dGVuZHMga2V5b2YgSFRNTEVsZW1lbnRFdmVudE1hcD4oXG4gICAgZWw6IEhUTUxFbGVtZW50LFxuICAgIGV2ZW50OiBLLFxuICAgIHNlbGVjdG9yOiBzdHJpbmcsXG4gICAgY2FsbGJhY2s6ICh0aGlzOiBIVE1MRWxlbWVudCwgZXY6IEhUTUxFbGVtZW50RXZlbnRNYXBbS10sIGRlbGVnYXRlVGFyZ2V0OiBIVE1MRWxlbWVudCkgPT4gYW55LFxuICAgIG9wdGlvbnM/OiBib29sZWFuIHwgQWRkRXZlbnRMaXN0ZW5lck9wdGlvbnNcbikge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn1cblxuZnVuY3Rpb24gc2V0VG9vbHRpcChlbDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZykge1xuICAgIGlmICh0ZXh0KSBlbC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIHRleHQgfHwgdW5kZWZpbmVkKTtcbiAgICBlbHNlIGVsLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIik7XG59IiwiaW1wb3J0IHtQbHVnaW4sIFRGaWxlLCBXb3Jrc3BhY2VUYWJzfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2FkZENvbW1hbmRzLCBjb21tYW5kfSBmcm9tIFwiLi9jb21tYW5kc1wiO1xuaW1wb3J0IHtIaXN0b3J5LCBpbnN0YWxsSGlzdG9yeX0gZnJvbSBcIi4vSGlzdG9yeVwiO1xuaW1wb3J0IHtOYXZpZ2F0aW9uLCBOYXZpZ2F0b3IsIG9uRWxlbWVudH0gZnJvbSBcIi4vTmF2aWdhdG9yXCI7XG5cbmRlY2xhcmUgbW9kdWxlIFwib2JzaWRpYW5cIiB7XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZSB7XG4gICAgICAgIG9uKHR5cGU6IFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgY2FsbGJhY2s6IChsZWFmOiBXb3Jrc3BhY2VMZWFmLCBoaXN0b3J5OiBIaXN0b3J5KSA9PiBhbnksIGN0eD86IGFueSk6IEV2ZW50UmVmO1xuICAgICAgICByZWdpc3RlckhvdmVyTGlua1NvdXJjZShzb3VyY2U6IHN0cmluZywgaW5mbzoge2Rpc3BsYXk6IHN0cmluZywgZGVmYXVsdE1vZD86IGJvb2xlYW59KTogdm9pZFxuICAgICAgICB1bnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKHNvdXJjZTogc3RyaW5nKTogdm9pZFxuICAgICAgICBpdGVyYXRlTGVhdmVzKGNhbGxiYWNrOiAoaXRlbTogV29ya3NwYWNlTGVhZikgPT4gdW5rbm93biwgaXRlbTogV29ya3NwYWNlUGFyZW50KTogYm9vbGVhbjtcbiAgICAgICAgb25MYXlvdXRDaGFuZ2UoKTogdm9pZFxuICAgIH1cbiAgICBpbnRlcmZhY2UgQXBwIHtcbiAgICAgICAgcGx1Z2luczoge1xuICAgICAgICAgICAgcGx1Z2luczoge1xuICAgICAgICAgICAgICAgIFwib2JzaWRpYW4taG92ZXItZWRpdG9yXCI6IHtcbiAgICAgICAgICAgICAgICAgICAgYWN0aXZlUG9wb3ZlcnM6IEhvdmVyUG9wb3ZlcltdXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGludGVyZmFjZSBXb3Jrc3BhY2VJdGVtIHtcbiAgICAgICAgY29udGFpbmVyRWw6IEhUTUxEaXZFbGVtZW50XG4gICAgfVxuICAgIGludGVyZmFjZSBXb3Jrc3BhY2VQYXJlbnQge1xuICAgICAgICBjaGlsZHJlbjogV29ya3NwYWNlSXRlbVtdXG4gICAgICAgIHJlY29tcHV0ZUNoaWxkcmVuRGltZW5zaW9ucygpOiB2b2lkXG4gICAgfVxuICAgIGludGVyZmFjZSBXb3Jrc3BhY2VUYWJzIGV4dGVuZHMgV29ya3NwYWNlUGFyZW50IHtcbiAgICAgICAgc2VsZWN0VGFiKGxlYWY6IFdvcmtzcGFjZUxlYWYpOiB2b2lkXG4gICAgfVxuICAgIGludGVyZmFjZSBXb3Jrc3BhY2VMZWFmIHtcbiAgICAgICAgcGFyZW50U3BsaXQ6IFdvcmtzcGFjZVBhcmVudFxuICAgIH1cbiAgICBpbnRlcmZhY2UgSG92ZXJQb3BvdmVyIHtcbiAgICAgICAgbGVhZj86IFdvcmtzcGFjZUxlYWZcbiAgICAgICAgcm9vdFNwbGl0PzogV29ya3NwYWNlU3BsaXRcbiAgICAgICAgaG92ZXJFbDogSFRNTEVsZW1lbnRcbiAgICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBhbmVSZWxpZWYgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgbmF2ID0gTmF2aWdhdGlvbi5wZXJXaW5kb3codGhpcykud2F0Y2goKTtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgaW5zdGFsbEhpc3RvcnkodGhpcyk7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5yZWdpc3RlckhvdmVyTGlua1NvdXJjZShOYXZpZ2F0b3IuaG92ZXJTb3VyY2UsIHtcbiAgICAgICAgICAgIGRpc3BsYXk6ICdIaXN0b3J5IGRyb3Bkb3ducycsIGRlZmF1bHRNb2Q6IHRydWVcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC52YXVsdC5vbihcInJlbmFtZVwiLCAoZmlsZSwgb2xkUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKFxuICAgICAgICAgICAgICAgICAgICBsZWFmID0+IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS5vbihcImFjdGl2ZS1sZWFmLWNoYW5nZVwiLCBsZWFmID0+IHRoaXMubmF2LmZvckxlYWYobGVhZikuZGlzcGxheShsZWFmKSlcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS5vbihcInBhbmUtcmVsaWVmOnVwZGF0ZS1oaXN0b3J5XCIsIChsZWFmLCBoaXN0b3J5KSA9PiB0aGlzLm5hdi5mb3JMZWFmKGxlYWYpLm9uVXBkYXRlSGlzdG9yeShsZWFmLCBoaXN0b3J5KSlcbiAgICAgICAgICAgICk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGFkZENvbW1hbmRzKHRoaXMsIHtcbiAgICAgICAgICAgIFtjb21tYW5kKFwic3dhcC1wcmV2XCIsIFwiU3dhcCBwYW5lIHdpdGggcHJldmlvdXMgaW4gc3BsaXRcIiwgIFwiTW9kK1NoaWZ0K1BhZ2VVcFwiKV0gICAoKXsgcmV0dXJuIHRoaXMubGVhZlBsYWNlcigtMSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtbmV4dFwiLCBcIlN3YXAgcGFuZSB3aXRoIG5leHQgaW4gc3BsaXRcIiwgICAgICBcIk1vZCtTaGlmdCtQYWdlRG93blwiKV0gKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoIDEpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLXByZXZcIiwgIFwiQ3ljbGUgdG8gcHJldmlvdXMgd29ya3NwYWNlIHBhbmVcIiwgICBcIk1vZCtQYWdlVXBcIiAgKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigtMSwgdHJ1ZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLW5leHRcIiwgIFwiQ3ljbGUgdG8gbmV4dCB3b3Jrc3BhY2UgcGFuZVwiLCAgICAgICBcIk1vZCtQYWdlRG93blwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZiggMSwgdHJ1ZSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLXByZXZcIiwgXCJDeWNsZSB0byBwcmV2aW91cyB3aW5kb3dcIiwgW10gKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coLTEsIHRydWUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tbmV4dFwiLCBcIkN5Y2xlIHRvIG5leHQgd2luZG93XCIsICAgICBbXSApXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdyggMSwgdHJ1ZSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tMXN0XCIsICAgXCJKdW1wIHRvIDFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzFcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTJuZFwiLCAgIFwiSnVtcCB0byAybmQgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsyXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0zcmRcIiwgICBcIkp1bXAgdG8gM3JkIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrM1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigyKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNHRoXCIsICAgXCJKdW1wIHRvIDR0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzRcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTV0aFwiLCAgIFwiSnVtcCB0byA1dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs1XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDQpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby02dGhcIiwgICBcIkp1bXAgdG8gNnRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig1KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tN3RoXCIsICAgXCJKdW1wIHRvIDd0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzdcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTh0aFwiLCAgIFwiSnVtcCB0byA4dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs4XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDcpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1sYXN0XCIsICBcIkp1bXAgdG8gbGFzdCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgXCJBbHQrOVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig5OTk5OTk5OSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTFzdFwiLCAgIFwiU3dpdGNoIHRvIDFzdCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coMCk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi0ybmRcIiwgICBcIlN3aXRjaCB0byAybmQgd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tM3JkXCIsICAgXCJTd2l0Y2ggdG8gM3JkIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdygyKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTR0aFwiLCAgIFwiU3dpdGNoIHRvIDR0aCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coMyk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi01dGhcIiwgICBcIlN3aXRjaCB0byA1dGggd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDQpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tNnRoXCIsICAgXCJTd2l0Y2ggdG8gNnRoIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdyg1KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTd0aFwiLCAgIFwiU3dpdGNoIHRvIDd0aCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coNik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi04dGhcIiwgICBcIlN3aXRjaCB0byA4dGggd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDcpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tbGFzdFwiLCAgXCJTd2l0Y2ggdG8gbGFzdCB3aW5kb3dcIiwgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdyg5OTk5OTk5OSk7IH0sXG5cbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTFzdFwiLCAgXCJQbGFjZSBhcyAxc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigwLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0ybmRcIiwgIFwiUGxhY2UgYXMgMm5kIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMSwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtM3JkXCIsICBcIlBsYWNlIGFzIDNyZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDIsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTR0aFwiLCAgXCJQbGFjZSBhcyA0dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigzLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC01dGhcIiwgIFwiUGxhY2UgYXMgNXRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNnRoXCIsICBcIlBsYWNlIGFzIDZ0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDUsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTd0aFwiLCAgXCJQbGFjZSBhcyA3dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig2LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC04dGhcIiwgIFwiUGxhY2UgYXMgOHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtbGFzdFwiLCBcIlBsYWNlIGFzIGxhc3QgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgXCJNb2QrQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDk5OTk5OTk5LCBmYWxzZSk7IH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgb251bmxvYWQoKSB7XG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS51bnJlZ2lzdGVySG92ZXJMaW5rU291cmNlKE5hdmlnYXRvci5ob3ZlclNvdXJjZSk7XG4gICAgfVxuXG4gICAgZ290b050aExlYWYobjogbnVtYmVyLCByZWxhdGl2ZTogYm9vbGVhbikge1xuICAgICAgICBjb25zdCBuYXYgPSB0aGlzLm5hdi5mb3JMZWFmKGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZik7XG4gICAgICAgIGNvbnN0IGxlYWYgPSBnb3RvTnRoKG5hdi5sZWF2ZXMoKSwgdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYsIG4sIHJlbGF0aXZlKTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgZ290b050aFdpbmRvdyhuOiBudW1iZXIsIHJlbGF0aXZlOiBib29sZWFuKSB7XG4gICAgICAgIGNvbnN0IG5hdiA9IGdvdG9OdGgodGhpcy5uYXYuZm9yQWxsKCksIHRoaXMubmF2LmZvckxlYWYoYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSwgbiwgcmVsYXRpdmUpO1xuICAgICAgICBjb25zdCBsZWFmID0gbmF2Py5sYXRlc3RMZWFmKCk7XG4gICAgICAgIGlmIChsZWFmKSBhcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgICAgIChuYXY/LndpbiBhcyBhbnkpLnJlcXVpcmU/LignZWxlY3Ryb24nKT8ucmVtb3RlPy5nZXRDdXJyZW50V2luZG93KCk/LmZvY3VzKCk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zOiBudW1iZXIsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgY2IgPSB0aGlzLmxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlKTtcbiAgICAgICAgaWYgKGNiKSBjYigpO1xuICAgIH1cblxuICAgIGxlYWZQbGFjZXIodG9Qb3M6IG51bWJlciwgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWY7XG4gICAgICAgIGlmICghbGVhZikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGNvbnN0XG4gICAgICAgICAgICBwYXJlbnRTcGxpdCA9IGxlYWYucGFyZW50U3BsaXQsXG4gICAgICAgICAgICBjaGlsZHJlbiA9IHBhcmVudFNwbGl0LmNoaWxkcmVuLFxuICAgICAgICAgICAgZnJvbVBvcyA9IGNoaWxkcmVuLmluZGV4T2YobGVhZilcbiAgICAgICAgO1xuICAgICAgICBpZiAoZnJvbVBvcyA9PSAtMSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICAgICAgdG9Qb3MgKz0gZnJvbVBvcztcbiAgICAgICAgICAgIGlmICh0b1BvcyA8IDAgfHwgdG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPj0gY2hpbGRyZW4ubGVuZ3RoKSB0b1BvcyA9IGNoaWxkcmVuLmxlbmd0aCAtIDE7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwKSB0b1BvcyA9IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZnJvbVBvcyA9PSB0b1BvcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvdGhlciA9IGNoaWxkcmVuW3RvUG9zXTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZShmcm9tUG9zLCAxKTtcbiAgICAgICAgICAgIGNoaWxkcmVuLnNwbGljZSh0b1BvcywgICAwLCBsZWFmKTtcbiAgICAgICAgICAgIGlmICgocGFyZW50U3BsaXQgYXMgV29ya3NwYWNlVGFicykuc2VsZWN0VGFiKSB7XG4gICAgICAgICAgICAgICAgKHBhcmVudFNwbGl0IGFzIFdvcmtzcGFjZVRhYnMpLnNlbGVjdFRhYihsZWFmKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb3RoZXIuY29udGFpbmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KGZyb21Qb3MgPiB0b1BvcyA/IFwiYmVmb3JlYmVnaW5cIiA6IFwiYWZ0ZXJlbmRcIiwgbGVhZi5jb250YWluZXJFbCk7XG4gICAgICAgICAgICAgICAgcGFyZW50U3BsaXQucmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk7XG4gICAgICAgICAgICAgICAgbGVhZi5vblJlc2l6ZSgpO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dENoYW5nZSgpO1xuXG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgZm9jdXMgYmFjayB0byBwYW5lO1xuICAgICAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uuc2V0QWN0aXZlTGVhZihsZWFmLCBmYWxzZSwgdHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGlzU3ludGhldGljSGlzdG9yeUV2ZW50KGJ1dHRvbjogbnVtYmVyKSB7XG4gICAgICAgIGNvbnN0IHdpbiA9IHRoaXMubmF2LndpbmRvd3MoKS5maWx0ZXIod2luID0+XG4gICAgICAgICAgICB3aW4uZXZlbnQgJiYgKHdpbi5ldmVudCBhcyBNb3VzZUV2ZW50KS5idXR0b24gPT09IGJ1dHRvblxuICAgICAgICApLnBvcCgpO1xuICAgICAgICBpZiAod2luICYmIHdpbi5ldmVudC50eXBlID09PSBcIm1vdXNlZG93blwiKSB7XG4gICAgICAgICAgICB3aW4uZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIHdpbi5ldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGdvdG9OdGg8VD4oaXRlbXM6IFRbXSwgY3VycmVudDogVCwgbjogbnVtYmVyLCByZWxhdGl2ZTogYm9vbGVhbik6IFQge1xuICAgIGlmIChyZWxhdGl2ZSkge1xuICAgICAgICBuICs9IGl0ZW1zLmluZGV4T2YoY3VycmVudCk7XG4gICAgICAgIG4gPSAobiArIGl0ZW1zLmxlbmd0aCkgJSBpdGVtcy5sZW5ndGg7ICAvLyB3cmFwIGFyb3VuZFxuICAgIH1cbiAgICByZXR1cm4gaXRlbXNbbiA+PSBpdGVtcy5sZW5ndGggPyBpdGVtcy5sZW5ndGgtMSA6IG5dO1xufSJdLCJuYW1lcyI6WyJOb3RpY2UiLCJXb3Jrc3BhY2VMZWFmIiwiQ29tcG9uZW50IiwiTWVudSIsIktleW1hcCIsIlRGaWxlIiwiUGx1Z2luIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUE7QUFNQSxNQUFNLFFBQVEsR0FBNEIsRUFBRSxDQUFDO0FBRTdCLFNBQUEsT0FBTyxDQUFDLEVBQVUsRUFBRSxJQUFZLEVBQUUsT0FBQSxHQUE2QixFQUFFLEVBQUUsR0FBRyxHQUFDLEVBQUUsRUFBQTs7O0lBSXJGLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUTtBQUFFLFFBQUEsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDckQsSUFBQSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsSUFBSyxPQUFrQixDQUFDLEdBQUc7QUFBRSxRQUFBLE9BQU8sR0FBRyxDQUFDLE9BQWlCLENBQUMsQ0FBQztBQUUxRixJQUFBLElBQUksSUFBSSxHQUFjLE9BQW9CLENBQUMsR0FBRyxDQUFDLFVB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QUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVB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
