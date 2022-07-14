import { Plugin, requireApiVersion, TFile, WorkspaceTabs } from "obsidian";
import { numWindows, use } from "ophidian";
import { addCommands, command } from "./commands";
import { FocusLock } from "./focus-lock";
import { History, HistoryManager } from "./History";
import { Maximizer } from "./maximizing";
import { Navigation, Navigator } from "./Navigator";

import "./styles.scss";

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
        hoverEl: HTMLElement
    }
}

export default class PaneRelief extends Plugin {
    use = use.plugin(this);
    nav = this.use(Navigation).watch();
    max = this.addChild(new Maximizer);

    onload() {
        this.use(HistoryManager).load();  // Install history before anything else

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
                app.workspace.on("active-leaf-change", leaf => this.nav.forLeaf(leaf).display(leaf))
            );
            this.registerEvent(
                app.workspace.on("pane-relief:update-history", (leaf, history) => this.nav.forLeaf(leaf).onUpdateHistory(leaf, history))
            );
        });
        addCommands(this);
        if (requireApiVersion("0.15.6")) this.use(FocusLock);
    }

    [command("swap-prev", "Swap pane with previous in split",  "Mod+Shift+PageUp")]   (){ return this.leafPlacer(-1); }
    [command("swap-next", "Swap pane with next in split",      "Mod+Shift+PageDown")] (){ return this.leafPlacer( 1); }

    [command("go-prev",  "Cycle to previous workspace pane",   "Mod+PageUp"  )] () { return () => this.gotoNthLeaf(-1, true); }
    [command("go-next",  "Cycle to next workspace pane",       "Mod+PageDown")] () { return () => this.gotoNthLeaf( 1, true); }

    [command("win-prev", "Cycle to previous window", [] )] () { if (numWindows() > 1) return () => this.gotoNthWindow(-1, true); }
    [command("win-next", "Cycle to next window",     [] )] () { if (numWindows() > 1) return () => this.gotoNthWindow( 1, true); }

    [command("go-1st",   "Jump to 1st pane in the workspace",  "Alt+1")] () { return () => this.gotoNthLeaf(0); }
    [command("go-2nd",   "Jump to 2nd pane in the workspace",  "Alt+2")] () { return () => this.gotoNthLeaf(1); }
    [command("go-3rd",   "Jump to 3rd pane in the workspace",  "Alt+3")] () { return () => this.gotoNthLeaf(2); }
    [command("go-4th",   "Jump to 4th pane in the workspace",  "Alt+4")] () { return () => this.gotoNthLeaf(3); }
    [command("go-5th",   "Jump to 5th pane in the workspace",  "Alt+5")] () { return () => this.gotoNthLeaf(4); }
    [command("go-6th",   "Jump to 6th pane in the workspace",  "Alt+6")] () { return () => this.gotoNthLeaf(5); }
    [command("go-7th",   "Jump to 7th pane in the workspace",  "Alt+7")] () { return () => this.gotoNthLeaf(6); }
    [command("go-8th",   "Jump to 8th pane in the workspace",  "Alt+8")] () { return () => this.gotoNthLeaf(7); }
    [command("go-last",  "Jump to last pane in the workspace", "Alt+9")] () { return () => this.gotoNthLeaf(99999999); }

    [command("win-1st",   "Switch to 1st window",  [])] () { if (numWindows() > 1) return () => this.gotoNthWindow(0); }
    [command("win-2nd",   "Switch to 2nd window",  [])] () { if (numWindows() > 1) return () => this.gotoNthWindow(1); }
    [command("win-3rd",   "Switch to 3rd window",  [])] () { if (numWindows() > 2) return () => this.gotoNthWindow(2); }
    [command("win-4th",   "Switch to 4th window",  [])] () { if (numWindows() > 3) return () => this.gotoNthWindow(3); }
    [command("win-5th",   "Switch to 5th window",  [])] () { if (numWindows() > 4) return () => this.gotoNthWindow(4); }
    [command("win-6th",   "Switch to 6th window",  [])] () { if (numWindows() > 5) return () => this.gotoNthWindow(5); }
    [command("win-7th",   "Switch to 7th window",  [])] () { if (numWindows() > 6) return () => this.gotoNthWindow(6); }
    [command("win-8th",   "Switch to 8th window",  [])] () { if (numWindows() > 7) return () => this.gotoNthWindow(7); }
    [command("win-last",  "Switch to last window", [])] () { if (numWindows() > 1) return () => this.gotoNthWindow(99999999); }

    [command("put-1st",  "Place as 1st pane in the split",     "Mod+Alt+1")] () { return () => this.placeLeaf(0, false); }
    [command("put-2nd",  "Place as 2nd pane in the split",     "Mod+Alt+2")] () { return () => this.placeLeaf(1, false); }
    [command("put-3rd",  "Place as 3rd pane in the split",     "Mod+Alt+3")] () { return () => this.placeLeaf(2, false); }
    [command("put-4th",  "Place as 4th pane in the split",     "Mod+Alt+4")] () { return () => this.placeLeaf(3, false); }
    [command("put-5th",  "Place as 5th pane in the split",     "Mod+Alt+5")] () { return () => this.placeLeaf(4, false); }
    [command("put-6th",  "Place as 6th pane in the split",     "Mod+Alt+6")] () { return () => this.placeLeaf(5, false); }
    [command("put-7th",  "Place as 7th pane in the split",     "Mod+Alt+7")] () { return () => this.placeLeaf(6, false); }
    [command("put-8th",  "Place as 8th pane in the split",     "Mod+Alt+8")] () { return () => this.placeLeaf(7, false); }
    [command("put-last", "Place as last pane in the split",    "Mod+Alt+9")] () { return () => this.placeLeaf(99999999, false); }

    [command("maximize", "Maximize active pane (Toggle)", [])] () {
        if (this.max.parentForLeaf(app.workspace.activeLeaf)) return () => this.max.toggleMaximize();
    }

    onunload() {
        this.app.workspace.unregisterHoverLinkSource(Navigator.hoverSource);
    }

    gotoNthLeaf(n: number, relative?: boolean) {
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

    gotoNthWindow(n: number, relative?: boolean) {
        const nav = gotoNth(this.nav.forAll(), this.nav.forLeaf(app.workspace.activeLeaf), n, relative);
        const leaf = nav?.latestLeaf();
        if (leaf) app.workspace.setActiveLeaf(leaf, true, true);
        (nav?.win as any).require?.('electron')?.remote?.getCurrentWindow()?.focus();
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

        if (children.length === 1) {
            const popoverEl = leaf.containerEl.matchParent(".hover-popover");
            if (popoverEl && relative && Math.abs(toPos) === 1) {
                // Allow swapping popovers in the stack
                let neighbor = popoverEl;
                while (neighbor && (neighbor === popoverEl || !neighbor.matches(".hover-popover")))
                    neighbor = toPos < 0 ? neighbor.previousElementSibling : neighbor.nextElementSibling;
                if (neighbor) return () => {
                    if (toPos < 0) neighbor.parentElement.insertBefore(popoverEl, neighbor);
                    else neighbor.parentElement.insertBefore(neighbor, popoverEl);
                    app.workspace.onLayoutChange();
                }
            }
        }

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

function gotoNth<T>(items: T[], current: T, n: number, relative: boolean): T {
    if (relative) {
        n += items.indexOf(current);
        n = (n + items.length) % items.length;  // wrap around
    }
    return items[n >= items.length ? items.length-1 : n];
}