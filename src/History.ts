import {HistoryState, Notice, requireApiVersion, TAbstractFile, WorkspaceLeaf} from 'obsidian';
import {around} from "monkey-around";
import {LayoutStorage, Service, windowEvent} from "@ophidian/core";
import { leafName } from './pane-relief';
import { formatState } from './Navigator';

const HIST_ATTR = "pane-relief:history-v1";
const SERIAL_PROP = "pane-relief:history-v1";
export const hasTabHistory = requireApiVersion("0.16.3");

declare module "obsidian" {
    interface Workspace {
        deserializeLayout(state: any, ...etc: any[]): Promise<WorkspaceItem>
    }

    interface WorkspaceLeaf {
        [HIST_ATTR]: History
        history?: LeafHistory
        pinned: boolean
        working: boolean
        serialize(): any
    }

    interface SerializedHistory {
        backHistory: HistoryState[]
        forwardHistory: HistoryState[]
    }

    interface LeafHistory extends SerializedHistory {
        go(offset: number): Promise<void>;
        deserialize(state: SerializedHistory): void;
    }

    interface HistoryState {
        title: string,
        icon: string,
        state: ViewState
        eState: any
    }

    interface ViewState {
        popstate?: boolean
    }
}


export const domLeaves = new WeakMap();

interface PushState {
    state: string
    eState: string
    title: string
    icon: string
}

export class HistoryEntry {

    raw: PushState
    eState: any
    path: string

    constructor(rawState: PushState) {
        this.setState(rawState);
    }

    static fromNative(state: HistoryState) {
        return new this({...state,
            state:  JSON.stringify(state.state),
            eState: JSON.stringify(state.eState),
        });
    }

