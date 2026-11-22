package settings

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func home(t *testing.T) string {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	return filepath.Join(dir, ".bro", "settings.json")
}

func TestLoadNeverCreatesSettings(t *testing.T) {
	path := home(t)
	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded without a settings file")
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("Load created %s: %v", filepath.Dir(path), err)
	}
}

func TestUnusableFilesArePreserved(t *testing.T) {
	for name, contents := range map[string]string{"malformed": "{not json", "empty token": `{"token":"  "}`} {
		t.Run(name, func(t *testing.T) {
			path := home(t)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadOrCreate(); err == nil {
				t.Fatal("unusable settings were accepted")
			}
			if got, _ := os.ReadFile(path); string(got) != contents {
				t.Fatalf("settings rewritten to %q", got)
			}
		})
	}
}

func TestCreatesPrivateSettings(t *testing.T) {
	path := home(t)
	s, err := LoadOrCreate()
	if err != nil {
		t.Fatal(err)
	}
	if s.Path != path || s.Token == "" {
		t.Fatalf("settings %q at %q", s.Path, path)
	}
	for p, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode %o, want %o", p, got, want)
		}
	}
	again, err := Load()
	if err != nil || again.Token != s.Token {
		t.Fatalf("reload: %v", err)
	}
}

func TestConcurrentCreatorsShareOneToken(t *testing.T) {
	path := home(t)
	const n = 16
	tokens := make([]string, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := LoadOrCreate()
			if err != nil {
				t.Error(err)
				return
			}
			tokens[i] = s.Token
		}()
	}
	wg.Wait()
	for _, token := range tokens {
		if token != tokens[0] {
			t.Fatal("creators returned different tokens")
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}
