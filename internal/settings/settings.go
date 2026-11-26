// Package settings owns ~/.bro/settings.json, which holds the local bridge token.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaotianxt/bro/internal/ids"
)

// Settings is a validated settings file.
type Settings struct {
	Token string
	Path  string
}

type file struct {
	Token string `json:"token"`
}

// Dir is ~/.bro, which holds the settings file and bro's installed files.
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".bro"), nil
}

// DefaultPath is ~/.bro/settings.json.
func DefaultPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// Load reads existing settings without creating or changing anything.
func Load() (Settings, error) {
	path, err := DefaultPath()
	if err != nil {
		return Settings{}, err
	}
	return read(path)
}

// LoadOrCreate reads settings, creating a private file with a new token when
// none exists. Malformed or empty-token files are left unchanged and reported.
func LoadOrCreate() (Settings, error) {
	path, err := DefaultPath()
	if err != nil {
		return Settings{}, err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Settings{}, fmt.Errorf("failed to prepare settings directory %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return Settings{}, fmt.Errorf("failed to prepare settings directory %s: %w", dir, err)
	}
	s, err := read(path)
	if errors.Is(err, fs.ErrNotExist) {
		return create(path)
	}
	return s, err
}

func read(path string) (Settings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Settings{}, fmt.Errorf("failed to read settings file %s: %w", path, err)
	}
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return Settings{}, fmt.Errorf("settings file %s is malformed: %w", path, err)
	}
	if strings.TrimSpace(f.Token) == "" {
		return Settings{}, fmt.Errorf("settings file %s contains an empty token", path)
	}
	return Settings{Token: f.Token, Path: path}, nil
}

// create publishes a complete file atomically: concurrent creators link the
// same name, and the loser reads the winner's token.
func create(path string) (Settings, error) {
	token := ids.UUID()
	data, err := json.MarshalIndent(file{Token: token}, "", "  ")
	if err != nil {
		return Settings{}, err
	}
	tmp := filepath.Join(filepath.Dir(path), ".settings-"+ids.UUID()+".tmp")
	if err := writeNew(tmp, append(data, '\n')); err != nil {
		return Settings{}, fmt.Errorf("failed to write temporary settings file %s: %w", tmp, err)
	}
	linkErr := os.Link(tmp, path)
	if err := os.Remove(tmp); err != nil {
		return Settings{}, fmt.Errorf("failed to remove temporary settings file %s: %w", tmp, err)
	}
	switch {
	case linkErr == nil:
		return Settings{Token: token, Path: path}, nil
	case errors.Is(linkErr, fs.ErrExist):
		return read(path)
	default:
		return Settings{}, fmt.Errorf("failed to publish settings file %s: %w", path, linkErr)
	}
}

func writeNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
