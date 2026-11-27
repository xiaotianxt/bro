# Changelog

## 2.3.1

- `tabs_context` with `all: true` lists the tabs of every window, tagged
  `anchor`, `incognito`, `focused` or the window type, each with its own active
  tab marked. Before, it listed only the anchor tab's window, so tabs in other
  windows, incognito ones included, were invisible. The anchor window comes
  first and keeps the `Active tab` line.
- Clicks no longer slow down when many bro tabs sit in the background: the
  render pump captures at most two background tabs at a time instead of all of
  them at once, which had made a click wait up to a second for its frame.
- Overlapping screenshots of one tab no longer leave its page shrunk to half
  size; captures of a tab run one at a time.

## 2.3.0

- `bro setup` installs everything in one command and can be rerun: it starts
  the background service (Homebrew services, a launchd agent or a systemd user
  unit, restarted when its version differs), installs the extension, configures
  the MCP clients it finds (Codex, Claude Code, Claude Desktop, Cursor), opens
  the extensions page and waits for the extension to connect. `bro setup codex`
  and `bro setup browser` still work on their own.
- The extension pairs itself: `bro setup` registers bro as a native messaging
  host for every installed Chromium-family browser, and the extension asks it
  for the local token instead of the user pasting it. It asks again when the
  server refuses its token. A pasted token still works.
- The extension's ID is pinned by a manifest key, and a packaged install loads
  it from `~/.bro/extension`, which `bro serve` refreshes after an upgrade; the
  extension reloads itself when the version on disk changes. Before, the folder
  setup showed could be Homebrew's versioned `Cellar` path, which the next
  upgrade deleted. An extension loaded the old way keeps working until it is
  replaced, which `bro setup` suggests. The Chrome Web Store copy, which has
  its own ID, pairs the same way. The new ID starts with empty storage:
  copy user scripts from the old extension's Options page before removing it.
- `bro mcp` serves MCP over stdio by relaying to the local service, so a client
  config needs only `bro mcp`, with no token. When the service restarts, it
  replays the client's handshake on a new session and retries, so the client
  does not notice.
- `install.sh` installs bro without Homebrew on macOS and Linux to fixed paths
  (`~/.local/bin/bro`, `~/.local/share/bro/extension`), checks the release
  checksum, and runs `bro setup`.
- A tool call made right after the extension connected could fail with "no
  browser extension is connected": the server acknowledged the connection
  before registering it.
- macOS release binaries are signed with one self-signed certificate under a
  fixed designated requirement, so macOS keeps permissions across upgrades.
- The extension drops the unused `activeTab`, `notifications`, `downloads` and
  `offscreen` permissions and gains `nativeMessaging`; `PRIVACY.md` states what
  it handles, for the Chrome Web Store listing.
- `/health` reports the server version. The settings file is found through the
  OS home directory, which fixes Windows, where `HOME` is usually unset.

## 2.2.0

- Reading a large page's accessibility tree (such as a 20,000-row list) no
  longer freezes the extension service worker for several seconds or stalls
  concurrent calls on other tabs. Frames above 3,000 DOM elements are read
  incrementally in small chunks until `maxChars` is filled, while still scanning
  trailing landmarks and headings for the truncation outline and supporting
  scoped `refId` reads and `cursor` pagination without losing sections.
  `renderSnapshot` also avoids per-node `Map` and `JSON.stringify` allocations.
- Removed the 5 s session-killing default timeout from CDP commands: a slow
  command no longer detaches the tab's debugger session. Callers that need a
  command bound (`Runtime.evaluate`, input dispatch, and input render-state
  checks) pass an explicit `timeoutMs` without detaching a healthy session.
- Deferred readiness (`browser.open` with `observe: false`) now stops polling
  immediately when the tab is discarded or closed instead of waiting out the
  full 4 s settle window before failing.

## 2.1.0

