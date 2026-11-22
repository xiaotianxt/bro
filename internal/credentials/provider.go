//go:build !credtest

package credentials

func providerExecutable() (string, error) { return opPath(), nil }

// VersionSuffix marks builds whose provider is not the real 1Password CLI.
const VersionSuffix = ""
