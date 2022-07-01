import { Component, WorkspaceItem, WorkspaceLeaf, WorkspaceParent } from "obsidian";

declare module "obsidian" {
    interface Workspace {
        getMostRecentLeaf(root: WorkspaceParent): WorkspaceLeaf
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
        this.registerEvent(app.workspace.on("active-leaf-change", leaf => {
            this.refresh(this.parentFor(leaf));
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
        parent.containerEl.ownerDocument.defaultView.requestAnimationFrame(() => {
            if (!walk(parent)) toggleClass(parent, "should-maximize", false);
        });
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