- `browser.watch` watches a page for a change and reports it without the agent
  polling: text appears or is gone, a pattern matches, an element becomes
  visible, hidden, enabled or disabled, or (streaming) any change of a target's
  text or value and any change in a selector's match count, with the added
  items' text. A start returns a `watchId`; a read returns the events after a
  cursor and long-polls up to 50 s. Targets are the page's text, a CSS
  selector, a ref or role + name; a re-rendered node is found again by its
  role and name, and the watch carries on across navigations.
  `bro watch '<start JSON>'` streams the same events as JSON lines and exits
  when the watch ends (0 when met), so an agent can run it in the background
  and be woken by each line.
  Changes are pushed, not polled: an observer in the page re-checks the
  condition once per task of DOM mutations and sends each new value at once,
  so a change, even one that shows for a single task, is reported within
  moments, and a page that mutates without changing what is watched sends
  nothing. Navigation reinstalls the observer and a closed tab is pushed too.
  A heartbeat probe on the server's clock (`intervalMs`, default 5 s) covers
  what a page cannot push. A watch never goes quiet: a frozen, unresponsive or
  disconnected tab is an event, and every read reports the tab's state and
  when it was last probed. A watch ends when it is met, stopped, times out
  (default 30 min, at most 24 h), or its tab closes, is discarded, stays
  unresponsive for 60 s, or loses its browser for 30 s; the reason is the
  last event. Watches live in the server and end when it restarts.
- A watch can run inside a child frame, such as a support chat in a
  cross-site iframe: pass the frame's `frameId` (from `frames_list`), or a ref
  that lives in the frame.
- `bro watch --once` exits 3 after the first change and leaves the watch
  running; `bro watch --id W --cursor N --once` resumes after event N. This is
  the loop for agent harnesses that wake only when a background command exits:
  a change that arrives between two runs is printed by the next one.
- The `wait` step's text conditions run on the same check: a text that shows
  for less than a poll is no longer missed, and a frozen tab ends the wait at
  once with the reason instead of after its timeout.
- An act step's change report waits for the fetch and XHR requests the step
  started, then for the page to settle, up to the 3 s cap. Before, a button
  whose request took longer than 400 ms, such as a form that validates on the
  server, was reported as "no visible change" while its answer was still on
  the way. Beacons, WebSockets and requests already in flight are not waited
  for. A request still out at the cap is named (`waiting on GET …`).
- A filled control keeps focus, so `fill` then `press Enter` submits a search
  box. Before, the key went to the page body.
