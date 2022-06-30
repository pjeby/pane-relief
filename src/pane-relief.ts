import {Plugin, TFile, WorkspaceLeaf, WorkspaceSplit, WorkspaceTabs} from 'obsidian';
import {addCommands, command} from "./commands";
import {History, installHistory} from "./History";
import {Navigation, Navigator, onElement} from "./Navigator";
import {WindowManager} from './PerWindowComponent';

declare module "obsidian" {
    interface Workspace {
        on(type: "pane-relief:update-history", callback: (leaf: WorkspaceLeaf, history: History) => any, ctx?: any): EventRef;
        registerHoverLinkSource(source: string, info: {display: string, defaultMod?: boolean}): void
        unregisterHoverLinkSource(source: string): void
        iterateLeaves(callback: (item: WorkspaceLeaf) => unknown, item: WorkspaceParent): boolean;
        onLayoutChange(): void
    }
    interface App {
        plugins: {
            plugins: {
                "obsidian-hover-editor": {
                    activePopovers: HoverPopover[]
                }
            }
        }
    }
    interface WorkspaceItem {
        containerEl: HTMLDivElement
    }
    interface WorkspaceParent {
        children: WorkspaceItem[]
        recomputeChildrenDimensions(): void
    }
    interface WorkspaceTabs extends WorkspaceParent {
        selectTab(leaf: WorkspaceLeaf): void
    }
    interface WorkspaceLeaf {
        parentSplit: WorkspaceParent
    }
    interface HoverPopover {
        leaf?: WorkspaceLeaf
        rootSplit?: WorkspaceSplit
    }
}

export default class PaneRelief extends Plugin {

    leafMap = new WeakMap()
    nav = new WindowManager(this, Navigation).watch();

