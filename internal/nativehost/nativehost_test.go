package nativehost

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"
)

func frame(t *testing.T, payload string) *bytes.Buffer {
	t.Helper()
	var b bytes.Buffer
	if err := binary.Write(&b, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatal(err)
	}
	b.WriteString(payload)
	return &b
}

func unframe(t *testing.T, b *bytes.Buffer) Reply {
	t.Helper()
	var n uint32
	if err := binary.Read(b, binary.LittleEndian, &n); err != nil {
		t.Fatal(err)
	}
	if int(n) != b.Len() {
		t.Fatalf("frame length %d, payload %d", n, b.Len())
	}
	var r Reply
	if err := json.Unmarshal(b.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestServeAnswersPairWithTheToken(t *testing.T) {
	var out bytes.Buffer
	err := Serve(frame(t, `{"type":"pair"}`), &out, "9.9.9", func() (string, error) { return "tok", nil })
	if err != nil {
		t.Fatal(err)
	}
	if r := unframe(t, &out); r.Token != "tok" || r.Version != "9.9.9" || r.Error != "" {
		t.Fatalf("reply = %+v", r)
	}
}

func TestServeRepliesWithAnErrorItCannotAnswer(t *testing.T) {
	for name, tc := range map[string]struct {
		payload string
		token   func() (string, error)
	}{
		"unknown type":   {`{"type":"other"}`, func() (string, error) { return "tok", nil }},
		"not an object":  {`[1]`, func() (string, error) { return "tok", nil }},
		"settings error": {`{"type":"pair"}`, func() (string, error) { return "", errors.New("settings malformed") }},
	} {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			if err := Serve(frame(t, tc.payload), &out, "1", tc.token); err != nil {
				t.Fatal(err)
			}
			if r := unframe(t, &out); r.Token != "" || r.Error == "" {
				t.Fatalf("reply = %+v", r)
			}
		})
	}
}

func TestServeRejectsAnOversizedFrame(t *testing.T) {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, uint32(maxMessage+1))
	var out bytes.Buffer
	if err := Serve(&b, &out, "1", func() (string, error) { return "tok", nil }); err == nil || out.Len() != 0 {
		t.Fatalf("err = %v, wrote %d bytes", err, out.Len())
	}
}

func TestIsLaunch(t *testing.T) {
	if !IsLaunch([]string{"chrome-extension://abc/", "--parent-window=0"}) || IsLaunch([]string{"serve"}) || IsLaunch(nil) {
		t.Fatal("IsLaunch misclassified its arguments")
	}
}
