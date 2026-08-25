//go:build !windows

package managerupdate

func LaunchInstaller(string, string) error { return ErrUpdateUnavailable }
