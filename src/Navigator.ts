import {Menu, Keymap, Component, WorkspaceLeaf, TFile, MenuItem} from 'obsidian';
import {domLeaves, History, HistoryEntry} from "./History";
import {PerWindowComponent} from "@ophidian/core";

declare module "obsidian" {
    interface Menu {
        dom: HTMLElement
        setUseNativeMenu?(flag: boolean): void;  // 0.16 to force HTML menu
    }
    interface MenuItem {
        dom: HTMLElement
    }
    interface App {
        dragManager: DragManager
    }
    interface DragManager {
        dragFile(event: DragEvent, file: TFile): DragData
        onDragStart(event: DragEvent, dragData: DragData): void
    }
    interface DragData {}
    interface WorkspaceLeaf {
        activeTime: number
    }
}

interface FileInfo {
    icon: string
    title: string
    file: TFile
    type: string
    state: any
    eState: any
}


const viewtypeIcons: Record<string, string> = {
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
}

const nonFileViews: Record<string, string[]> = {
    graph: ["dot-network", "Graph View"],
    "file-explorer": ["folder", "File Explorer"],
    starred: ["star", "Starred Files"],
    tag: ["tag", "Tags View"],

    // third-party plugins
    "recent-files": ["clock", "Recent Files"],
    calendar: ["calendar-with-checkmark", "Calendar"],
    empty: ["cross", "No file"]
}

export class Navigation extends PerWindowComponent {

    back: Navigator
    forward: Navigator
    // Set to true while either menu is open, so we don't switch it out
    historyIsOpen = false;

    display(leaf = this.latestLeaf()) {
        if (this.historyIsOpen) return;
        if (!this._loaded) { this.load(); return; }
        this.win.requestAnimationFrame(() => {
            const history = leaf ? History.forLeaf(leaf) : new History();
            this.back.setHistory(history);
            this.forward.setHistory(history);
            if (leaf) this.updateLeaf(leaf, history)
        });
    }

