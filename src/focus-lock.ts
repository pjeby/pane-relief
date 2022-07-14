import { around } from "monkey-around";
import { Notice, Plugin, setIcon, Workspace, WorkspaceLeaf } from "obsidian";
import { LayoutSetting, Service } from "ophidian";
import { addCommands, command } from "./commands";
import { setTooltip } from "./Navigator";

const FOCUS_LOCK = "pane-relief:focus-lock";

declare module "ophidian" {
    interface LayoutSettings {
        [FOCUS_LOCK]: boolean
    }
}

export class FocusLock extends Service {

    setting = new LayoutSetting(this, FOCUS_LOCK).of(app.workspace);

    plugin = this.use(Plugin);
    statusEl = this.plugin.addStatusBarItem();
    iconEl = this.statusEl.createSpan(
        "pane-relief-focus-lock icon", e => {e.setAttribute("aria-label-position", "top")}
    );

    isLocked?: boolean = null;

    installed: boolean = false;

    onload() {
        this.registerDomEvent(this.iconEl, "click", () => this.toggle());
        addCommands(this.plugin, {
           [command("focus-lock", "Toggle focus lock (Enable/disable sidebar focusing)")]: () => () => this.toggle()
        });
        this.registerEvent(this.setting.onLoadWorkspace(this.onChange, this));
    }

    install() {
        this.installed = true;
        const self = this;
        // wrap setActiveLeaf and canNavigate to prevent select/activate
        this.register(around(app.workspace, {
            setActiveLeaf(old) { return function(this: Workspace, leaf, pushHistory, focus) {
                if (!self.isLocked || isMain(leaf)) return old.call(this, leaf, pushHistory, focus);
                // Handle the case where there was no prior active leaf
                if (!this.activeLeaf || !this.isLeafAttached(this.activeLeaf))
                    return old.call(this, this.getUnpinnedLeaf(), pushHistory, focus);
            }}
        }));
        this.register(around(WorkspaceLeaf.prototype, {
            canNavigate(old) {
                return function() {
                    return old.call(this) && (!self.isLocked || isMain(this));
                }
            }
        }))
    }

    toggle() {
        this.setting.set(!this.setting.get());
        this.onChange()
    }

    onChange() {
        const shouldLock = this.setting.get();
        if (shouldLock && !this.installed) this.install();
        if (this.isLocked === shouldLock) return;
        if (this.isLocked != null) { // don't show notice on plugin start
            document.body.appendChild( // force notice to main window
                new Notice(shouldLock ? "Sidebar focusing disabled" : "Sidebar focusing enabled").noticeEl.parentElement
            );
        }
        this.isLocked = shouldLock;

        setIcon(this.iconEl, shouldLock ? "lucide-lock" : "lucide-unlock", 13);
        setTooltip(this.iconEl, shouldLock ?
            "Sidebar focus disabled: click to enable" :
            "Sidebar focus enabled: click to disable"
        );
        if (shouldLock && !isMain(app.workspace.activeLeaf)) {
            // Leave the sidebar
            app.workspace.setActiveLeaf(app.workspace.getUnpinnedLeaf(), false, true);
        }
    }

}

function isMain(leaf: WorkspaceLeaf) {
    const root = leaf?.getRoot();
    return !!(root && root !== app.workspace.leftSplit && root !== app.workspace.rightSplit);
}

declare module "obsidian" {
    interface Workspace {
        isLeafAttached(leaf: WorkspaceLeaf): boolean
    }
    interface WorkspaceLeaf {
        canNavigate(): boolean
    }
    interface Notice {
        noticeEl: HTMLDivElement
    }
}