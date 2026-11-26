# bro Privacy Policy

Last updated: 2026-11-26

bro is a browser extension paired with a server program that runs on your own
computer. Together they let AI agents and tools you run locally read and operate
your browser. This policy covers the bro extension and the bro server.

## What bro handles

When a program on your computer asks bro to, the extension reads and acts on
the pages in your browser: page text and structure, URLs and titles of tabs,
console messages and network requests of a page being inspected, screenshots,
and the text it types into forms. It also stores, in the browser's local
extension storage, the local connection token, the server address, and any user
scripts you register.

## Where it goes

The extension sends this data only to the bro server on the same computer, over
a loopback connection (`127.0.0.1`, `localhost` or `[::1]`); it refuses any
other server address. The bro server passes it to the local program that asked
for it. What that program does with it is governed by that program, not by bro.

bro itself does not send your data to the developer or to any third party. It
has no analytics, telemetry, advertising, or remote servers of its own, and the
developer never receives your browsing data. bro does not sell data or use it
for any purpose other than carrying out the requests of your local programs.

## Pairing

`bro setup` registers the bro program with your browser as a native messaging
host. The extension asks it, on the same computer, for the local token stored
in `~/.bro/settings.json`, so you do not have to copy it by hand. The token never
leaves your computer.

## Your control

Everything bro stores lives on your computer: remove the extension to delete
its storage, and delete `~/.bro` to remove the server's settings. Stop the bro
server, or disable the extension, to stop all access.

## Contact

Questions and reports: <https://github.com/xiaotianxt/bro/issues>.
