import { use, addCommands, command, LayoutSetting, PerWindowComponent, WindowManager, LayoutItem, toggleClass, allWindows, PWCFactory } from "@ophidian/core";
import { around } from "monkey-around";
import { Plugin, WorkspaceLeaf, WorkspaceRoot, WorkspaceWindow, debounce } from "obsidian";

type SlideSettings = {
    active: boolean;
}

export class SlidingPanes extends PerWindowComponent {

    manager = this.use(SlidingPanes);

    [use.factory](): SlidingPanesManager<this> {
        return new SlidingPanesManager(this.constructor as PWCFactory<this>);
    }

    onload()   { this.onSet(); }
    onunload() { this.update(false); }

    get options() {
        return this.manager.options.get(this.container);
    }

    set options(options) {
        this.manager.options.set(options, this.container);
    }

    onSet(options: SlideSettings = this.options) {
        // XXX check here for other plugin and deactivate if options.active?
        this.update(options.active);
    }

    update(active: boolean) {
        toggleClass(this.container.containerEl, "is-sliding", active);
        const parent = this.container.containerEl.matchParent(".workspace");
        if (parent) {
            toggleClass(parent, "is-sliding", active);
        } else {
            this.register(this.container.containerEl.onNodeInserted(() => this.update(this.options.active), true));
        }
    }

    activate(leaf: WorkspaceLeaf) {
        const {options} = this;
        // Activate the window if needed, but only if another Obsidian window has focus
        if (!this.win.document.hasFocus() && allWindows().some(w => w.document.hasFocus())) {
            this.container.focus();
        }
        if (options.active) {
            (leaf.containerEl.matchParent(".workspace-tabs") ?? leaf.containerEl).scrollIntoView();
        }
        this.manager.options.defaultValue = options;
    }

    toggleSliding() {
        const {options} = this;
        this.options = {...options, active: !options.active}
    }
}

declare module "obsidian" {
    interface WorkspaceContainer {
        focus(): void;
    }
}


class SlidingPanesManager<T extends SlidingPanes> extends WindowManager<T> {
    options = new LayoutSetting(this, "pane-relief:sliding-panes", {active: false} as SlideSettings);

    // Due to a quirk of how electron handles titlebar draggability (and rendering of
    // out-of-view scrolled panes), we need to overlay parts of the title bar to
    // ensure they're handled correctly
    overlay = app.workspace.containerEl.parentElement.createDiv("prsp-tb-overlay");

    requestOverlayUpdate = debounce(() => {
        if (app.workspace.layoutReady && !app.workspace.leftSplit?.collapsed) {
            const r = app.workspace.leftSplit.containerEl.find(".workspace-tabs.mod-top-left-space .workspace-tab-header-spacer")?.getBoundingClientRect();
            if (r) this.overlay.style.setProperty("--pr-overlay-width", `${r.width}px`);
            if (r) this.overlay.style.setProperty("--pr-overlay-left", `${r.left}px`);
        }
    }, 100, true);

    onunload(): void {
        super.onunload();
        this.overlay.detach();
    }

    onload() {
        super.onload();
        window.CodeMirror.getMode({}, "XXX"); // force modes to load, prevents weird sliding
        const self = this;
        addCommands(this.use(Plugin), {
            [command("toggle-sliding", "Toggle sliding panes (for current window)")] (this: Plugin) {
                return () => self.forLeaf(app.workspace.activeLeaf).toggleSliding();
            }
        });
        this.registerEvent(this.options.onSet(this.onChange, this));
        this.registerEvent(this.options.store.onLoadItem(this.onChange, this));
        this.registerEvent(this.onLeafChange(leaf => this.forLeaf(leaf).activate(leaf)));
        app.workspace.onLayoutReady(() => {
            this.registerEvent(app.workspace.on("layout-change", this.requestOverlayUpdate));
            this.registerEvent(app.workspace.on("resize", this.requestOverlayUpdate));
            const mgr = this;
            this.register(around(app.workspace.leftSplit.constructor.prototype, {
                expand(old) { return function() { mgr.requestOverlayUpdate(); return old.call(this); }; }
            }));
            this.requestOverlayUpdate();
        });
    }

    onChange(item: LayoutItem) {
        if (item instanceof WorkspaceRoot || item instanceof WorkspaceWindow) {
            this.forContainer(item).onSet(this.options.get(item));
        }
    }
}
