// Package nativehost answers the bro extension's native messaging requests,
// so the extension gets the local token without the user pasting it.
//
// The browser starts bro itself as the host, as the same OS user, and only for
// extension IDs listed in the host manifest's allowed_origins. A web page or
// another extension cannot reach it, and any process that could already reads
// ~/.bro/settings.json, so answering with the token widens nothing.
package nativehost

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Name is the native messaging host name the extension connects to.
const Name = "com.xiaotianxt.bro"

// ExtensionIDs may ask for the token: first the unpacked build, whose ID the
// manifest key pins, then the Chrome Web Store listing, whose ID the store
// assigns (store uploads cannot carry a key).
var ExtensionIDs = []string{
	"ibnjnpacbcpiodnhpgmnohhnhgpkmieg",
	"gldmnpdbkkpmahhajekjcccmflfohaol",
}

// maxMessage bounds a request; a pair request is a few bytes.
const maxMessage = 1 << 20

// IsLaunch reports whether the browser started this process as the native
// host: Chrome passes the caller's origin as the first argument.
func IsLaunch(args []string) bool {
	return len(args) > 0 && strings.HasPrefix(args[0], "chrome-extension://")
}

type request struct {
	Type string `json:"type"`
}

// Reply is the host's single answer. Exactly one of Token and Error is set.
type Reply struct {
	Version string `json:"version"`
	Token   string `json:"token,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Serve reads one framed request from r and writes one framed reply to w.
// A request bro cannot answer gets an error reply; only a broken frame on
// either side is returned as an error.
func Serve(r io.Reader, w io.Writer, version string, token func() (string, error)) error {
	data, err := read(r)
	if err != nil {
		return err
	}
	reply := Reply{Version: version}
	var req request
	switch {
	case json.Unmarshal(data, &req) != nil:
		reply.Error = "request is not a JSON object"
	case req.Type != "pair":
		reply.Error = fmt.Sprintf("unsupported request type %q", req.Type)
	default:
		if reply.Token, err = token(); err != nil {
			reply.Error = err.Error()
		}
	}
	return write(w, reply)
}

// Messages are a native-endian uint32 length and UTF-8 JSON; every platform
// bro ships for is little-endian.
func read(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, fmt.Errorf("read native message length: %w", err)
	}
	if n > maxMessage {
		return nil, fmt.Errorf("native message of %d bytes exceeds %d", n, maxMessage)
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, fmt.Errorf("read native message: %w", err)
	}
	return data, nil
}

func write(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > maxMessage {
		return errors.New("native reply too large")
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}
