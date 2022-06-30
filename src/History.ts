import {Notice, TAbstractFile, ViewState, WorkspaceLeaf} from 'obsidian';
import {around} from "monkey-around";
import PaneRelief from "./pane-relief";

const HIST_ATTR = "pane-relief:history-v1";
const SERIAL_PROP = "pane-relief:history-v1";

declare module "obsidian" {
    interface Workspace {
        deserializeLayout(state: any, ...etc: any[]): Promise<WorkspaceItem>
    }

    interface WorkspaceLeaf {
        [HIST_ATTR]: History
        pinned: boolean
        working: boolean
        serialize(): any
    }

    interface ViewState {
        popstate?: boolean
    }
}


const domLeaves = new WeakMap();

interface PushState {
    state: string
    eState: string
}

export class HistoryEntry {

    raw: PushState
    eState: any
    path: string

    constructor(rawState: PushState) {
        this.setState(rawState);
    }


    get viewState() {
        return JSON.parse(this.raw.state || "{}")
    }

    setState(rawState: PushState) {
        this.raw = rawState;
        this.eState = JSON.parse(rawState.eState || "null");
        this.path = this.viewState.state?.file;
    }

    onRename(file: TAbstractFile, oldPath: string) {
        if (this.path === oldPath) {
            const viewState = this.viewState
            this.path = viewState.state.file = file.path
            this.raw.state = JSON.stringify(viewState);
        }
    }

    go(leaf?: WorkspaceLeaf) {
        let {viewState, path, eState} = this;
        let file = path && app?.vault.getAbstractFileByPath(path);
        if (path && !file) {
            new Notice("Missing file: "+path);
            viewState = {type: "empty", state:{}};
            eState = undefined;
        }
        leaf.setViewState({...viewState, active: true, popstate: true}, eState);
    }

    replaceState(rawState: PushState) {
        if (rawState.state !== this.raw.state) {
            const viewState = JSON.parse(rawState.state || "{}");
            // Don't replace a file with an empty in the history
            if (viewState.type === "empty") return true;
            // File is different from existing file: should be a push instead
            if (this.path && this.path !== viewState?.state?.file) return false;
            if (viewState.type === "media-view") {
                const oldInfo = JSON.stringify(this.viewState.state.info);
                const newInfo = JSON.stringify(viewState.state.info);
                if (oldInfo !== newInfo) return false;
            }
        }
        this.setState(rawState);
        return true;
    }
}

interface SerializableHistory {
    pos: number
    stack: PushState[]
}

export class History {
    static current() {
        return this.forLeaf(app.workspace.activeLeaf) || new this();
    }

    static forLeaf(leaf: WorkspaceLeaf) {
        if (leaf) domLeaves.set(leaf.containerEl, leaf);
        if (leaf) return leaf[HIST_ATTR] instanceof this ?
            leaf[HIST_ATTR] :
            leaf[HIST_ATTR] = new this(leaf, leaf[HIST_ATTR]?.serialize() || undefined);
    }

    pos: number
    stack: HistoryEntry[]

    constructor(public leaf?: WorkspaceLeaf, {pos, stack}: SerializableHistory = {pos:0, stack:[]}) {
        this.leaf = leaf;
        this.pos = pos;
        this.stack = stack.map(raw => new HistoryEntry(raw));
    }

    cloneTo(leaf: WorkspaceLeaf) {
        return leaf[HIST_ATTR] = new History(leaf, this.serialize());
    }

    onRename(file: TAbstractFile, oldPath: string) {
        for(const histEntry of this.stack) histEntry.onRename(file, oldPath);
    }

    serialize(): SerializableHistory { return {pos: this.pos, stack: this.stack.map(e => e.raw)}; }

    get state() { return this.stack[this.pos]?.raw || null; }
    get length() { return this.stack.length; }

    back()    { this.go(-1); }
    forward() { this.go( 1); }

    lookAhead() { return this.stack.slice(0, this.pos).reverse(); }
    lookBehind() { return this.stack.slice(this.pos+1); }

    goto(pos: number): void {
        if (!this.leaf) return;
        if (this.leaf.pinned) return new Notice("Pinned pane: unpin before going forward or back"), undefined;
        if (this.leaf.working) return new Notice("Pane is busy: please wait before navigating further"), undefined;
        pos = this.pos = Math.max(0, Math.min(pos, this.stack.length - 1));
        this.stack[pos]?.go(this.leaf);
        app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
    }

    go(by: number, force?: boolean) {
        if (!this.leaf || !by) return;  // no-op
        // prevent wraparound
        const newPos = Math.max(0, Math.min(this.pos - by, this.stack.length - 1));
        if (force || newPos !== this.pos) {
            this.goto(newPos);
        } else {
            new Notice(`No more ${by < 0 ? "back" : "forward"} history for pane`);
        }
    }

