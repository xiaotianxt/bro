package e2e

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

const enoughText = "This page contains enough readable content to satisfy the normal text readiness contract. The batch must reach explicit cleanup before its deadline expires."

func TestBatchFlowRecordsOwnershipBeforeReadinessAndNeverEvaluatesOnFailure(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		s := startServer(t)
		ext := s.connectExt(t, "a")
		c := s.client(t)
		timeoutMs := 12000
		if timeout {
			timeoutMs = 100
		}
		p := c.Start("browser.batch.flow", j(`{"urls":["https://slow.test"],"steps":[{"type":"eval","code":"document.URL"}],"timeoutMs":%d}`, timeoutMs))
		create := ext.NextTool("tabs_create")
		equalJSON(t, create.Args["url"], `"about:blank"`)
		ext.Reply(create, "Created tab: 42")
		navigate := ext.NextTool("navigate")
		if !timeout {
			ext.ReplyFailed(navigate, "readiness unmet")
		}
		close := ext.NextTool("tabs_close")
		equalJSON(t, close.Args["tabId"], `42`)
		ext.Reply(close, "closed")
		equalJSON(t, p.Wait().Get("results", 0, "status"), `"failed"`)
		ext.Quiet()
		// The extension's interruption reply after the owning tab closed is ignored.
		if timeout {
			ext.ReplyFailed(navigate, "interrupted")
			ext.Quiet()
		}
	}
}

func TestBatchAcquisitionTimeoutReclaimsTheLateTab(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("browser.batch.flow", j(`{"urls":["https://slow.invalid"],"timeoutMs":10,"steps":[{"type":"eval","code":"mustNotRun()"}]}`))
	create := ext.NextTool("tabs_create")
	equalJSON(t, p.Wait().Get("results", 0, "status"), `"failed"`)
	ext.Reply(create, "Created tab: 42")
	close := ext.NextTool("tabs_close")
	equalJSON(t, close.Args["tabId"], `42`)
	ext.Reply(close, "closed")
	ext.Quiet()
}

func TestLateAllocationCleanupNeverClosesAReplacementConnectionsTab(t *testing.T) {
	s := startServer(t)
	first := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("browser.batch.flow", j(`{"urls":["https://slow.invalid"],"timeoutMs":10,"steps":[{"type":"eval","code":"mustNotRun()"}]}`))
	create := first.NextTool("tabs_create")
	p.Wait()
	replacement := s.connectExt(t, "a")
	first.Reply(create, "Created tab: 42")
	replacement.Quiet()
	first.Quiet()
}

func TestCancelledOpenCleansTheLateAllocation(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("browser.open", j(`{"url":"https://test.invalid","observe":false}`))
	create := ext.NextTool("tabs_create")
	p.Cancel()
	// Reply only once the server has seen the cancellation; before that the
	// open may legitimately complete.
	s.waitLog(t, "cancelled")
	ext.Reply(create, "Created tab: 42")
	close := ext.NextTool("tabs_close")
	equalJSON(t, close.Args["tabId"], `42`)
	ext.Reply(close, "closed")
	ext.Quiet()
	// The cancelled open never became this session's default target.
	isErrorWith(t, c.Call("browser.observe", j(`{}`)), "targetId is required")
}

var cleanupTarget = regexp.MustCompile(`targetId (\S+?):`)

func TestFailedBatchCleanupRetainsTheTargetForExplicitRetry(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	p := c.Start("browser.batch.flow", j(`{"urls":["https://test.invalid"],"steps":[{"type":"eval","code":"document.URL"}]}`))
	ext.Reply(ext.NextTool("tabs_create"), "Created tab: 42")
	ext.Reply(ext.NextTool("navigate"), "ready")
	ext.Reply(ext.NextTool("javascript_tool"), "evaluated")
	ext.ReplyError(ext.NextTool("tabs_close"), "removal denied")
	r := p.Wait()
	equalJSON(t, r.Get("results", 0, "status"), `"failed"`)
	match := cleanupTarget.FindStringSubmatch(r.Str("results", 0, "error"))
	if match == nil {
		t.Fatalf("cleanup error names no targetId: %v", r.Get("results", 0))
	}
	// Failed cleanup must not silently retry.
	ext.Quiet()

	p = c.Start("browser.close", j(`{"targetId":%q}`, match[1]))
	ext.Reply(ext.NextTool("tabs_close"), "closed")
	equalJSON(t, p.Wait().Get("closed"), `true`)
}