    leaves() {
        const leaves = new Set<WorkspaceLeaf>();
        const cb = (leaf: WorkspaceLeaf) => { leaves.add(leaf); };
        app.workspace.iterateLeaves(cb, this.container);

        // Support Hover Editors
        const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers) for (const popover of popovers) {
            if (popover.hoverEl.ownerDocument.defaultView !== this.win) continue; // must be in same window
            else if (popover.rootSplit) app.workspace.iterateLeaves(cb, popover.rootSplit);
            else if (popover.leaf) cb(popover.leaf);
        }
        return [...leaves.values()];
    }

    latestLeaf() {
        let leaf = app.workspace.activeLeaf;
        if (leaf && this.use(Navigation).forLeaf(leaf) === this) return leaf;
        return this.leaves().reduce((best, leaf)=>{ return (!best || best.activeTime < leaf.activeTime) ? leaf : best; }, null);
    }

    onload() {
        // Override default mouse history behavior.  We need this because 1) Electron will use the built-in
        // history object if we don't (instead of our wrapper), and 2) we want the click to apply to the leaf
        // that was under the mouse, rather than whichever leaf was active.
        const {document} = this.win;
        document.addEventListener("mouseup", historyHandler, true);
        document.addEventListener("mousedown", historyHandler, true);
        this.register(() => {
            document.removeEventListener("mouseup", historyHandler, true);
            document.removeEventListener("mousedown", historyHandler, true);
        });
        function historyHandler(e: MouseEvent) {
            if (e.button !== 3 && e.button !== 4) return;
            e.preventDefault(); e.stopPropagation();  // prevent default behavior
            const target = (e.target as HTMLElement).matchParent(".workspace-leaf");
            if (target && e.type === "mouseup") {
                let leaf = domLeaves.get(target);
                if (!leaf) app.workspace.iterateAllLeaves(l => leaf = (l.containerEl === target) ? l : leaf);
                if (!leaf) return false;
                if (e.button == 3) { History.forLeaf(leaf).back(); }
                if (e.button == 4) { History.forLeaf(leaf).forward(); }
            }
            return false;
        }

        app.workspace.onLayoutReady(() => {
            this.addChild(this.back    = new Navigator(this, "back", -1));
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
            if (fwd)  setTooltip(fwd, this.forward.oldLabel);
            if (back) setTooltip(fwd, this.back.oldLabel);
        })
    }

    unNumberPanes(selector = ".workspace-leaf") {
        this.win.document.body.findAll(selector).forEach(el => {
            el.style.removeProperty("--pane-relief-label");
            el.toggleClass("has-pane-relief-label", false);
            el.style.removeProperty("--pane-relief-forward-count");
            el.style.removeProperty("--pane-relief-backward-count");
        });
    }

    updateLeaf(leaf: WorkspaceLeaf, history: History = History.forLeaf(leaf)) {
        leaf.containerEl.style.setProperty("--pane-relief-forward-count", '"'+(history.lookAhead().length || "")+'"');
        leaf.containerEl.style.setProperty("--pane-relief-backward-count", '"'+(history.lookBehind().length || "")+'"');

        // Add labels for CPHATB nav buttons
        const actions = leaf.containerEl.find(".view-header > .view-actions");
        const fwd = actions?.find('.view-action[class*=" app:go-forward"]');
        const back = actions?.find('.view-action[class*=" app:go-back"]');
        if (fwd) this.forward.updateDisplay(history, fwd);
        if (back) this.back.updateDisplay(history, back);
    }

    numberPanes() {
        this.win.requestAnimationFrame(() => {
            // unnumber sidebar panes in main window, if something was moved there
            if (this.win === window) this.unNumberPanes(".workspace-tabs > .workspace-leaf");
            let count = 0, lastLeaf: WorkspaceLeaf = null;
            this.leaves().forEach(leaf => {
                leaf.containerEl.style.setProperty("--pane-relief-label", ++count < 9 ? ""+count : "");
                leaf.containerEl.toggleClass("has-pane-relief-label", count<9);
                lastLeaf = leaf;
                this.updateLeaf(leaf);
            });
            if (count>8) {
                lastLeaf?.containerEl.style.setProperty("--pane-relief-label", "9");
                lastLeaf?.containerEl.toggleClass("has-pane-relief-label", true);
            }
        })
    }

    onUpdateHistory(leaf: WorkspaceLeaf, history: History) {
        this.win.requestAnimationFrame(() => {
            this.updateLeaf(leaf); // update leaf's stats and buttons
            // update window's nav arrows
            if (history === this.forward.history) this.forward.setHistory(history);
            if (history === this.back.history)    this.back.setHistory(history);
        });
    }
}

export class Navigator extends Component {

    static hoverSource = "pane-relief:history-menu";

    containerEl: HTMLElement
    count: HTMLSpanElement
    history: History = null;
    oldLabel: string

    constructor(public owner: Navigation, public kind: 'forward'|'back', public dir: number)  {
        super();
    }

    onload() {
        this.containerEl = this.owner.win.document.body.find(
            `.titlebar .titlebar-button-container.mod-left .titlebar-button.mod-${this.kind}`
        );
        this.count = this.containerEl.createSpan({prepend: this.kind === "back", cls: "history-counter"});
        this.history = null;
        this.oldLabel = this.containerEl.getAttribute("aria-label");
        this.registerDomEvent(this.containerEl, "contextmenu", this.openMenu.bind(this));
        const onClick = (e: MouseEvent) => {
            // Don't allow Obsidian to switch window or forward the event
            e.preventDefault(); e.stopImmediatePropagation();
            // Do the navigation
            this.history?.[this.kind]();
        }
        this.register(() => this.containerEl.removeEventListener("click", onClick, true));
        this.containerEl.addEventListener("click", onClick, true);
        this.register(
            // Support "Customizable Page Header and Title Bar" buttons
            onElement(
                this.owner.win.document.body,
                "contextmenu",
                `.view-header > .view-actions > .view-action[class*="app:go-${this.kind}"]`,
                (evt, target) => {
                    const el = target.matchParent(".workspace-leaf");
                    const leaf = this.owner.leaves().filter(leaf => leaf.containerEl === el).pop();
                    if (!leaf) return;
                    evt.preventDefault();
                    evt.stopImmediatePropagation();
                    this.openMenu(evt, History.forLeaf(leaf));
                }, {capture: true}
            )
        );
    }

