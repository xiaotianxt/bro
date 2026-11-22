//go:build credtest

package credentials

import "os"

// providerExecutable: a credtest build only runs the disposable provider the
// test names, so it can never read a real vault.
func providerExecutable() (string, error) {
	path := os.Getenv("BRO_TEST_OP")
	if path == "" {
		return "", failure("Test build requires an explicit disposable provider; real vault access disabled")
	}
	return path, nil
}

// VersionSuffix marks builds whose provider is not the real 1Password CLI.
const VersionSuffix = "+credential-test-provider"
