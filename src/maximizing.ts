import { Service } from "@ophidian/core";
import { around } from "monkey-around";
import { debounce, WorkspaceLeaf } from "obsidian";

declare module "obsidian" {
    interface Workspace {
        requestActiveLeafEvents(): void
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
 * @param el The element to add or remove the class from
 * @param cls The class to add or remove
 * @param state Boolean, flag to add or remove, defaults to opposite of current state
 * @returns boolean for the state of the class afterwards
 */
function toggleClass(el: Element, cls: string, state?: boolean): boolean {
    const had = el.classList.contains(cls);
    state = state ?? !had;
    if (state !== had) { state ? el.classList.add(cls) : el.classList.remove(cls); }
    return state;
}

export class Maximizer extends Service {

    onload() {
        this.registerEvent(app.workspace.on("layout-change", () => {
            for (const parent of this.parents()) this.refresh(parent);
        }));

        const self = this
        this.register(around(app.workspace, {
            setActiveLeaf(old) { return function setActiveLeaf(leaf, pushHistory, focus) {
                // We have to do this here so that MarkdownView can be focused in the new pane
                const parent = self.parentForLeaf(leaf), oldParent = self.parentForLeaf(app.workspace.activeLeaf);
                if (
                    parent && oldParent && parent !== oldParent &&
                    oldParent.matchParent(".hover-popover.is-active.snap-to-viewport") &&
                    parent.ownerDocument === oldParent.ownerDocument &&
                    !parent.matchParent(".hover-popover")
                ) {
                    // Switching from maximized popover to non-popover; de-maximize it first
                    app.commands.executeCommandById("obsidian-hover-editor:restore-active-popover");
                }
                if (parent) self.refresh(parent, parent.hasClass("should-maximize") ? leaf.containerEl : null);
                return old.call(this, leaf, pushHistory, focus);
            }}
        }));
    }

    onunload() {
        // Un-maximize all panes
        for (const parent of this.parents()) this.refresh(parent, null);
    }

    toggleMaximize(leaf = app.workspace.activeLeaf) {
        const parent = this.parentForLeaf(leaf);
        if (!parent) return;
        const popoverEl = parent.matchParent(".hover-popover");
        if (popoverEl && app.plugins.plugins["obsidian-hover-editor"]) {
            // Check if single leaf in a popover
            let count = popoverEl.findAll(".workspace-leaf").length;
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
        if (parent) this.refresh(parent, toggleClass(parent, "should-maximize") ? leaf.containerEl : null);
    }

    lastMaximized(parent: Element) {
        return parent.find(".workspace-leaf.is-maximized") || app.workspace.getMostRecentLeaf().containerEl;
    }

    fixSlidingPanes = debounce(() => {
        if ((app.plugins.plugins as any)["sliding-panes-obsidian"]) {
            app.workspace.onLayoutChange();
            app.workspace.requestActiveLeafEvents();
        }
    }, 5);

    refresh(
        parent: Element,
        leafEl: Element =
            parent.hasClass("should-maximize") ? this.lastMaximized(parent) : null
    ) {
        const hadMax = parent.hasClass("has-maximized");
        parent.findAllSelf(".workspace-split, .workspace-tabs").forEach(split => {
            if (split === parent || this.parentFor(split) === parent)
                toggleClass(split, "has-maximized", leafEl ? split.contains(leafEl): false);
        });
        parent.findAll(".workspace-leaf").forEach(leaf => {
            if (this.parentFor(leaf) === parent) toggleClass(leaf, "is-maximized", leaf === leafEl);
        })
        if (!leafEl || !parent.contains(leafEl)) {
            toggleClass(parent, "should-maximize", false);
            if (hadMax) this.fixSlidingPanes();
        }
    }

    parents() {
        const parents: HTMLDivElement[] = [app.workspace.rootSplit.containerEl]
        parents.concat((app.workspace.floatingSplit?.children ?? []).map(i => i.containerEl));
        const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers) for (const popover of popovers) {
            if (popover.rootSplit) parents.push(popover.rootSplit.containerEl)
        }
        return parents;
    }

    parentForLeaf(leaf: WorkspaceLeaf) {
        return this.parentFor(leaf?.containerEl);
    }

    parentFor(el: Element) {
        return el?.matchParent(".workspace-split.mod-root, .hover-popover > .popover-content > .workspace-split");
    }

}