var loggedTarget = regexp.MustCompile(`target_id="?([^"\s]+)`)

// Cleanup that is still in flight at the batch deadline keeps its owner: no
// duplicate close, a logged target for retry, and never a retry on a
// replacement connection that may reuse the tab id.
func TestBatchCleanupOutlivesTheDeadlineWithoutDuplicateClose(t *testing.T) {
	for _, outcome := range []string{"failure", "success", "replacement", "timeout"} {
		t.Run(outcome, func(t *testing.T) {
			s := startServer(t)
			ext := s.connectExt(t, "a")
			c := s.client(t)
			p := c.Start("browser.batch.flow", j(`{"urls":["https://test.invalid"],"timeoutMs":300,"steps":[{"type":"eval","code":"document.URL"}]}`))
			ext.Reply(ext.NextTool("tabs_create"), "Created tab: 42")
			ext.Reply(ext.NextTool("navigate"), "ready")
			ext.Reply(ext.NextTool("javascript_tool"), enoughText)
			close := ext.NextTool("tabs_close")
			equalJSON(t, close.Args["tabId"], `42`)
			logStart := len(s.Logs())

			r := p.Wait()
			equalJSON(t, r.Get("results", 0, "status"), `"failed"`)
			contains(t, r.Str("results", 0, "error"), "operation timed out")
			contains(t, r.Str("results", 0, "error"), "cleanup scheduled")
			ext.Quiet()

			var replacement *Ext
			switch outcome {
			case "replacement":
				replacement = s.connectExt(t, "a")
				ext.ReplyError(close, "removal denied")
			case "timeout":
				time.Sleep(2200 * time.Millisecond) // the cleanup's own 2 s timeout
			case "success":
				ext.Reply(close, "closed")
			default:
				ext.ReplyError(close, "removal denied")
			}
			ext.Quiet()
			logs := s.Logs()[logStart:]
			if outcome == "success" {
				if strings.Contains(logs, "cleanup failed") {
					t.Fatalf("successful cleanup logged a failure:\n%s", logs)
				}
				return
			}
			contains(t, logs, "owned tab cleanup failed; ownership retained")
			contains(t, logs, "tab_id=42")
			if outcome == "timeout" {
				contains(t, logs, "cleanup timed out")
			} else {
				contains(t, logs, "removal denied")
			}
			target := loggedTarget.FindStringSubmatch(logs)
			if target == nil {
				t.Fatalf("no target_id in:\n%s", logs)
			}
			switch outcome {
			case "replacement":
				r := c.Call("browser.close", j(`{"targetId":%q}`, target[1]))
				equalJSON(t, r.Get("closed"), `false`)
				equalJSON(t, r.Get("status"), `"failed"`)
				replacement.Quiet()
			case "failure":
				p := c.Start("browser.close", j(`{"targetId":%q}`, target[1]))
				retry := ext.NextTool("tabs_close")
				equalJSON(t, retry.Args["tabId"], `42`)
				ext.Reply(retry, "closed")
				equalJSON(t, p.Wait().Get("closed"), `true`)
			case "timeout":
				// A timeout is uncertain, not permission to send another removal.
				ext.Reply(close, "late close reply")
			}
			ext.Quiet()
		})
	}
}

func TestClosedClientSessionCleansTheLateAllocation(t *testing.T) {
	s := startServer(t)
	ext := s.connectExt(t, "a")
	c := s.client(t)
	c.Start("browser.open", j(`{"url":"https://test.invalid","observe":false}`))
	create := ext.NextTool("tabs_create")
	// The client ends its session mid-call (DELETE /mcp): the in-flight open is
	// cancelled, so the tab that arrives later is closed instead of left open
	// and unknown.
	req, err := http.NewRequest(http.MethodDelete, s.URL("/mcp"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Mcp-Session-Id", c.session.ID())
	resp, err := (&http.Client{Transport: bearer{http.DefaultTransport}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	s.waitLog(t, "cancelled")
	ext.Reply(create, "Created tab: 42")
	close := ext.NextTool("tabs_close")
	equalJSON(t, close.Args["tabId"], `42`)
	ext.Reply(close, "closed")
	ext.Quiet()
}