    replaceState(rawState: PushState, title: string, url: string){
        const entry = this.stack[this.pos];
        if (!entry) {
            this.stack[this.pos] = new HistoryEntry(rawState);
        } else if (!entry.replaceState(rawState)) {
            // replaceState was erroneously called with a new file for the same leaf;
            // force a pushState instead (fixes the issue reported here: https://forum.obsidian.md/t/18518)
            this.pushState(rawState, title, url);
        }
    }

    pushState(rawState: PushState, title: string, url: string)   {
        //console.log("pushing", rawState)
        this.stack.splice(0, this.pos, new HistoryEntry(rawState));
        this.pos = 0;
        // Limit "back" to 20
        while (this.stack.length > 20) this.stack.pop();
        app?.workspace?.trigger("pane-relief:update-history", this.leaf, this)
    }
}

export function installHistory(plugin: PaneRelief) {

    // Monkeypatch: include history in leaf serialization (so it's persisted with the workspace)
    // and check for popstate events (to suppress them)
    plugin.register(around(WorkspaceLeaf.prototype, {
        serialize(old) { return function serialize(){
            const result = old.call(this);
            if (this[HIST_ATTR]) result[SERIAL_PROP] = this[HIST_ATTR].serialize();
            return result;
        }},
        setViewState(old) { return function setViewState(vs, es){
            if (vs.popstate && window.event?.type === "popstate") {
                return Promise.resolve();
            }
            return old.call(this, vs, es);
        }}
    }));

    plugin.register(around(app.workspace, {
        // Monkeypatch: load history during leaf load, if present
        deserializeLayout(old) { return async function deserializeLayout(state, ...etc: any[]){
            let result = await old.call(this, state, ...etc);
            if (state.type === "leaf") {
                if (!result) {
                    // Retry loading the pane as an empty
                    state.state.type = 'empty';
                    result = await old.call(this, state, ...etc);
                    if (!result) return result;
                }
                if (state[SERIAL_PROP]) result[HIST_ATTR] = new History(result, state[SERIAL_PROP]);
            }
            return result;
        }},
        // Monkeypatch: keep Obsidian from pushing history in setActiveLeaf
        setActiveLeaf(old) { return function setActiveLeaf(leaf, ...etc) {
            const unsub = around(this, {
                recordHistory(old) { return function (leaf: WorkspaceLeaf, _push: boolean, ...args: any[]) {
                    // Always update state in place
                    return old.call(this, leaf, false, ...args);
                }; }
            });
            try {
                return old.call(this, leaf, ...etc);
            } finally {
                unsub();
            }
        }},
    }));

    // Override default mouse history behavior.  We need this because 1) Electron will use the built-in
    // history object if we don't (instead of our wrapper), and 2) we want the click to apply to the leaf
    // that was under the mouse, rather than whichever leaf was active.
    document.addEventListener("mouseup", historyHandler, true);
    plugin.register(() => {
        document.removeEventListener("mouseup", historyHandler, true);
    });
    function historyHandler(e: MouseEvent) {
        if (e.button !== 3 && e.button !== 4) return;
        e.preventDefault(); e.stopPropagation();  // prevent default behavior
        const target = (e.target as HTMLElement).matchParent(".workspace-leaf");
        if (target && e.type === "mouseup") {
            let leaf = domLeaves.get(target);
            if (!leaf) app.workspace.iterateAllLeaves(l => leaf = (l.containerEl === target) ? l : leaf);
            if (!leaf) return false;
            if (e.button == 3) { History.forLeaf(leaf).back(); }
            if (e.button == 4) { History.forLeaf(leaf).forward(); }
        }
        return false;
    }

    // Proxy the window history with a wrapper that delegates to the active leaf's History object,
    const realHistory = window.history;
    plugin.register(() => (window as any).history = realHistory);
    Object.defineProperty(window, "history", { enumerable: true, configurable: true, writable: true, value: {
        get state()      { return History.current().state; },
        get length()     { return History.current().length; },

        back()    { this.go(-1); },
        forward() { this.go( 1); },
        go(by: number)    { History.current().go(by); },

        replaceState(state: PushState, title: string, url: string){ History.current().replaceState(state, title, url); },
        pushState(state: PushState, title: string, url: string)   { History.current().pushState(state, title, url); },

        get scrollRestoration()    { return realHistory.scrollRestoration; },
        set scrollRestoration(val) { realHistory.scrollRestoration = val; },
    }});

}
