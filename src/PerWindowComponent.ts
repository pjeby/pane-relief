import { Component, Plugin, View, WorkspaceLeaf, WorkspaceParent, WorkspaceSplit, WorkspaceWindow } from "obsidian";

/**
 * Component that belongs to a plugin + window. e.g.:
 *
 *     class TitleWidget extends PerWindowComponent<MyPlugin> {
 *         onload() {
 *             // do stuff with this.plugin and this.win ...
 *         }
 *     }
 *
 *     class MyPlugin extends Plugin {
 *         titleWidgets = TitleWidget.perWindow(this);
 *         ...
 *     }
 *
 * This will automatically create a title widget for each window as it's opened, and
 * on plugin load.  The plugin's `.titleWidgets` will also be a WindowManager that can
 * look up the title widget for a given window, leaf, or view, or return a list of
 * all of them.  See WindowManager for the full API.
 *
 * If you want your components to be created on demand instead of automatically when
 * window(s) are opened, you can pass `false` as the second argument to `perWindow()`.
 */
export class PerWindowComponent<P extends Plugin> extends Component {

    get root(): WorkspaceParent {
        return containerForWindow(this.win);
    }

    constructor(public plugin: P, public win: Window) {
        super();
    }

    static perWindow<T extends PerWindowComponent<P>, P extends Plugin>(
        this: new (plugin: P, win: Window) => T,
        plugin: P
    ) {
        return new WindowManager(plugin, this);
    }
}

/**
 * Manage per-window components
 */
export class WindowManager<T extends PerWindowComponent<P>, P extends Plugin> extends Component {
    instances = new WeakMap<Window, T>();

    watching: boolean = false

    constructor (
        public plugin: P,
        public factory: new (plugin: P, win: Window) => T,  // The class of thing to manage
    ) {
        super();
        plugin.addChild(this);
    }

    watch(): this {
        // Defer watch until plugin is loaded
        if (!this._loaded) this.onload = () => this.watch();
        else if (!this.watching) {
            const {workspace} = app;
            this.watching = true;
            this.registerEvent(
                workspace.on("window-open", (_, win) => {
                    workspace.onLayoutReady(() => Promise.resolve().then(() => this.forWindow(win)));
                })
            );
            workspace.onLayoutReady(() => Promise.resolve().then(() => this.forAll()));
        }
        return this;
    }

    forWindow(): T;
    forWindow(win: Window): T;
    forWindow(win: Window, create: true): T;
    forWindow(win: Window, create: boolean): T | undefined;

    forWindow(win: Window = window.activeWindow ?? window, create = true): T | undefined {
        let inst = this.instances.get(win);
        if (!inst && create) {
            inst = new this.factory(this.plugin, win);
            if (inst) {
                this.instances.set(win, inst!);
                inst.registerDomEvent(win, "beforeunload", () => {
                    this.removeChild(inst!);
                    this.instances.delete(win);
                });
                this.addChild(inst);
            }
        }
        return inst || undefined;
    }

    forDom(el: HTMLElement): T;
    forDom(el: HTMLElement, create: true): T;
    forDom(el: HTMLElement, create: boolean): T | undefined;

    forDom(el: HTMLElement, create = true) {
        return this.forWindow(windowForDom(el), create);
    }

    forLeaf(leaf: WorkspaceLeaf): T;
    forLeaf(leaf: WorkspaceLeaf, create: true): T;
    forLeaf(leaf: WorkspaceLeaf, create: boolean): T | undefined;

    forLeaf(leaf: WorkspaceLeaf, create = true) {
        return this.forDom(leaf.containerEl, create);
    }

    forView(view: View): T;
    forView(view: View, create: true): T;
    forView(view: View, create: boolean): T | undefined;

    forView(view: View, create = true) {
        return this.forLeaf(view.leaf, create);
    }

    windows() {
        const windows: Window[] = [window], {floatingSplit} = app.workspace;
        if (floatingSplit) {
            for(const split of floatingSplit.children) if (split.win) windows.push(split.win);
        }
        return windows;
    }

    forAll(create = true) {
        return this.windows().map(win => this.forWindow(win, create)).filter(t => t);
    }
}

export function windowForDom(el: Node) {
    return (el.ownerDocument || <Document>el).defaultView!;
}

function containerForWindow(win: Window): WorkspaceParent {
    if (win === window) return app.workspace.rootSplit;
    const {floatingSplit} = app.workspace;
    if (floatingSplit) {
        for(const split of floatingSplit.children) if (win === split.win) return split;
    }
}

declare global {
    // Backward compatibility for single-window Obsidian (<0.15)
    interface Window {
        activeWindow?: Window
    }
}

declare module "obsidian" {
    interface Workspace {
        floatingSplit?: { children: WorkspaceWindow[] };
        openPopout?(): WorkspaceSplit;
        openPopoutLeaf?(): WorkspaceLeaf;
        on(name: 'window-open', callback: (win: WorkspaceWindow, window: Window) => any, ctx?: any): EventRef;
    }
    interface WorkspaceWindow extends WorkspaceParent {
        win: Window
    }
    interface WorkspaceLeaf {
        containerEl: HTMLDivElement;
    }
    interface Component {
        _loaded: boolean
    }
}
