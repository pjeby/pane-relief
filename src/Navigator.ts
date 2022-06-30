import {Menu, Keymap, Component, WorkspaceLeaf, TFile, MenuItem} from 'obsidian';
import {History, HistoryEntry} from "./History";
import PaneRelief from './pane-relief';
import {PerWindowComponent} from './PerWindowComponent';

declare module "obsidian" {
    interface Menu {
        dom: HTMLElement
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
    interface Workspace {
        getMostRecentLeaf(root?: WorkspaceParent): WorkspaceLeaf
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

export class Navigation extends PerWindowComponent<PaneRelief> {
    back: Navigator
    forward: Navigator
    // Set to true while either menu is open, so we don't switch it out
    historyIsOpen = false;

    display(leaf = this.latestLeaf()) {
        if (this.historyIsOpen) return;
        if (!this._loaded) { this.load(); return; }
        const history = leaf ? History.forLeaf(leaf) : new History();
        this.back.setHistory(history);
        this.forward.setHistory(history);
    }

    latestLeaf() {
        let leaf = app.workspace.activeLeaf;
        if (leaf && this.plugin.nav.forLeaf(leaf) === this) return leaf;
        return app.workspace.getMostRecentLeaf(this.root);
    }

    onload() {
        app.workspace.onLayoutReady(() => {
            this.addChild(this.back    = new Navigator(this, "back", -1));
            this.addChild(this.forward = new Navigator(this, "forward", 1));
            this.display();
            this.register(
                // Support "Customizable Page Header and Title Bar" buttons
                onElement(
                    this.win.document.body,
                    "contextmenu",
                    ".view-header > .view-actions > .view-action",
                    (evt, target) => {
                        const dir = (
                            (target.matches('[class*=" app:go-forward"]') && "forward") ||
                            (target.matches('[class*=" app:go-back"]')    && "back")
                        );
                        if (!dir) return;
                        const leaf = this.plugin.leafMap.get(target.matchParent(".workspace-leaf"));
                        if (!leaf) return;
                        evt.preventDefault();
                        evt.stopImmediatePropagation();
                        this.display(leaf);
                        this[dir].openMenu(evt);
                    }, {capture: true}
                )
            );
        });
    }
}

export class Navigator extends Component {

    static hoverSource = "pane-relief:history-menu";

    containerEl: HTMLElement
    count: HTMLSpanElement
    history: History = null;
    states: HistoryEntry[];
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
        this.states = [];
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
        this.registerEvent(
            app.workspace.on("pane-relief:update-history", (_, history) => {
                if (history === this.history) this.setHistory(history);
            })
        );
    }

    onunload() {
        this.setTooltip(this.oldLabel);
        this.count.detach();
        this.containerEl.toggleClass("mod-active", false);
    }

    setCount(num: number) { this.count.textContent = "" + (num || ""); }

    setTooltip(text: string) {
        if (text) this.containerEl.setAttribute("aria-label", text || undefined);
        else this.containerEl.removeAttribute("aria-label");
    }

    setHistory(history = History.current()) {
        this.history = history;
        const states = this.states = history[this.dir < 0 ? "lookBehind" : "lookAhead"].call(history);
        this.setCount(states.length);
        this.setTooltip(states.length ?
            this.oldLabel + "\n" + this.formatState(states[0]).title :
            `No ${this.kind} history`
        );
        this.containerEl.toggleClass("mod-active", states.length > 0);
    }

    openMenu(evt: {clientX: number, clientY: number}) {
        if (!this.states.length) return;
        const menu = new Menu();
        menu.dom.addClass("pane-relief-history-menu");
        menu.dom.on("mousedown", ".menu-item", e => {e.stopPropagation();}, true);
        this.states.map(this.formatState.bind(this)).forEach(
            (info: FileInfo, idx) => this.menuItem(info, idx, menu)
        );
        menu.showAtPosition({x: evt.clientX, y: evt.clientY + 20});
        this.owner.historyIsOpen = true;
        menu.onHide(() => { this.owner.historyIsOpen = false; this.owner.display(); });
    }

    menuItem(info: FileInfo, idx: number, menu: Menu) {
        const my = this;
        menu.addItem(i => { createItem(i); if (info.file) setupFileEvents(i.dom); });
        return;

        function createItem(i: MenuItem, prefix="") {
            i.setIcon(info.icon).setTitle(prefix + info.title).onClick(e => {
                let history = my.history;
                // Check for ctrl/cmd/middle button and split leaf + copy history
                if (Keymap.isModifier(e, "Mod") || 1 === (e as MouseEvent).button) {
                    history = history.cloneTo(app.workspace.splitActiveLeaf());
                }
                history.go((idx+1) * my.dir, true);
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
                menu.addItem(i => createItem(i, `Go ${my.kind} to `)).addSeparator();
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