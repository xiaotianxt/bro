package credentials

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustPage(t *testing.T, raw string) page {
	t.Helper()
	p, err := checkedURL(raw)
	if err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return p
}

func TestOriginIsCanonicalAndHTTPSOnly(t *testing.T) {
	if got := mustPage(t, "https://EXAMPLE.com/a?q=1").origin(); got != "https://example.com" {
		t.Errorf("origin %q", got)
	}
	if got := mustPage(t, "http://localhost:1234/").origin(); got != "http://localhost:1234" {
		t.Errorf("origin %q", got)
	}
	if got := mustPage(t, "https://bücher.example:443/").origin(); got != "https://xn--bcher-kva.example" {
		t.Errorf("origin %q", got)
	}
	for _, bad := range []string{"https://user:password@example.com/", "http://example.com/", "example.com", "mailto:a@example.com"} {
		if _, err := checkedURL(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestWebsitesMatchByRegistrableDomainNotSubstring(t *testing.T) {
	pnc := mustPage(t, "https://www.pnc.com/en/personal-banking.html")
	uk := mustPage(t, "https://a.co.uk/")
	gh := mustPage(t, "https://alice.github.io/")
	local := mustPage(t, "http://localhost:8080/")
	for _, c := range []struct {
		href string
		page page
		want match
	}{
		{"https://www.pnc.com/login", pnc, exact},
		{"https://secure.pnc.com", pnc, sameSite},
		{"pnc.com", pnc, sameSite},
		{"https://evilpnc.com", pnc, noMatch},
		{"https://pnc.com.evil.test", pnc, noMatch},
		{"http://secure.pnc.com", pnc, noMatch},
		{"https://secure.pnc.com:444", pnc, noMatch},
		// Public suffixes, including the private section, are not one site.
		{"https://b.co.uk", uk, noMatch},
		{"https://bob.github.io", gh, noMatch},
		// IP and loopback hosts only match exactly.
		{"http://localhost:8080/x", local, exact},
		{"http://127.0.0.1:8080", local, noMatch},
	} {
		if got := websiteMatch(c.href, c.page); got != c.want {
			t.Errorf("websiteMatch(%q, %s) = %v, want %v", c.href, c.page.origin(), got, c.want)
		}
	}
}

func TestItemMatchPrefersExactOrigin(t *testing.T) {
	var it item
	if err := json.Unmarshal([]byte(`{"id":"a","vault":{"id":"v"},"urls":[{"href":"https://pnc.com"},{"href":"https://secure.pnc.com"}]}`), &it); err != nil {
		t.Fatal(err)
	}
	if got := itemMatch(&it, mustPage(t, "https://secure.pnc.com/web-auth")); got != exact {
		t.Fatalf("match %v", got)
	}
}

func TestUntrustedErrorsNeverEchoProviderOrPageValues(t *testing.T) {
	_, err := safeStatus(map[string]any{"status": "secret-canary", "error": "secret-canary"})
	if err == nil || strings.Contains(err.Error(), "secret-canary") {
		t.Fatalf("status error %v", err)
	}
	reveal := "--reveal"
	if scope(&reveal) == nil {
		t.Fatal("flag-shaped scope accepted")
	}
}
