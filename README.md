## Pane Relief: Pane History and Management for Obsidian

This plugin helps relieve the "pane" of managing lots of panes in [Obsidian.md](https://obsidian.md) (especially when using the keyboard), by providing features such as:

- Browser-like per-pane navigation history (complete with forward/back lists)
- Commands to move between panes or windows, move panes around, jump to the Nth pane, etc.
- An intelligent pane maximizing command
- Optional [per-pane navigation buttons](#per-pane-navigation-buttons) and [pane numbering](#pane-numbering)

The overall goal of these features is to provide a more browser-like Obsidian experience for users that like using lots of panes, windows, and/or Hover Editors.

(Note: this plugin adds a lot of preconfigured hotkeys.  You may want to install the [Hotkey Helper](https://obsidian.md/plugins?id=hotkey-helper) plugin first, so you can easily see and resolve any conflicts, or update the keys to better suit your preferences.)

### Per-Pane Navigation History

Normally, Obsidian keeps a single global history for back/forward navigation commands.  This history includes not just how you navigate within each pane, but also your navigation *between* panes.  (Which produces counterintuitive results at times, especially if you've pinned any panes in place, causing *new*, additional panes to be split off when you go "back" or "forward"!)

Pane Relief fixes these problems by giving each pane its own unique back/forward history, just like the tabs in a browser.  Going back or forward affects *only* that pane, and no other.  If a pane is pinned, a notice is displayed telling you to unpin if you want to go forward or back, instead of opening a new pane.  (Messages are also displayed if you try to go further "back" or "forward" than existing history for the pane.)

In addition, Pane Relief captures the fourth and fifth mouse buttons ("back" and "forward") and applies the navigation to the pane (if any) where the mouse was pointing when those buttons were clicked.

Plus, Pane Relief augments the Obsidian forward/back buttons found in the titlebar, giving them counts to show how far "back" or "forward" you can go in the current pane.  And, as in a normal browser, you can right-click those arrows to show a list of pages you can click to directly navigate to, without losing your history position.

The pages shown in the list can be:

- Previewed for quick reference (by holding Ctrl or Cmd while hovering),
- Dragged from the menu and dropped elsewhere to create a link or move the file
- Clicked to navigate to that position in history (without losing your place),
- Ctrl/Cmd clicked to open a new pane *with duplicated history* at that point in the navigation (similar to doing the same thing in Chrome or Firefox)
- Right-clicked to open a file context menu to perform actions directly on the file

Last, but far from least, Pane Relief saves each pane's history not only across Obsidian restarts, but *also* saves and loads the history along with workspace layouts, so if you're using the Obsidian workspaces plugin, your navigation history will not get confused by switching between workspaces.  (And it even works with Obsidian 0.15.3+'s multiple desktop windows feature.)

### Pane Access and Movement Commands

Also similar to browser tabs, Pane Relief provides some keyboard commands for jumping to specific panes and reshuffling them.  Ctrl/Cmd+PageUp and PageDown cycle between panes, while adding Shift swaps the panes themselves (as in Firefox).  Alt+1 through Alt+8 jump to that numbered pane in the workspace, and Alt+9 jumps to the last pane.  Adding Ctrl/Cmd moves the panes to the specified position, instead.

With these commands, you no longer need extreme dexterity to reposition panes when using the [Sliding Panes plugin](https://github.com/deathau/sliding-panes-obsidian): you can simply bump them up or down in the order, or assign them to a specific spot.  And with the numbered positions, you can easily reserve certain panes for specific documents you always need open, and then use the relevant hotkeys to jump directly to them.

To see the full list of commands and view or change their key assignments, visit the Hotkeys section of the Obsidian settings, and then type "pane relief" into the search box.

> New in 0.1.2: There are now commands for navigating between popout windows in Obsidian 0.15.3+, and you can also configure hotkeys to jump to the Nth window.  These commands do not have hotkeys assigned by default, however: you must manually define your own.

### Maximize Active Pane

As of version 0.1.6, Pane Relief also includes a "Maximize Active Pane" command that is compatible with the Hover Editor plugin and the popout windows of Obsidian 0.15.3+.  If you were previously using the "Maximize Active Pane" plugin, you may wish to switch to disable that plugin and assign the hotkey to Pane Relief's version instead.

## Installation

To install the plugin, open [Pane Relief](https://obsidian.md/plugins?id=pane-relief) in Obsidian's Community Plugins browser, then select "Install" and "Enable".

Once enabled, Pane Relief will take over managing history, but will not use or erase Obsidian's builtin history.  Disabling Pane Relief will re-enable the builtin history, but then Pane Relief's own history may be lost if you don't re-enable the plugin before you exit or load a new workspace.  (This is because Pane Relief has to be enabled in order for it to save or load the history when a workspace is saved or loaded.)

If you encounter any problems with the plugin, please file bug reports to this repository rather than using the Obsidian forums: I don't check the forums every day (or even every week!) but I do receive email notices from Github and will get back to you much faster than I will see forum comments.

## Styling And Integration

### Per-pane Navigation Buttons

If you'd like to have each pane get its own back/forward buttons with all of Pane Relief's features available, you can install the [Custom Page Headers and Title Bar Buttons](https://obsidian.md/plugins?id=customizable-page-header-buttons) plugin, enable it, and then configure it as follows:

1. Turn on "Show buttons on desktop"
2. Turn on "Pane Relief count" (optional)
3. Add buttons for "Navigate back" and "Navigate Forward"

Each pane header will then have a back and forward button with counts, titles, and right-click menus with draggable and right-clickable history entries.

### Styling Maximized Panes

Pane Relief uses slightly different CSS classes from the Maximize Active Pane plugin; if you want to e.g. show a border on a maximized work area, the relevant classes are:

- `.should-maximize` appears on the outermost workspace split that contains a maximized pane
- `.has-maximized` appears on every workspace split containing a maximized pane (recursively)
- `.is-maximized` appears on workspace leaves that are maximized

Note: these classes don't apply to hover editors with just a single pane, but if you split a hover editor into multiple panes and maximize one, they will apply within that hover editor.

### Pane Numbering

To support theming and CSS snippets that may want to show pane shortcut position numbers, Pane Relief adds a class (`.has-pane-relief-label`) and a variable (`--pane-relief-label`) to the first 8 (and last) workspace leaves.  The variable gives a number that can be used with `counter-reset` and `content` to label the panes using appropriate CSS.  Here's a short CSS snippet that puts the numbers in the pane headers, and works reasonably well with the Sliding Panes plugin:

```css
/* Number panes in their headers */
.workspace-split.mod-root .workspace-leaf .view-header-icon::before {
    content: "";
    display: inline-flex;
    position: relative;
    bottom: 3px;
    min-inline-size: 1em;
}

.workspace-split.mod-root .workspace-leaf.has-pane-relief-label .view-header-icon::before {
    counter-reset: pane-number var(--pane-relief-label);
    content: counter(pane-number);
}
```

### Known Issues/Current Limitations

#### Linked Panes

The history management doesn't have any special handling for linked panes, and so may produce counterintuitive results.  For example, going "back" in one pane may cause linked panes to treat that movement as if it were "forward", in the sense of adding the back target as a new history entry.  This may or may not be better than what Obsidian's built-in history does, but I'm open to feedback or suggestions for better ways to handle things.  (Especially if they can actually be implemented, technically speaking.)

#### Renames and Deletes

If you rename or delete a note that's in the history for a pane, then going backward or forward to that point may not find the file, and will give you a "No file open" message instead.