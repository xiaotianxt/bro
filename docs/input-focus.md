# Input without changing user focus

Introduced in v1.1.2. Server tool descriptions and extension must be upgraded together.

## Contract

Ref clicks, ref scrolling and `computer` input no longer select the target tab,
focus its window or call `Page.bringToFront`. They use a scoped
`Emulation.setFocusEmulationEnabled` call to allow hidden-page rendering and
trusted input, then disable it before returning. Screenshot/zoom do not need
this scope. Form setters and CSS/eval paths retain their existing behavior.

This simulates the page's focus/active state; it is not physical window focus.
Websites can observe changed `document.hasFocus()` and `visibilityState` during
an action. The CDP method is experimental, so unsupported browsers fail rather
than silently switching to foreground input.

Same-tab input scopes are serialized; different tabs remain independent. Cleanup
runs on success or failure. It does not reattach a detached tab. If disabling
emulation fails, bro attempts to detach the debugger and reports the failure;
it never reports successful cleanup when cleanup failed. Debugger detachment
also invalidates frame transport state and any monitors on that attachment.

`tabs_activate` remains the explicit physical foreground operation. Agents may
choose it when genuinely needed (native UI or a foreground-sensitive workflow),
without a mandatory confirmation prompt. Do not use it as routine preparation,
blind error recovery, or a reason to replay an uncertain click. `active:true`
still explicitly selects newly created tabs.

## Why not just remove activation?

Hidden-page `requestAnimationFrame` and scroll-event delivery can stall. Ref
geometry checks and scrolling depend on those signals. A direct background
CDP click succeeding does not prove render-synchronized ref interaction works.
Only removing `windows.update(focused:true)` is insufficient because
`Page.bringToFront` can also focus/restore the window.

Focus emulation addresses that rendering condition without switching the user's
tab. It replaces the unconditional foreground policy, not actionability checks,
ref identity checks, geometry validation, or application postcondition checks.

## Validation and limits

The isolated Chrome-for-Testing 149 experiment exercised inactive tabs,
unfocused windows and minimized windows through `chrome.debugger`. Focus
emulation allowed rendering, trusted click, text insertion and scroll-event
observation without activating the target tab or restoring its minimized window.
This does not establish compatibility with every Chromium version or native UI.

The existing live-ref suite validates cross-site/nested-frame input and background
scrolling. Background-scroll tests now also require the target to return to
`hidden` while the previously selected tab remains active (checked through the tabs API,
not page visibility, which also changes when the OS occludes a window). Unit tests cover
same-tab overlap, failure cleanup, no replay, cleanup rejection/detachment and
no reattachment after a timed-out input.

The consecutive fill/select test initially exposed an existing attachment race:
idle cleanup could detach the debugger while the next request reused its frame
sessions. Attachment now waits for pending detachment, and frame state is
invalidated when detachment starts. Missing-attachment errors invalidate state
without replaying commands. All eleven live-ref contract groups passed after
this lifecycle fix, including background input and visibility restoration.

Use isolated builds from [ref-interaction.md](ref-interaction.md); do not overwrite
the extension directory loaded in the user's daily browser while testing.