- Reads wait for content a page says is still loading. An indeterminate
  `progressbar` or `aria-busy` region in view (an app shell's spinner) keeps
  extract, batch extract, and a target's first observe or act waiting, up to
  their caps. Previously a single-page app's stable shell, such as an X post
  page before its timeline arrived, was returned as the page.
- `minChars` is a requirement. Extract waits for that much text and otherwise
  reports `status: "partial"`; before, a settled short page passed regardless.
- Extract no longer reads unrendered shadow-root content: a widget's `<style>`
  or hidden panel was returned as page text.
- One readiness rule for every read. A target's first observe or act, network
  and console capture, and `read_text` steps wait by extract's rule; text
  observe no longer waits up to 4 s on pages under 120 characters.
- `make check` and CI run staticcheck.
- A tab that once showed a password manager's frame no longer stalls every
  call while Chrome has it frozen. Attaching to such a tab first removed
  foreign frames with `chrome.scripting`, which waits until Chrome unfreezes
  the page, sometimes for a minute. `navigate` then timed out, and the queued
  navigations aborted each other (`net::ERR_ABORTED`). bro now skips that
  step in a frozen tab, where no script can add a frame, and attaches over CDP,
  which works there.
- Clicks into a cross-site iframe no longer report success when nothing was
  clicked. Chrome routes input into such a frame by what it last composited,
  and a tab that was not painting (a background or attached tab, or the
  selected tab of an occluded window or a dark display) had no frame of the
  current page yet, so the press landed on the parent's `<iframe>` instead.
  Input now waits for one composited frame in a tab that is not painting, and
  a ref click fails when its press does not reach the target's document.
- Whether a tab paints is decided in one place, from its document's real
  visibility rather than from being the selected tab. The render pump now
  keeps an occluded window's selected tab rendering. Input into a frozen or
  discarded tab, and an evaluate that times out in one, says so and how to
  wake it, instead of blaming the expression.
- An act step's change report waits for quiet after the step returns. Time
  the step spent preparing counted as quiet, so a slow click settled at once
  and missed the update its fetch made a moment later.
- A password manager's frame no longer locks bro out of a tab. While another
  extension's frame is in the page, Chrome rejects every debugger call from
  bro, detach included, yet keeps the session open. bro took that rejected
  detach as done, so every later attach failed with "Another debugger is
  already attached". It now removes the frame and detaches again. A ref
  action whose cleanup finds the session closed no longer fails: the closed
  session freed what the cleanup would have released. Input removes such
  frames first. Attach sees only frames that have loaded, so a menu drawn at
  load or on the last focus could still be loading and commit mid-input,
  closing the session.
- Acts and reads resume a tab Chrome froze. Chrome freezes background tabs
  once it holds more than a few, and a frozen page runs no injected script
  until Chrome unfreezes it, often a minute later: an act on such a tab hung
  until the bridge's 30 s timeout. bro now resumes the tab before an act,
  observe, extract or wait step and again if Chrome freezes it mid-call, does
  not count time spent frozen as the page settling, and fails within seconds
  with the reason when a tab is discarded or does not resume. The freeze
  listener is armed before the tab's state is read: Chrome can report a
  freeze ahead of the reply to a read made just before it, and that freeze
  was resumed by nobody, so a change report came back 5 to 8 s late, when
  Chrome unfroze the tab by itself. `browser.watch` still only observes and
  reports a frozen tab as an event.
- `make check` runs its parts at once and prints each part's output as one
  block. `make live-refs` runs the checks that need the whole browser one at
  a time and the rest four at a time on one MCP session
  (`LIVE_CONCURRENCY`); `CHECKS` takes several name substrings joined by
  `|`. `make live-refs-repeat N=3` runs N whole suites at once and reports
  the passes per check.

## 2.0.0

2.0 removes tools that newer ones fully cover: the MCP surface goes from 62
tools to 43. Which tools stayed was decided from 8,088 recorded agent calls,
plus the calls the Pi adapter makes on its own. Update the bro skill and the
Pi adapter together with the server.

Removed, with their replacements:

| Removed | Use instead |
|---|---|
| `browser.flow.start/observe/act/finish` | `browser.open/observe/act/close` (same executor; `targetId` instead of `sessionId`) |
| `browser.batch.run` | `browser.batch.extract` |
| `browser.current.extract` | `browser.extract` without `url` (below) |
| `click_element`, `fill_element`, `form_input` | `browser.click` / `browser.fill` / `browser.act`, after `browser.attach` for a tab bro did not open |
| `agent_done`, `tabs_claim`, `tabs_create_mcp`, `tabs_context_mcp` | `browser.open` / `browser.attach` / `browser.close` |
| `scroll_element` | an act `scroll` step |
| `get_response_body` | `browser.network.capture` with `includeResponseBodies` |
| `gif_creator`, `shortcuts_list`, `shortcuts_execute`, `extract_page` | none; agents did not call them |

- `browser.extract` without `url` reads an existing tab in place and leaves
  it open: the active tab, or `tabId` from `tabs_context`. Passing both is an
  error.
- `browser.attach` makes an existing tab a target: one the user opened, or a
  popup a page opened. Pass its `tabId` from `tabs_context`. Before this,
  `browser.act` and its change reports only worked on tabs bro opened, so
  work on the user's logged-in pages fell back to one raw tool call per
  action. bro never closes an attached tab: `close: true` or `browser.close`
  releases the target and reports `released: true`.
- `browser.act` has an `upload` step (`paths`, optional `drop`, by `refId` or
  `role` + `name`), so uploads chain with other steps. A form that takes one
  file per post used to cost three calls per file (find the new ref,
  `file_upload`, then submit). It is now one act call, because role + name
  targets survive the post's navigation.
- Ending an MCP session (`DELETE /mcp`) cancels its in-flight calls. A
  client that left during `browser.open` used to leave the late tab open,
  owned by a target nobody knew.
- `browsers_context` no longer reports `nativeInfo` (best-effort browser
  process and profile paths).
- The Pi adapter activates exactly the tools the server marks as default and
  no longer carries fallbacks for servers older than 1.4.
- A slow navigation no longer loses the tab's debugger session. bro bounded
  `Page.navigate` by the 5 s CDP command timeout, which treats a missing reply
  as a dead session and detaches; Chrome replies to `Page.navigate` only at
  commit, so a slow server cost the session and surfaced as an unrelated
  detach error. The 10 s readiness wait now bounds navigation, and a detach
  error names who detached and why.
- Observing a large page no longer detaches the tab. The background render
  pump's screenshot waits for the renderer to draw, which a multi-second
  accessibility-tree read delays past the 5 s command timeout; that timeout
  detached the whole tab mid-observe. The capture is now bounded by its
  caller, not by the session timeout.
- `browser.extract` no longer returns a lazy page's skeleton. A short,
  stable text counted as ready even before a background tab had rendered a
  frame, so cards that appear on IntersectionObserver or
  requestAnimationFrame were missed now and then. Where frames arrive (a
  visible page, or a background tab bro renders), the text must now stay
  stable across two rendered frames.
- Logs no longer carry color codes when stderr is not a terminal (for example
  under `brew services`).
- Building from source needs Go: `go build ./cmd/bro`, or `make build`.

## 1.7.0

- `browser.open` returns the first observation with the `targetId`, so the
  next call can act on its refs without a separate `browser.observe` turn.
  `observe` takes browser.observe's options (`{"mode":"text"}` to read);
  `observe: false` keeps the old return-at-dispatch behavior.
- `close: true` on `browser.observe`, `act`, `click`, `fill` or `press`
  closes the target once that call succeeds, instead of a separate
  `browser.close` turn. A failed act step keeps the target open.
- Small pages no longer wait out the readiness cap. Readiness required 120
  characters of text, so a short page cost 8 s in `browser.extract` and 4 s on
  its first observe; a complete document whose text has stopped changing is
  now ready at once (0.5 s and 0.3 s measured). A short "Loading…" placeholder
  still waits.
- `browser.extract` reads the page's rendered `innerText`, so table rows stay
  on one line and repeated cells are kept; the old text walker split every
  cell onto its own line, dropped repeated text, and stopped after 5000 nodes.
  One page now returns up to 20,000 characters by default (batch stays at
  8,000 per page).
- bro's "Agent is active" indicator is hidden from accessibility snapshots.

## 1.6.0

- `file_upload` takes the control a user clicks to pick files, not the file
  input. Most pages hide that input, create it on click, or cover it with a
  drop label, so an agent often had no ref for it. Pass the ref of the upload
  button, drop zone, or input; or a `coordinate` when the control has no ref
  (a canvas app's menu text). bro clicks it with a real pointer, catches the
  file chooser the page opens, and fills that chooser's input; a ref to the
  input itself is filled directly. `drop: true` drags the files onto the target instead, for drop-only
  zones and pages that ask through `showOpenFilePicker`, which no file input
  can answer.
- File choosers no longer open an OS window under automation. Like native
  dialogs, every chooser on a tab bro controls is intercepted; one that no
  `file_upload` asked for is cancelled and reported in the action's result.
- Native dialogs raised inside cross-site iframes are answered too.

## 1.5.0

- `file_upload` takes local files by path. Pass absolute paths in `paths`;
  bro checks each is a regular file and the browser reads it itself, so the
  page sees real files and trusted `input`/`change` events, and nothing is
  copied through the model. Several paths need a `multiple` input.
  **Breaking:** the base64 `fileName`/`mimeType`/`data` arguments and
  `upload_image` are removed; to upload a screenshot or generated content,
  save it to a file first.
- bro no longer goes dead after closing the browser's last tab. On macOS,
  closing the last window unloads the profile, which stopped the extension
  and its reconnect alarm until a window opened. bro now leaves a background
  New Tab page when it closes the last tab.
- The Pi adapter loads the MCP SDK on its first connection, taking about
  65 ms off every Pi start.

## 1.4.5

- Password managers no longer break CDP. 1Password's inline menu, save
  prompt and modal are iframes of its own pages, and Chromium refuses the
  debugger on a tab while one is present and closes a live session when one
  appears. bro now removes those iframes from the page and attaches; it keeps
  their hosts, so 1Password's later redraws create no frame and clicks and
  typing in login and payment fields keep working. Nothing is disabled or
  reloaded, and reloading the page restores 1Password's in-page UI there. A
  navigation whose new page draws such a frame finishes instead of failing,
  and the focus cleanup after a click that woke 1Password no longer errors.
- Native dialogs no longer hang a tab. bro answers each alert, confirm,
  prompt and beforeunload as it opens and reports it: alerts and
  beforeunload are accepted, confirm and prompt cancelled unless a
  `browser.act` `{"type":"dialog","accept":true}` step arms an answer for the
  rest of that call.

## 1.4.4

- The MCP endpoint accepts `Host: host.docker.internal`, so agents in a
  container can reach bro on the Mac's localhost. Other names are still
  rejected, which keeps the DNS-rebinding protection.

## 1.4.3

- `onepassword_fill_login` fills one field at a time: it focuses, writes and
  dispatches events for a field, then yields before the next, as 1Password
  does. Before, it wrote every value before dispatching any event, so on
  controlled-input pages such as Infura's React form the username's re-render
  wiped the password and the fill failed with "Fill dispatched but not
  verified".
- Session tab groups are created in the new tab's own window. Before, Chrome
  put the group in the focused window, so opening a tab while an installed
  app or popup window had focus failed with "Grouping is not supported by tabs
  in this window".
- Screenshots of device-scaled viewports are captured at CSS pixel size, so
  image coordinates are `computer` coordinates and payloads shrink by dpr².
- `find` ranks nodes by matched label words instead of requiring every word,
  so natural descriptions resolve; `wait_for_element` keeps strict matching.
  `tabs_context_mcp` without `sessionId` falls back to the anchor window's
  context instead of an empty answer.
- `javascript_tool` evaluates like a console: top-level `await` works without
  leaking declarations into the page, and a returned Promise is awaited.
  `computer` click, hover and scroll accept `refId`. `find` maps "dropdown"
  and "select" to combobox/listbox roles.

## 1.4.2

- The server now pings each extension connection every 15 s and drops one that
  has been silent for 45 s. A connection that died without a close frame used
  to stay registered: every call went to it and waited out the 30 s tool
  timeout, and the extension, still seeing an open socket, never reconnected.
  Now its pending calls fail at once with "browser extension disconnected",
  and closing the socket makes the extension reconnect.
- A WebSocket error from the extension (for example "Connection reset without
  closing handshake") now unregisters that connection and fails its pending
  calls, instead of leaving a stale registration behind.

## 1.4.1

- Background tabs that bro creates now render: Chrome gives hidden tabs no
  frames, so `requestAnimationFrame` and `IntersectionObserver` never ran and
  lazy feeds (YouTube's home grid) stayed skeletons. bro takes a cheap
  screenshot of each such tab every 250 ms, which renders one frame without
  activating the tab or changing focus.
- `browser.extract` polls page stability from the extension instead of waiting
  inside the page. The page-side wait outlived the 5 s CDP command limit on
  busy pages, detached the debugger and fell back to navigation-only text; an
  unsettled page now returns what it has with reason `guard`.

## 1.4.0

- Add the default `browser.open/observe/act/close` interface with explicit
  browser/tab-pinned target IDs, composable typed actions and observations.
  Keep extraction/batch fast paths and legacy flow signatures on the same engine.
- Preserve same-node refs across rereads, scopes, filters and find. Bound the
  volatile registry to 10,000 handles with explicit stale errors; never reuse
  evicted/restarted identities. Validate complete frame inventories around reads.
- Expose scoped/bounded observation controls on both facades and inside act;
  text mode accepts `maxChars`/`cursor` and rejects only a11y-only options.
- Wait for document-specific DOMContentLoaded at navigation dispatch, before
  dependent evaluation. Preserve redirects, fail unmet readiness, clean listeners
  and failed newly created tabs. Do not treat legitimate empty eval as failure.
- Let server metadata select Pi defaults. Automatically inject owner/label,
  preserve targets across reload and report shutdown cleanup errors. Older
  servers retain legacy defaults; new servers keep legacy flows inactive by default.
- Shrink the model-facing surface: short epoch-prefixed refs (`kqx297`) that
  reject handles from an earlier registry; one-line act step results with the
  failure first and no connection/cleanup/acknowledgement fields; observe
  defaults of 8000 characters (3000 inside act) with cursor continuation.
- Add the act `check` step for native radios/checkboxes. Covered clicks name
  the covering element and its overlay as refs instead of a bare tag.
- Ref scroll moves the nearest scrollable ancestor or the document and names
  it; clicks accept hits on descendants, slotted content, composed ancestors and
  labels, re-measure once, and report empty points as not visible, not covered.
  An act `observe` whose scope was re-rendered reads the page and says so.
- `browser.open` returns once navigation is dispatched; the target's first
  observe or act waits up to 4 s for DOMContentLoaded and readable text, and
  proceeds at the cap instead of failing.
- Steer content reading to `mode: text`. Facade `maxChars` accepts at most
  20000; a11y output is capped at 12000, and its truncation footer lists the
  unread top-level landmarks and headings as refs to scope to. Add a condition-only act
  `wait` step: `text`, `textGone`, or `refId` + `state`, polled up to
  `timeoutMs` (default 5000, at most 15000); a timeout is reported and later
  steps still run. An a11y observation retries once when the document
  changes mid-read and says so; an evaluation timeout names the busy page or
  long await and points to `wait`.
- `browser.batch.flow` accepts act's step names (`navigate`, `evaluate`);
  `goto`/`eval` remain aliases. Move developer invariants out of the injected
  facade guide into `docs/interaction-internals.md`.
- Act click/fill/select/check wait for the main frame to settle (400 ms quiet,
  3 s cap) and report opened/closed dialogs and menus, alerts, new text and
  navigation; a click with no visible change says so. Element steps accept
  `role` + `name`, resolved when the step runs, instead of `refId`.
- A click that opens a menu/dialog lists refs for its controls; a form post
  started by an action holds the settle wait; a role + name miss names the
  roles found instead. Add `browser.click`/`fill`/`press` single-action tools
  and an act `press` step; `targetId` defaults to the MCP session's last
  target. Observations show native date/time inputs as one ISO-fillable node
  and drop text that repeats its parent's name.
- See `docs/releases/1.4.0.md` for migration, boundaries and deferred scope.

## 1.4.4

- Fix Pi MCP shared-connection ownership: request cancellation and ordinary
  request failures do not disconnect sibling calls; expired sessions reconnect
  on the next request without replay. Bound setup and shutdown deadlines.

- Add one-click Enable/Disable actions to the extension's user-script list.
  Disabled scripts retain their source and stay disabled across restarts and
  extension updates; editing does not re-enable them. Reload matching pages
  to apply changes; disabling cannot undo code that has already run.

- Match 1Password logins by registrable domain (Public Suffix List) instead of
  exact origin, like 1Password's default, so `secure.pnc.com` logins are found
  from `www.pnc.com`. Candidates report `match: exact-origin|same-site`; fill
  re-checks the same rule. `login_form_inspect` now reports `hiddenFields`,
  text-free `accountSwitchers` and a remembered-account `hint`. Candidates
  include the username; an empty search says how to proceed instead of leaving
  agents to work around it with raw `op` output.

- Keep focus emulation alive through rendering after `computer.scroll` wheel
  dispatch so fresh background pages actually process the scroll. Report dispatch
  rather than claiming movement; do not foreground, replay, or override canceled
  wheels. Add real-browser panel/page regressions and rendering-failure coverage.

- Serialize CDP attach/detach transitions and invalidate child frame sessions
  before idle detachment. Consecutive flow steps no longer reuse a detaching
  connection; attachment-loss errors are reported without replaying input.

- Replace unconditional foregrounding for ref click/scroll and computer input
  with scoped page-focus emulation. Preserve the user's selected tab/window,
  serialize same-tab input, clear emulation on success/failure, and retain
  `tabs_activate` for deliberate foreground work. See `docs/input-focus.md`.

- Add `browser.network.capture` to keep monitoring, trigger execution, matching
  request collection, bounded response bodies, and cleanup inside one MCP call.
- Propagate nested browser errors through flow results, stop at the failed step,
  and mark failed facade outcomes as MCP tool errors.
- Add typed `select` flow steps, framework-aware input setters, awaited eval
  expressions, shorter flow IDs, and explicit flow-step schemas.
- Keep the outcome-level network facade active by default in Pi after benchmark
  runs reduced the network task from 0/3 to 3/3 success.
- Fix tab-envelope extraction for every forwarded tab tool, including
  `extract_page`, with a catalog-wide invariant test.
- Bound CDP commands, detach failed sessions, foreground real input targets,
  preserve held mouse-button state during drag, and publish screenshot coordinate
  and device-scale guidance.
- Add `frames_list` plus frame-aware flow eval, click, fill, select, and read
  steps for child-frame interaction.
- Add one-call `browser.console.capture` and server-owned capability metadata so
  Pi loads coherent interaction, tabs, frames, accessibility, console, visual,
  upload, shortcut, and user-script tool packs.
- Keep nine internal or compatibility tools on the MCP server while omitting
  them from Pi registration; retain `tabs_finalize` in the dynamic tab pack for
  explicit keep/handoff lifecycle work.

## 1.0.1

- Fix the extension options bundle so its ES module imports load correctly.
- Add a full-width Options-page manager for listing, creating, editing, and
  deleting inline user scripts, with low-frequency connection settings collapsed.
- Preserve user scripts in extension-local storage and restore them when an
  extension update clears Chrome's dynamic registration database.
- Show an editable purpose description for each user script.
- Add a bro-owned Pi adapter that exposes live MCP schemas as native namespaced
  tools over one persistent connection.
- Add dynamic low-level tool loading, Pi session-aware tab/flow cleanup, bounded
  result mapping, and correct MCP error propagation for Pi.

## 1.0.0

- Mark the local MCP server, authenticated extension bridge, and supported
  CLI/MCP surface as the first stable bro release.
- Keep read-only settings access free of filesystem writes and preserve invalid
  settings files with clear errors instead of silently replacing their token.
- Harden extension authentication state, reconnect ownership, and the initial
  WebSocket authentication timeout.
- Keep extension tokens in local trusted-context storage and restrict server
  URLs to loopback WebSocket endpoints.
- Keep the extension manifest version aligned with the server version in checks
  and release builds.

## 0.2.5

- Add best-effort native browser profile and process metadata to
  `browsers_context`.
- Add browser monitoring diagnostics, user-script management, and richer
  JavaScript and network inspection options.

## 0.2.4

- Add browser session lifecycle parity tools: `session_name`, `tabs_claim`, and `tabs_finalize`.
- Track session-owned and session-claimed tabs in the extension so owned tabs
  can be closed while claimed user tabs are released.
- Document bro's Chrome connector parity matrix and the remaining Playwright-object-model gap.

## 0.2.2

- Add `browser.batch.flow` for running the same ordered click/fill/wait/eval/read
  workflow across many URLs with bounded concurrency and cleanup.
- Document when to use batch flow instead of many separate flow sessions.
- Update the bro-browser Codex skill to prefer `browser.batch.flow` for repeated
  multi-page interactions.

## 0.2.1

- Add `bro setup codex` to configure Codex MCP without shell-specific token environment setup.
- Add `bro setup browser` to open browser extension setup, reveal the extension
  directory, and copy the local token to the clipboard when available.
- Install the browser extension asset through the Homebrew formula so Homebrew
  users do not need a source checkout.
- Update README setup instructions around Homebrew, Codex MCP auth, and browser extension loading.

## 0.2.0

- Add cross-platform GitHub release builds for macOS, Linux, and Windows on x86_64 and arm64.
- Add Homebrew release automation for `xiaotianxt/tap/bro` using GitHub-built binaries.
- Add Homebrew service support for running the local bro MCP server.
- Add `bro --version` for release and install verification.

## 0.1.0

- Initial bro repository.
- Local MCP server and CLI for browser automation.
- Minimal WebExtension adapter for Chromium-family browsers.
- Batch extraction and flow tools for short agent/browser interaction loops.
- CI metadata for server format, lint and tests, and extension typecheck/build.
- GitHub release workflow metadata for binary artifacts.