    onload() {
        installHistory(this);
        this.app.workspace.registerHoverLinkSource(Navigator.hoverSource, {
            display: 'History dropdowns', defaultMod: true
        });
        this.app.workspace.onLayoutReady(() => {
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile) this.app.workspace.iterateAllLeaves(
                    leaf => History.forLeaf(leaf).onRename(file, oldPath)
                );
            }));
            this.registerEvent(
                app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf) => this.nav.forLeaf(leaf).display(leaf))
            );
            this.registerEvent(
                app.workspace.on("pane-relief:update-history", (leaf: WorkspaceLeaf) => this.updateLeaf(leaf))
            );
            this.registerEvent(this.app.workspace.on("layout-change", this.numberPanes, this));
            this.numberPanes();
        });

        addCommands(this, {
            [command("swap-prev", "Swap pane with previous in split",  "Mod+Shift+PageUp")]   (){ return this.leafPlacer(-1); },
            [command("swap-next", "Swap pane with next in split",      "Mod+Shift+PageDown")] (){ return this.leafPlacer( 1); },

            [command("go-prev",  "Cycle to previous workspace pane",   "Mod+PageUp"  )] () { return () => this.gotoNthLeaf(-1, true); },
            [command("go-next",  "Cycle to next workspace pane",       "Mod+PageDown")] () { return () => this.gotoNthLeaf( 1, true); },

            [command("go-1st",   "Jump to 1st pane in the workspace",  "Alt+1")] () { return () => this.gotoNthLeaf(0); },
            [command("go-2nd",   "Jump to 2nd pane in the workspace",  "Alt+2")] () { return () => this.gotoNthLeaf(1); },
            [command("go-3rd",   "Jump to 3rd pane in the workspace",  "Alt+3")] () { return () => this.gotoNthLeaf(2); },
            [command("go-4th",   "Jump to 4th pane in the workspace",  "Alt+4")] () { return () => this.gotoNthLeaf(3); },
            [command("go-5th",   "Jump to 5th pane in the workspace",  "Alt+5")] () { return () => this.gotoNthLeaf(4); },
            [command("go-6th",   "Jump to 6th pane in the workspace",  "Alt+6")] () { return () => this.gotoNthLeaf(5); },
            [command("go-7th",   "Jump to 7th pane in the workspace",  "Alt+7")] () { return () => this.gotoNthLeaf(6); },
            [command("go-8th",   "Jump to 8th pane in the workspace",  "Alt+8")] () { return () => this.gotoNthLeaf(7); },
            [command("go-last",  "Jump to last pane in the workspace", "Alt+9")] () { return () => this.gotoNthLeaf(99999999); },

            [command("put-1st",  "Place as 1st pane in the split",     "Mod+Alt+1")] () { return () => this.placeLeaf(0, false); },
            [command("put-2nd",  "Place as 2nd pane in the split",     "Mod+Alt+2")] () { return () => this.placeLeaf(1, false); },
            [command("put-3rd",  "Place as 3rd pane in the split",     "Mod+Alt+3")] () { return () => this.placeLeaf(2, false); },
            [command("put-4th",  "Place as 4th pane in the split",     "Mod+Alt+4")] () { return () => this.placeLeaf(3, false); },
            [command("put-5th",  "Place as 5th pane in the split",     "Mod+Alt+5")] () { return () => this.placeLeaf(4, false); },
            [command("put-6th",  "Place as 6th pane in the split",     "Mod+Alt+6")] () { return () => this.placeLeaf(5, false); },
            [command("put-7th",  "Place as 7th pane in the split",     "Mod+Alt+7")] () { return () => this.placeLeaf(6, false); },
            [command("put-8th",  "Place as 8th pane in the split",     "Mod+Alt+8")] () { return () => this.placeLeaf(7, false); },
            [command("put-last", "Place as last pane in the split",    "Mod+Alt+9")] () { return () => this.placeLeaf(99999999, false); }
        });
    }

    iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => void | boolean) {
        this.app.workspace.iterateRootLeaves(cb);

        // Support Hover Editors
        const popovers = this.app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers) for (const popover of popovers) {
            // More recent plugin: we can skip the scan
            if ((popover.constructor as any).iteratePopoverLeaves) return false;
            if (popover.leaf && cb(popover.leaf)) return true;
            if (popover.rootSplit && this.app.workspace.iterateLeaves(cb, popover.rootSplit)) return true;
        }

        return false;
    }

    updateLeaf(leaf: WorkspaceLeaf) {
        const history = History.forLeaf(leaf);
        leaf.containerEl.style.setProperty("--pane-relief-forward-count", '"'+(history.lookAhead().length || "")+'"');
        leaf.containerEl.style.setProperty("--pane-relief-backward-count", '"'+(history.lookBehind().length || "")+'"');
        this.leafMap.set(leaf.containerEl, leaf);
    }

    numberPanes() {
        let count = 0, lastLeaf: WorkspaceLeaf = null;
        this.iterateRootLeaves(leaf => {
            leaf.containerEl.style.setProperty("--pane-relief-label", ++count < 9 ? ""+count : "");
            leaf.containerEl.toggleClass("has-pane-relief-label", count<9);
            lastLeaf = leaf;
        });
        if (count>8) {
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
        })
    }

    gotoNthLeaf(n: number, relative: boolean) {
        const leaves: WorkspaceLeaf[] = [];
        this.iterateRootLeaves((leaf) => (leaves.push(leaf), false));
        if (relative) {
            n += leaves.indexOf(this.app.workspace.activeLeaf);
            n = (n + leaves.length) % leaves.length;  // wrap around
        }
        const leaf = leaves[n>=leaves.length ? leaves.length-1 : n];
        !leaf || this.app.workspace.setActiveLeaf(leaf, true, true);
    }

    placeLeaf(toPos: number, relative=true) {
        const cb = this.leafPlacer(toPos, relative);
        if (cb) cb();
    }

    leafPlacer(toPos: number, relative=true) {
        const leaf = this.app.workspace.activeLeaf;
        if (!leaf) return false;

        const
            parentSplit = leaf.parentSplit,
            children = parentSplit.children,
            fromPos = children.indexOf(leaf)
        ;
        if (fromPos == -1) return false;

        if (relative) {
            toPos += fromPos;
            if (toPos < 0 || toPos >= children.length) return false;
        } else {
            if (toPos >= children.length) toPos = children.length - 1;
            if (toPos < 0) toPos = 0;
        }

        if (fromPos == toPos) return false;

        return () => {
            const other = children[toPos];
            children.splice(fromPos, 1);
            children.splice(toPos,   0, leaf);
            if ((parentSplit as WorkspaceTabs).selectTab) {
                (parentSplit as WorkspaceTabs).selectTab(leaf);
            } else {
                other.containerEl.insertAdjacentElement(fromPos > toPos ? "beforebegin" : "afterend", leaf.containerEl);
                parentSplit.recomputeChildrenDimensions();
                leaf.onResize();
                this.app.workspace.onLayoutChange();

                // Force focus back to pane;
                this.app.workspace.activeLeaf = null;
                this.app.workspace.setActiveLeaf(leaf, false, true)
            }
        }
    }
}

