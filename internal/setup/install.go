package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/xiaotianxt/bro/internal/ids"
	"github.com/xiaotianxt/bro/internal/nativehost"
)

// StableExecutable is the running bro's path as it survives upgrades. A
// Homebrew keg path (…/Cellar/bro/<version>/bin/bro) is removed by the next
// upgrade's cleanup, so it maps to the keg's opt link when that exists.
func StableExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", err
	}
	return stablePath(resolved), nil
}

func stablePath(path string) string {
	sep := string(filepath.Separator)
	marker := sep + "Cellar" + sep + "bro" + sep
	i := strings.LastIndex(path, marker)
	if i < 0 {
		return path
	}
	_, rest, ok := strings.Cut(path[i+len(marker):], sep) // drop "<version>"
	if !ok {
		return path
	}
	opt := filepath.Join(path[:i], "opt", "bro", rest)
	if _, err := os.Stat(opt); err != nil {
		return path
	}
	return opt
}

// HomebrewManaged reports whether exe is a Homebrew install of bro: it
// resolves into a keg, as the opt link does.
func HomebrewManaged(exe string) bool {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	sep := string(filepath.Separator)
	return strings.Contains(exe, sep+"Cellar"+sep+"bro"+sep)
}

// hostBrowser is a Chromium-family browser bro can register its native host with.
type hostBrowser struct {
	Name string
	// dataDir is the browser's user data directory under the platform's
	// application-data root; the host manifest goes in its
	// NativeMessagingHosts subdirectory.
	dataDir string
	// registryKey is the Windows key under HKCU\Software that lists hosts.
	registryKey string
}

var macBrowsers = []hostBrowser{
	{Name: "Google Chrome", dataDir: "Google/Chrome"},
	{Name: "Google Chrome Beta", dataDir: "Google/Chrome Beta"},
	{Name: "Google Chrome Dev", dataDir: "Google/Chrome Dev"},
	{Name: "Google Chrome Canary", dataDir: "Google/Chrome Canary"},
	{Name: "Chromium", dataDir: "Chromium"},
	{Name: "Brave", dataDir: "BraveSoftware/Brave-Browser"},
	{Name: "Microsoft Edge", dataDir: "Microsoft Edge"},
	{Name: "Microsoft Edge Beta", dataDir: "Microsoft Edge Beta"},
	{Name: "Microsoft Edge Dev", dataDir: "Microsoft Edge Dev"},
	{Name: "Arc", dataDir: "Arc/User Data"},
	{Name: "Vivaldi", dataDir: "Vivaldi"},
	{Name: "Helium", dataDir: "net.imput.helium"},
}

var linuxBrowsers = []hostBrowser{
	{Name: "Google Chrome", dataDir: "google-chrome"},
	{Name: "Google Chrome Beta", dataDir: "google-chrome-beta"},
	{Name: "Google Chrome Dev", dataDir: "google-chrome-unstable"},
	{Name: "Chromium", dataDir: "chromium"},
	{Name: "Brave", dataDir: "BraveSoftware/Brave-Browser"},
	{Name: "Microsoft Edge", dataDir: "microsoft-edge"},
	{Name: "Vivaldi", dataDir: "vivaldi"},
	{Name: "Helium", dataDir: "net.imput.helium"},
}

// Windows browsers read the registry, which works whether or not the browser
// is installed yet, so every one is registered.
var windowsBrowsers = []hostBrowser{
	{Name: "Google Chrome", registryKey: `Google\Chrome`},
	{Name: "Chromium", registryKey: `Chromium`},
	{Name: "Brave", registryKey: `BraveSoftware\Brave-Browser`},
	{Name: "Microsoft Edge", registryKey: `Microsoft\Edge`},
}

// NativeHostReport lists where the native host was registered.
type NativeHostReport struct {
	Executable string   `json:"executable"`
	Browsers   []string `json:"browsers"`
}

func hostManifest(exe string) ([]byte, error) {
	origins := make([]string, len(nativehost.ExtensionIDs))
	for i, id := range nativehost.ExtensionIDs {
		origins[i] = "chrome-extension://" + id + "/"
	}
	data, err := json.MarshalIndent(map[string]any{
		"name":            nativehost.Name,
		"description":     "bro local pairing: hands the bro extension its local token",
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": origins,
	}, "", "  ")
	return append(data, '\n'), err
}

