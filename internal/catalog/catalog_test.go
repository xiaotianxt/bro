package catalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadPathsAreCheckedAndCanonical(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.txt")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	// The browser reads exactly the regular file that was checked.
	if got, err := CanonicalUploadPath("upload", link); err != nil || got != file {
		t.Fatalf("canonical %q, %v", got, err)
	}
	for path, want := range map[string]string{
		"a.txt":                       "path must be absolute",
		dir:                           "not a regular file",
		filepath.Join(dir, "missing"): "cannot open",
	} {
		if _, err := CanonicalUploadPath("upload", path); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: error %v, want %q", path, err, want)
		}
	}
}
