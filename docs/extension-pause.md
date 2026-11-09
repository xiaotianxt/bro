# Cross-extension debugger blocking and temporary pause

## Problem and boundary

A normal web tab can contain another extension's `chrome-extension://` iframe,
including inside a closed shadow root. 1Password 8 draws its inline menu, save
prompt, modal and universal sign-on UI this way (`com-1password-menu`,
`-notification`, `-modal`, `-uso`), at load on some login pages and on field
focus on others. Chromium then:

- rejects `chrome.debugger.attach` with
  `Cannot access a chrome-extension:// URL of different extension`;
- closes a live session (`onDetach` reason `target_closed`, or commands failing
  with the same access error) the moment such a frame is created, even when
  the iframe is removed in the next microtask.

The attach check reads committed frame URLs, so an attach can also succeed
while the frame is still loading and then be closed when it commits. Hiding
the iframe does not help, and disabling the extension does not remove a frame
it already injected: until now the only recovery was pausing the extension and
reloading the page.

## Page-local removal (automatic)

`foreign-frames.ts` removes other extensions' iframes from every frame of the
tab, searching closed shadow roots through `chrome.dom.openOrClosedShadowRoot`,
and **leaves their host elements in place**. 1Password keeps its iframe element
and reuses it, so its later redraws in the same document set `src` on a
detached iframe and create no frame: the session stays attached while the
agent clicks and types into login fields. Removing the host instead would make
1Password re-add it with the iframe inside, closing the session again.

`CDPSession.attach` runs the removal when attach is rejected for this reason
and retries once. A tab where such a frame rejected or closed a session is
remembered, and later attaches to it remove frames first, which also catches
frames that have not committed yet. Commands failing because Chrome closed the
session raise `CdpSessionClosed` with a hint, and are never replayed. Navigation
treats a session closed after commit as unfinished readiness: it reattaches and
confirms the same loader's document is ready.

Effects and limits:

- Nothing is disabled or reloaded, and no other tab changes. The extension
  keeps working elsewhere; reloading or navigating the page restores its
  in-page UI there. While bro drives a tab, that UI stays gone from that page.
- An extension that recreates its iframe on every draw closes the session on
  each draw; bro reattaches on the next call but cannot keep a long-lived
  monitor attached through it.
- Frames bro cannot script, or extension frames navigated without a
  `chrome-extension://` `src`, still fail attach with `[CDP_FOREIGN_EXTENSION]`
  and the recovery guidance below.

## Agent recovery guidance

When the automatic removal could not clear the blocker, the attach boundary
preserves the browser's original error and appends `[CDP_FOREIGN_EXTENSION]`
with recovery guidance. Unrelated failures (another debugger attached, missing
tab, etc.) are unchanged. No automatic pause, reload or input replay happens.

In Pi, search `CDP extension recovery` with `bro_search_tools` to discover the
complete `extensions` capability pack: diagnosis, status, pause, and resume.
The error also names upstream tools for non-Pi callers. Diagnosis is not proof
that an installed extension is the culprit. If login needs a password manager,
keep it enabled and complete the authorized login with user/native UI before
resuming bro. Otherwise, only explicit authorization for the exact extension
and profile-wide impact permits a pause. Always restore and verify afterward;
expiry is a backstop rather than the normal cleanup path.

An older server may not expose the tools even with the new extension. The error
provides a Settings-page fallback and advises upgrading the matching components.
Do not invent unavailable tools or interpret that mismatch as a reason to loop.

## Explicit diagnostic

`debugger_diagnose {browserId, tabId}` uses `webNavigation.getAllFrames`, not CDP.
It returns frame origins and foreign extension IDs when the browser exposes
them. It never returns paths, query strings, page contents or credentials.
These numeric frame IDs are **not** bro's CDP frame refs.

The inventory is best-effort. In the isolated Chromium fixture, the API returned
an empty array while a protected iframe was demonstrably blocking attachment.
An empty result is marked inconclusive; it is not a clean bill of health and
cannot identify the responsible extension. The exact attach error and a
controlled enable/disable comparison remain important evidence.

## Explicit pause

