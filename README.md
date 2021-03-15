## Pane Relief: Pane History and Management for Obsidian

This plugin adds per-pane navigation history to [Obsidian.md](https://obsidian.md), along with keyboard commands for jumping to specific panes, or moving them around.  (The plugin's name is a play on the fact that both the standard history and mouse-based pane management mechanisms can be downright "paneful" to work with when you have lots of panes, as is often the case when using the [Sliding Panes plugin](https://github.com/deathau/sliding-panes-obsidian).)

### Per-Pane Navigation History

Normally, Obsidian keeps a single global history for back/forward navigation commands.  This history includes not just how you navigate within each pane, but also your navigation *between* panes.  (Which produces counterintuitive results at times, especially if you've pinned any panes in place, causing *new*, additional panes to be split off when you go "back" or "forward"!)

Pane Relief fixes these problems by giving each pane its own unique back/forward history, just like the tabs in a browser.  Going back or forward affects *only* that pane, and no other.  If a pane is pinned, a notice is displayed telling you to unpin if you want to go forward or back, instead of opening a new pane.  (Messages are also displayed if you try to go further "back" or "forward" than existing history for the pane.)

In addition, Pane Relief captures the fourth and fifth mouse buttons ("back" and "forward") and applies the navigation to the pane (if any) where the mouse was pointing when those buttons were clicked.

Last, but far from least, Pane Relief saves each pane's history not only across Obsidian restarts, but *also* saves and loads the history along with workspace layouts, so if you're using the Obsidian workspaces plugin, your navigation history will not get confused by switching between workspaces.

### Pane Access and Movement Commands

Also similar to browser tabs, Pane Relief provides some keyboard commands for jumping to specific panes and reshuffling them.  Ctrl/Cmd+PageUp and PageDown cycle between panes, while adding Shift swaps the panes themselves (as in Firefox).  Alt+1 through Alt+8 jump to that numbered pane in the workspace, and Alt+9 jumps to the last pane.  Adding Ctrl/Cmd moves the panes to the specified position, instead.

With these commands, you no longer need extreme dexterity to reposition panes when using the [Sliding Panes plugin](https://github.com/deathau/sliding-panes-obsidian): you can simply bump them up or down in the order, or assign them to a specific spot.  And with the numbered positions, you can easily reserve certain panes for specific documents you always need open, and then use the relevant hotkeys to jump directly to them.

To see the full list of commands and view or change their key assignments, visit the Hotkeys section of the Obsidian settings, and then type "pane relief" into the search box.

## Installation

To install the plugin, search for "pane relief" in Obsidian's Community Plugins interface.  Or, if it's not there yet, just visit the [Github releases page](https://github.com/pjeby/pane-relief/releases), download the plugin .zip from the latest release, and unzip it in your vault's `.obsidian/plugins/` directory.

Either way, you can then enable it from the Obsidian "Community Plugins" tab for that vault.

Once enabled, Pane Relief will take over managing history, but will not use or erase Obsidian's builtin history.  Disabling Pane Relief will re-enable the builtin history, but then Pane Relief's own history may be lost if you don't re-enable the plugin before you exit or load a new workspace.  (This is because Pane Relief has to be enabled in order for it to save or load the history when a workspace is saved or loaded.)

If you encounter any problems with the plugin, please file bug reports to this repository rather than using the Obsidian forums: I don't check the forums every day (or even every week!) but I do receive email notices from Github and will get back to you much faster than I will see forum comments.

### Known Issues/Current Limitations

#### Linked Panes

The history management doesn't have any special handling for linked panes, and so may produce counterintuitive results.  For example, going "back" in one pane may cause linked panes to treat that movement as if it were "forward", in the sense of adding the back target as a new history entry.  This may or may not be better than what Obsidian's built-in history does, but I'm open to feedback or suggestions for better ways to handle things.  (Especially if they can actually be implemented, technically speaking.)

#### Renames and Deletes

If you rename or delete a note that's in the history for a pane, then going backward or forward to that point will not find the file, and will give you a "No file open" message instead.  This is consistent with Obsidian's built-in history management, but might be (somewhat) fixable in a future release, at least for the history of the currently-loaded workspace.  (There isn't really a way to update the history in saved workspaces, however.)