    get asNative() {
        const state = {...this.raw, state: this.viewState, eState: this.eState};
        if (!state.title || !state.icon) {
            const info = formatState(this);
            state.title ||= (info.title || "");
            state.icon  ||= (info.icon  || "");
        }
        return state;
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

    isEmpty() {
        const viewState = JSON.parse(this.raw.state || "{}");
        return (viewState.type === "empty");
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
        if (leaf) {
            const old = leaf[HIST_ATTR] as any;
            // Already cached?  Return it
            if (old instanceof this) return old;
            if (old && !old.hadTabs) {
                // Try to re-use previous plugin version's state if it wasn't on 0.16.3+
                // This will let people who upgrade to 0.16.3 keep their previous history
                // if they don't update Pane Relief ahead of time
                const oldState: SerializableHistory = old?.serialize() || undefined;
                return new this(leaf, oldState).saveToNative();
            }
            // Either a new install or an update/reload on 0.16.3, get the current state
            return new this(leaf).loadFromNative();
        }
    }

    pos: number
    stack: HistoryEntry[]
    hadTabs = hasTabHistory;

    constructor(public leaf?: WorkspaceLeaf, {pos, stack}: SerializableHistory = {pos:0, stack:[]}) {
        if (leaf) leaf[HIST_ATTR] = this;   // prevent recursive lookups
        this.leaf = leaf;
        this.pos = pos;
        this.stack = stack.map(raw => new HistoryEntry(raw));
    }

    saveToNative(): this {
        const nativeHistory = this.leaf?.history;
        if (!nativeHistory || !hasTabHistory) return this;
        const stack = this.stack.map(entry => entry.asNative);
        nativeHistory.deserialize({
            backHistory: stack.slice(this.pos+1).reverse(),
            forwardHistory: stack.slice(0, this.pos),
        })
        return this;
    }

    loadFromNative(): this {
        const history = this.leaf?.history;
        if (!history || !hasTabHistory) return this;
        const stack: typeof history.backHistory = [].concat(
            history.forwardHistory.slice().filter(s => s),
            {state: {}, eState: {}},
            history.backHistory.slice().filter(s => s).reverse()
        );
        this.stack = stack.map(e => HistoryEntry.fromNative(e));
        this.pos = history.forwardHistory.length;
        return this;
    }

    cloneTo(leaf: WorkspaceLeaf) {
        return new History(leaf, this.serialize()).saveToNative();
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

    announce() {
        app?.workspace?.trigger("pane-relief:update-history", this.leaf, this);
    }

    goto(pos: number): void {
        if (!this.leaf) return;
        if (this.leaf.pinned) return new Notice(`Pinned ${leafName}: unpin before going forward or back`), undefined;
        if (this.leaf.working) return new Notice("Pane is busy: please wait before navigating further"), undefined;
        pos = this.pos = Math.max(0, Math.min(pos, this.stack.length - 1));
        this.stack[pos]?.go(this.leaf);
        this.announce();
    }

    go(by: number, force?: boolean) {
        if (!this.leaf || !by) return;  // no-op
        // prevent wraparound
        const newPos = Math.max(0, Math.min(this.pos - by, this.stack.length - 1));
        if (force || newPos !== this.pos) {
            if (this.leaf.history && hasTabHistory) {
                this.pos = newPos;
                this.leaf.history.go(by);
            } else this.goto(newPos);
        } else {
            new Notice(`No more ${by < 0 ? "back" : "forward"} history for ${leafName}`);
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
        const entry = this.stack[this.pos];
        if (entry && entry.isEmpty()) return this.replaceState(rawState, title, url);
        this.stack.splice(0, this.pos, new HistoryEntry(rawState));
        this.pos = 0;
        // Limit "back" to 20
        while (this.stack.length > 20) this.stack.pop();
        this.announce();
    }
}

export class HistoryManager extends Service {
    onload() {
        const store = this.use(LayoutStorage);

        this.registerEvent(store.onSaveItem((item, state) => {
            if (item instanceof WorkspaceLeaf && item[HIST_ATTR]) {
                state[SERIAL_PROP] = item[HIST_ATTR].serialize();
            }
        }));

        this.registerEvent(store.onLoadItem((item, state) => {
            if (item instanceof WorkspaceLeaf && state && state[SERIAL_PROP]) {
                new History(item, state[SERIAL_PROP]).saveToNative();
            }
        }));

        if (hasTabHistory) {
            // Forward native tab history events to our own implementation
            this.register(around(WorkspaceLeaf.prototype, {
                trigger(old) { return function trigger(name, ...data) {
                    if (name === "history-change") {
                        const history = History.forLeaf(this)
                        history.loadFromNative();
                        app.workspace.trigger("pane-relief:update-history", this, history);
                    }
                    return old.call(this, name, ...data);
                }; }
            }));

            // Incorporate any prior history state (e.g. on plugin update)
            if (app.workspace.layoutReady) app.workspace.iterateAllLeaves(leaf => { History.forLeaf(leaf); })

            // Skip most actual history replacement if native history is tab-based
            return;
        }

        // Monkeypatch: check for popstate events (to suppress them)
        this.register(around(WorkspaceLeaf.prototype, {
            setViewState(old) { return function setViewState(vs, es){
                if (vs.popstate && window.event?.type === "popstate") {
                    return Promise.resolve();
                }
                return old.call(this, vs, es);
            }}
        }));

        this.register(around(app.workspace, {
        // Monkeypatch: keep Obsidian from pushing history in setActiveLeaf
            setActiveLeaf(old) { return function setActiveLeaf(leaf, ...etc: any[]) {
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

        function isSyntheticHistoryEvent(button: number) {
            return !!windowEvent((_, event) => {
                if (event.type === "mousedown" && (event as MouseEvent).button === button) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return true;
                }
            });
        }

        // Proxy the window history with a wrapper that delegates to the active leaf's History object,
        const realHistory = window.history;
        this.register(() => (window as any).history = realHistory);
        Object.defineProperty(window, "history", { enumerable: true, configurable: true, writable: true, value: {
            get state()      { return History.current().state; },
            get length()     { return History.current().length; },

            back()    { if (!isSyntheticHistoryEvent(3)) this.go(-1); },
            forward() { if (!isSyntheticHistoryEvent(4)) this.go( 1); },
            go(by: number)    { History.current().go(by); },

            replaceState(state: PushState, title: string, url: string){ History.current().replaceState(state, title, url); },
            pushState(state: PushState, title: string, url: string)   { History.current().pushState(state, title, url); },

            get scrollRestoration()    { return realHistory.scrollRestoration; },
            set scrollRestoration(val) { realHistory.scrollRestoration = val; },
        }});
    }
}