The extension now requires the `management` permission. Browser reapproval may
be necessary on reload/update. This is broad authority over other extensions,
not a tab-scoped host permission. There is no automatic pause on attach failure;
page-local removal makes a pause unnecessary for 1Password's in-page UI.

Use the **Temporary extension pause** section of bro Settings, or:

1. `extensions_status {browserId}` — inspect exact IDs and outstanding recovery.
2. `extensions_pause {browserId, extensionId, confirmProfileWide:true,
   durationSeconds:300}` — only after explicit user authorization. Range: 30–900
   seconds; the Settings button uses five minutes.
3. Run the authorized task. bro removes iframes the paused extension already
   injected on its next attach; it never refreshes pages.
4. `extensions_resume {browserId, resumeToken}` — use the returned ownership
   token. The outcome is `enabled` or `uninstalled`, not an unverified success.
5. Verify the actual page/task result separately from extension enabled state.

Only one pause may be outstanding per profile. Overlapping pauses are rejected,
not silently shared or extended. Bro cannot pause itself, an already-disabled
extension, or a policy-protected extension. Tokens prevent accidentally ending
a different pause; they are not an authorization/security boundary. Status
exposes the outstanding token for recovery after a disconnected client.

## Recovery and visible state

Before disabling, bro stores a restoration journal and schedules a persistent
alarm. It verifies disable and re-enable results. Worker startup reconciles the
journal, recreates an unexpired alarm without extending its deadline, and
restores overdue pauses. Partial disable failures trigger verified rollback.
A confirmed uninstall clears the journal without reinstalling anything.

The toolbar shows `PAUSE`, and Settings shows the outstanding extension,
deadline, explicit restore button, and restoration failure. Settings uses the
same worker-owned serialized operations as MCP, not an independent state writer.
Its control message is accepted only from bro's own options page.

Alarms are best-effort, not a guarantee while the browser is closed or bro is
disabled/uninstalled. Policies, permission changes, or a user-gesture requirement
can block re-enable. In that case the journal/error remains visible; there is no
silent retry loop. Enable the target manually in `chrome://extensions`, then
click Restore or call `extensions_resume` to reconcile. If bro itself is gone,
use the browser's extension manager directly.

## Verification

- Unit tests cover restoration ordering, ownership, pre-disabled targets,
  interrupted disable, alarm failure, expired recovery, blocked restoration,
  uninstall during pause, confirmation, and origin-only diagnostics; attach
  retry after removal, guidance when nothing was removable, and navigation that
  finishes after its new document closed the session.
- `make live-refs CHECKS="password manager"` loads a fixture extension shaped
  like 1Password (closed shadow host, reused iframe, drawn at load and on focus,
  erased on blur) and logs in through `navigate`, `find` and `computer` clicks
  and typing in one tab. With the removal disabled the same check fails.
- `scripts/live-extension-pause.mjs` (disposable profile, credential-free
  fixture) verifies removal without pause, pause/resume, removal after
  re-injection, alarm restoration and Settings recovery state.

```
pnpm --filter @bro/extension exec vite build --outDir "$TMPDIR/bro-pause-build"
cargo build
node scripts/live-extension-pause.mjs "$TMPDIR/bro-pause-build" "$CHROME_BIN"
```

Fixtures do not establish that every 1Password version behaves identically;
verify the real profile after loading the extension.

### Real-profile verification before page-local removal: Helium 155

After the user reloaded the development extension, its live Settings page
confirmed the new UI and `management` permission. A newly opened background
Google AddSession tab produced this controlled sequence:

1. 1Password enabled: attach rejected with the cross-extension URL error.
2. Paused through the Settings page's worker control message: disabling was
   verified, but the existing tab still rejected attach without navigation.
3. Navigated only the disposable test tab to the same login entry: attach and
   origin-only evaluation succeeded.
4. Explicitly resumed 1Password: outcome `enabled`, management state verified
   `enabled:true`, recovery journal cleared, and Settings reflected no pause.
5. Navigated the test tab again: the same attach rejection returned.

Both task-owned tabs were then closed. No credentials were read or entered.
This establishes the workaround for this real profile and confirms that pausing
alone did not remove the already-injected blocker. Never silently refresh user
work to obtain the same result. This check used the Settings worker channel;
production MCP discovery still requires the matching server release.

