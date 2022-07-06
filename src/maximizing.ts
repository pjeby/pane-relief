import { around } from "monkey-around";
import { Component, debounce, WorkspaceItem, WorkspaceLeaf, WorkspaceParent } from "obsidian";

declare module "obsidian" {
    interface Workspace {
        getMostRecentLeaf(root: WorkspaceParent): WorkspaceLeaf
        requestActiveLeafEvents(): void
    }
    interface WorkspaceItem {
        getContainer?(): WorkspaceParent
    }
    interface App {
        commands: {
            executeCommandById(id: string, event?: Event): boolean
        }
    }
}

/**
 * Efficiently update a class on a workspace item, only touching where changes are needed
 *
 * @param item The workspace item to add or remove the class from
 * @param cls The class to add or remove
 * @param state Boolean, flag to add or remove, defaults to opposite of current state
 * @returns boolean for the state of the class afterwards
 */
function toggleClass(item: WorkspaceItem, cls: string, state?: boolean): boolean {
    const el = item.containerEl, had = el.classList.contains(cls);
    state = state ?? !had;
    if (state !== had) { state ? el.classList.add(cls) : el.classList.remove(cls); }
    return state;
}

export class Maximizer extends Component {

    onload() {
        this.registerEvent(app.workspace.on("layout-change", () => {
            for (const parent of this.parents()) this.refresh(parent);
        }));

        const self = this
        this.register(around(app.workspace, {
            setActiveLeaf(old) { return function setActiveLeaf(leaf, pushHistory, focus) {
                // We have to do this here so that MarkdownView can be focused in the new pane
                const parent = self.parentFor(leaf), oldParent = self.parentFor(app.workspace.activeLeaf);
                if (
                    parent && oldParent && parent !== oldParent &&
                    oldParent.containerEl?.matchParent(".hover-popover.is-active.snap-to-viewport") &&
                    parent.containerEl?.ownerDocument === oldParent.containerEl.ownerDocument &&
                    !parent.containerEl.matchParent(".hover-popover")
                ) {
                    // Switching from maximized popover to non-popover; de-maximize it first
                    app.commands.executeCommandById("obsidian-hover-editor:restore-active-popover");
                }
                if (parent) self.refresh(parent, parent.containerEl.hasClass("should-maximize") ? leaf : null);
                return old.call(this, leaf, pushHistory, focus);
            }}
        }));
    }

    onunload() {
        // Un-maximize all panes
        for (const parent of this.parents()) this.refresh(parent, null);
    }

    toggleMaximize(leaf = app.workspace.activeLeaf) {
        const parent = this.parentFor(leaf);
        if (!parent) return;
        const popoverEl = parent.containerEl.matchParent(".hover-popover");
        if (popoverEl && app.plugins.plugins["obsidian-hover-editor"]) {
            // Check if single leaf in a popover
            let count = 0; app.workspace.iterateLeaves(() => { count++; }, parent);
            if (count === 1) {
                // Maximize or restore the popover instead of the leaf
                app.commands.executeCommandById(
                    "obsidian-hover-editor:" + (
                        popoverEl.hasClass("snap-to-viewport") ? "restore-active-popover" : "snap-active-popover-to-viewport"
                    )
                );
                return;
            }
        }
        if (parent) this.refresh(parent, toggleClass(parent, "should-maximize") ? leaf : null);
    }

    lastMaximized(parent: WorkspaceParent) {
        let result: WorkspaceLeaf = null;
        app.workspace.iterateLeaves(leaf => { if (leaf.containerEl.hasClass("is-maximized")) result = leaf; }, parent);
        return result || app.workspace.getMostRecentLeaf();
    }

    fixSlidingPanes = debounce(() => {
        if ((app.plugins.plugins as any)["sliding-panes-obsidian"]) {
            app.workspace.onLayoutChange();
            app.workspace.requestActiveLeafEvents();
        }
    }, 5);

    refresh(
        parent: WorkspaceParent,
        leaf: WorkspaceLeaf =
            parent.containerEl.hasClass("should-maximize") ? this.lastMaximized(parent) : null
    ) {
        function walk(parent: WorkspaceParent) {
            let haveMatch = false, match = false;
            for (const item of parent.children) {
                if (item instanceof WorkspaceLeaf) {
                    toggleClass(item, "is-maximized",  match = (leaf === item));
                } else if (item instanceof WorkspaceParent) {
                    match = walk(item);
                }
                haveMatch ||= match;
            }
            return toggleClass(parent, "has-maximized", haveMatch);
        }
        const hadMax = parent.containerEl.hasClass("has-maximized");
        if (!walk(parent)) {
            toggleClass(parent, "should-maximize", false);
            if (hadMax) this.fixSlidingPanes();
        }
    }

    parents() {
        const parents: WorkspaceParent[] = [app.workspace.rootSplit]
        parents.concat(app.workspace.floatingSplit?.children ?? []);
        const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers) for (const popover of popovers) {
            if (popover.rootSplit) parents.push(popover.rootSplit)
        }
        return parents;
    }

    parentFor(leaf: WorkspaceLeaf): WorkspaceParent {
        if (!leaf || leaf.containerEl.matchParent(".workspace-tabs")) return null;
        const container = leaf.getContainer?.();
        if (container && container.containerEl.hasClass("mod-root")) return container;
        const popoverEl = leaf.containerEl.matchParent(".hover-popover");
        if (popoverEl) {
            const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
            if (popovers) for (const popover of popovers) {
                if (popoverEl.contains(popover.rootSplit.containerEl)) return popover.rootSplit;
            }
        }
        return app.workspace.rootSplit;
    }
}