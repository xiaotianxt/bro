# Scoped 1Password password login

## Workflow

Requires 1Password CLI (`op`), a configured account and approved CLI access on the
machine running bro. Unlock/biometric approval is a user action. This is a
username/password workflow, not a passkey, CAPTCHA or MFA implementation.

Discover the `login` capability pack (Pi search: `1Password login`):

1. `login_form_inspect {browserId, tabId}` obtains the **actual main-frame origin**,
   document ID, a 120-second form token, fillable input indices/types,
   `hiddenFields`, and `accountSwitchers`. No field values or control text are
   returned. When only a password is fillable it adds a `hint`: the page is
   showing a remembered account. Fill the password for that account, or apply an
   `accountSwitchers` entry (`select` with `optionValue`, or click its `css`) and
   inspect again, instead of debugging the username input's DOM. It uses extension ISOLATED-world scripting, not CDP, so
   a foreign-extension iframe need not be disabled to inspect/fill this form.
2. `onepassword_find_logins {url, vault?, account?, confirmMetadataSearch:true}`
   lists Login metadata locally and returns only same-site candidate
   item/vault IDs, bounded titles and `match: exact-origin|same-site`, exact first. User authorization to search metadata is
   required; narrow the vault/account when known. Without a vault scope the CLI
   may enumerate all accessible Login metadata locally, but unmatched entries
   are not returned. This does not fetch credential fields.
3. Select a candidate. Multiple candidates require the user's choice unless
   their existing instructions unambiguously identify the desired item. No
   automatic first-match selection, arbitrary vault browsing, or password dump.
4. `onepassword_fill_login` takes explicit browser/tab, documentId, formToken,
   expectedOrigin, itemId, vaultId, optional account, selected usernameIndex
   and/or passwordIndex, and `confirmFill:true`. Username-first pages can use
   usernameIndex alone; inspect again after a navigation before password fill.
5. Verify the page's non-secret outcome. Submit separately within the user's
   authorization and check for autosubmit/navigation before dispatching a click.
   bro never calls submit in the fill tool; website input handlers can still act
   on values. Never repeat an uncertain fill/submit automatically.

Only HTTPS is accepted except on literal localhost/127.0.0.1/[::1]. Matching
follows 1Password's default "Fill anywhere on this website": a saved website
matches when scheme and effective port are equal and the registrable domain
(eTLD+1 from the Public Suffix List, private section included) is the same.
Saved `https://secure.example.com` therefore matches `https://www.example.com`,
while `evilexample.com`, `example.com.evil.test`, `a.co.uk`/`b.co.uk` and
`alice.github.io`/`bob.github.io` do not. Loopback and IP hosts match only
exactly. Bare saved hosts such as `example.com` are read as HTTPS. Paths/queries
are not authorization boundaries. Discovery and fill use the same rule, and fill
re-checks it on the freshly read item.

1Password's per-URL "Only fill on this exact host" and "Never fill" settings
are not present in the CLI fields bro reads, so bro cannot honor them; an item
restricted that way can still be offered on a sibling host. Associated-domain
groups (one organization on several registrable domains) and SSO providers are
not matched. A zero-match result does not prove no related account exists. Do
not update the saved item's URL.

## Private data path

Public tool calls contain references and form selection, never credentials:

```
agent references → Rust server → scoped op subprocess (stdout pipe)
                → private authenticated WebSocket message
                → isolated, document-bound extension script → intended inputs
```

The provider runs without a shell. Stdout is bounded (4 MiB metadata / 256 KiB
selected item), stderr is discarded, execution is bounded to 45 seconds, and
provider output is never forwarded into errors. No temporary credential files,
plaintext argv, clipboard or password-bearing environment variables are created
by this implementation. Ordinary process/transport memory contains secrets;
this is **not** secure-memory erasure or end-to-end encryption against the local
OS. The existing broker bearer-token boundary and trusted extension still apply.

The selected item is fetched only after form preflight. Its ID, vault, Login
category and saved origin are verified again. Only requested username/password
fields are sent to the private handler. `__bro_login_*` handlers are absent from
the public MCP catalog and rejected as public tool calls.

Before mutation the extension checks the exact document, origin, original DOM
node identities, expiry, visibility, input types, and empty values. OTP and
new-password autocomplete tokens are rejected, including section prefixes.
The background owns a one-shot fill authorization; Stop, agent completion and
tab removal revoke it. An isolated script must acquire it at execution time,
so Stop during a delayed CLI read cannot trigger a later fill. A mutation that
already acquired authorization may be in progress: cancellation is not undo.
No automatic foreground fallback or retry is used if a frozen tab cannot run.

Connection-bound dispatch/replies prevent a replacement or different browser
from completing another connection's request. Tool-call Debug hides arguments;
WebSocket DEBUG/TRACE payload logging is excluded independently of RUST_LOG.
The server reconstructs allowlisted outcomes instead of reflecting page errors.

## Limits on the confidentiality claim

The intended website necessarily receives and can read/react to filled values.
A hostile page can reflect them into console, network, DOM or screenshots, and
bro has other tools that can read those surfaces. Do not monitor or capture a
credential-bearing tab or read field values after filling. This feature does
not prevent an independently authorized client/agent from issuing such reads.
Metadata titles are user-authored and can themselves be sensitive.

No guarantee is made about OS swap/core dumps, external instrumentation,
1Password's own internals, or arbitrary destination-site behavior. The guarantee
is a narrow one: this tool's public arguments/results and bro's normal/verbose
transport logging do not intentionally contain the credential fields.

## Verification and reproducible experiment

```
cargo build --features credential-test-provider --target-dir target/credential-test
pnpm --filter @bro/extension exec vite build --outDir "$TMPDIR/bro-login-extension"
node scripts/live-login.mjs "$TMPDIR/bro-login-extension" "$CHROME_BIN"
```

The test build is unmistakably labeled `+credential-test-provider` and refuses
real vault access. The script refuses a production binary. The injected provider
executable path is unavailable in production builds. Release workflows do not
enable the test feature.

An isolated Chrome profile and local HTTP fixture verify:

- A protected extension iframe blocks CDP but not form inspection/private fill.
- Exact-origin metadata matching, and refusal of an item whose saved origin changed.
- Remembered-account state: hidden username, visible password and an "other user"
  select produce `hiddenFields`, `accountSwitchers` and a `hint`.
- Provider failure (including canaries in stdout/stderr) does not expose output.
- Changed document/DOM node, tokenized new-password, expired and nonempty fields fail.
- Stop during delayed provider retrieval leaves the form empty; consumed tokens refuse replay.
- No automatic submit; the local server verifies the exact synthetic credentials
  on the one explicitly submitted request, returning only a match result.
- Synthetic canaries are absent from captured public requests/results and the
  broker/browser process log with RUST_LOG=trace. These are the scanned surfaces,
  not a claim that all OS storage or destination-site state was scanned.

Unit tests additionally check registrable-domain matching (public and private
suffixes, ports, schemes, bare hosts), canonical origins, fixed error projection, redacted
Debug, and browser/session-bound responses. An independent source review found
and drove the Stop-during-provider and autocomplete-token fixes.

**Real-provider status:** on the development machine, `op 2.40.0` help confirmed
list/get/read behavior, but authentication was not ready and a scoped PNC-related
metadata experiment timed out. No real password was read and PNC was not logged
into. Synthetic-provider success does not establish real CLI integration; finish
CLI setup/approval, then verify metadata discovery before any real fill.