    onunload() {
        setTooltip(this.containerEl, this.oldLabel);
        this.count.detach();
        this.containerEl.toggleClass("mod-active", false);
    }

    setCount(num: number) { this.count.textContent = "" + (num || ""); }

    setHistory(history = History.current()) {
        this.updateDisplay(this.history = history);
    }

    updateDisplay(history: History, el = this.containerEl) {
        const states = history[this.dir < 0 ? "lookBehind" : "lookAhead"]();
        if (el===this.containerEl) this.setCount(states.length);
        setTooltip(el, states.length ?
            this.oldLabel + "\n" + this.formatState(states[0]).title :
            `No ${this.kind} history`
        );
        el.toggleClass("mod-active", states.length > 0);
    }

    openMenu(evt: {clientX: number, clientY: number}, history = this.history) {
        const states = history[this.dir < 0 ? "lookBehind" : "lookAhead"]();
        if (!states.length) return;
        const menu = new Menu();
        menu.setUseNativeMenu?.(false);  // 0.16: force HTML menu
        menu.dom.addClass("pane-relief-history-menu");
        menu.dom.on("mousedown", ".menu-item", e => {e.stopPropagation();}, true);
        states.map(this.formatState.bind(this)).forEach(
            (info: FileInfo, idx) => this.menuItem(info, idx, menu, history)
        );
        menu.showAtPosition({x: evt.clientX, y: evt.clientY + 20});
        this.owner.historyIsOpen = true;
        menu.onHide(() => { this.owner.historyIsOpen = false; this.owner.display(); });
    }

    menuItem(info: FileInfo, idx: number, menu: Menu, history: History) {
        const {dir, kind} = this;
        menu.addItem(i => { createItem(i); if (info.file) setupFileEvents(i.dom); });
        return;

        function createItem(i: MenuItem, prefix="") {
            i.setIcon(info.icon).setTitle(prefix + info.title).onClick(e => {
                // Check for ctrl/cmd/middle button and split leaf + copy history
                if (Keymap.isModEvent(e)) {
                    history = history.cloneTo(app.workspace.splitActiveLeaf());
                }
                history.go((idx+1) * dir, true);
            });
        }

        function setupFileEvents(dom: HTMLElement) {
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
                const menu = new Menu();
                menu.addItem(i => createItem(i, `Go ${kind} to `)).addSeparator();
                app.workspace.trigger(
                    "file-menu", menu, info.file, "link-context-menu"
                );
                menu.showAtPosition({x: e.clientX, y: e.clientY});
                e.stopPropagation(); // keep the parent menu open for now
            }, true);
        }
    }

    formatState(entry: HistoryEntry): FileInfo {
        const {viewState: {type, state}, eState, path} = entry;
        const file = path && app.vault.getAbstractFileByPath(path) as TFile;
        const info = {icon: "", title: "", file, type, state, eState};

        if (nonFileViews[type]) {
            [info.icon, info.title] = nonFileViews[type];
        } else if (path && !file) {
            [info.icon, info.title] = ["trash", "Missing file "+path];
        } else if (file instanceof TFile) {
            info.icon = viewtypeIcons[type] ?? "document";
            if (type === "markdown" && state.mode === "preview") info.icon = "lines-of-text";
            info.title = file ? file.basename + (file.extension !== "md" ? "."+file.extension : "") : "No file";
            if (type === "media-view" && !file) info.title = state.info?.filename ?? info.title;
        }

        app.workspace.trigger("pane-relief:format-history-item", info);
        return info;
    }
}

export function onElement<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    event: K,
    selector: string,
    callback: (this: HTMLElement, ev: HTMLElementEventMap[K], delegateTarget: HTMLElement) => any,
    options?: boolean | AddEventListenerOptions
) {
    el.on(event, selector, callback, options)
    return () => el.off(event, selector, callback, options);
}

export function setTooltip(el: HTMLElement, text: string) {
    if (text) el.setAttribute("aria-label", text || undefined);
    else el.removeAttribute("aria-label");
}