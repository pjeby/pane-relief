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
    isEmpty() {
        const viewState = JSON.parse(this.raw.state || "{}");
        return (viewState.type === "empty");
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
        const entry = this.stack[this.pos];
        if (entry && entry.isEmpty())
            return this.replaceState(rawState, title, url);
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
 * Efficiently update a class on a workspace item, only touching where changes are needed
 *
 * @param el The element to add or remove the class from
 * @param cls The class to add or remove
 * @param state Boolean, flag to add or remove, defaults to opposite of current state
 * @returns boolean for the state of the class afterwards
 */
function toggleClass(el, cls, state) {
    const had = el.classList.contains(cls);
    state = state ?? !had;
    if (state !== had) {
        state ? el.classList.add(cls) : el.classList.remove(cls);
    }
    return state;
}
class Maximizer extends obsidian.Component {
    constructor() {
        super(...arguments);
        this.fixSlidingPanes = obsidian.debounce(() => {
            if (app.plugins.plugins["sliding-panes-obsidian"]) {
                app.workspace.onLayoutChange();
                app.workspace.requestActiveLeafEvents();
            }
        }, 5);
    }
    onload() {
        this.registerEvent(app.workspace.on("layout-change", () => {
            for (const parent of this.parents())
                this.refresh(parent);
        }));
        const self = this;
        this.register(around(app.workspace, {
            setActiveLeaf(old) {
                return function setActiveLeaf(leaf, pushHistory, focus) {
                    // We have to do this here so that MarkdownView can be focused in the new pane
                    const parent = self.parentForLeaf(leaf), oldParent = self.parentForLeaf(app.workspace.activeLeaf);
                    if (parent && oldParent && parent !== oldParent &&
                        oldParent.matchParent(".hover-popover.is-active.snap-to-viewport") &&
                        parent.ownerDocument === oldParent.ownerDocument &&
                        !parent.matchParent(".hover-popover")) {
                        // Switching from maximized popover to non-popover; de-maximize it first
                        app.commands.executeCommandById("obsidian-hover-editor:restore-active-popover");
                    }
                    if (parent)
                        self.refresh(parent, parent.hasClass("should-maximize") ? leaf.containerEl : null);
                    return old.call(this, leaf, pushHistory, focus);
                };
            }
        }));
    }
    onunload() {
        // Un-maximize all panes
        for (const parent of this.parents())
            this.refresh(parent, null);
    }
    toggleMaximize(leaf = app.workspace.activeLeaf) {
        const parent = this.parentForLeaf(leaf);
        if (!parent)
            return;
        const popoverEl = parent.matchParent(".hover-popover");
        if (popoverEl && app.plugins.plugins["obsidian-hover-editor"]) {
            // Check if single leaf in a popover
            let count = popoverEl.findAll(".workspace-leaf").length;
            if (count === 1) {
                // Maximize or restore the popover instead of the leaf
                app.commands.executeCommandById("obsidian-hover-editor:" + (popoverEl.hasClass("snap-to-viewport") ? "restore-active-popover" : "snap-active-popover-to-viewport"));
                return;
            }
        }
        if (parent)
            this.refresh(parent, toggleClass(parent, "should-maximize") ? leaf.containerEl : null);
    }
    lastMaximized(parent) {
        return parent.find(".workspace-leaf.is-maximized") || app.workspace.getMostRecentLeaf().containerEl;
    }
    refresh(parent, leafEl = parent.hasClass("should-maximize") ? this.lastMaximized(parent) : null) {
        const hadMax = parent.hasClass("has-maximized");
        parent.findAllSelf(".workspace-split").forEach(split => {
            if (split === parent || this.parentFor(split) === parent)
                toggleClass(split, "has-maximized", leafEl ? split.contains(leafEl) : false);
        });
        parent.findAll(".workspace-leaf").forEach(leaf => {
            if (this.parentFor(leaf) === parent)
                toggleClass(leaf, "is-maximized", leaf === leafEl);
        });
        if (!leafEl || !parent.contains(leafEl)) {
            toggleClass(parent, "should-maximize", false);
            if (hadMax)
                this.fixSlidingPanes();
        }
    }
    parents() {
        const parents = [app.workspace.rootSplit.containerEl];
        parents.concat((app.workspace.floatingSplit?.children ?? []).map(i => i.containerEl));
        const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers)
            for (const popover of popovers) {
                if (popover.rootSplit)
                    parents.push(popover.rootSplit.containerEl);
            }
        return parents;
    }
    parentForLeaf(leaf) {
        return this.parentFor(leaf.containerEl);
    }
    parentFor(el) {
        return el.matchParent(".workspace-split.mod-root, .hover-popover > .popover-content > .workspace-split");
    }
}

