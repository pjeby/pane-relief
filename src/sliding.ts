import { use, addCommands, command, LayoutSetting, PerWindowComponent, WindowManager, LayoutItem, toggleClass, allWindows, PWCFactory } from "@ophidian/core";
import { Plugin, WorkspaceLeaf, WorkspaceRoot, WorkspaceWindow } from "obsidian";

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
    }

    activate(leaf: WorkspaceLeaf) {
        const {options} = this;
        // Activate the window if needed, but only if another Obsidian window has focus
        if (!this.win.document.hasFocus() && allWindows().some(w => w.document.hasFocus())) {
            this.container.focus();
        }
        if (options.active) {
            (leaf.containerEl.matchParent(".workspace-tabs") ?? leaf.containerEl).scrollIntoView({behavior: "smooth"});
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
    }

    onChange(item: LayoutItem) {
        if (item instanceof WorkspaceRoot || item instanceof WorkspaceWindow) {
            this.forContainer(item).onSet(this.options.get(item));
        }
    }
}
