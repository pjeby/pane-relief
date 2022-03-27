import { around } from 'monkey-around';
import {Plugin, TFile, WorkspaceLeaf} from 'obsidian';
import {addCommands, command} from "./commands";
import {History, installHistory} from "./History";
import {Navigator, onElement} from "./Navigator";

export default class PaneRelief extends Plugin {

    onload() {
        installHistory(this);
        this.leafMap = new WeakMap();

        this.app.workspace.registerHoverLinkSource(Navigator.hoverSource, {
            display: 'History dropdowns', defaultMod: true
        });
        this.app.workspace.onLayoutReady(() => {
            this.setupDisplay();
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile) this.app.workspace.iterateAllLeaves(
                    leaf => History.forLeaf(leaf).onRename(file, oldPath)
                );
            }));
            this.registerEvent(this.app.workspace.on("pane-relief:update-history", (leaf, history) => {
                this.updateLeaf(leaf);
                if (leaf === this.app.workspace.activeLeaf) this.display(history);
            }));
            this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => this.display(History.forLeaf(leaf))));
            if (this.app.workspace.activeLeaf) this.display(History.forLeaf(this.app.workspace.activeLeaf));
            this.registerEvent(this.app.workspace.on("layout-change", this.numberPanes, this));
            this.numberPanes();
            this.register(
                onElement(
                    document.body, "contextmenu", ".view-header > .view-actions > .view-action", (evt, target) => {
                        const nav = (
                            (target.matches('[class*=" app:go-forward"]') && this.forward) ||
                            (target.matches('[class*=" app:go-back"]')    && this.back)
                        );
                        if (!nav) return;
                        const leaf = this.leafMap.get(target.matchParent(".workspace-leaf"));
                        if (!leaf) return;
                        this.display(History.forLeaf(leaf));
                        nav.openMenu(evt);
                        this.display();
                    }, {capture: true}
                )
            );
        });

        this.register(around(WorkspaceLeaf.prototype, {
            // Workaround for https://github.com/obsidianmd/obsidian-api/issues/47
            setEphemeralState(old) { return function(state){
                if (state?.focus) {
                    const {activeElement} = document;
                    if (activeElement instanceof Node && !this.containerEl.contains(activeElement)) {
                        activeElement.blur?.();
                    }
                }
                return old.call(this, state);
            }}
        }));

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

    setupDisplay() {
        this.addChild(this.back    = new Navigator(this, "back", -1));
        this.addChild(this.forward = new Navigator(this, "forward", 1));
    }

    // Set to true while either menu is open, so we don't switch it out
    historyIsOpen = false;

    display(history = History.forLeaf(this.app.workspace.activeLeaf)) {
        if (this.historyIsOpen) return;
        this.back.setHistory(history);
        this.forward.setHistory(history);
    }

    iterateRootLeaves(cb) {
        if (this.app.workspace.iterateRootLeaves(cb)) return true;

        // Support Hover Editors
        const popovers = this.app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers) for (const popover of popovers) {
            // More recent plugin: we can skip the scan
            if (popover.constructor.iteratePopoverLeaves) return false;
            if (popover.leaf && cb(popover.leaf)) return true;
            if (popover.rootSplit && this.app.workspace.iterateLeaves(cb, popover.rootSplit)) return true;
        }

        return false;
    }

    updateLeaf(leaf) {
        const history = History.forLeaf(leaf);
        leaf.containerEl.style.setProperty("--pane-relief-forward-count", '"'+(history.lookAhead().length || "")+'"');
        leaf.containerEl.style.setProperty("--pane-relief-backward-count", '"'+(history.lookBehind().length || "")+'"');
        this.leafMap.set(leaf.containerEl, leaf);
    }

    numberPanes() {
        let count = 0, lastLeaf = null;
        this.iterateRootLeaves(leaf => {
            leaf.containerEl.style.setProperty("--pane-relief-label", ++count < 9 ? count : "");
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

    gotoNthLeaf(n, relative) {
        const leaves = [];
        this.iterateRootLeaves((leaf) => (leaves.push(leaf), false));
        if (relative) {
            n += leaves.indexOf(this.app.workspace.activeLeaf);
            n = (n + leaves.length) % leaves.length;  // wrap around
        }
        const leaf = leaves[n>=leaves.length ? leaves.length-1 : n];
        !leaf || this.app.workspace.setActiveLeaf(leaf, true, true);
    }

    placeLeaf(toPos, relative=true) {
        const cb = this.leafPlacer(toPos, relative);
        if (cb) cb();
    }

    leafPlacer(toPos, relative=true) {
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
            if (parentSplit.selectTab) {
                parentSplit.selectTab(leaf);
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