// InstallNativeHost registers exe as the bro native messaging host for every
// browser found under appData (the platform's application-data root).
func InstallNativeHost(exe, appData string) (NativeHostReport, error) {
	report := NativeHostReport{Executable: exe, Browsers: []string{}}
	manifest, err := hostManifest(exe)
	if err != nil {
		return report, err
	}
	file := nativehost.Name + ".json"
	if runtime.GOOS == "windows" {
		path := filepath.Join(appData, "bro", file)
		if err := writeFileAtomic(path, manifest, 0o644); err != nil {
			return report, err
		}
		for _, b := range windowsBrowsers {
			key := `HKCU\Software\` + b.registryKey + `\NativeMessagingHosts\` + nativehost.Name
			if out, err := exec.Command("reg", "add", key, "/ve", "/t", "REG_SZ", "/d", path, "/f").CombinedOutput(); err != nil {
				return report, fmt.Errorf("register native host for %s: %v: %s", b.Name, err, strings.TrimSpace(string(out)))
			}
			report.Browsers = append(report.Browsers, b.Name)
		}
		return report, nil
	}
	browsers := linuxBrowsers
	if runtime.GOOS == "darwin" {
		browsers = macBrowsers
	}
	for _, b := range browsers {
		dataDir := filepath.Join(appData, filepath.FromSlash(b.dataDir))
		if info, err := os.Stat(dataDir); err != nil || !info.IsDir() {
			continue
		}
		path := filepath.Join(dataDir, "NativeMessagingHosts", file)
		if err := writeFileAtomic(path, manifest, 0o644); err != nil {
			return report, err
		}
		report.Browsers = append(report.Browsers, b.Name)
	}
	return report, nil
}

// AppDataDir is where Chromium-family browsers keep user data on this
// platform: ~/Library/Application Support, $XDG_CONFIG_HOME or ~/.config,
// and %LOCALAPPDATA% on Windows.
func AppDataDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return dir, nil
		}
		return "", errors.New("LOCALAPPDATA is not set")
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support"), nil
	default:
		if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
			return dir, nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".config"), nil
	}
}

func writeFileAtomic(path string, data []byte, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp-" + ids.UUID()
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// treeDigest hashes every regular file's relative path and content, so two
// directories with the same digest hold the same extension.
func treeDigest(root string) (string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(rel))
		} else if !d.IsDir() {
			return fmt.Errorf("%s is not a regular file or directory", path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	h := sha256.New()
	for _, rel := range files {
		f, err := os.Open(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%s\x00", rel)
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return "", err
		}
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// InstallExtension makes dst an exact copy of the packaged extension src and
// reports whether anything changed. The browser keeps loading dst across bro
// upgrades, so dst is replaced as a whole: a reader never sees half a version.
func InstallExtension(src, dst string) (bool, error) {
	want, err := treeDigest(src)
	if err != nil {
		return false, fmt.Errorf("read packaged extension %s: %w", src, err)
	}
	if have, err := treeDigest(dst); err == nil && have == want {
		return false, nil
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, fmt.Errorf("read installed extension %s: %w", dst, err)
	}
	staging := dst + ".new-" + ids.UUID()
	if err := copyTree(src, staging); err != nil {
		_ = os.RemoveAll(staging)
		return false, fmt.Errorf("copy extension to %s: %w", staging, err)
	}
	old := dst + ".old-" + ids.UUID()
	if err := os.Rename(dst, old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		_ = os.RemoveAll(staging)
		return false, fmt.Errorf("move aside %s: %w", dst, err)
	}
	if err := os.Rename(staging, dst); err != nil {
		_ = os.Rename(old, dst)
		_ = os.RemoveAll(staging)
		return false, fmt.Errorf("install extension at %s: %w", dst, err)
	}
	if err := os.RemoveAll(old); err != nil {
		return true, fmt.Errorf("remove previous extension %s: %w", old, err)
	}
	return true, nil
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	})
}
