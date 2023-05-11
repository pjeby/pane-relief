import { Service, toggleClass } from "@ophidian/core";
import { around } from "monkey-around";
import { debounce, requireApiVersion, WorkspaceLeaf, WorkspaceTabs } from "obsidian";
import { isMain } from "./focus-lock";

declare module "obsidian" {
    interface Workspace {
        requestActiveLeafEvents(): void
        rightSidebarToggleButtonEl: HTMLDivElement
    }
    interface WorkspaceTabs {
        scrollIntoView(tab: number): void;
        tabsContainerEl: HTMLDivElement;
        isStacked: boolean;
        currentTab: number;
        onContainerScroll(): void;
    }
    interface App {
        commands: {
            executeCommandById(id: string, event?: Event): boolean
        }
    }
}

export class Maximizer extends Service {

    changing = false;

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
                if (isMain(leaf) && parent) self.refresh(parent, parent.hasClass("should-maximize") ? leaf.containerEl : null);
                return old.call(this, leaf, pushHistory, focus);
            }}
        }));
        this.register(around(WorkspaceTabs.prototype, {
            onContainerScroll(old) {
                return function() {
                    // Don't hide tabs while we're switching modes
                    if (!self.changing && this.containerEl.isShown()) return old.call(this)
                }
            }
        }))

        // Replace the right sidebar toggle that gets hidden during maximize
        app.workspace.onLayoutReady(() => {
            const toggle = app.workspace.rightSidebarToggleButtonEl.cloneNode(true) as HTMLDivElement;
            toggle.id = "pr-maximize-sb-toggle";
            toggle.addEventListener("click", () => app.workspace.rightSplit.toggle());
            toggle.ariaLabel = i18next.t(app.workspace.rightSplit.collapsed ? "interface.sidebar-expand" : "interface.sidebar-collapse")
            app.workspace.containerEl.parentElement.appendChild(toggle);
            this.register(() => toggle.detach());
            this.register(around(app.workspace.rightSplit.constructor.prototype, {
                expand(old) {
                    return function() {
                        toggle.ariaLabel = i18next.t("interface.sidebar-collapse");
                        return old.call(this);
                    };
                },
                collapse(old) {
                    return function() {
                        toggle.ariaLabel = i18next.t("interface.sidebar-expand");
                        return old.call(this);
                    };
                }
            }));
        })
    }

    onunload() {
        // Un-maximize all panes
        for (const parent of this.parents()) this.refresh(parent, null);
    }

    toggleMaximize(leaf = app.workspace.activeLeaf) {
        if (!leaf || !isMain(leaf)) leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
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
        const parent = app.workspace.activeLeaf.parentSplit;
        if (requireApiVersion("0.16.2") && parent instanceof WorkspaceTabs && parent.isStacked) {
            parent.containerEl.win.requestAnimationFrame(() => {
                const remove = around(parent.tabsContainerEl, {
                    scrollTo(old) { return function(optionsOrX, y?: number) {
                        if (typeof optionsOrX === "object") {
                            delete optionsOrX.behavior;
                            return old.call(this, optionsOrX);
                        }
                        return old.call(this, optionsOrX, y);
                    }}
                });
                try { parent.scrollIntoView(parent.currentTab); } finally { remove(); this.changing = false; }
            });
        } else {
            app.workspace.requestActiveLeafEvents();
            this.changing = false;
        }
    }, 1, true);

    refresh(
        parent: Element,
        leafEl: Element =
            parent.hasClass("should-maximize") ? this.lastMaximized(parent) : null
    ) {
        this.changing = true;
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
            if (hadMax) return this.fixSlidingPanes();
        }
        this.changing = false;
    }

    parents() {
        const parents: HTMLDivElement[] = [app.workspace.rootSplit.containerEl]
        parents.concat((app.workspace.floatingSplit?.children ?? []).map(i => i.containerEl));
        const popovers = app.plugins.plugins["obsidian-hover-editor"]?.activePopovers;
        if (popovers) for (const popover of popovers) {
            if (popover.rootSplit) parents.push(popover.rootSplit.containerEl)
        }
        return parents.map(e => this.parentFor(e));
    }

    parentForLeaf(leaf: WorkspaceLeaf) {
        return this.parentFor(leaf?.containerEl);
    }

    parentFor(el: Element) {
        return el?.matchParent(".workspace, .hover-popover > .popover-content > .workspace-split");
    }

}