package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The CLI read waits stay under the tool's 50 s ceiling.
const (
	watchReadWaitMs = 45_000
	watchStopBound  = 5 * time.Second
)

// exitError ends the process with code after the message (if any) is printed.
type exitError struct {
	code int
	err  error
}

func (e exitError) Error() string {
	if e.err == nil {
		return ""
	}
	return e.err.Error()
}

// watchCmd streams one watch's events to stdout as JSON lines, one per
// event, for an agent harness to run in the background: each line can wake
// the agent, and the process exits when the watch ends (0 when its condition
// was met, 1 for any other end, 2 for a usage or connection error). The last
// line is then an "end" event. A watch this command started is stopped when
// the command is interrupted; one it joined with --id is left running.
//
// --once is for harnesses that wake an agent only when a background command
// exits: the command exits 3 after the first change while the watch keeps
// running in the server, and `--id W --cursor N --once` resumes after event N,
// so nothing that arrives between two runs is lost.
//
// It is a client of the browser.watch tool, so the server owns the watch and
// its limits; the command only follows the cursor.
func watchCmd(args []string) error {
	fs := flags("watch")
	port := fs.Int("port", defaultPort, "")
	id := fs.String("id", "", "")
	once := fs.Bool("once", false, "")
	from := fs.Int64("cursor", 0, "")
	positional, err := parse(fs, args)
	if err != nil {
		return exitError{2, err}
	}
	if *from != 0 && *id == "" {
		return exitError{2, fmt.Errorf("--cursor resumes a watch and needs --id\n\n%s", usage)}
	}
	if *from < 0 {
		return exitError{2, errors.New("--cursor must be at least 0")}
	}
	var start map[string]any
	switch {
	case *id == "" && len(positional) == 1:
		if err := json.Unmarshal([]byte(positional[0]), &start); err != nil || start == nil {
			return exitError{2, fmt.Errorf("watch arguments must be a JSON object: %s", positional[0])}
		}
	case *id != "" && len(positional) == 0:
	default:
		return exitError{2, fmt.Errorf("watch requires a JSON start object or --id WATCHID\n\n%s", usage)}
	}
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	session, err := connect(ctx, *port)
	if err != nil {
		return exitError{2, err}
	}
	defer session.Close()

	out := json.NewEncoder(os.Stdout)
	call := func(ctx context.Context, arguments map[string]any) (map[string]any, error) {
		r, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "browser.watch", Arguments: arguments})
		if err != nil {
			return nil, err
		}
		text := ""
		for _, c := range r.Content {
			if t, ok := c.(*mcp.TextContent); ok {
				text += t.Text
			}
		}
		if r.IsError {
			return nil, toolFailure(text)
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			return nil, fmt.Errorf("unreadable browser.watch result: %w", err)
		}
		return value, nil
	}
	// emit prints the read's events; it returns the exit code once the
	// watch has ended (or, with --once, changed), or -1 while it runs.
	emit := func(value map[string]any) (int, error) {
		events, _ := value["events"].([]any)
		changed := false
		for _, e := range events {
			event, _ := e.(map[string]any)
			event["watchId"] = value["watchId"]
			if err := out.Encode(event); err != nil {
				return 2, err
			}
			changed = changed || event["type"] != "initial"
		}
		if value["active"] == true {
			if *once && changed {
				return 3, nil
			}
			return -1, nil
		}
		if value["reason"] == "met" {
			return 0, nil
		}
		return 1, nil
	}
	end := func(watchID, reason string, cause error) error {
		_ = out.Encode(map[string]any{"type": "end", "reason": reason, "error": cause.Error(), "watchId": watchID})
		return exitError{1, nil}
	}

	watchID, owned := *id, false
	cursor := float64(*from)
	if start != nil {
		value, err := call(ctx, start)
		if err != nil {
			return exitError{2, err}
		}
		watchID, owned = value["watchId"].(string), true
		cursor, _ = value["cursor"].(float64)
		if code, err := emit(value); code >= 0 || err != nil {
			return exitError{code, err}
		}
	}
	for {
		value, err := call(ctx, map[string]any{"watchId": watchID, "cursor": cursor, "waitMs": watchReadWaitMs})
		if ctx.Err() != nil {
			if !owned {
				return exitError{1, nil}
			}
			// Interrupted: stop the watch this command owns and print its end.
			stopCtx, cancel := context.WithTimeout(context.Background(), watchStopBound)
			defer cancel()
			value, err := call(stopCtx, map[string]any{"watchId": watchID, "cursor": cursor, "stop": true})
			if err != nil {
				return end(watchID, "stopped", err)
			}
			_, err = emit(value)
			return exitError{1, err}
		}
		var tf toolFailure
		switch {
		case errors.As(err, &tf):
			// The server forgot the watch: it restarted or the watch expired.
			return end(watchID, "gone", err)
		case err != nil:
			return end(watchID, "broUnreachable", err)
		}
		cursor, _ = value["cursor"].(float64)
		if code, err := emit(value); code >= 0 || err != nil {
			return exitError{code, err}
		}
	}
}

// toolFailure is a browser.watch result marked isError.
type toolFailure string

func (t toolFailure) Error() string { return strings.TrimSpace(string(t)) }