//import { use } from "ophidian";
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
    /*static [use.me]<T extends PerWindowComponent<P>, P extends Plugin>(
        key: new (plugin: P, win: Window) => T
    ) {
        return this.perWindow(use(Plugin));
    }*/
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
                workspace.onLayoutReady(() => Promise.resolve().then(() => this.forWindow(win)));
            }));
            workspace.onLayoutReady(() => Promise.resolve().then(() => this.forAll()));
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
            if (leaf)
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
        this.register(
        // Support "Customizable Page Header and Title Bar" buttons
        onElement(this.owner.win.document.body, "contextmenu", `.view-header > .view-actions > .view-action[class*="app:go-${this.kind}"]`, (evt, target) => {
            const el = target.matchParent(".workspace-leaf");
            const leaf = this.owner.leaves().filter(leaf => leaf.containerEl === el).pop();
            if (!leaf)
                return;
            evt.preventDefault();
            evt.stopImmediatePropagation();
            this.openMenu(evt, History.forLeaf(leaf));
        }, { capture: true }));
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
        const states = history[this.dir < 0 ? "lookBehind" : "lookAhead"]();
        if (el === this.containerEl)
            this.setCount(states.length);
        setTooltip(el, states.length ?
            this.oldLabel + "\n" + this.formatState(states[0]).title :
            `No ${this.kind} history`);
        el.toggleClass("mod-active", states.length > 0);
    }
    openMenu(evt, history = this.history) {
        const states = history[this.dir < 0 ? "lookBehind" : "lookAhead"]();
        if (!states.length)
            return;
        const menu = new obsidian.Menu();
        menu.dom.addClass("pane-relief-history-menu");
        menu.dom.on("mousedown", ".menu-item", e => { e.stopPropagation(); }, true);
        states.map(this.formatState.bind(this)).forEach((info, idx) => this.menuItem(info, idx, menu, history));
        menu.showAtPosition({ x: evt.clientX, y: evt.clientY + 20 });
        this.owner.historyIsOpen = true;
        menu.onHide(() => { this.owner.historyIsOpen = false; this.owner.display(); });
    }
    menuItem(info, idx, menu, history) {
        const { dir, kind } = this;
        menu.addItem(i => { createItem(i); if (info.file)
            setupFileEvents(i.dom); });
        return;
        function createItem(i, prefix = "") {
            i.setIcon(info.icon).setTitle(prefix + info.title).onClick(e => {
                // Check for ctrl/cmd/middle button and split leaf + copy history
                if (obsidian.Keymap.isModifier(e, "Mod") || 1 === e.button) {
                    history = history.cloneTo(app.workspace.splitActiveLeaf());
                }
                history.go((idx + 1) * dir, true);
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
                menu.addItem(i => createItem(i, `Go ${kind} to `)).addSeparator();
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
        this.max = this.addChild(new Maximizer);
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
            [command("put-last", "Place as last pane in the split", "Mod+Alt+9")]() { return () => this.placeLeaf(99999999, false); },
            [command("maximize", "Maximize active pane (Toggle)", [])]() {
                if (this.max.parentForLeaf(app.workspace.activeLeaf))
                    return () => this.max.toggleMaximize();
            },
        });
    }
    onunload() {
        this.app.workspace.unregisterHoverLinkSource(Navigator.hoverSource);
    }
    gotoNthLeaf(n, relative) {
        let leaf = app.workspace.activeLeaf;
        const root = leaf.getRoot();
        if (root === app.workspace.leftSplit || root === app.workspace.rightSplit) {
            // Workaround for 0.15.3 sidebar tabs stealing focus
            leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
        }
        const nav = this.nav.forLeaf(leaf);
        leaf = gotoNth(nav.leaves(), leaf, n, relative);
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
        if (children.length === 1) {
            const popoverEl = leaf.containerEl.matchParent(".hover-popover");
            if (popoverEl && relative && Math.abs(toPos) === 1) {
                // Allow swapping popovers in the stack
                let neighbor = popoverEl;
                while (neighbor && (neighbor === popoverEl || !neighbor.matches(".hover-popover")))
                    neighbor = toPos < 0 ? neighbor.previousElementSibling : neighbor.nextElementSibling;
                if (neighbor)
                    return () => {
                        if (toPos < 0)
                            neighbor.parentElement.insertBefore(popoverEl, neighbor);
                        else
                            neighbor.parentElement.insertBefore(neighbor, popoverEl);
                        app.workspace.onLayoutChange();
                    };
            }
        }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL2NvbW1hbmRzLnRzIiwibm9kZV9tb2R1bGVzLy5wbnBtL21vbmtleS1hcm91bmRAMi4zLjAvbm9kZV9tb2R1bGVzL21vbmtleS1hcm91bmQvbWpzL2luZGV4LmpzIiwic3JjL0hpc3RvcnkudHMiLCJzcmMvbWF4aW1pemluZy50cyIsInNyYy9QZXJXaW5kb3dDb21wb25lbnQudHMiLCJzcmMvTmF2aWdhdG9yLnRzIiwic3JjL3BhbmUtcmVsaWVmLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFNpbXBsaWZpZWQgQ29tbWFuZHMgRnJhbWV3b3JrXG5cbmltcG9ydCB7Q29tbWFuZCwgSG90a2V5LCBNb2RpZmllciwgUGx1Z2lufSBmcm9tIFwib2JzaWRpYW5cIlxuXG50eXBlIEtleURlZiA9IEhvdGtleSB8IHN0cmluZ1xuXG5jb25zdCBjb21tYW5kczogUmVjb3JkPHN5bWJvbCwgQ29tbWFuZD4gPSB7fTsgLy9uZXcgTWFwO1xuXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZChpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGhvdGtleXM6IEtleURlZiB8IEtleURlZltdID0gW10sIGNtZD17fSkge1xuXG4gICAgLy8gQWxsb3cgaG90a2V5cyB0byBiZSBleHByZXNzZWQgYXMgYSBzdHJpbmcsIGFycmF5IG9mIHN0cmluZ3MsXG4gICAgLy8gb2JqZWN0LCBvciBhcnJheSBvZiBvYmplY3RzLiAgKE5vcm1hbGl6ZSB0byBhbiBhcnJheSBmaXJzdC4pXG4gICAgaWYgKHR5cGVvZiBob3RrZXlzID09PSBcInN0cmluZ1wiKSBob3RrZXlzID0gW2hvdGtleXNdO1xuICAgIGlmICh0eXBlb2YgaG90a2V5cyA9PT0gXCJvYmplY3RcIiAmJiAoaG90a2V5cyBhcyBIb3RrZXkpLmtleSkgaG90a2V5cyA9IFtob3RrZXlzIGFzIEhvdGtleV07XG5cbiAgICBsZXQga2V5czogSG90a2V5W10gPSAoaG90a2V5cyBhcyBLZXlEZWZbXSkubWFwKGZ1bmN0aW9uKGtleSk6IEhvdGtleSB7XG4gICAgICAgIC8vIElmIGEgaG90a2V5IGlzIGFuIG9iamVjdCBhbHJlYWR5LCBubyBuZWVkIHRvIHByb2Nlc3MgaXRcbiAgICAgICAgaWYgKHR5cGVvZiBrZXkgPT09IFwib2JqZWN0XCIpIHJldHVybiBrZXk7XG4gICAgICAgIC8vIENvbnZlcnQgc3RyaW5ncyB0byBPYnNpZGlhbidzIGhvdGtleSBmb3JtYXRcbiAgICAgICAgbGV0IHBhcnRzID0ga2V5LnNwbGl0KFwiK1wiKVxuICAgICAgICByZXR1cm4geyBtb2RpZmllcnM6IHBhcnRzIGFzIE1vZGlmaWVyW10sIGtleTogcGFydHMucG9wKCkgfHwgXCIrXCIgfSAgLy8gZW1wdHkgbGFzdCBwYXJ0ID0gZS5nLiAnTW9kKysnXG4gICAgfSk7XG4gICAgT2JqZWN0LmFzc2lnbihjbWQsIHtpZCwgbmFtZSwgaG90a2V5czoga2V5c30pO1xuXG4gICAgLy8gU2F2ZSB0aGUgY29tbWFuZCBkYXRhIHVuZGVyIGEgdW5pcXVlIHN5bWJvbFxuICAgIGNvbnN0IHN5bSA9IFN5bWJvbChcImNtZDpcIiArIGlkKTtcbiAgICBjb21tYW5kc1tzeW1dID0gY21kIGFzIENvbW1hbmQ7XG4gICAgcmV0dXJuIHN5bTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbW1hbmRzPFAgZXh0ZW5kcyBQbHVnaW4+KFxuICAgIHBsdWdpbjogUCxcbiAgICBjbWRzZXQ6IFJlY29yZDxzeW1ib2wsICh0aGlzQXJnOiBQKSA9PiBib29sZWFuIHwgKCgpID0+IGFueSk+XG4pIHtcbiAgICAvLyBFeHRyYWN0IGNvbW1hbmQgc3ltYm9scyBmcm9tIGNtZHNldCBhbmQgcmVnaXN0ZXIgdGhlbSwgYm91bmQgdG8gdGhlIHBsdWdpbiBmb3IgbWV0aG9kc1xuICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eVN5bWJvbHMoY21kc2V0KS5mb3JFYWNoKHN5bSA9PiB7XG4gICAgICAgIGNvbnN0IGNtZCA9IGNvbW1hbmRzW3N5bV0sIG1ldGhvZCA9IGNtZHNldFtzeW1dO1xuICAgICAgICBpZiAoY21kKSBwbHVnaW4uYWRkQ29tbWFuZChPYmplY3QuYXNzaWduKHt9LCBjbWQsIHtcbiAgICAgICAgICAgIGNoZWNrQ2FsbGJhY2soY2hlY2s6IGJvb2xlYW4pIHtcbiAgICAgICAgICAgICAgICAvLyBDYWxsIHRoZSBtZXRob2QgYm9keSB3aXRoIHRoZSBwbHVnaW4gYXMgJ3RoaXMnXG4gICAgICAgICAgICAgICAgY29uc3QgY2IgPSBtZXRob2QuY2FsbChwbHVnaW4pO1xuICAgICAgICAgICAgICAgIC8vIEl0IHRoZW4gcmV0dXJucyBhIGNsb3N1cmUgaWYgdGhlIGNvbW1hbmQgaXMgcmVhZHkgdG8gZXhlY3V0ZSwgYW5kXG4gICAgICAgICAgICAgICAgLy8gd2UgY2FsbCB0aGF0IGNsb3N1cmUgdW5sZXNzIHRoaXMgaXMganVzdCBhIGNoZWNrIGZvciBhdmFpbGFiaWxpdHlcbiAgICAgICAgICAgICAgICByZXR1cm4gKGNoZWNrIHx8IHR5cGVvZiBjYiAhPT0gXCJmdW5jdGlvblwiKSA/ICEhY2IgOiAoY2IoKSwgdHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pKTtcbiAgICB9KVxufSIsImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGRlZHVwZShrZXksIG9sZEZuLCBuZXdGbikge1xuICAgIGNoZWNrW2tleV0gPSBrZXk7XG4gICAgcmV0dXJuIGNoZWNrO1xuICAgIGZ1bmN0aW9uIGNoZWNrKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIChvbGRGbltrZXldID09PSBrZXkgPyBvbGRGbiA6IG5ld0ZuKS5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9XG59XG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXIocHJvbWlzZSwgY2IpIHtcbiAgICByZXR1cm4gcHJvbWlzZS50aGVuKGNiLCBjYik7XG59XG5leHBvcnQgZnVuY3Rpb24gc2VyaWFsaXplKGFzeW5jRnVuY3Rpb24pIHtcbiAgICBsZXQgbGFzdFJ1biA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4ge1xuICAgICAgICAgICAgYWZ0ZXIobGFzdFJ1biwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGFzeW5jRnVuY3Rpb24uYXBwbHkodGhpcywgYXJncykudGhlbihyZXMsIHJlaik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdyYXBwZXIuYWZ0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiBsYXN0UnVuID0gbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGFmdGVyKGxhc3RSdW4sIHJlcyk7IH0pO1xuICAgIH07XG4gICAgcmV0dXJuIHdyYXBwZXI7XG59XG4iLCJpbXBvcnQge05vdGljZSwgVEFic3RyYWN0RmlsZSwgVmlld1N0YXRlLCBXb3Jrc3BhY2VMZWFmfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcbmltcG9ydCBQYW5lUmVsaWVmIGZyb20gXCIuL3BhbmUtcmVsaWVmXCI7XG5cbmNvbnN0IEhJU1RfQVRUUiA9IFwicGFuZS1yZWxpZWY6aGlzdG9yeS12MVwiO1xuY29uc3QgU0VSSUFMX1BST1AgPSBcInBhbmUtcmVsaWVmOmhpc3RvcnktdjFcIjtcblxuZGVjbGFyZSBtb2R1bGUgXCJvYnNpZGlhblwiIHtcbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlIHtcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQoc3RhdGU6IGFueSwgLi4uZXRjOiBhbnlbXSk6IFByb21pc2U8V29ya3NwYWNlSXRlbT5cbiAgICB9XG5cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlTGVhZiB7XG4gICAgICAgIFtISVNUX0FUVFJdOiBIaXN0b3J5XG4gICAgICAgIHBpbm5lZDogYm9vbGVhblxuICAgICAgICB3b3JraW5nOiBib29sZWFuXG4gICAgICAgIHNlcmlhbGl6ZSgpOiBhbnlcbiAgICB9XG5cbiAgICBpbnRlcmZhY2UgVmlld1N0YXRlIHtcbiAgICAgICAgcG9wc3RhdGU/OiBib29sZWFuXG4gICAgfVxufVxuXG5cbmV4cG9ydCBjb25zdCBkb21MZWF2ZXMgPSBuZXcgV2Vha01hcCgpO1xuXG5pbnRlcmZhY2UgUHVzaFN0YXRlIHtcbiAgICBzdGF0ZTogc3RyaW5nXG4gICAgZVN0YXRlOiBzdHJpbmdcbn1cblxuZXhwb3J0IGNsYXNzIEhpc3RvcnlFbnRyeSB7XG5cbiAgICByYXc6IFB1c2hTdGF0ZVxuICAgIGVTdGF0ZTogYW55XG4gICAgcGF0aDogc3RyaW5nXG5cbiAgICBjb25zdHJ1Y3RvcihyYXdTdGF0ZTogUHVzaFN0YXRlKSB7XG4gICAgICAgIHRoaXMuc2V0U3RhdGUocmF3U3RhdGUpO1xuICAgIH1cblxuXG4gICAgZ2V0IHZpZXdTdGF0ZSgpIHtcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UodGhpcy5yYXcuc3RhdGUgfHwgXCJ7fVwiKVxuICAgIH1cblxuICAgIHNldFN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUpIHtcbiAgICAgICAgdGhpcy5yYXcgPSByYXdTdGF0ZTtcbiAgICAgICAgdGhpcy5lU3RhdGUgPSBKU09OLnBhcnNlKHJhd1N0YXRlLmVTdGF0ZSB8fCBcIm51bGxcIik7XG4gICAgICAgIHRoaXMucGF0aCA9IHRoaXMudmlld1N0YXRlLnN0YXRlPy5maWxlO1xuICAgIH1cblxuICAgIG9uUmVuYW1lKGZpbGU6IFRBYnN0cmFjdEZpbGUsIG9sZFBhdGg6IHN0cmluZykge1xuICAgICAgICBpZiAodGhpcy5wYXRoID09PSBvbGRQYXRoKSB7XG4gICAgICAgICAgICBjb25zdCB2aWV3U3RhdGUgPSB0aGlzLnZpZXdTdGF0ZVxuICAgICAgICAgICAgdGhpcy5wYXRoID0gdmlld1N0YXRlLnN0YXRlLmZpbGUgPSBmaWxlLnBhdGhcbiAgICAgICAgICAgIHRoaXMucmF3LnN0YXRlID0gSlNPTi5zdHJpbmdpZnkodmlld1N0YXRlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvKGxlYWY/OiBXb3Jrc3BhY2VMZWFmKSB7XG4gICAgICAgIGxldCB7dmlld1N0YXRlLCBwYXRoLCBlU3RhdGV9ID0gdGhpcztcbiAgICAgICAgbGV0IGZpbGUgPSBwYXRoICYmIGFwcD8udmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuICAgICAgICBpZiAocGF0aCAmJiAhZmlsZSkge1xuICAgICAgICAgICAgbmV3IE5vdGljZShcIk1pc3NpbmcgZmlsZTogXCIrcGF0aCk7XG4gICAgICAgICAgICB2aWV3U3RhdGUgPSB7dHlwZTogXCJlbXB0eVwiLCBzdGF0ZTp7fX07XG4gICAgICAgICAgICBlU3RhdGUgPSB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgbGVhZi5zZXRWaWV3U3RhdGUoey4uLnZpZXdTdGF0ZSwgYWN0aXZlOiB0cnVlLCBwb3BzdGF0ZTogdHJ1ZX0sIGVTdGF0ZSk7XG4gICAgfVxuXG4gICAgaXNFbXB0eSgpIHtcbiAgICAgICAgY29uc3Qgdmlld1N0YXRlID0gSlNPTi5wYXJzZSh0aGlzLnJhdy5zdGF0ZSB8fCBcInt9XCIpO1xuICAgICAgICByZXR1cm4gKHZpZXdTdGF0ZS50eXBlID09PSBcImVtcHR5XCIpO1xuICAgIH1cblxuICAgIHJlcGxhY2VTdGF0ZShyYXdTdGF0ZTogUHVzaFN0YXRlKSB7XG4gICAgICAgIGlmIChyYXdTdGF0ZS5zdGF0ZSAhPT0gdGhpcy5yYXcuc3RhdGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHZpZXdTdGF0ZSA9IEpTT04ucGFyc2UocmF3U3RhdGUuc3RhdGUgfHwgXCJ7fVwiKTtcbiAgICAgICAgICAgIC8vIERvbid0IHJlcGxhY2UgYSBmaWxlIHdpdGggYW4gZW1wdHkgaW4gdGhlIGhpc3RvcnlcbiAgICAgICAgICAgIGlmICh2aWV3U3RhdGUudHlwZSA9PT0gXCJlbXB0eVwiKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIC8vIEZpbGUgaXMgZGlmZmVyZW50IGZyb20gZXhpc3RpbmcgZmlsZTogc2hvdWxkIGJlIGEgcHVzaCBpbnN0ZWFkXG4gICAgICAgICAgICBpZiAodGhpcy5wYXRoICYmIHRoaXMucGF0aCAhPT0gdmlld1N0YXRlPy5zdGF0ZT8uZmlsZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgaWYgKHZpZXdTdGF0ZS50eXBlID09PSBcIm1lZGlhLXZpZXdcIikge1xuICAgICAgICAgICAgICAgIGNvbnN0IG9sZEluZm8gPSBKU09OLnN0cmluZ2lmeSh0aGlzLnZpZXdTdGF0ZS5zdGF0ZS5pbmZvKTtcbiAgICAgICAgICAgICAgICBjb25zdCBuZXdJbmZvID0gSlNPTi5zdHJpbmdpZnkodmlld1N0YXRlLnN0YXRlLmluZm8pO1xuICAgICAgICAgICAgICAgIGlmIChvbGRJbmZvICE9PSBuZXdJbmZvKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zZXRTdGF0ZShyYXdTdGF0ZSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn1cblxuaW50ZXJmYWNlIFNlcmlhbGl6YWJsZUhpc3Rvcnkge1xuICAgIHBvczogbnVtYmVyXG4gICAgc3RhY2s6IFB1c2hTdGF0ZVtdXG59XG5cbmV4cG9ydCBjbGFzcyBIaXN0b3J5IHtcbiAgICBzdGF0aWMgY3VycmVudCgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yTGVhZihhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpIHx8IG5ldyB0aGlzKCk7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZikge1xuICAgICAgICBpZiAobGVhZikgZG9tTGVhdmVzLnNldChsZWFmLmNvbnRhaW5lckVsLCBsZWFmKTtcbiAgICAgICAgaWYgKGxlYWYpIHJldHVybiBsZWFmW0hJU1RfQVRUUl0gaW5zdGFuY2VvZiB0aGlzID9cbiAgICAgICAgICAgIGxlYWZbSElTVF9BVFRSXSA6XG4gICAgICAgICAgICBsZWFmW0hJU1RfQVRUUl0gPSBuZXcgdGhpcyhsZWFmLCAobGVhZltISVNUX0FUVFJdYXMgYW55KT8uc2VyaWFsaXplKCkgfHwgdW5kZWZpbmVkKTtcbiAgICB9XG5cbiAgICBwb3M6IG51bWJlclxuICAgIHN0YWNrOiBIaXN0b3J5RW50cnlbXVxuXG4gICAgY29uc3RydWN0b3IocHVibGljIGxlYWY/OiBXb3Jrc3BhY2VMZWFmLCB7cG9zLCBzdGFja306IFNlcmlhbGl6YWJsZUhpc3RvcnkgPSB7cG9zOjAsIHN0YWNrOltdfSkge1xuICAgICAgICB0aGlzLmxlYWYgPSBsZWFmO1xuICAgICAgICB0aGlzLnBvcyA9IHBvcztcbiAgICAgICAgdGhpcy5zdGFjayA9IHN0YWNrLm1hcChyYXcgPT4gbmV3IEhpc3RvcnlFbnRyeShyYXcpKTtcbiAgICB9XG5cbiAgICBjbG9uZVRvKGxlYWY6IFdvcmtzcGFjZUxlYWYpIHtcbiAgICAgICAgcmV0dXJuIGxlYWZbSElTVF9BVFRSXSA9IG5ldyBIaXN0b3J5KGxlYWYsIHRoaXMuc2VyaWFsaXplKCkpO1xuICAgIH1cblxuICAgIG9uUmVuYW1lKGZpbGU6IFRBYnN0cmFjdEZpbGUsIG9sZFBhdGg6IHN0cmluZykge1xuICAgICAgICBmb3IoY29uc3QgaGlzdEVudHJ5IG9mIHRoaXMuc3RhY2spIGhpc3RFbnRyeS5vblJlbmFtZShmaWxlLCBvbGRQYXRoKTtcbiAgICB9XG5cbiAgICBzZXJpYWxpemUoKTogU2VyaWFsaXphYmxlSGlzdG9yeSB7IHJldHVybiB7cG9zOiB0aGlzLnBvcywgc3RhY2s6IHRoaXMuc3RhY2subWFwKGUgPT4gZS5yYXcpfTsgfVxuXG4gICAgZ2V0IHN0YXRlKCkgeyByZXR1cm4gdGhpcy5zdGFja1t0aGlzLnBvc10/LnJhdyB8fCBudWxsOyB9XG4gICAgZ2V0IGxlbmd0aCgpIHsgcmV0dXJuIHRoaXMuc3RhY2subGVuZ3RoOyB9XG5cbiAgICBiYWNrKCkgICAgeyB0aGlzLmdvKC0xKTsgfVxuICAgIGZvcndhcmQoKSB7IHRoaXMuZ28oIDEpOyB9XG5cbiAgICBsb29rQWhlYWQoKSB7IHJldHVybiB0aGlzLnN0YWNrLnNsaWNlKDAsIHRoaXMucG9zKS5yZXZlcnNlKCk7IH1cbiAgICBsb29rQmVoaW5kKCkgeyByZXR1cm4gdGhpcy5zdGFjay5zbGljZSh0aGlzLnBvcysxKTsgfVxuXG4gICAgYW5ub3VuY2UoKSB7XG4gICAgICAgIGFwcD8ud29ya3NwYWNlPy50cmlnZ2VyKFwicGFuZS1yZWxpZWY6dXBkYXRlLWhpc3RvcnlcIiwgdGhpcy5sZWFmLCB0aGlzKTtcbiAgICB9XG5cbiAgICBnb3RvKHBvczogbnVtYmVyKTogdm9pZCB7XG4gICAgICAgIGlmICghdGhpcy5sZWFmKSByZXR1cm47XG4gICAgICAgIGlmICh0aGlzLmxlYWYucGlubmVkKSByZXR1cm4gbmV3IE5vdGljZShcIlBpbm5lZCBwYW5lOiB1bnBpbiBiZWZvcmUgZ29pbmcgZm9yd2FyZCBvciBiYWNrXCIpLCB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh0aGlzLmxlYWYud29ya2luZykgcmV0dXJuIG5ldyBOb3RpY2UoXCJQYW5lIGlzIGJ1c3k6IHBsZWFzZSB3YWl0IGJlZm9yZSBuYXZpZ2F0aW5nIGZ1cnRoZXJcIiksIHVuZGVmaW5lZDtcbiAgICAgICAgcG9zID0gdGhpcy5wb3MgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihwb3MsIHRoaXMuc3RhY2subGVuZ3RoIC0gMSkpO1xuICAgICAgICB0aGlzLnN0YWNrW3Bvc10/LmdvKHRoaXMubGVhZik7XG4gICAgICAgIHRoaXMuYW5ub3VuY2UoKTtcbiAgICB9XG5cbiAgICBnbyhieTogbnVtYmVyLCBmb3JjZT86IGJvb2xlYW4pIHtcbiAgICAgICAgaWYgKCF0aGlzLmxlYWYgfHwgIWJ5KSByZXR1cm47ICAvLyBuby1vcFxuICAgICAgICAvLyBwcmV2ZW50IHdyYXBhcm91bmRcbiAgICAgICAgY29uc3QgbmV3UG9zID0gTWF0aC5tYXgoMCwgTWF0aC5taW4odGhpcy5wb3MgLSBieSwgdGhpcy5zdGFjay5sZW5ndGggLSAxKSk7XG4gICAgICAgIGlmIChmb3JjZSB8fCBuZXdQb3MgIT09IHRoaXMucG9zKSB7XG4gICAgICAgICAgICB0aGlzLmdvdG8obmV3UG9zKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYE5vIG1vcmUgJHtieSA8IDAgPyBcImJhY2tcIiA6IFwiZm9yd2FyZFwifSBoaXN0b3J5IGZvciBwYW5lYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXBsYWNlU3RhdGUocmF3U3RhdGU6IFB1c2hTdGF0ZSwgdGl0bGU6IHN0cmluZywgdXJsOiBzdHJpbmcpe1xuICAgICAgICBjb25zdCBlbnRyeSA9IHRoaXMuc3RhY2tbdGhpcy5wb3NdO1xuICAgICAgICBpZiAoIWVudHJ5KSB7XG4gICAgICAgICAgICB0aGlzLnN0YWNrW3RoaXMucG9zXSA9IG5ldyBIaXN0b3J5RW50cnkocmF3U3RhdGUpO1xuICAgICAgICB9IGVsc2UgaWYgKCFlbnRyeS5yZXBsYWNlU3RhdGUocmF3U3RhdGUpKSB7XG4gICAgICAgICAgICAvLyByZXBsYWNlU3RhdGUgd2FzIGVycm9uZW91c2x5IGNhbGxlZCB3aXRoIGEgbmV3IGZpbGUgZm9yIHRoZSBzYW1lIGxlYWY7XG4gICAgICAgICAgICAvLyBmb3JjZSBhIHB1c2hTdGF0ZSBpbnN0ZWFkIChmaXhlcyB0aGUgaXNzdWUgcmVwb3J0ZWQgaGVyZTogaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90LzE4NTE4KVxuICAgICAgICAgICAgdGhpcy5wdXNoU3RhdGUocmF3U3RhdGUsIHRpdGxlLCB1cmwpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcHVzaFN0YXRlKHJhd1N0YXRlOiBQdXNoU3RhdGUsIHRpdGxlOiBzdHJpbmcsIHVybDogc3RyaW5nKSAgIHtcbiAgICAgICAgLy9jb25zb2xlLmxvZyhcInB1c2hpbmdcIiwgcmF3U3RhdGUpXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5zdGFja1t0aGlzLnBvc107XG4gICAgICAgIGlmIChlbnRyeSAmJiBlbnRyeS5pc0VtcHR5KCkpIHJldHVybiB0aGlzLnJlcGxhY2VTdGF0ZShyYXdTdGF0ZSwgdGl0bGUsIHVybCk7XG4gICAgICAgIHRoaXMuc3RhY2suc3BsaWNlKDAsIHRoaXMucG9zLCBuZXcgSGlzdG9yeUVudHJ5KHJhd1N0YXRlKSk7XG4gICAgICAgIHRoaXMucG9zID0gMDtcbiAgICAgICAgLy8gTGltaXQgXCJiYWNrXCIgdG8gMjBcbiAgICAgICAgd2hpbGUgKHRoaXMuc3RhY2subGVuZ3RoID4gMjApIHRoaXMuc3RhY2sucG9wKCk7XG4gICAgICAgIHRoaXMuYW5ub3VuY2UoKTtcbiAgICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsSGlzdG9yeShwbHVnaW46IFBhbmVSZWxpZWYpIHtcblxuICAgIC8vIE1vbmtleXBhdGNoOiBpbmNsdWRlIGhpc3RvcnkgaW4gbGVhZiBzZXJpYWxpemF0aW9uIChzbyBpdCdzIHBlcnNpc3RlZCB3aXRoIHRoZSB3b3Jrc3BhY2UpXG4gICAgLy8gYW5kIGNoZWNrIGZvciBwb3BzdGF0ZSBldmVudHMgKHRvIHN1cHByZXNzIHRoZW0pXG4gICAgcGx1Z2luLnJlZ2lzdGVyKGFyb3VuZChXb3Jrc3BhY2VMZWFmLnByb3RvdHlwZSwge1xuICAgICAgICBzZXJpYWxpemUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXJpYWxpemUoKXtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgaWYgKHRoaXNbSElTVF9BVFRSXSkgcmVzdWx0W1NFUklBTF9QUk9QXSA9IHRoaXNbSElTVF9BVFRSXS5zZXJpYWxpemUoKTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH19LFxuICAgICAgICBzZXRWaWV3U3RhdGUob2xkKSB7IHJldHVybiBmdW5jdGlvbiBzZXRWaWV3U3RhdGUodnMsIGVzKXtcbiAgICAgICAgICAgIGlmICh2cy5wb3BzdGF0ZSAmJiB3aW5kb3cuZXZlbnQ/LnR5cGUgPT09IFwicG9wc3RhdGVcIikge1xuICAgICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCB2cywgZXMpO1xuICAgICAgICB9fVxuICAgIH0pKTtcblxuICAgIHBsdWdpbi5yZWdpc3Rlcihhcm91bmQoYXBwLndvcmtzcGFjZSwge1xuICAgICAgICAvLyBNb25rZXlwYXRjaDogbG9hZCBoaXN0b3J5IGR1cmluZyBsZWFmIGxvYWQsIGlmIHByZXNlbnRcbiAgICAgICAgZGVzZXJpYWxpemVMYXlvdXQob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZUxheW91dChzdGF0ZSwgLi4uZXRjOiBhbnlbXSl7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgb2xkLmNhbGwodGhpcywgc3RhdGUsIC4uLmV0Yyk7XG4gICAgICAgICAgICBpZiAoc3RhdGUudHlwZSA9PT0gXCJsZWFmXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBSZXRyeSBsb2FkaW5nIHRoZSBwYW5lIGFzIGFuIGVtcHR5XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnN0YXRlLnR5cGUgPSAnZW1wdHknO1xuICAgICAgICAgICAgICAgICAgICByZXN1bHQgPSBhd2FpdCBvbGQuY2FsbCh0aGlzLCBzdGF0ZSwgLi4uZXRjKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChzdGF0ZVtTRVJJQUxfUFJPUF0pIHJlc3VsdFtISVNUX0FUVFJdID0gbmV3IEhpc3RvcnkocmVzdWx0LCBzdGF0ZVtTRVJJQUxfUFJPUF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfX0sXG4gICAgICAgIC8vIE1vbmtleXBhdGNoOiBrZWVwIE9ic2lkaWFuIGZyb20gcHVzaGluZyBoaXN0b3J5IGluIHNldEFjdGl2ZUxlYWZcbiAgICAgICAgc2V0QWN0aXZlTGVhZihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIHNldEFjdGl2ZUxlYWYobGVhZiwgLi4uZXRjKSB7XG4gICAgICAgICAgICBjb25zdCB1bnN1YiA9IGFyb3VuZCh0aGlzLCB7XG4gICAgICAgICAgICAgICAgcmVjb3JkSGlzdG9yeShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uIChsZWFmOiBXb3Jrc3BhY2VMZWFmLCBfcHVzaDogYm9vbGVhbiwgLi4uYXJnczogYW55W10pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQWx3YXlzIHVwZGF0ZSBzdGF0ZSBpbiBwbGFjZVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgZmFsc2UsIC4uLmFyZ3MpO1xuICAgICAgICAgICAgICAgIH07IH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgLi4uZXRjKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgdW5zdWIoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfX0sXG4gICAgfSkpO1xuXG4gICAgLy8gUHJveHkgdGhlIHdpbmRvdyBoaXN0b3J5IHdpdGggYSB3cmFwcGVyIHRoYXQgZGVsZWdhdGVzIHRvIHRoZSBhY3RpdmUgbGVhZidzIEhpc3Rvcnkgb2JqZWN0LFxuICAgIGNvbnN0IHJlYWxIaXN0b3J5ID0gd2luZG93Lmhpc3Rvcnk7XG4gICAgcGx1Z2luLnJlZ2lzdGVyKCgpID0+ICh3aW5kb3cgYXMgYW55KS5oaXN0b3J5ID0gcmVhbEhpc3RvcnkpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiaGlzdG9yeVwiLCB7IGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUsIHZhbHVlOiB7XG4gICAgICAgIGdldCBzdGF0ZSgpICAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KCkuc3RhdGU7IH0sXG4gICAgICAgIGdldCBsZW5ndGgoKSAgICAgeyByZXR1cm4gSGlzdG9yeS5jdXJyZW50KCkubGVuZ3RoOyB9LFxuXG4gICAgICAgIGJhY2soKSAgICB7IGlmICghcGx1Z2luLmlzU3ludGhldGljSGlzdG9yeUV2ZW50KDMpKSB0aGlzLmdvKC0xKTsgfSxcbiAgICAgICAgZm9yd2FyZCgpIHsgaWYgKCFwbHVnaW4uaXNTeW50aGV0aWNIaXN0b3J5RXZlbnQoNCkpIHRoaXMuZ28oIDEpOyB9LFxuICAgICAgICBnbyhieTogbnVtYmVyKSAgICB7IEhpc3RvcnkuY3VycmVudCgpLmdvKGJ5KTsgfSxcblxuICAgICAgICByZXBsYWNlU3RhdGUoc3RhdGU6IFB1c2hTdGF0ZSwgdGl0bGU6IHN0cmluZywgdXJsOiBzdHJpbmcpeyBIaXN0b3J5LmN1cnJlbnQoKS5yZXBsYWNlU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpOyB9LFxuICAgICAgICBwdXNoU3RhdGUoc3RhdGU6IFB1c2hTdGF0ZSwgdGl0bGU6IHN0cmluZywgdXJsOiBzdHJpbmcpICAgeyBIaXN0b3J5LmN1cnJlbnQoKS5wdXNoU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpOyB9LFxuXG4gICAgICAgIGdldCBzY3JvbGxSZXN0b3JhdGlvbigpICAgIHsgcmV0dXJuIHJlYWxIaXN0b3J5LnNjcm9sbFJlc3RvcmF0aW9uOyB9LFxuICAgICAgICBzZXQgc2Nyb2xsUmVzdG9yYXRpb24odmFsKSB7IHJlYWxIaXN0b3J5LnNjcm9sbFJlc3RvcmF0aW9uID0gdmFsOyB9LFxuICAgIH19KTtcblxufVxuIiwiaW1wb3J0IHsgYXJvdW5kIH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcbmltcG9ydCB7IENvbXBvbmVudCwgZGVib3VuY2UsIFdvcmtzcGFjZUl0ZW0sIFdvcmtzcGFjZUxlYWYsIFdvcmtzcGFjZVBhcmVudCB9IGZyb20gXCJvYnNpZGlhblwiO1xuXG5kZWNsYXJlIG1vZHVsZSBcIm9ic2lkaWFuXCIge1xuICAgIGludGVyZmFjZSBXb3Jrc3BhY2Uge1xuICAgICAgICBnZXRNb3N0UmVjZW50TGVhZihyb290OiBXb3Jrc3BhY2VQYXJlbnQpOiBXb3Jrc3BhY2VMZWFmXG4gICAgICAgIHJlcXVlc3RBY3RpdmVMZWFmRXZlbnRzKCk6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUl0ZW0ge1xuICAgICAgICBnZXRDb250YWluZXI/KCk6IFdvcmtzcGFjZVBhcmVudFxuICAgIH1cbiAgICBpbnRlcmZhY2UgQXBwIHtcbiAgICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgICAgIGV4ZWN1dGVDb21tYW5kQnlJZChpZDogc3RyaW5nLCBldmVudD86IEV2ZW50KTogYm9vbGVhblxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqIEVmZmljaWVudGx5IHVwZGF0ZSBhIGNsYXNzIG9uIGEgd29ya3NwYWNlIGl0ZW0sIG9ubHkgdG91Y2hpbmcgd2hlcmUgY2hhbmdlcyBhcmUgbmVlZGVkXG4gKlxuICogQHBhcmFtIGVsIFRoZSBlbGVtZW50IHRvIGFkZCBvciByZW1vdmUgdGhlIGNsYXNzIGZyb21cbiAqIEBwYXJhbSBjbHMgVGhlIGNsYXNzIHRvIGFkZCBvciByZW1vdmVcbiAqIEBwYXJhbSBzdGF0ZSBCb29sZWFuLCBmbGFnIHRvIGFkZCBvciByZW1vdmUsIGRlZmF1bHRzIHRvIG9wcG9zaXRlIG9mIGN1cnJlbnQgc3RhdGVcbiAqIEByZXR1cm5zIGJvb2xlYW4gZm9yIHRoZSBzdGF0ZSBvZiB0aGUgY2xhc3MgYWZ0ZXJ3YXJkc1xuICovXG5mdW5jdGlvbiB0b2dnbGVDbGFzcyhlbDogRWxlbWVudCwgY2xzOiBzdHJpbmcsIHN0YXRlPzogYm9vbGVhbik6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGhhZCA9IGVsLmNsYXNzTGlzdC5jb250YWlucyhjbHMpO1xuICAgIHN0YXRlID0gc3RhdGUgPz8gIWhhZDtcbiAgICBpZiAoc3RhdGUgIT09IGhhZCkgeyBzdGF0ZSA/IGVsLmNsYXNzTGlzdC5hZGQoY2xzKSA6IGVsLmNsYXNzTGlzdC5yZW1vdmUoY2xzKTsgfVxuICAgIHJldHVybiBzdGF0ZTtcbn1cblxuZXhwb3J0IGNsYXNzIE1heGltaXplciBleHRlbmRzIENvbXBvbmVudCB7XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudChhcHAud29ya3NwYWNlLm9uKFwibGF5b3V0LWNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHBhcmVudCBvZiB0aGlzLnBhcmVudHMoKSkgdGhpcy5yZWZyZXNoKHBhcmVudCk7XG4gICAgICAgIH0pKTtcblxuICAgICAgICBjb25zdCBzZWxmID0gdGhpc1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAud29ya3NwYWNlLCB7XG4gICAgICAgICAgICBzZXRBY3RpdmVMZWFmKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24gc2V0QWN0aXZlTGVhZihsZWFmLCBwdXNoSGlzdG9yeSwgZm9jdXMpIHtcbiAgICAgICAgICAgICAgICAvLyBXZSBoYXZlIHRvIGRvIHRoaXMgaGVyZSBzbyB0aGF0IE1hcmtkb3duVmlldyBjYW4gYmUgZm9jdXNlZCBpbiB0aGUgbmV3IHBhbmVcbiAgICAgICAgICAgICAgICBjb25zdCBwYXJlbnQgPSBzZWxmLnBhcmVudEZvckxlYWYobGVhZiksIG9sZFBhcmVudCA9IHNlbGYucGFyZW50Rm9yTGVhZihhcHAud29ya3NwYWNlLmFjdGl2ZUxlYWYpO1xuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgcGFyZW50ICYmIG9sZFBhcmVudCAmJiBwYXJlbnQgIT09IG9sZFBhcmVudCAmJlxuICAgICAgICAgICAgICAgICAgICBvbGRQYXJlbnQubWF0Y2hQYXJlbnQoXCIuaG92ZXItcG9wb3Zlci5pcy1hY3RpdmUuc25hcC10by12aWV3cG9ydFwiKSAmJlxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQub3duZXJEb2N1bWVudCA9PT0gb2xkUGFyZW50Lm93bmVyRG9jdW1lbnQgJiZcbiAgICAgICAgICAgICAgICAgICAgIXBhcmVudC5tYXRjaFBhcmVudChcIi5ob3Zlci1wb3BvdmVyXCIpXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFN3aXRjaGluZyBmcm9tIG1heGltaXplZCBwb3BvdmVyIHRvIG5vbi1wb3BvdmVyOyBkZS1tYXhpbWl6ZSBpdCBmaXJzdFxuICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmRCeUlkKFwib2JzaWRpYW4taG92ZXItZWRpdG9yOnJlc3RvcmUtYWN0aXZlLXBvcG92ZXJcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChwYXJlbnQpIHNlbGYucmVmcmVzaChwYXJlbnQsIHBhcmVudC5oYXNDbGFzcyhcInNob3VsZC1tYXhpbWl6ZVwiKSA/IGxlYWYuY29udGFpbmVyRWwgOiBudWxsKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgbGVhZiwgcHVzaEhpc3RvcnksIGZvY3VzKTtcbiAgICAgICAgICAgIH19XG4gICAgICAgIH0pKTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgLy8gVW4tbWF4aW1pemUgYWxsIHBhbmVzXG4gICAgICAgIGZvciAoY29uc3QgcGFyZW50IG9mIHRoaXMucGFyZW50cygpKSB0aGlzLnJlZnJlc2gocGFyZW50LCBudWxsKTtcbiAgICB9XG5cbiAgICB0b2dnbGVNYXhpbWl6ZShsZWFmID0gYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSB7XG4gICAgICAgIGNvbnN0IHBhcmVudCA9IHRoaXMucGFyZW50Rm9yTGVhZihsZWFmKTtcbiAgICAgICAgaWYgKCFwYXJlbnQpIHJldHVybjtcbiAgICAgICAgY29uc3QgcG9wb3ZlckVsID0gcGFyZW50Lm1hdGNoUGFyZW50KFwiLmhvdmVyLXBvcG92ZXJcIik7XG4gICAgICAgIGlmIChwb3BvdmVyRWwgJiYgYXBwLnBsdWdpbnMucGx1Z2luc1tcIm9ic2lkaWFuLWhvdmVyLWVkaXRvclwiXSkge1xuICAgICAgICAgICAgLy8gQ2hlY2sgaWYgc2luZ2xlIGxlYWYgaW4gYSBwb3BvdmVyXG4gICAgICAgICAgICBsZXQgY291bnQgPSBwb3BvdmVyRWwuZmluZEFsbChcIi53b3Jrc3BhY2UtbGVhZlwiKS5sZW5ndGg7XG4gICAgICAgICAgICBpZiAoY291bnQgPT09IDEpIHtcbiAgICAgICAgICAgICAgICAvLyBNYXhpbWl6ZSBvciByZXN0b3JlIHRoZSBwb3BvdmVyIGluc3RlYWQgb2YgdGhlIGxlYWZcbiAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuZXhlY3V0ZUNvbW1hbmRCeUlkKFxuICAgICAgICAgICAgICAgICAgICBcIm9ic2lkaWFuLWhvdmVyLWVkaXRvcjpcIiArIChcbiAgICAgICAgICAgICAgICAgICAgICAgIHBvcG92ZXJFbC5oYXNDbGFzcyhcInNuYXAtdG8tdmlld3BvcnRcIikgPyBcInJlc3RvcmUtYWN0aXZlLXBvcG92ZXJcIiA6IFwic25hcC1hY3RpdmUtcG9wb3Zlci10by12aWV3cG9ydFwiXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAocGFyZW50KSB0aGlzLnJlZnJlc2gocGFyZW50LCB0b2dnbGVDbGFzcyhwYXJlbnQsIFwic2hvdWxkLW1heGltaXplXCIpID8gbGVhZi5jb250YWluZXJFbCA6IG51bGwpO1xuICAgIH1cblxuICAgIGxhc3RNYXhpbWl6ZWQocGFyZW50OiBFbGVtZW50KSB7XG4gICAgICAgIHJldHVybiBwYXJlbnQuZmluZChcIi53b3Jrc3BhY2UtbGVhZi5pcy1tYXhpbWl6ZWRcIikgfHwgYXBwLndvcmtzcGFjZS5nZXRNb3N0UmVjZW50TGVhZigpLmNvbnRhaW5lckVsO1xuICAgIH1cblxuICAgIGZpeFNsaWRpbmdQYW5lcyA9IGRlYm91bmNlKCgpID0+IHtcbiAgICAgICAgaWYgKChhcHAucGx1Z2lucy5wbHVnaW5zIGFzIGFueSlbXCJzbGlkaW5nLXBhbmVzLW9ic2lkaWFuXCJdKSB7XG4gICAgICAgICAgICBhcHAud29ya3NwYWNlLm9uTGF5b3V0Q2hhbmdlKCk7XG4gICAgICAgICAgICBhcHAud29ya3NwYWNlLnJlcXVlc3RBY3RpdmVMZWFmRXZlbnRzKCk7XG4gICAgICAgIH1cbiAgICB9LCA1KTtcblxuICAgIHJlZnJlc2goXG4gICAgICAgIHBhcmVudDogRWxlbWVudCxcbiAgICAgICAgbGVhZkVsOiBFbGVtZW50ID1cbiAgICAgICAgICAgIHBhcmVudC5oYXNDbGFzcyhcInNob3VsZC1tYXhpbWl6ZVwiKSA/IHRoaXMubGFzdE1heGltaXplZChwYXJlbnQpIDogbnVsbFxuICAgICkge1xuICAgICAgICBjb25zdCBoYWRNYXggPSBwYXJlbnQuaGFzQ2xhc3MoXCJoYXMtbWF4aW1pemVkXCIpO1xuICAgICAgICBwYXJlbnQuZmluZEFsbFNlbGYoXCIud29ya3NwYWNlLXNwbGl0XCIpLmZvckVhY2goc3BsaXQgPT4ge1xuICAgICAgICAgICAgaWYgKHNwbGl0ID09PSBwYXJlbnQgfHwgdGhpcy5wYXJlbnRGb3Ioc3BsaXQpID09PSBwYXJlbnQpXG4gICAgICAgICAgICAgICAgdG9nZ2xlQ2xhc3Moc3BsaXQsIFwiaGFzLW1heGltaXplZFwiLCBsZWFmRWwgPyBzcGxpdC5jb250YWlucyhsZWFmRWwpOiBmYWxzZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBwYXJlbnQuZmluZEFsbChcIi53b3Jrc3BhY2UtbGVhZlwiKS5mb3JFYWNoKGxlYWYgPT4ge1xuICAgICAgICAgICAgaWYgKHRoaXMucGFyZW50Rm9yKGxlYWYpID09PSBwYXJlbnQpIHRvZ2dsZUNsYXNzKGxlYWYsIFwiaXMtbWF4aW1pemVkXCIsIGxlYWYgPT09IGxlYWZFbCk7XG4gICAgICAgIH0pXG4gICAgICAgIGlmICghbGVhZkVsIHx8ICFwYXJlbnQuY29udGFpbnMobGVhZkVsKSkge1xuICAgICAgICAgICAgdG9nZ2xlQ2xhc3MocGFyZW50LCBcInNob3VsZC1tYXhpbWl6ZVwiLCBmYWxzZSk7XG4gICAgICAgICAgICBpZiAoaGFkTWF4KSB0aGlzLmZpeFNsaWRpbmdQYW5lcygpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcGFyZW50cygpIHtcbiAgICAgICAgY29uc3QgcGFyZW50czogSFRNTERpdkVsZW1lbnRbXSA9IFthcHAud29ya3NwYWNlLnJvb3RTcGxpdC5jb250YWluZXJFbF1cbiAgICAgICAgcGFyZW50cy5jb25jYXQoKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4gPz8gW10pLm1hcChpID0+IGkuY29udGFpbmVyRWwpKTtcbiAgICAgICAgY29uc3QgcG9wb3ZlcnMgPSBhcHAucGx1Z2lucy5wbHVnaW5zW1wib2JzaWRpYW4taG92ZXItZWRpdG9yXCJdPy5hY3RpdmVQb3BvdmVycztcbiAgICAgICAgaWYgKHBvcG92ZXJzKSBmb3IgKGNvbnN0IHBvcG92ZXIgb2YgcG9wb3ZlcnMpIHtcbiAgICAgICAgICAgIGlmIChwb3BvdmVyLnJvb3RTcGxpdCkgcGFyZW50cy5wdXNoKHBvcG92ZXIucm9vdFNwbGl0LmNvbnRhaW5lckVsKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBwYXJlbnRzO1xuICAgIH1cblxuICAgIHBhcmVudEZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZikge1xuICAgICAgICByZXR1cm4gdGhpcy5wYXJlbnRGb3IobGVhZi5jb250YWluZXJFbCk7XG4gICAgfVxuXG4gICAgcGFyZW50Rm9yKGVsOiBFbGVtZW50KSB7XG4gICAgICAgIHJldHVybiBlbC5tYXRjaFBhcmVudChcIi53b3Jrc3BhY2Utc3BsaXQubW9kLXJvb3QsIC5ob3Zlci1wb3BvdmVyID4gLnBvcG92ZXItY29udGVudCA+IC53b3Jrc3BhY2Utc3BsaXRcIik7XG4gICAgfVxuXG59IiwiaW1wb3J0IHsgQ29tcG9uZW50LCBQbHVnaW4sIFZpZXcsIFdvcmtzcGFjZUxlYWYsIFdvcmtzcGFjZVBhcmVudCwgV29ya3NwYWNlU3BsaXQsIFdvcmtzcGFjZVdpbmRvdyB9IGZyb20gXCJvYnNpZGlhblwiO1xuLy9pbXBvcnQgeyB1c2UgfSBmcm9tIFwib3BoaWRpYW5cIjtcblxuLyoqXG4gKiBDb21wb25lbnQgdGhhdCBiZWxvbmdzIHRvIGEgcGx1Z2luICsgd2luZG93LiBlLmcuOlxuICpcbiAqICAgICBjbGFzcyBUaXRsZVdpZGdldCBleHRlbmRzIFBlcldpbmRvd0NvbXBvbmVudDxNeVBsdWdpbj4ge1xuICogICAgICAgICBvbmxvYWQoKSB7XG4gKiAgICAgICAgICAgICAvLyBkbyBzdHVmZiB3aXRoIHRoaXMucGx1Z2luIGFuZCB0aGlzLndpbiAuLi5cbiAqICAgICAgICAgfVxuICogICAgIH1cbiAqXG4gKiAgICAgY2xhc3MgTXlQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICogICAgICAgICB0aXRsZVdpZGdldHMgPSBUaXRsZVdpZGdldC5wZXJXaW5kb3codGhpcyk7XG4gKiAgICAgICAgIC4uLlxuICogICAgIH1cbiAqXG4gKiBUaGlzIHdpbGwgYXV0b21hdGljYWxseSBjcmVhdGUgYSB0aXRsZSB3aWRnZXQgZm9yIGVhY2ggd2luZG93IGFzIGl0J3Mgb3BlbmVkLCBhbmRcbiAqIG9uIHBsdWdpbiBsb2FkLiAgVGhlIHBsdWdpbidzIGAudGl0bGVXaWRnZXRzYCB3aWxsIGFsc28gYmUgYSBXaW5kb3dNYW5hZ2VyIHRoYXQgY2FuXG4gKiBsb29rIHVwIHRoZSB0aXRsZSB3aWRnZXQgZm9yIGEgZ2l2ZW4gd2luZG93LCBsZWFmLCBvciB2aWV3LCBvciByZXR1cm4gYSBsaXN0IG9mXG4gKiBhbGwgb2YgdGhlbS4gIFNlZSBXaW5kb3dNYW5hZ2VyIGZvciB0aGUgZnVsbCBBUEkuXG4gKlxuICogSWYgeW91IHdhbnQgeW91ciBjb21wb25lbnRzIHRvIGJlIGNyZWF0ZWQgb24gZGVtYW5kIGluc3RlYWQgb2YgYXV0b21hdGljYWxseSB3aGVuXG4gKiB3aW5kb3cocykgYXJlIG9wZW5lZCwgeW91IGNhbiBwYXNzIGBmYWxzZWAgYXMgdGhlIHNlY29uZCBhcmd1bWVudCB0byBgcGVyV2luZG93KClgLlxuICovXG5leHBvcnQgY2xhc3MgUGVyV2luZG93Q29tcG9uZW50PFAgZXh0ZW5kcyBQbHVnaW4+IGV4dGVuZHMgQ29tcG9uZW50IHtcblxuICAgIC8qc3RhdGljIFt1c2UubWVdPFQgZXh0ZW5kcyBQZXJXaW5kb3dDb21wb25lbnQ8UD4sIFAgZXh0ZW5kcyBQbHVnaW4+KFxuICAgICAgICBrZXk6IG5ldyAocGx1Z2luOiBQLCB3aW46IFdpbmRvdykgPT4gVFxuICAgICkge1xuICAgICAgICByZXR1cm4gdGhpcy5wZXJXaW5kb3codXNlKFBsdWdpbikpO1xuICAgIH0qL1xuXG4gICAgZ2V0IHJvb3QoKTogV29ya3NwYWNlUGFyZW50IHtcbiAgICAgICAgcmV0dXJuIGNvbnRhaW5lckZvcldpbmRvdyh0aGlzLndpbik7XG4gICAgfVxuXG4gICAgY29uc3RydWN0b3IocHVibGljIHBsdWdpbjogUCwgcHVibGljIHdpbjogV2luZG93KSB7XG4gICAgICAgIHN1cGVyKCk7XG4gICAgfVxuXG4gICAgc3RhdGljIHBlcldpbmRvdzxUIGV4dGVuZHMgUGVyV2luZG93Q29tcG9uZW50PFA+LCBQIGV4dGVuZHMgUGx1Z2luPihcbiAgICAgICAgdGhpczogbmV3IChwbHVnaW46IFAsIHdpbjogV2luZG93KSA9PiBULFxuICAgICAgICBwbHVnaW46IFBcbiAgICApIHtcbiAgICAgICAgcmV0dXJuIG5ldyBXaW5kb3dNYW5hZ2VyKHBsdWdpbiwgdGhpcyk7XG4gICAgfVxufVxuXG4vKipcbiAqIE1hbmFnZSBwZXItd2luZG93IGNvbXBvbmVudHNcbiAqL1xuZXhwb3J0IGNsYXNzIFdpbmRvd01hbmFnZXI8VCBleHRlbmRzIFBlcldpbmRvd0NvbXBvbmVudDxQPiwgUCBleHRlbmRzIFBsdWdpbj4gZXh0ZW5kcyBDb21wb25lbnQge1xuICAgIGluc3RhbmNlcyA9IG5ldyBXZWFrTWFwPFdpbmRvdywgVD4oKTtcblxuICAgIHdhdGNoaW5nOiBib29sZWFuID0gZmFsc2VcblxuICAgIGNvbnN0cnVjdG9yIChcbiAgICAgICAgcHVibGljIHBsdWdpbjogUCxcbiAgICAgICAgcHVibGljIGZhY3Rvcnk6IG5ldyAocGx1Z2luOiBQLCB3aW46IFdpbmRvdykgPT4gVCwgIC8vIFRoZSBjbGFzcyBvZiB0aGluZyB0byBtYW5hZ2VcbiAgICApIHtcbiAgICAgICAgc3VwZXIoKTtcbiAgICAgICAgcGx1Z2luLmFkZENoaWxkKHRoaXMpO1xuICAgIH1cblxuICAgIHdhdGNoKCk6IHRoaXMge1xuICAgICAgICAvLyBEZWZlciB3YXRjaCB1bnRpbCBwbHVnaW4gaXMgbG9hZGVkXG4gICAgICAgIGlmICghdGhpcy5fbG9hZGVkKSB0aGlzLm9ubG9hZCA9ICgpID0+IHRoaXMud2F0Y2goKTtcbiAgICAgICAgZWxzZSBpZiAoIXRoaXMud2F0Y2hpbmcpIHtcbiAgICAgICAgICAgIGNvbnN0IHt3b3Jrc3BhY2V9ID0gYXBwO1xuICAgICAgICAgICAgdGhpcy53YXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoXG4gICAgICAgICAgICAgICAgd29ya3NwYWNlLm9uKFwid2luZG93LW9wZW5cIiwgKF8sIHdpbikgPT4ge1xuICAgICAgICAgICAgICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiBQcm9taXNlLnJlc29sdmUoKS50aGVuKCgpID0+IHRoaXMuZm9yV2luZG93KHdpbikpKTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHdvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gdGhpcy5mb3JBbGwoKSkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIGZvcldpbmRvdygpOiBUO1xuICAgIGZvcldpbmRvdyh3aW46IFdpbmRvdyk6IFQ7XG4gICAgZm9yV2luZG93KHdpbjogV2luZG93LCBjcmVhdGU6IHRydWUpOiBUO1xuICAgIGZvcldpbmRvdyh3aW46IFdpbmRvdywgY3JlYXRlOiBib29sZWFuKTogVCB8IHVuZGVmaW5lZDtcblxuICAgIGZvcldpbmRvdyh3aW46IFdpbmRvdyA9IHdpbmRvdy5hY3RpdmVXaW5kb3cgPz8gd2luZG93LCBjcmVhdGUgPSB0cnVlKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgICAgIGxldCBpbnN0ID0gdGhpcy5pbnN0YW5jZXMuZ2V0KHdpbik7XG4gICAgICAgIGlmICghaW5zdCAmJiBjcmVhdGUpIHtcbiAgICAgICAgICAgIGluc3QgPSBuZXcgdGhpcy5mYWN0b3J5KHRoaXMucGx1Z2luLCB3aW4pO1xuICAgICAgICAgICAgaWYgKGluc3QpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmluc3RhbmNlcy5zZXQod2luLCBpbnN0ISk7XG4gICAgICAgICAgICAgICAgaW5zdC5yZWdpc3RlckRvbUV2ZW50KHdpbiwgXCJiZWZvcmV1bmxvYWRcIiwgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnJlbW92ZUNoaWxkKGluc3QhKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5pbnN0YW5jZXMuZGVsZXRlKHdpbik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgdGhpcy5hZGRDaGlsZChpbnN0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaW5zdCB8fCB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZm9yRG9tKGVsOiBIVE1MRWxlbWVudCk6IFQ7XG4gICAgZm9yRG9tKGVsOiBIVE1MRWxlbWVudCwgY3JlYXRlOiB0cnVlKTogVDtcbiAgICBmb3JEb20oZWw6IEhUTUxFbGVtZW50LCBjcmVhdGU6IGJvb2xlYW4pOiBUIHwgdW5kZWZpbmVkO1xuXG4gICAgZm9yRG9tKGVsOiBIVE1MRWxlbWVudCwgY3JlYXRlID0gdHJ1ZSkge1xuICAgICAgICByZXR1cm4gdGhpcy5mb3JXaW5kb3cod2luZG93Rm9yRG9tKGVsKSwgY3JlYXRlKTtcbiAgICB9XG5cbiAgICBmb3JMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYpOiBUO1xuICAgIGZvckxlYWYobGVhZjogV29ya3NwYWNlTGVhZiwgY3JlYXRlOiB0cnVlKTogVDtcbiAgICBmb3JMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGNyZWF0ZTogYm9vbGVhbik6IFQgfCB1bmRlZmluZWQ7XG5cbiAgICBmb3JMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGNyZWF0ZSA9IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZm9yRG9tKGxlYWYuY29udGFpbmVyRWwsIGNyZWF0ZSk7XG4gICAgfVxuXG4gICAgZm9yVmlldyh2aWV3OiBWaWV3KTogVDtcbiAgICBmb3JWaWV3KHZpZXc6IFZpZXcsIGNyZWF0ZTogdHJ1ZSk6IFQ7XG4gICAgZm9yVmlldyh2aWV3OiBWaWV3LCBjcmVhdGU6IGJvb2xlYW4pOiBUIHwgdW5kZWZpbmVkO1xuXG4gICAgZm9yVmlldyh2aWV3OiBWaWV3LCBjcmVhdGUgPSB0cnVlKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmZvckxlYWYodmlldy5sZWFmLCBjcmVhdGUpO1xuICAgIH1cblxuICAgIHdpbmRvd3MoKSB7XG4gICAgICAgIGNvbnN0IHdpbmRvd3M6IFdpbmRvd1tdID0gW3dpbmRvd10sIHtmbG9hdGluZ1NwbGl0fSA9IGFwcC53b3Jrc3BhY2U7XG4gICAgICAgIGlmIChmbG9hdGluZ1NwbGl0KSB7XG4gICAgICAgICAgICBmb3IoY29uc3Qgc3BsaXQgb2YgZmxvYXRpbmdTcGxpdC5jaGlsZHJlbikgaWYgKHNwbGl0Lndpbikgd2luZG93cy5wdXNoKHNwbGl0Lndpbik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHdpbmRvd3M7XG4gICAgfVxuXG4gICAgZm9yQWxsKGNyZWF0ZSA9IHRydWUpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMud2luZG93cygpLm1hcCh3aW4gPT4gdGhpcy5mb3JXaW5kb3cod2luLCBjcmVhdGUpKS5maWx0ZXIodCA9PiB0KTtcbiAgICB9XG59XG5cbmV4cG9ydCBjbGFzcyBSb290TWFuYWdlcjxUIGV4dGVuZHMgUGVyV2luZG93Q29tcG9uZW50PFA+LCBQIGV4dGVuZHMgUGx1Z2luPiBleHRlbmRzIFdpbmRvd01hbmFnZXI8VCxQPiB7XG4gICAgaW5zdGFuY2VzOiBXZWFrTWFwPFdpbmRvd3xXb3Jrc3BhY2VQYXJlbnQsIFQ+O1xuXG4gICAgZm9yRG9tKGVsOiBIVE1MRWxlbWVudCwgY3JlYXRlID0gdHJ1ZSkge1xuICAgICAgICBjb25zdCBwb3BvdmVyRWwgPSBlbC5tYXRjaFBhcmVudChcIi5ob3Zlci1wb3BvdmVyXCIpO1xuICAgICAgICBpZiAoIXBvcG92ZXJFbCkgcmV0dXJuIHRoaXMuZm9yV2luZG93KHdpbmRvd0ZvckRvbShlbCksIGNyZWF0ZSk7XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gd2luZG93Rm9yRG9tKGVsOiBOb2RlKSB7XG4gICAgcmV0dXJuIChlbC5vd25lckRvY3VtZW50IHx8IDxEb2N1bWVudD5lbCkuZGVmYXVsdFZpZXchO1xufVxuXG5mdW5jdGlvbiBjb250YWluZXJGb3JXaW5kb3cod2luOiBXaW5kb3cpOiBXb3Jrc3BhY2VQYXJlbnQge1xuICAgIGlmICh3aW4gPT09IHdpbmRvdykgcmV0dXJuIGFwcC53b3Jrc3BhY2Uucm9vdFNwbGl0O1xuICAgIGNvbnN0IHtmbG9hdGluZ1NwbGl0fSA9IGFwcC53b3Jrc3BhY2U7XG4gICAgaWYgKGZsb2F0aW5nU3BsaXQpIHtcbiAgICAgICAgZm9yKGNvbnN0IHNwbGl0IG9mIGZsb2F0aW5nU3BsaXQuY2hpbGRyZW4pIGlmICh3aW4gPT09IHNwbGl0LndpbikgcmV0dXJuIHNwbGl0O1xuICAgIH1cbn1cblxuZGVjbGFyZSBnbG9iYWwge1xuICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgZm9yIHNpbmdsZS13aW5kb3cgT2JzaWRpYW4gKDwwLjE1KVxuICAgIGludGVyZmFjZSBXaW5kb3cge1xuICAgICAgICBhY3RpdmVXaW5kb3c/OiBXaW5kb3dcbiAgICB9XG59XG5cbmRlY2xhcmUgbW9kdWxlIFwib2JzaWRpYW5cIiB7XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZSB7XG4gICAgICAgIGZsb2F0aW5nU3BsaXQ/OiB7IGNoaWxkcmVuOiBXb3Jrc3BhY2VXaW5kb3dbXSB9O1xuICAgICAgICBvcGVuUG9wb3V0PygpOiBXb3Jrc3BhY2VTcGxpdDtcbiAgICAgICAgb3BlblBvcG91dExlYWY/KCk6IFdvcmtzcGFjZUxlYWY7XG4gICAgICAgIG9uKG5hbWU6ICd3aW5kb3ctb3BlbicsIGNhbGxiYWNrOiAod2luOiBXb3Jrc3BhY2VXaW5kb3csIHdpbmRvdzogV2luZG93KSA9PiBhbnksIGN0eD86IGFueSk6IEV2ZW50UmVmO1xuICAgIH1cbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlV2luZG93IGV4dGVuZHMgV29ya3NwYWNlUGFyZW50IHtcbiAgICAgICAgd2luOiBXaW5kb3dcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBjb250YWluZXJFbDogSFRNTERpdkVsZW1lbnQ7XG4gICAgfVxuICAgIGludGVyZmFjZSBDb21wb25lbnQge1xuICAgICAgICBfbG9hZGVkOiBib29sZWFuXG4gICAgfVxufVxuIiwiaW1wb3J0IHtNZW51LCBLZXltYXAsIENvbXBvbmVudCwgV29ya3NwYWNlTGVhZiwgVEZpbGUsIE1lbnVJdGVtfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQge2RvbUxlYXZlcywgSGlzdG9yeSwgSGlzdG9yeUVudHJ5fSBmcm9tIFwiLi9IaXN0b3J5XCI7XG5pbXBvcnQgUGFuZVJlbGllZiBmcm9tICcuL3BhbmUtcmVsaWVmJztcbmltcG9ydCB7UGVyV2luZG93Q29tcG9uZW50fSBmcm9tICcuL1BlcldpbmRvd0NvbXBvbmVudCc7XG5cbmRlY2xhcmUgbW9kdWxlIFwib2JzaWRpYW5cIiB7XG4gICAgaW50ZXJmYWNlIE1lbnUge1xuICAgICAgICBkb206IEhUTUxFbGVtZW50XG4gICAgfVxuICAgIGludGVyZmFjZSBNZW51SXRlbSB7XG4gICAgICAgIGRvbTogSFRNTEVsZW1lbnRcbiAgICB9XG4gICAgaW50ZXJmYWNlIEFwcCB7XG4gICAgICAgIGRyYWdNYW5hZ2VyOiBEcmFnTWFuYWdlclxuICAgIH1cbiAgICBpbnRlcmZhY2UgRHJhZ01hbmFnZXIge1xuICAgICAgICBkcmFnRmlsZShldmVudDogRHJhZ0V2ZW50LCBmaWxlOiBURmlsZSk6IERyYWdEYXRhXG4gICAgICAgIG9uRHJhZ1N0YXJ0KGV2ZW50OiBEcmFnRXZlbnQsIGRyYWdEYXRhOiBEcmFnRGF0YSk6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIERyYWdEYXRhIHt9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBhY3RpdmVUaW1lOiBudW1iZXJcbiAgICB9XG59XG5cbmludGVyZmFjZSBGaWxlSW5mbyB7XG4gICAgaWNvbjogc3RyaW5nXG4gICAgdGl0bGU6IHN0cmluZ1xuICAgIGZpbGU6IFRGaWxlXG4gICAgdHlwZTogc3RyaW5nXG4gICAgc3RhdGU6IGFueVxuICAgIGVTdGF0ZTogYW55XG59XG5cblxuY29uc3Qgdmlld3R5cGVJY29uczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICBtYXJrZG93bjogXCJkb2N1bWVudFwiLFxuICAgIGltYWdlOiBcImltYWdlLWZpbGVcIixcbiAgICBhdWRpbzogXCJhdWRpby1maWxlXCIsXG4gICAgdmlkZW86IFwiYXVkaW8tZmlsZVwiLFxuICAgIHBkZjogXCJwZGYtZmlsZVwiLFxuICAgIGxvY2FsZ3JhcGg6IFwiZG90LW5ldHdvcmtcIixcbiAgICBvdXRsaW5lOiBcImJ1bGxldC1saXN0XCIsXG4gICAgYmFja2xpbms6IFwibGlua1wiLFxuXG4gICAgLy8gdGhpcmQtcGFydHkgcGx1Z2luc1xuICAgIGthbmJhbjogXCJibG9ja3NcIixcbiAgICBleGNhbGlkcmF3OiBcImV4Y2FsaWRyYXctaWNvblwiLFxuICAgIFwibWVkaWEtdmlld1wiOiBcImF1ZGlvLWZpbGVcIixcbn1cblxuY29uc3Qgbm9uRmlsZVZpZXdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7XG4gICAgZ3JhcGg6IFtcImRvdC1uZXR3b3JrXCIsIFwiR3JhcGggVmlld1wiXSxcbiAgICBcImZpbGUtZXhwbG9yZXJcIjogW1wiZm9sZGVyXCIsIFwiRmlsZSBFeHBsb3JlclwiXSxcbiAgICBzdGFycmVkOiBbXCJzdGFyXCIsIFwiU3RhcnJlZCBGaWxlc1wiXSxcbiAgICB0YWc6IFtcInRhZ1wiLCBcIlRhZ3MgVmlld1wiXSxcblxuICAgIC8vIHRoaXJkLXBhcnR5IHBsdWdpbnNcbiAgICBcInJlY2VudC1maWxlc1wiOiBbXCJjbG9ja1wiLCBcIlJlY2VudCBGaWxlc1wiXSxcbiAgICBjYWxlbmRhcjogW1wiY2FsZW5kYXItd2l0aC1jaGVja21hcmtcIiwgXCJDYWxlbmRhclwiXSxcbiAgICBlbXB0eTogW1wiY3Jvc3NcIiwgXCJObyBmaWxlXCJdXG59XG5cbmV4cG9ydCBjbGFzcyBOYXZpZ2F0aW9uIGV4dGVuZHMgUGVyV2luZG93Q29tcG9uZW50PFBhbmVSZWxpZWY+IHtcbiAgICBiYWNrOiBOYXZpZ2F0b3JcbiAgICBmb3J3YXJkOiBOYXZpZ2F0b3JcbiAgICAvLyBTZXQgdG8gdHJ1ZSB3aGlsZSBlaXRoZXIgbWVudSBpcyBvcGVuLCBzbyB3ZSBkb24ndCBzd2l0Y2ggaXQgb3V0XG4gICAgaGlzdG9yeUlzT3BlbiA9IGZhbHNlO1xuXG4gICAgZGlzcGxheShsZWFmID0gdGhpcy5sYXRlc3RMZWFmKCkpIHtcbiAgICAgICAgaWYgKHRoaXMuaGlzdG9yeUlzT3BlbikgcmV0dXJuO1xuICAgICAgICBpZiAoIXRoaXMuX2xvYWRlZCkgeyB0aGlzLmxvYWQoKTsgcmV0dXJuOyB9XG4gICAgICAgIHRoaXMud2luLnJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBoaXN0b3J5ID0gbGVhZiA/IEhpc3RvcnkuZm9yTGVhZihsZWFmKSA6IG5ldyBIaXN0b3J5KCk7XG4gICAgICAgICAgICB0aGlzLmJhY2suc2V0SGlzdG9yeShoaXN0b3J5KTtcbiAgICAgICAgICAgIHRoaXMuZm9yd2FyZC5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgICAgICAgICAgaWYgKGxlYWYpIHRoaXMudXBkYXRlTGVhZihsZWFmLCBoaXN0b3J5KVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBsZWF2ZXMoKSB7XG4gICAgICAgIGNvbnN0IGxlYXZlczogV29ya3NwYWNlTGVhZltdID0gW107XG4gICAgICAgIGNvbnN0IGNiID0gKGxlYWY6IFdvcmtzcGFjZUxlYWYpID0+IHsgbGVhdmVzLnB1c2gobGVhZik7IH07XG4gICAgICAgIGFwcC53b3Jrc3BhY2UuaXRlcmF0ZUxlYXZlcyhjYiwgdGhpcy5yb290KTtcblxuICAgICAgICAvLyBTdXBwb3J0IEhvdmVyIEVkaXRvcnNcbiAgICAgICAgY29uc3QgcG9wb3ZlcnMgPSBhcHAucGx1Z2lucy5wbHVnaW5zW1wib2JzaWRpYW4taG92ZXItZWRpdG9yXCJdPy5hY3RpdmVQb3BvdmVycztcbiAgICAgICAgaWYgKHBvcG92ZXJzKSBmb3IgKGNvbnN0IHBvcG92ZXIgb2YgcG9wb3ZlcnMpIHtcbiAgICAgICAgICAgIGlmIChwb3BvdmVyLmhvdmVyRWwub3duZXJEb2N1bWVudC5kZWZhdWx0VmlldyAhPT0gdGhpcy53aW4pIGNvbnRpbnVlOyAvLyBtdXN0IGJlIGluIHNhbWUgd2luZG93XG4gICAgICAgICAgICBlbHNlIGlmIChwb3BvdmVyLnJvb3RTcGxpdCkgYXBwLndvcmtzcGFjZS5pdGVyYXRlTGVhdmVzKGNiLCBwb3BvdmVyLnJvb3RTcGxpdCk7XG4gICAgICAgICAgICBlbHNlIGlmIChwb3BvdmVyLmxlYWYpIGNiKHBvcG92ZXIubGVhZik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxlYXZlcztcbiAgICB9XG5cbiAgICBsYXRlc3RMZWFmKCkge1xuICAgICAgICBsZXQgbGVhZiA9IGFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZjtcbiAgICAgICAgaWYgKGxlYWYgJiYgdGhpcy5wbHVnaW4ubmF2LmZvckxlYWYobGVhZikgPT09IHRoaXMpIHJldHVybiBsZWFmO1xuICAgICAgICByZXR1cm4gdGhpcy5sZWF2ZXMoKS5yZWR1Y2UoKGJlc3QsIGxlYWYpPT57IHJldHVybiAoIWJlc3QgfHwgYmVzdC5hY3RpdmVUaW1lIDwgbGVhZi5hY3RpdmVUaW1lKSA/IGxlYWYgOiBiZXN0OyB9LCBudWxsKTtcbiAgICB9XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIC8vIE92ZXJyaWRlIGRlZmF1bHQgbW91c2UgaGlzdG9yeSBiZWhhdmlvci4gIFdlIG5lZWQgdGhpcyBiZWNhdXNlIDEpIEVsZWN0cm9uIHdpbGwgdXNlIHRoZSBidWlsdC1pblxuICAgICAgICAvLyBoaXN0b3J5IG9iamVjdCBpZiB3ZSBkb24ndCAoaW5zdGVhZCBvZiBvdXIgd3JhcHBlciksIGFuZCAyKSB3ZSB3YW50IHRoZSBjbGljayB0byBhcHBseSB0byB0aGUgbGVhZlxuICAgICAgICAvLyB0aGF0IHdhcyB1bmRlciB0aGUgbW91c2UsIHJhdGhlciB0aGFuIHdoaWNoZXZlciBsZWFmIHdhcyBhY3RpdmUuXG4gICAgICAgIGNvbnN0IHtkb2N1bWVudH0gPSB0aGlzLndpbjtcbiAgICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgaGlzdG9yeUhhbmRsZXIsIHRydWUpO1xuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwibW91c2Vkb3duXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlcigoKSA9PiB7XG4gICAgICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBoaXN0b3J5SGFuZGxlciwgdHJ1ZSk7XG4gICAgICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2Vkb3duXCIsIGhpc3RvcnlIYW5kbGVyLCB0cnVlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGZ1bmN0aW9uIGhpc3RvcnlIYW5kbGVyKGU6IE1vdXNlRXZlbnQpIHtcbiAgICAgICAgICAgIGlmIChlLmJ1dHRvbiAhPT0gMyAmJiBlLmJ1dHRvbiAhPT0gNCkgcmV0dXJuO1xuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOyBlLnN0b3BQcm9wYWdhdGlvbigpOyAgLy8gcHJldmVudCBkZWZhdWx0IGJlaGF2aW9yXG4gICAgICAgICAgICBjb25zdCB0YXJnZXQgPSAoZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQpLm1hdGNoUGFyZW50KFwiLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICAgICAgaWYgKHRhcmdldCAmJiBlLnR5cGUgPT09IFwibW91c2V1cFwiKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlYWYgPSBkb21MZWF2ZXMuZ2V0KHRhcmdldCk7XG4gICAgICAgICAgICAgICAgaWYgKCFsZWFmKSBhcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMobCA9PiBsZWFmID0gKGwuY29udGFpbmVyRWwgPT09IHRhcmdldCkgPyBsIDogbGVhZik7XG4gICAgICAgICAgICAgICAgaWYgKCFsZWFmKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgaWYgKGUuYnV0dG9uID09IDMpIHsgSGlzdG9yeS5mb3JMZWFmKGxlYWYpLmJhY2soKTsgfVxuICAgICAgICAgICAgICAgIGlmIChlLmJ1dHRvbiA9PSA0KSB7IEhpc3RvcnkuZm9yTGVhZihsZWFmKS5mb3J3YXJkKCk7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuYmFjayAgICA9IG5ldyBOYXZpZ2F0b3IodGhpcywgXCJiYWNrXCIsIC0xKSk7XG4gICAgICAgICAgICB0aGlzLmFkZENoaWxkKHRoaXMuZm9yd2FyZCA9IG5ldyBOYXZpZ2F0b3IodGhpcywgXCJmb3J3YXJkXCIsIDEpKTtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheSgpO1xuICAgICAgICAgICAgdGhpcy5udW1iZXJQYW5lcygpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KGFwcC53b3Jrc3BhY2Uub24oXCJsYXlvdXQtY2hhbmdlXCIsIHRoaXMubnVtYmVyUGFuZXMsIHRoaXMpKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgb251bmxvYWQoKSB7XG4gICAgICAgIHRoaXMudW5OdW1iZXJQYW5lcygpO1xuICAgICAgICB0aGlzLndpbi5kb2N1bWVudC5ib2R5LmZpbmRBbGwoXCIud29ya3NwYWNlLWxlYWZcIikuZm9yRWFjaChsZWFmRWwgPT4ge1xuICAgICAgICAgICAgLy8gUmVzdG9yZSBDUEhBVEIgYnV0dG9uIGxhYmVsc1xuICAgICAgICAgICAgY29uc3QgYWN0aW9ucyA9IGxlYWZFbC5maW5kKFwiLnZpZXctaGVhZGVyID4gLnZpZXctYWN0aW9uc1wiKTtcbiAgICAgICAgICAgIGNvbnN0IGZ3ZCA9IGFjdGlvbnM/LmZpbmQoJy52aWV3LWFjdGlvbltjbGFzcyo9XCIgYXBwOmdvLWZvcndhcmRcIl0nKTtcbiAgICAgICAgICAgIGNvbnN0IGJhY2sgPSBhY3Rpb25zPy5maW5kKCcudmlldy1hY3Rpb25bY2xhc3MqPVwiIGFwcDpnby1iYWNrXCJdJyk7XG4gICAgICAgICAgICBpZiAoZndkKSAgc2V0VG9vbHRpcChmd2QsIHRoaXMuZm9yd2FyZC5vbGRMYWJlbCk7XG4gICAgICAgICAgICBpZiAoYmFjaykgc2V0VG9vbHRpcChmd2QsIHRoaXMuYmFjay5vbGRMYWJlbCk7XG4gICAgICAgIH0pXG4gICAgfVxuXG4gICAgdW5OdW1iZXJQYW5lcyhzZWxlY3RvciA9IFwiLndvcmtzcGFjZS1sZWFmXCIpIHtcbiAgICAgICAgdGhpcy53aW4uZG9jdW1lbnQuYm9keS5maW5kQWxsKHNlbGVjdG9yKS5mb3JFYWNoKGVsID0+IHtcbiAgICAgICAgICAgIGVsLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1sYWJlbFwiKTtcbiAgICAgICAgICAgIGVsLnRvZ2dsZUNsYXNzKFwiaGFzLXBhbmUtcmVsaWVmLWxhYmVsXCIsIGZhbHNlKTtcbiAgICAgICAgICAgIGVsLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwiLS1wYW5lLXJlbGllZi1mb3J3YXJkLWNvdW50XCIpO1xuICAgICAgICAgICAgZWwuc3R5bGUucmVtb3ZlUHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWJhY2t3YXJkLWNvdW50XCIpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB1cGRhdGVMZWFmKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGhpc3Rvcnk6IEhpc3RvcnkgPSBIaXN0b3J5LmZvckxlYWYobGVhZikpIHtcbiAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtZm9yd2FyZC1jb3VudFwiLCAnXCInKyhoaXN0b3J5Lmxvb2tBaGVhZCgpLmxlbmd0aCB8fCBcIlwiKSsnXCInKTtcbiAgICAgICAgbGVhZi5jb250YWluZXJFbC5zdHlsZS5zZXRQcm9wZXJ0eShcIi0tcGFuZS1yZWxpZWYtYmFja3dhcmQtY291bnRcIiwgJ1wiJysoaGlzdG9yeS5sb29rQmVoaW5kKCkubGVuZ3RoIHx8IFwiXCIpKydcIicpO1xuXG4gICAgICAgIC8vIEFkZCBsYWJlbHMgZm9yIENQSEFUQiBuYXYgYnV0dG9uc1xuICAgICAgICBjb25zdCBhY3Rpb25zID0gbGVhZi5jb250YWluZXJFbC5maW5kKFwiLnZpZXctaGVhZGVyID4gLnZpZXctYWN0aW9uc1wiKTtcbiAgICAgICAgY29uc3QgZndkID0gYWN0aW9ucz8uZmluZCgnLnZpZXctYWN0aW9uW2NsYXNzKj1cIiBhcHA6Z28tZm9yd2FyZFwiXScpO1xuICAgICAgICBjb25zdCBiYWNrID0gYWN0aW9ucz8uZmluZCgnLnZpZXctYWN0aW9uW2NsYXNzKj1cIiBhcHA6Z28tYmFja1wiXScpO1xuICAgICAgICBpZiAoZndkKSB0aGlzLmZvcndhcmQudXBkYXRlRGlzcGxheShoaXN0b3J5LCBmd2QpO1xuICAgICAgICBpZiAoYmFjaykgdGhpcy5iYWNrLnVwZGF0ZURpc3BsYXkoaGlzdG9yeSwgYmFjayk7XG4gICAgfVxuXG4gICAgbnVtYmVyUGFuZXMoKSB7XG4gICAgICAgIHRoaXMud2luLnJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICAvLyB1bm51bWJlciBzaWRlYmFyIHBhbmVzIGluIG1haW4gd2luZG93LCBpZiBzb21ldGhpbmcgd2FzIG1vdmVkIHRoZXJlXG4gICAgICAgICAgICBpZiAodGhpcy53aW4gPT09IHdpbmRvdykgdGhpcy51bk51bWJlclBhbmVzKFwiLndvcmtzcGFjZS10YWJzID4gLndvcmtzcGFjZS1sZWFmXCIpO1xuICAgICAgICAgICAgbGV0IGNvdW50ID0gMCwgbGFzdExlYWY6IFdvcmtzcGFjZUxlYWYgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5sZWF2ZXMoKS5mb3JFYWNoKGxlYWYgPT4ge1xuICAgICAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwuc3R5bGUuc2V0UHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWxhYmVsXCIsICsrY291bnQgPCA5ID8gXCJcIitjb3VudCA6IFwiXCIpO1xuICAgICAgICAgICAgICAgIGxlYWYuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgY291bnQ8OSk7XG4gICAgICAgICAgICAgICAgbGFzdExlYWYgPSBsZWFmO1xuICAgICAgICAgICAgICAgIHRoaXMudXBkYXRlTGVhZihsZWFmKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKGNvdW50PjgpIHtcbiAgICAgICAgICAgICAgICBsYXN0TGVhZj8uY29udGFpbmVyRWwuc3R5bGUuc2V0UHJvcGVydHkoXCItLXBhbmUtcmVsaWVmLWxhYmVsXCIsIFwiOVwiKTtcbiAgICAgICAgICAgICAgICBsYXN0TGVhZj8uY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJoYXMtcGFuZS1yZWxpZWYtbGFiZWxcIiwgdHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgfVxuXG4gICAgb25VcGRhdGVIaXN0b3J5KGxlYWY6IFdvcmtzcGFjZUxlYWYsIGhpc3Rvcnk6IEhpc3RvcnkpIHtcbiAgICAgICAgdGhpcy53aW4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMudXBkYXRlTGVhZihsZWFmKTsgLy8gdXBkYXRlIGxlYWYncyBzdGF0cyBhbmQgYnV0dG9uc1xuICAgICAgICAgICAgLy8gdXBkYXRlIHdpbmRvdydzIG5hdiBhcnJvd3NcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ID09PSB0aGlzLmZvcndhcmQuaGlzdG9yeSkgdGhpcy5mb3J3YXJkLnNldEhpc3RvcnkoaGlzdG9yeSk7XG4gICAgICAgICAgICBpZiAoaGlzdG9yeSA9PT0gdGhpcy5iYWNrLmhpc3RvcnkpICAgIHRoaXMuYmFjay5zZXRIaXN0b3J5KGhpc3RvcnkpO1xuICAgICAgICB9KTtcbiAgICB9XG59XG5cbmV4cG9ydCBjbGFzcyBOYXZpZ2F0b3IgZXh0ZW5kcyBDb21wb25lbnQge1xuXG4gICAgc3RhdGljIGhvdmVyU291cmNlID0gXCJwYW5lLXJlbGllZjpoaXN0b3J5LW1lbnVcIjtcblxuICAgIGNvbnRhaW5lckVsOiBIVE1MRWxlbWVudFxuICAgIGNvdW50OiBIVE1MU3BhbkVsZW1lbnRcbiAgICBoaXN0b3J5OiBIaXN0b3J5ID0gbnVsbDtcbiAgICBvbGRMYWJlbDogc3RyaW5nXG5cbiAgICBjb25zdHJ1Y3RvcihwdWJsaWMgb3duZXI6IE5hdmlnYXRpb24sIHB1YmxpYyBraW5kOiAnZm9yd2FyZCd8J2JhY2snLCBwdWJsaWMgZGlyOiBudW1iZXIpICB7XG4gICAgICAgIHN1cGVyKCk7XG4gICAgfVxuXG4gICAgb25sb2FkKCkge1xuICAgICAgICB0aGlzLmNvbnRhaW5lckVsID0gdGhpcy5vd25lci53aW4uZG9jdW1lbnQuYm9keS5maW5kKFxuICAgICAgICAgICAgYC50aXRsZWJhciAudGl0bGViYXItYnV0dG9uLWNvbnRhaW5lci5tb2QtbGVmdCAudGl0bGViYXItYnV0dG9uLm1vZC0ke3RoaXMua2luZH1gXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuY291bnQgPSB0aGlzLmNvbnRhaW5lckVsLmNyZWF0ZVNwYW4oe3ByZXBlbmQ6IHRoaXMua2luZCA9PT0gXCJiYWNrXCIsIGNsczogXCJoaXN0b3J5LWNvdW50ZXJcIn0pO1xuICAgICAgICB0aGlzLmhpc3RvcnkgPSBudWxsO1xuICAgICAgICB0aGlzLm9sZExhYmVsID0gdGhpcy5jb250YWluZXJFbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRG9tRXZlbnQodGhpcy5jb250YWluZXJFbCwgXCJjb250ZXh0bWVudVwiLCB0aGlzLm9wZW5NZW51LmJpbmQodGhpcykpO1xuICAgICAgICBjb25zdCBvbkNsaWNrID0gKGU6IE1vdXNlRXZlbnQpID0+IHtcbiAgICAgICAgICAgIC8vIERvbid0IGFsbG93IE9ic2lkaWFuIHRvIHN3aXRjaCB3aW5kb3cgb3IgZm9yd2FyZCB0aGUgZXZlbnRcbiAgICAgICAgICAgIGUucHJldmVudERlZmF1bHQoKTsgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgIC8vIERvIHRoZSBuYXZpZ2F0aW9uXG4gICAgICAgICAgICB0aGlzLmhpc3Rvcnk/Llt0aGlzLmtpbmRdKCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5yZWdpc3RlcigoKSA9PiB0aGlzLmNvbnRhaW5lckVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkNsaWNrLCB0cnVlKSk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uQ2xpY2ssIHRydWUpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKFxuICAgICAgICAgICAgLy8gU3VwcG9ydCBcIkN1c3RvbWl6YWJsZSBQYWdlIEhlYWRlciBhbmQgVGl0bGUgQmFyXCIgYnV0dG9uc1xuICAgICAgICAgICAgb25FbGVtZW50KFxuICAgICAgICAgICAgICAgIHRoaXMub3duZXIud2luLmRvY3VtZW50LmJvZHksXG4gICAgICAgICAgICAgICAgXCJjb250ZXh0bWVudVwiLFxuICAgICAgICAgICAgICAgIGAudmlldy1oZWFkZXIgPiAudmlldy1hY3Rpb25zID4gLnZpZXctYWN0aW9uW2NsYXNzKj1cImFwcDpnby0ke3RoaXMua2luZH1cIl1gLFxuICAgICAgICAgICAgICAgIChldnQsIHRhcmdldCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBlbCA9IHRhcmdldC5tYXRjaFBhcmVudChcIi53b3Jrc3BhY2UtbGVhZlwiKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMub3duZXIubGVhdmVzKCkuZmlsdGVyKGxlYWYgPT4gbGVhZi5jb250YWluZXJFbCA9PT0gZWwpLnBvcCgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWxlYWYpIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICAgICAgICAgIGV2dC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5vcGVuTWVudShldnQsIEhpc3RvcnkuZm9yTGVhZihsZWFmKSk7XG4gICAgICAgICAgICAgICAgfSwge2NhcHR1cmU6IHRydWV9XG4gICAgICAgICAgICApXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgb251bmxvYWQoKSB7XG4gICAgICAgIHNldFRvb2x0aXAodGhpcy5jb250YWluZXJFbCwgdGhpcy5vbGRMYWJlbCk7XG4gICAgICAgIHRoaXMuY291bnQuZGV0YWNoKCk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyRWwudG9nZ2xlQ2xhc3MoXCJtb2QtYWN0aXZlXCIsIGZhbHNlKTtcbiAgICB9XG5cbiAgICBzZXRDb3VudChudW06IG51bWJlcikgeyB0aGlzLmNvdW50LnRleHRDb250ZW50ID0gXCJcIiArIChudW0gfHwgXCJcIik7IH1cblxuICAgIHNldEhpc3RvcnkoaGlzdG9yeSA9IEhpc3RvcnkuY3VycmVudCgpKSB7XG4gICAgICAgIHRoaXMudXBkYXRlRGlzcGxheSh0aGlzLmhpc3RvcnkgPSBoaXN0b3J5KTtcbiAgICB9XG5cbiAgICB1cGRhdGVEaXNwbGF5KGhpc3Rvcnk6IEhpc3RvcnksIGVsID0gdGhpcy5jb250YWluZXJFbCkge1xuICAgICAgICBjb25zdCBzdGF0ZXMgPSBoaXN0b3J5W3RoaXMuZGlyIDwgMCA/IFwibG9va0JlaGluZFwiIDogXCJsb29rQWhlYWRcIl0oKTtcbiAgICAgICAgaWYgKGVsPT09dGhpcy5jb250YWluZXJFbCkgdGhpcy5zZXRDb3VudChzdGF0ZXMubGVuZ3RoKTtcbiAgICAgICAgc2V0VG9vbHRpcChlbCwgc3RhdGVzLmxlbmd0aCA/XG4gICAgICAgICAgICB0aGlzLm9sZExhYmVsICsgXCJcXG5cIiArIHRoaXMuZm9ybWF0U3RhdGUoc3RhdGVzWzBdKS50aXRsZSA6XG4gICAgICAgICAgICBgTm8gJHt0aGlzLmtpbmR9IGhpc3RvcnlgXG4gICAgICAgICk7XG4gICAgICAgIGVsLnRvZ2dsZUNsYXNzKFwibW9kLWFjdGl2ZVwiLCBzdGF0ZXMubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgb3Blbk1lbnUoZXZ0OiB7Y2xpZW50WDogbnVtYmVyLCBjbGllbnRZOiBudW1iZXJ9LCBoaXN0b3J5ID0gdGhpcy5oaXN0b3J5KSB7XG4gICAgICAgIGNvbnN0IHN0YXRlcyA9IGhpc3RvcnlbdGhpcy5kaXIgPCAwID8gXCJsb29rQmVoaW5kXCIgOiBcImxvb2tBaGVhZFwiXSgpO1xuICAgICAgICBpZiAoIXN0YXRlcy5sZW5ndGgpIHJldHVybjtcbiAgICAgICAgY29uc3QgbWVudSA9IG5ldyBNZW51KCk7XG4gICAgICAgIG1lbnUuZG9tLmFkZENsYXNzKFwicGFuZS1yZWxpZWYtaGlzdG9yeS1tZW51XCIpO1xuICAgICAgICBtZW51LmRvbS5vbihcIm1vdXNlZG93blwiLCBcIi5tZW51LWl0ZW1cIiwgZSA9PiB7ZS5zdG9wUHJvcGFnYXRpb24oKTt9LCB0cnVlKTtcbiAgICAgICAgc3RhdGVzLm1hcCh0aGlzLmZvcm1hdFN0YXRlLmJpbmQodGhpcykpLmZvckVhY2goXG4gICAgICAgICAgICAoaW5mbzogRmlsZUluZm8sIGlkeCkgPT4gdGhpcy5tZW51SXRlbShpbmZvLCBpZHgsIG1lbnUsIGhpc3RvcnkpXG4gICAgICAgICk7XG4gICAgICAgIG1lbnUuc2hvd0F0UG9zaXRpb24oe3g6IGV2dC5jbGllbnRYLCB5OiBldnQuY2xpZW50WSArIDIwfSk7XG4gICAgICAgIHRoaXMub3duZXIuaGlzdG9yeUlzT3BlbiA9IHRydWU7XG4gICAgICAgIG1lbnUub25IaWRlKCgpID0+IHsgdGhpcy5vd25lci5oaXN0b3J5SXNPcGVuID0gZmFsc2U7IHRoaXMub3duZXIuZGlzcGxheSgpOyB9KTtcbiAgICB9XG5cbiAgICBtZW51SXRlbShpbmZvOiBGaWxlSW5mbywgaWR4OiBudW1iZXIsIG1lbnU6IE1lbnUsIGhpc3Rvcnk6IEhpc3RvcnkpIHtcbiAgICAgICAgY29uc3Qge2Rpciwga2luZH0gPSB0aGlzO1xuICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiB7IGNyZWF0ZUl0ZW0oaSk7IGlmIChpbmZvLmZpbGUpIHNldHVwRmlsZUV2ZW50cyhpLmRvbSk7IH0pO1xuICAgICAgICByZXR1cm47XG5cbiAgICAgICAgZnVuY3Rpb24gY3JlYXRlSXRlbShpOiBNZW51SXRlbSwgcHJlZml4PVwiXCIpIHtcbiAgICAgICAgICAgIGkuc2V0SWNvbihpbmZvLmljb24pLnNldFRpdGxlKHByZWZpeCArIGluZm8udGl0bGUpLm9uQ2xpY2soZSA9PiB7XG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgZm9yIGN0cmwvY21kL21pZGRsZSBidXR0b24gYW5kIHNwbGl0IGxlYWYgKyBjb3B5IGhpc3RvcnlcbiAgICAgICAgICAgICAgICBpZiAoS2V5bWFwLmlzTW9kaWZpZXIoZSwgXCJNb2RcIikgfHwgMSA9PT0gKGUgYXMgTW91c2VFdmVudCkuYnV0dG9uKSB7XG4gICAgICAgICAgICAgICAgICAgIGhpc3RvcnkgPSBoaXN0b3J5LmNsb25lVG8oYXBwLndvcmtzcGFjZS5zcGxpdEFjdGl2ZUxlYWYoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGhpc3RvcnkuZ28oKGlkeCsxKSAqIGRpciwgdHJ1ZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHNldHVwRmlsZUV2ZW50cyhkb206IEhUTUxFbGVtZW50KSB7XG4gICAgICAgICAgICAvLyBIb3ZlciBwcmV2aWV3XG4gICAgICAgICAgICBkb20uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VvdmVyJywgZSA9PiB7XG4gICAgICAgICAgICAgICAgYXBwLndvcmtzcGFjZS50cmlnZ2VyKCdob3Zlci1saW5rJywge1xuICAgICAgICAgICAgICAgICAgICBldmVudDogZSwgc291cmNlOiBOYXZpZ2F0b3IuaG92ZXJTb3VyY2UsXG4gICAgICAgICAgICAgICAgICAgIGhvdmVyUGFyZW50OiBtZW51LmRvbSwgdGFyZ2V0RWw6IGRvbSwgbGlua3RleHQ6IGluZm8uZmlsZS5wYXRoXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRHJhZyBtZW51IGl0ZW0gdG8gbW92ZSBvciBsaW5rIGZpbGVcbiAgICAgICAgICAgIGRvbS5zZXRBdHRyKCdkcmFnZ2FibGUnLCAndHJ1ZScpO1xuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIGUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdNYW5hZ2VyID0gYXBwLmRyYWdNYW5hZ2VyO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRyYWdEYXRhID0gZHJhZ01hbmFnZXIuZHJhZ0ZpbGUoZSwgaW5mby5maWxlKTtcbiAgICAgICAgICAgICAgICBkcmFnTWFuYWdlci5vbkRyYWdTdGFydChlLCBkcmFnRGF0YSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGRvbS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgZSA9PiBtZW51LmhpZGUoKSk7XG5cbiAgICAgICAgICAgIC8vIEZpbGUgbWVudVxuICAgICAgICAgICAgZG9tLmFkZEV2ZW50TGlzdGVuZXIoXCJjb250ZXh0bWVudVwiLCBlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBtZW51ID0gbmV3IE1lbnUoKTtcbiAgICAgICAgICAgICAgICBtZW51LmFkZEl0ZW0oaSA9PiBjcmVhdGVJdGVtKGksIGBHbyAke2tpbmR9IHRvIGApKS5hZGRTZXBhcmF0b3IoKTtcbiAgICAgICAgICAgICAgICBhcHAud29ya3NwYWNlLnRyaWdnZXIoXG4gICAgICAgICAgICAgICAgICAgIFwiZmlsZS1tZW51XCIsIG1lbnUsIGluZm8uZmlsZSwgXCJsaW5rLWNvbnRleHQtbWVudVwiXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBtZW51LnNob3dBdFBvc2l0aW9uKHt4OiBlLmNsaWVudFgsIHk6IGUuY2xpZW50WX0pO1xuICAgICAgICAgICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7IC8vIGtlZXAgdGhlIHBhcmVudCBtZW51IG9wZW4gZm9yIG5vd1xuICAgICAgICAgICAgfSwgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmb3JtYXRTdGF0ZShlbnRyeTogSGlzdG9yeUVudHJ5KTogRmlsZUluZm8ge1xuICAgICAgICBjb25zdCB7dmlld1N0YXRlOiB7dHlwZSwgc3RhdGV9LCBlU3RhdGUsIHBhdGh9ID0gZW50cnk7XG4gICAgICAgIGNvbnN0IGZpbGUgPSBwYXRoICYmIGFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCkgYXMgVEZpbGU7XG4gICAgICAgIGNvbnN0IGluZm8gPSB7aWNvbjogXCJcIiwgdGl0bGU6IFwiXCIsIGZpbGUsIHR5cGUsIHN0YXRlLCBlU3RhdGV9O1xuXG4gICAgICAgIGlmIChub25GaWxlVmlld3NbdHlwZV0pIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gbm9uRmlsZVZpZXdzW3R5cGVdO1xuICAgICAgICB9IGVsc2UgaWYgKHBhdGggJiYgIWZpbGUpIHtcbiAgICAgICAgICAgIFtpbmZvLmljb24sIGluZm8udGl0bGVdID0gW1widHJhc2hcIiwgXCJNaXNzaW5nIGZpbGUgXCIrcGF0aF07XG4gICAgICAgIH0gZWxzZSBpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB7XG4gICAgICAgICAgICBpbmZvLmljb24gPSB2aWV3dHlwZUljb25zW3R5cGVdID8/IFwiZG9jdW1lbnRcIjtcbiAgICAgICAgICAgIGlmICh0eXBlID09PSBcIm1hcmtkb3duXCIgJiYgc3RhdGUubW9kZSA9PT0gXCJwcmV2aWV3XCIpIGluZm8uaWNvbiA9IFwibGluZXMtb2YtdGV4dFwiO1xuICAgICAgICAgICAgaW5mby50aXRsZSA9IGZpbGUgPyBmaWxlLmJhc2VuYW1lICsgKGZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIgPyBcIi5cIitmaWxlLmV4dGVuc2lvbiA6IFwiXCIpIDogXCJObyBmaWxlXCI7XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gXCJtZWRpYS12aWV3XCIgJiYgIWZpbGUpIGluZm8udGl0bGUgPSBzdGF0ZS5pbmZvPy5maWxlbmFtZSA/PyBpbmZvLnRpdGxlO1xuICAgICAgICB9XG5cbiAgICAgICAgYXBwLndvcmtzcGFjZS50cmlnZ2VyKFwicGFuZS1yZWxpZWY6Zm9ybWF0LWhpc3RvcnktaXRlbVwiLCBpbmZvKTtcbiAgICAgICAgcmV0dXJuIGluZm87XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gb25FbGVtZW50PEsgZXh0ZW5kcyBrZXlvZiBIVE1MRWxlbWVudEV2ZW50TWFwPihcbiAgICBlbDogSFRNTEVsZW1lbnQsXG4gICAgZXZlbnQ6IEssXG4gICAgc2VsZWN0b3I6IHN0cmluZyxcbiAgICBjYWxsYmFjazogKHRoaXM6IEhUTUxFbGVtZW50LCBldjogSFRNTEVsZW1lbnRFdmVudE1hcFtLXSwgZGVsZWdhdGVUYXJnZXQ6IEhUTUxFbGVtZW50KSA9PiBhbnksXG4gICAgb3B0aW9ucz86IGJvb2xlYW4gfCBBZGRFdmVudExpc3RlbmVyT3B0aW9uc1xuKSB7XG4gICAgZWwub24oZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucylcbiAgICByZXR1cm4gKCkgPT4gZWwub2ZmKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpO1xufVxuXG5mdW5jdGlvbiBzZXRUb29sdGlwKGVsOiBIVE1MRWxlbWVudCwgdGV4dDogc3RyaW5nKSB7XG4gICAgaWYgKHRleHQpIGVsLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdGV4dCB8fCB1bmRlZmluZWQpO1xuICAgIGVsc2UgZWwucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbn0iLCJpbXBvcnQge1BsdWdpbiwgVEZpbGUsIFdvcmtzcGFjZVRhYnN9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7YWRkQ29tbWFuZHMsIGNvbW1hbmR9IGZyb20gXCIuL2NvbW1hbmRzXCI7XG5pbXBvcnQge0hpc3RvcnksIGluc3RhbGxIaXN0b3J5fSBmcm9tIFwiLi9IaXN0b3J5XCI7XG5pbXBvcnQgeyBNYXhpbWl6ZXIgfSBmcm9tICcuL21heGltaXppbmcnO1xuaW1wb3J0IHtOYXZpZ2F0aW9uLCBOYXZpZ2F0b3IsIG9uRWxlbWVudH0gZnJvbSBcIi4vTmF2aWdhdG9yXCI7XG5cbmltcG9ydCBcIi4vc3R5bGVzLnNjc3NcIjtcblxuZGVjbGFyZSBtb2R1bGUgXCJvYnNpZGlhblwiIHtcbiAgICBpbnRlcmZhY2UgV29ya3NwYWNlIHtcbiAgICAgICAgb24odHlwZTogXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCBjYWxsYmFjazogKGxlYWY6IFdvcmtzcGFjZUxlYWYsIGhpc3Rvcnk6IEhpc3RvcnkpID0+IGFueSwgY3R4PzogYW55KTogRXZlbnRSZWY7XG4gICAgICAgIHJlZ2lzdGVySG92ZXJMaW5rU291cmNlKHNvdXJjZTogc3RyaW5nLCBpbmZvOiB7ZGlzcGxheTogc3RyaW5nLCBkZWZhdWx0TW9kPzogYm9vbGVhbn0pOiB2b2lkXG4gICAgICAgIHVucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2Uoc291cmNlOiBzdHJpbmcpOiB2b2lkXG4gICAgICAgIGl0ZXJhdGVMZWF2ZXMoY2FsbGJhY2s6IChpdGVtOiBXb3Jrc3BhY2VMZWFmKSA9PiB1bmtub3duLCBpdGVtOiBXb3Jrc3BhY2VQYXJlbnQpOiBib29sZWFuO1xuICAgICAgICBvbkxheW91dENoYW5nZSgpOiB2b2lkXG4gICAgfVxuICAgIGludGVyZmFjZSBBcHAge1xuICAgICAgICBwbHVnaW5zOiB7XG4gICAgICAgICAgICBwbHVnaW5zOiB7XG4gICAgICAgICAgICAgICAgXCJvYnNpZGlhbi1ob3Zlci1lZGl0b3JcIjoge1xuICAgICAgICAgICAgICAgICAgICBhY3RpdmVQb3BvdmVyczogSG92ZXJQb3BvdmVyW11cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUl0ZW0ge1xuICAgICAgICBjb250YWluZXJFbDogSFRNTERpdkVsZW1lbnRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZVBhcmVudCB7XG4gICAgICAgIGNoaWxkcmVuOiBXb3Jrc3BhY2VJdGVtW11cbiAgICAgICAgcmVjb21wdXRlQ2hpbGRyZW5EaW1lbnNpb25zKCk6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZVRhYnMgZXh0ZW5kcyBXb3Jrc3BhY2VQYXJlbnQge1xuICAgICAgICBzZWxlY3RUYWIobGVhZjogV29ya3NwYWNlTGVhZik6IHZvaWRcbiAgICB9XG4gICAgaW50ZXJmYWNlIFdvcmtzcGFjZUxlYWYge1xuICAgICAgICBwYXJlbnRTcGxpdDogV29ya3NwYWNlUGFyZW50XG4gICAgfVxuICAgIGludGVyZmFjZSBIb3ZlclBvcG92ZXIge1xuICAgICAgICBsZWFmPzogV29ya3NwYWNlTGVhZlxuICAgICAgICByb290U3BsaXQ/OiBXb3Jrc3BhY2VTcGxpdFxuICAgICAgICBob3ZlckVsOiBIVE1MRWxlbWVudFxuICAgIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgUGFuZVJlbGllZiBleHRlbmRzIFBsdWdpbiB7XG5cbiAgICBuYXYgPSBOYXZpZ2F0aW9uLnBlcldpbmRvdyh0aGlzKS53YXRjaCgpO1xuICAgIG1heCA9IHRoaXMuYWRkQ2hpbGQobmV3IE1heGltaXplcik7XG5cbiAgICBvbmxvYWQoKSB7XG4gICAgICAgIGluc3RhbGxIaXN0b3J5KHRoaXMpO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlLCB7XG4gICAgICAgICAgICBkaXNwbGF5OiAnSGlzdG9yeSBkcm9wZG93bnMnLCBkZWZhdWx0TW9kOiB0cnVlXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAudmF1bHQub24oXCJyZW5hbWVcIiwgKGZpbGUsIG9sZFBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcyhcbiAgICAgICAgICAgICAgICAgICAgbGVhZiA9PiBIaXN0b3J5LmZvckxlYWYobGVhZikub25SZW5hbWUoZmlsZSwgb2xkUGF0aClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgICAgIGFwcC53b3Jrc3BhY2Uub24oXCJhY3RpdmUtbGVhZi1jaGFuZ2VcIiwgbGVhZiA9PiB0aGlzLm5hdi5mb3JMZWFmKGxlYWYpLmRpc3BsYXkobGVhZikpXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgICAgIGFwcC53b3Jrc3BhY2Uub24oXCJwYW5lLXJlbGllZjp1cGRhdGUtaGlzdG9yeVwiLCAobGVhZiwgaGlzdG9yeSkgPT4gdGhpcy5uYXYuZm9yTGVhZihsZWFmKS5vblVwZGF0ZUhpc3RvcnkobGVhZiwgaGlzdG9yeSkpXG4gICAgICAgICAgICApO1xuICAgICAgICB9KTtcblxuICAgICAgICBhZGRDb21tYW5kcyh0aGlzLCB7XG4gICAgICAgICAgICBbY29tbWFuZChcInN3YXAtcHJldlwiLCBcIlN3YXAgcGFuZSB3aXRoIHByZXZpb3VzIGluIHNwbGl0XCIsICBcIk1vZCtTaGlmdCtQYWdlVXBcIildICAgKCl7IHJldHVybiB0aGlzLmxlYWZQbGFjZXIoLTEpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJzd2FwLW5leHRcIiwgXCJTd2FwIHBhbmUgd2l0aCBuZXh0IGluIHNwbGl0XCIsICAgICAgXCJNb2QrU2hpZnQrUGFnZURvd25cIildICgpeyByZXR1cm4gdGhpcy5sZWFmUGxhY2VyKCAxKTsgfSxcblxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1wcmV2XCIsICBcIkN5Y2xlIHRvIHByZXZpb3VzIHdvcmtzcGFjZSBwYW5lXCIsICAgXCJNb2QrUGFnZVVwXCIgICldICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoLTEsIHRydWUpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby1uZXh0XCIsICBcIkN5Y2xlIHRvIG5leHQgd29ya3NwYWNlIHBhbmVcIiwgICAgICAgXCJNb2QrUGFnZURvd25cIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoIDEsIHRydWUpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi1wcmV2XCIsIFwiQ3ljbGUgdG8gcHJldmlvdXMgd2luZG93XCIsIFtdICldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KC0xLCB0cnVlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLW5leHRcIiwgXCJDeWNsZSB0byBuZXh0IHdpbmRvd1wiLCAgICAgW10gKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coIDEsIHRydWUpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTFzdFwiLCAgIFwiSnVtcCB0byAxc3QgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCsxXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDApOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby0ybmRcIiwgICBcIkp1bXAgdG8gMm5kIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrMlwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZigxKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tM3JkXCIsICAgXCJKdW1wIHRvIDNyZCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzNcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoMik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTR0aFwiLCAgIFwiSnVtcCB0byA0dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs0XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDMpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby01dGhcIiwgICBcIkp1bXAgdG8gNXRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrNVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig0KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tNnRoXCIsICAgXCJKdW1wIHRvIDZ0aCBwYW5lIGluIHRoZSB3b3Jrc3BhY2VcIiwgIFwiQWx0KzZcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoNSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcImdvLTd0aFwiLCAgIFwiSnVtcCB0byA3dGggcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsICBcIkFsdCs3XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhMZWFmKDYpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJnby04dGhcIiwgICBcIkp1bXAgdG8gOHRoIHBhbmUgaW4gdGhlIHdvcmtzcGFjZVwiLCAgXCJBbHQrOFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoTGVhZig3KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwiZ28tbGFzdFwiLCAgXCJKdW1wIHRvIGxhc3QgcGFuZSBpbiB0aGUgd29ya3NwYWNlXCIsIFwiQWx0KzlcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMuZ290b050aExlYWYoOTk5OTk5OTkpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi0xc3RcIiwgICBcIlN3aXRjaCB0byAxc3Qgd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDApOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tMm5kXCIsICAgXCJTd2l0Y2ggdG8gMm5kIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdygxKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTNyZFwiLCAgIFwiU3dpdGNoIHRvIDNyZCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coMik7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi00dGhcIiwgICBcIlN3aXRjaCB0byA0dGggd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDMpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tNXRoXCIsICAgXCJTd2l0Y2ggdG8gNXRoIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdyg0KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLTZ0aFwiLCAgIFwiU3dpdGNoIHRvIDZ0aCB3aW5kb3dcIiwgIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coNSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcIndpbi03dGhcIiwgICBcIlN3aXRjaCB0byA3dGggd2luZG93XCIsICBbXSldICgpIHsgaWYgKGFwcC53b3Jrc3BhY2UuZmxvYXRpbmdTcGxpdD8uY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gKCkgPT4gdGhpcy5nb3RvTnRoV2luZG93KDYpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJ3aW4tOHRoXCIsICAgXCJTd2l0Y2ggdG8gOHRoIHdpbmRvd1wiLCAgW10pXSAoKSB7IGlmIChhcHAud29ya3NwYWNlLmZsb2F0aW5nU3BsaXQ/LmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuICgpID0+IHRoaXMuZ290b050aFdpbmRvdyg3KTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwid2luLWxhc3RcIiwgIFwiU3dpdGNoIHRvIGxhc3Qgd2luZG93XCIsIFtdKV0gKCkgeyBpZiAoYXBwLndvcmtzcGFjZS5mbG9hdGluZ1NwbGl0Py5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiAoKSA9PiB0aGlzLmdvdG9OdGhXaW5kb3coOTk5OTk5OTkpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC0xc3RcIiwgIFwiUGxhY2UgYXMgMXN0IHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrMVwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMCwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtMm5kXCIsICBcIlBsYWNlIGFzIDJuZCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzJcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDEsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTNyZFwiLCAgXCJQbGFjZSBhcyAzcmQgcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCszXCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZigyLCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC00dGhcIiwgIFwiUGxhY2UgYXMgNHRoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrNFwiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoMywgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtNXRoXCIsICBcIlBsYWNlIGFzIDV0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzVcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDQsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LTZ0aFwiLCAgXCJQbGFjZSBhcyA2dGggcGFuZSBpbiB0aGUgc3BsaXRcIiwgICAgIFwiTW9kK0FsdCs2XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig1LCBmYWxzZSk7IH0sXG4gICAgICAgICAgICBbY29tbWFuZChcInB1dC03dGhcIiwgIFwiUGxhY2UgYXMgN3RoIHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgICBcIk1vZCtBbHQrN1wiKV0gKCkgeyByZXR1cm4gKCkgPT4gdGhpcy5wbGFjZUxlYWYoNiwgZmFsc2UpOyB9LFxuICAgICAgICAgICAgW2NvbW1hbmQoXCJwdXQtOHRoXCIsICBcIlBsYWNlIGFzIDh0aCBwYW5lIGluIHRoZSBzcGxpdFwiLCAgICAgXCJNb2QrQWx0KzhcIildICgpIHsgcmV0dXJuICgpID0+IHRoaXMucGxhY2VMZWFmKDcsIGZhbHNlKTsgfSxcbiAgICAgICAgICAgIFtjb21tYW5kKFwicHV0LWxhc3RcIiwgXCJQbGFjZSBhcyBsYXN0IHBhbmUgaW4gdGhlIHNwbGl0XCIsICAgIFwiTW9kK0FsdCs5XCIpXSAoKSB7IHJldHVybiAoKSA9PiB0aGlzLnBsYWNlTGVhZig5OTk5OTk5OSwgZmFsc2UpOyB9LFxuXG4gICAgICAgICAgICBbY29tbWFuZChcIm1heGltaXplXCIsIFwiTWF4aW1pemUgYWN0aXZlIHBhbmUgKFRvZ2dsZSlcIiwgW10pXSAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMubWF4LnBhcmVudEZvckxlYWYoYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSkgcmV0dXJuICgpID0+IHRoaXMubWF4LnRvZ2dsZU1heGltaXplKCk7XG4gICAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnVucmVnaXN0ZXJIb3ZlckxpbmtTb3VyY2UoTmF2aWdhdG9yLmhvdmVyU291cmNlKTtcbiAgICB9XG5cbiAgICBnb3RvTnRoTGVhZihuOiBudW1iZXIsIHJlbGF0aXZlOiBib29sZWFuKSB7XG4gICAgICAgIGxldCBsZWFmID0gYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmO1xuICAgICAgICBjb25zdCByb290ID0gbGVhZi5nZXRSb290KCk7XG4gICAgICAgIGlmIChyb290ID09PSBhcHAud29ya3NwYWNlLmxlZnRTcGxpdCB8fCByb290ID09PSBhcHAud29ya3NwYWNlLnJpZ2h0U3BsaXQpIHtcbiAgICAgICAgICAgIC8vIFdvcmthcm91bmQgZm9yIDAuMTUuMyBzaWRlYmFyIHRhYnMgc3RlYWxpbmcgZm9jdXNcbiAgICAgICAgICAgIGxlYWYgPSBhcHAud29ya3NwYWNlLmdldE1vc3RSZWNlbnRMZWFmKGFwcC53b3Jrc3BhY2Uucm9vdFNwbGl0KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBuYXYgPSB0aGlzLm5hdi5mb3JMZWFmKGxlYWYpO1xuICAgICAgICBsZWFmID0gZ290b050aChuYXYubGVhdmVzKCksIGxlYWYsIG4sIHJlbGF0aXZlKTtcbiAgICAgICAgIWxlYWYgfHwgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgZ290b050aFdpbmRvdyhuOiBudW1iZXIsIHJlbGF0aXZlOiBib29sZWFuKSB7XG4gICAgICAgIGNvbnN0IG5hdiA9IGdvdG9OdGgodGhpcy5uYXYuZm9yQWxsKCksIHRoaXMubmF2LmZvckxlYWYoYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmKSwgbiwgcmVsYXRpdmUpO1xuICAgICAgICBjb25zdCBsZWFmID0gbmF2Py5sYXRlc3RMZWFmKCk7XG4gICAgICAgIGlmIChsZWFmKSBhcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgICAgIChuYXY/LndpbiBhcyBhbnkpLnJlcXVpcmU/LignZWxlY3Ryb24nKT8ucmVtb3RlPy5nZXRDdXJyZW50V2luZG93KCk/LmZvY3VzKCk7XG4gICAgfVxuXG4gICAgcGxhY2VMZWFmKHRvUG9zOiBudW1iZXIsIHJlbGF0aXZlPXRydWUpIHtcbiAgICAgICAgY29uc3QgY2IgPSB0aGlzLmxlYWZQbGFjZXIodG9Qb3MsIHJlbGF0aXZlKTtcbiAgICAgICAgaWYgKGNiKSBjYigpO1xuICAgIH1cblxuICAgIGxlYWZQbGFjZXIodG9Qb3M6IG51bWJlciwgcmVsYXRpdmU9dHJ1ZSkge1xuICAgICAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmFjdGl2ZUxlYWY7XG4gICAgICAgIGlmICghbGVhZikgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGNvbnN0XG4gICAgICAgICAgICBwYXJlbnRTcGxpdCA9IGxlYWYucGFyZW50U3BsaXQsXG4gICAgICAgICAgICBjaGlsZHJlbiA9IHBhcmVudFNwbGl0LmNoaWxkcmVuLFxuICAgICAgICAgICAgZnJvbVBvcyA9IGNoaWxkcmVuLmluZGV4T2YobGVhZilcbiAgICAgICAgO1xuICAgICAgICBpZiAoZnJvbVBvcyA9PSAtMSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IHBvcG92ZXJFbCA9IGxlYWYuY29udGFpbmVyRWwubWF0Y2hQYXJlbnQoXCIuaG92ZXItcG9wb3ZlclwiKTtcbiAgICAgICAgICAgIGlmIChwb3BvdmVyRWwgJiYgcmVsYXRpdmUgJiYgTWF0aC5hYnModG9Qb3MpID09PSAxKSB7XG4gICAgICAgICAgICAgICAgLy8gQWxsb3cgc3dhcHBpbmcgcG9wb3ZlcnMgaW4gdGhlIHN0YWNrXG4gICAgICAgICAgICAgICAgbGV0IG5laWdoYm9yID0gcG9wb3ZlckVsO1xuICAgICAgICAgICAgICAgIHdoaWxlIChuZWlnaGJvciAmJiAobmVpZ2hib3IgPT09IHBvcG92ZXJFbCB8fCAhbmVpZ2hib3IubWF0Y2hlcyhcIi5ob3Zlci1wb3BvdmVyXCIpKSlcbiAgICAgICAgICAgICAgICAgICAgbmVpZ2hib3IgPSB0b1BvcyA8IDAgPyBuZWlnaGJvci5wcmV2aW91c0VsZW1lbnRTaWJsaW5nIDogbmVpZ2hib3IubmV4dEVsZW1lbnRTaWJsaW5nO1xuICAgICAgICAgICAgICAgIGlmIChuZWlnaGJvcikgcmV0dXJuICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCkgbmVpZ2hib3IucGFyZW50RWxlbWVudC5pbnNlcnRCZWZvcmUocG9wb3ZlckVsLCBuZWlnaGJvcik7XG4gICAgICAgICAgICAgICAgICAgIGVsc2UgbmVpZ2hib3IucGFyZW50RWxlbWVudC5pbnNlcnRCZWZvcmUobmVpZ2hib3IsIHBvcG92ZXJFbCk7XG4gICAgICAgICAgICAgICAgICAgIGFwcC53b3Jrc3BhY2Uub25MYXlvdXRDaGFuZ2UoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgICAgIHRvUG9zICs9IGZyb21Qb3M7XG4gICAgICAgICAgICBpZiAodG9Qb3MgPCAwIHx8IHRvUG9zID49IGNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRvUG9zID49IGNoaWxkcmVuLmxlbmd0aCkgdG9Qb3MgPSBjaGlsZHJlbi5sZW5ndGggLSAxO1xuICAgICAgICAgICAgaWYgKHRvUG9zIDwgMCkgdG9Qb3MgPSAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZyb21Qb3MgPT0gdG9Qb3MpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3RoZXIgPSBjaGlsZHJlblt0b1Bvc107XG4gICAgICAgICAgICBjaGlsZHJlbi5zcGxpY2UoZnJvbVBvcywgMSk7XG4gICAgICAgICAgICBjaGlsZHJlbi5zcGxpY2UodG9Qb3MsICAgMCwgbGVhZik7XG4gICAgICAgICAgICBpZiAoKHBhcmVudFNwbGl0IGFzIFdvcmtzcGFjZVRhYnMpLnNlbGVjdFRhYikge1xuICAgICAgICAgICAgICAgIChwYXJlbnRTcGxpdCBhcyBXb3Jrc3BhY2VUYWJzKS5zZWxlY3RUYWIobGVhZik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG90aGVyLmNvbnRhaW5lckVsLmluc2VydEFkamFjZW50RWxlbWVudChmcm9tUG9zID4gdG9Qb3MgPyBcImJlZm9yZWJlZ2luXCIgOiBcImFmdGVyZW5kXCIsIGxlYWYuY29udGFpbmVyRWwpO1xuICAgICAgICAgICAgICAgIHBhcmVudFNwbGl0LnJlY29tcHV0ZUNoaWxkcmVuRGltZW5zaW9ucygpO1xuICAgICAgICAgICAgICAgIGxlYWYub25SZXNpemUoKTtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRDaGFuZ2UoKTtcblxuICAgICAgICAgICAgICAgIC8vIEZvcmNlIGZvY3VzIGJhY2sgdG8gcGFuZTtcbiAgICAgICAgICAgICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuYWN0aXZlTGVhZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLnNldEFjdGl2ZUxlYWYobGVhZiwgZmFsc2UsIHRydWUpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpc1N5bnRoZXRpY0hpc3RvcnlFdmVudChidXR0b246IG51bWJlcikge1xuICAgICAgICBjb25zdCB3aW4gPSB0aGlzLm5hdi53aW5kb3dzKCkuZmlsdGVyKHdpbiA9PlxuICAgICAgICAgICAgd2luLmV2ZW50ICYmICh3aW4uZXZlbnQgYXMgTW91c2VFdmVudCkuYnV0dG9uID09PSBidXR0b25cbiAgICAgICAgKS5wb3AoKTtcbiAgICAgICAgaWYgKHdpbiAmJiB3aW4uZXZlbnQudHlwZSA9PT0gXCJtb3VzZWRvd25cIikge1xuICAgICAgICAgICAgd2luLmV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICB3aW4uZXZlbnQuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBnb3RvTnRoPFQ+KGl0ZW1zOiBUW10sIGN1cnJlbnQ6IFQsIG46IG51bWJlciwgcmVsYXRpdmU6IGJvb2xlYW4pOiBUIHtcbiAgICBpZiAocmVsYXRpdmUpIHtcbiAgICAgICAgbiArPSBpdGVtcy5pbmRleE9mKGN1cnJlbnQpO1xuICAgICAgICBuID0gKG4gKyBpdGVtcy5sZW5ndGgpICUgaXRlbXMubGVuZ3RoOyAgLy8gd3JhcCBhcm91bmRcbiAgICB9XG4gICAgcmV0dXJuIGl0ZW1zW24gPj0gaXRlbXMubGVuZ3RoID8gaXRlbXMubGVuZ3RoLTEgOiBuXTtcbn0iXSwibmFtZXMiOlsiTm90aWNlIiwiV29ya3NwYWNlTGVhZiIsIkNvbXBvbmVudCIsImRlYm91bmNlIiwiTWVudSIsIktleW1hcCIsIlRGaWxlIiwiUGx1Z2luIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUE7QUFNQSxNQUFNLFFBQVEsR0FBNEIsRUFBRSxDQUFDO0FBRTdCLFNBQUEsT0FBTyxDQUFDLEVBQVUsRUFBRSxJQUFZLEVBQUUsT0FBQSxHQUE2QixFQUFFLEVBQUUsR0FBRyxHQUFDLEVBQUUsRUFBQTs7O0lBSXJGLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUTtBQUFFLFFBQUEsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDckQsSUFBQSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsSUFBSyxPQUFrQixDQUFDLEdBQUc7QUFBRSxRQUFBLE9BQU8sR0FBRyxDQUFDLE9BQWlCLENBQUMsQ0FBQztBQUUxRixJQUFBLElBQUksSUFBSSxHQUFjLE9BQW9CLENBQUMsR0FBRyxDQUFDLFVBQVMsR0FBRyxFQUFBOztR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LE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRTtBQUNoSixZQUFBLENBQUMsT0FBTyxDQUFDLFNBQVMsRUFBSSxzQkFBc0IsRUFBRyxFQUFFLENBQUMsQ0FBQyxLQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsUUFBUSxDQUFDLE1BQU07Z0JBQUUsT0FBTyxNQUFNLElBQUksQ0FB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
