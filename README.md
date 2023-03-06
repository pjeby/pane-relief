## Pane Relief: Tab History Enhancements and Pane Management for Obsidian

> Note: this documentation uses the new Obsidan 1.0 terminology of "tabs" and "groups" replacing "panes" and "splits".  If you're not using Obsidian 1.0 yet, [please use the older documentation](https://github.com/pjeby/pane-relief/blob/0.3.3/README.md).

This plugin helps relieve the "pane" of managing lots of panes and tabs in [Obsidian.md](https://obsidian.md) (especially when using the keyboard), by providing features such as:

- Enhanced, persistent per-tab navigation history
- Commands to move between tabs or windows, move tabs around, etc.
- An intelligent [tab maximizing command](#maximize-active-tab)
- [Focus lock](#focus-lock), to stop sidebar panes stealing focus
- A browser-style "close" command that activates an adjacent tab instead of the most-recently used one
- A [Simple Sliding Panes mode](#simple-sliding-panes-mode) that can be toggled per-window and is compatible with Obsidian 1.0 stacked tabs (NEW in 0.3.1)

The overall goal of these features is to provide a more browser-like Obsidian experience for users that like using lots of tabs, panes, windows, and/or Hover Editors.

(Note: this plugin adds a lot of preconfigured hotkeys.  You may want to install the [Hotkey Helper](https://obsidian.md/plugins?id=hotkey-helper) plugin first, so you can easily see and resolve any conflicts, update the keys to better suit your preferences, and assign hotkeys for the commands that don't have a default.)

### Per-Tab History Enhancements

Pane Relief adds several enhancements to Obsidian 1.0's built-in history:

- History is saved across restarts for all tabs in all windows (and is also saved with any workspaces you're using with the Workspaces plugin)
- History arrows in the tab title bar show counts of how many items are in the forward or back history
- History arrows, when hovered, show what you'd be navigating forward or back *to*
- You can use the fourth and fifth mouse buttons ("back" and "forward") to click on any tab and navigate that specific tab forward or back (Obsidian by default navigates the currently-active tab, not the tab you click on.)

Right-clicking the navigation arrows also gives you a list of pages to go forward or back to, that can be:

- Previewed for quick reference (by holding Ctrl or Cmd while hovering),
- Dragged from the menu and dropped elsewhere to create a link or move the file
- Clicked to navigate to that position in history (without losing your place),
- Ctrl/Cmd clicked to open a new tab *with duplicated history* at that point in the navigation (similar to doing the same thing in Chrome or Firefox)
    - (You can also use standard Obsidian modifier keys to open the new tab in a new group (Ctrl/Cmd+Alt) or window (Ctrl/Cmd+Alt+Shift)
- Right-clicked to open a file context menu to perform actions directly on the file

### Tab Access and Movement Commands

Also similar to browser tabs, Pane Relief provides some keyboard commands for jumping to specific tabs and reshuffling them.  Ctrl/Cmd+PageUp and PageDown cycle between panes, while adding Shift swaps the tabs themselves (as in Firefox).  Alt+1 through Alt+8 jump to that numbered pane in the workspace, and Alt+9 jumps to the last pane.  Adding Ctrl/Cmd moves the panes to the specified position, instead.

With these commands, you no longer need extreme dexterity to reposition tabs when stacking or sliding them: you can simply bump them up or down in the order, or assign them to a specific spot.  And with the numbered positions, you can easily reserve certain tabs for specific documents you always need open, and then use the relevant hotkeys to jump directly to them.

To see the full list of commands and view or change their key assignments, visit the Hotkeys section of the Obsidian settings, and then type "pane relief" into the search box.

> New in 0.1.2: There are now commands for navigating between popout windows in Obsidian 0.15.3+, and you can also configure hotkeys to jump to the Nth window.  These commands do not have hotkeys assigned by default, however: you must manually define your own.

### Maximize Active Tab

As of version 0.1.6, Pane Relief also includes a "Maximize Active Tab" command that is compatible with the Hover Editor plugin and the popout windows of Obsidian 0.15.3+.  If you were previously using the "Maximize Active Pane" plugin, you may wish to switch to disable that plugin and assign the hotkey to Pane Relief's version instead.

### Simple Sliding Panes Mode

As of version 0.3.0, Pane Relief includes a "Toggle sliding panes" command that lets you make each window's workspace horizontally scrollable with fixed-width panes, instead of a limited width divided between them.  This is similar to the "classic" Sliding Panes plugin, but without the stacking and header rotation that are now supplied natively by Obsidian 0.16.2.  Sliding can be toggled on or off on a per-window basis, and the state is saved across Obsidian restarts and workspace save/load.

By default, panes will be 700px wide, but if you use the Style Settings plugin you can configure the width to any CSS value.  If you are using Obsidian 0.16.2's "stacked tabs", the width of the tab headers will be added to this value, so that your available space in each pane won't shrink as you add more tabs.  (This can be useful even if you don't create multiple panes or tab groups!)  This feature should be considered beta, however, and scrolling may be jumpy or require manual adjustment if a given stacked tab set does not fit the application window.

Please note that if you are migrating from the standalone Sliding Panes plugin, you must both *disable* it (not just turn off sliding panes!) **and** restart Obsidian before trying to use Pane Relief's sliding panes (or Obsidian's stacked tabs, for that matter).  This is because the Sliding Panes plugin does not properly uninstall all of its hooks when disabled, and it will interfere with Pane Relief's sliding panes if left active.

### Focus Lock

As of version 0.2.1, Pane Relief allows you to block sidebar tabs from receiving focus (and thereby stealing keystrokes or opening links in the wrong pane(s)), using its focus lock function.  If you are on Obsidian 0.15.6 or above, a clickable lock symbol appears in the status bar, and a keyboard command is also available to toggle the feature on and off (in case you want to edit a note in your sidebar, use keyboard navigation in the file explorer, etc.)

The toggle's current state is saved with your workspace, so it persists across Obsidian restarts, and if you're using Workspaces or Workspaces Plus, each workspace can have a different state.  (Focus lock will default to "off" in new workspaces, so if you want it on in your current workspaces you will have to turn it on in each one the first time.)

## Installation

To install the plugin, open [Pane Relief](https://obsidian.md/plugins?id=pane-relief) in Obsidian's Community Plugins browser, then select "Install" and "Enable".

Pane Relief must be enabled to handle saving and restoring history, or workspace settings like whether focus lock or sliding panes are enabled.  So disabling it may lose stored history or these settings, if you don't re-enable the plugin before you exit or load a new workspace.  (Note: if you are using a hack to delay plugins loading at Obsidian start, you *must* ensure that Pane Relief loads *before* the workspace, or it will not be able to load its settings.)

If you encounter any problems with the plugin, please file bug reports to this repository rather than using the Obsidian forums: I don't check the forums every day (or even every week!) but I do receive email notices from Github and will get back to you much faster than I will see forum comments.

## Styling And Integration

### Style Settings

Two commonly requested style features are 1) disabling history counts on the titlebar arrows, and 2) adding numbers to panes.  These options are now available via the [Style Settings plugin](https://obsidian.md/plugins?id=obsidian-style-settings) -- just install it and go to its settings: there will be toggles for "Disable history counts" and "Number panes".

### Centralized Tab Lists

Two other plugins that work well with Pane Relief for navigating between tabs are [Quick Switcher++](https://obsidian.md/plugins?id=darlal-switcher-plus) and [Koncham Workspace](https://obsidian.md/plugins?id=koncham-workspace).  Quick Switcher++ lets you assign a hotkey to pop up a list of open notes and jump directly to the applicable tab (even across multiple windows or hover editors), and Koncham Workspace lets you have a sidebar tab listing the contents of all your main window's center area panes and hover editors (that you can click to jump to).

### Per-pane Navigation Buttons

If you'd like to have each pane get its own back/forward buttons with all of Pane Relief's features available, you can install the [Custom Page Headers and Title Bar Buttons](https://obsidian.md/plugins?id=customizable-page-header-buttons) plugin, enable it, and then configure it as follows:

1. Turn on "Show buttons on desktop"
2. Turn on "Pane Relief count" (optional)
3. Add buttons for "Navigate back" and "Navigate Forward"

Each tab title header will then have a back and forward button with counts, titles, and right-click menus with draggable and right-clickable history entries.  (In Obsidian 0.16 and higher, you need to enable "Show tab title bar" in Settings > Appearance > Advanced for this to be visible.)

### Styling Maximized Tabs

Pane Relief uses slightly different CSS classes from the Maximize Active Pane plugin; if you want to e.g. show a border on a maximized work area, the relevant classes are:

- `.should-maximize` appears on the outermost workspace split that contains a maximized pane
- `.has-maximized` appears on every workspace split containing a maximized pane (recursively)
- `.is-maximized` appears on workspace leaves that are maximized

Note: these classes don't apply to hover editors with just a single pane, but if you split a hover editor into multiple panes and maximize one, they will apply within that hover editor.

### Tab Numbering

If you install the Style Settings plugin, you can turn on Pane Relief tab numbering in its options page.  If turned on, it will show tab title bars r

But for custom theming and CSS snippets that may want to show pane shortcut position numbers, Pane Relief adds a class (`.has-pane-relief-label`) and a variable (`--pane-relief-label`) to the first 8 (and last) workspace leaves.  The variable gives a number that can be used with `counter-reset` and `content` to label the tabs using appropriate CSS.  Here's a short CSS snippet that puts the numbers in the tab title headers (which you have to have enabled for this to work):

```css
/* Number panes in their headers */
.workspace-split.mod-root .workspace-leaf .view-header-icon::before {
    content: "";
    display: inline-flex;
    position: relative;
    bottom: 0px;
    min-inline-size: 1em;
}

.workspace-split.mod-root .workspace-leaf.has-pane-relief-label .view-header-icon::before {
    counter-reset: pane-number var(--pane-relief-label);
    content: counter(pane-number);
}
```

