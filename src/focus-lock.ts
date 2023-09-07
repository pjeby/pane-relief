import { around } from "monkey-around";
import { Notice, Plugin, setIcon, Workspace, WorkspaceLeaf } from "obsidian";
import { defer, isLeafAttached, LayoutSetting, Service, o } from "@ophidian/core";
import { addCommands, command } from "./commands";
import { setTooltip } from "./Navigator";

export class FocusLock extends Service {

    setting = new LayoutSetting<boolean, o.Workspace>(this, "pane-relief:focus-lock").of(app.workspace);

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
            setActiveLeaf(old) { return function(this: Workspace, leaf, ...etc: any[]) {
                if (!self.isLocked || isMain(leaf)) return old.call(this, leaf, ...etc);
                // Handle the case where there was no prior active leaf
                if (!this.activeLeaf || !isLeafAttached(this.activeLeaf))
                    return old.call(this, this.getLeaf(), ...etc);
            }},
            revealLeaf(old) {
                return function(leaf: WorkspaceLeaf) {
                    const container = leaf.getContainer();
                    if (!self.isLocked || isMain(leaf) || !container) return old.call(this, leaf);
                    const remove = around(container, {focus() { return function() {}; }});
                    try { return old.call(this, leaf); } finally { remove(); }
                }
            }
        }));
        this.register(around(WorkspaceLeaf.prototype, {
            canNavigate(old) {
                return function() {
                    return old.call(this) && (!self.isLocked || isMain(this));
                }
            }
        }));
        this.register(around((app as any).internalPlugins.plugins["file-explorer"].instance, {
            init(old) { return function init(...args: any[]) {
                try { return old.apply(this, args); } finally { self.blockFileExplorerReveal(); }
            }}
        }));
        this.blockFileExplorerReveal();
    }

    blockFileExplorerReveal() {
        const self = this;
        const raf = (app.commands as any).commands["file-explorer:reveal-active-file"];
        if (raf) this.register(around(raf, {
            checkCallback(old) {
                return function (...args: any[]) {
                    if (self.isLocked) for (const leaf of app.workspace.getLeavesOfType("file-explorer")) {
                        if (!isMain(leaf)) {
                            const el: HTMLElement = (leaf.view as any).dom?.navFileContainerEl;
                            el && defer(around(el, {focus(old) {
                                // Block focus stealing
                                return function() {};
                            }}));
                        }
                    }
                    return old?.apply(this, args);
                }
            }
        }));
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

        setIcon(this.iconEl, shouldLock ? "lucide-lock" : "lucide-unlock");
        setTooltip(this.iconEl, shouldLock ?
            "Sidebar focus disabled: click to enable" :
            "Sidebar focus enabled: click to disable"
        );
        if (shouldLock && !isMain(app.workspace.activeLeaf) && app.workspace.layoutReady) {
            // Leave the sidebar
            app.workspace.setActiveLeaf(app.workspace.getUnpinnedLeaf(), false, true);
        }
    }

}

export function isMain(leaf: WorkspaceLeaf) {
    const root = leaf?.getRoot();
    return !!(root && root !== app.workspace.leftSplit && root !== app.workspace.rightSplit);
}

declare module "obsidian" {
    interface WorkspaceLeaf {
        canNavigate(): boolean
    }
}
