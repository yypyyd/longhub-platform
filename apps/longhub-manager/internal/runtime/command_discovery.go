package runtime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// OpenClawResolver is an optional extension to CommandRunner for installations
// that exist in npm's global prefix but are not currently on PATH.
type OpenClawResolver interface {
	ResolveOpenClaw(context.Context) (string, error)
}

type OpenClawResolverFunc func(context.Context) (string, error)

func (f OpenClawResolverFunc) ResolveOpenClaw(ctx context.Context) (string, error) {
	return f(ctx)
}

// findOpenClaw prefers the ordinary PATH lookup. Only the trusted OS runner
// may perform additional global-prefix discovery; an HTTP request cannot
// select a command path.
func findOpenClaw(ctx context.Context, runner CommandRunner) (string, error) {
	path, pathErr := runner.LookPath("openclaw")
	if pathErr == nil {
		return path, nil
	}
	if resolver, ok := runner.(OpenClawResolver); ok {
		return resolver.ResolveOpenClaw(ctx)
	}
	return "", pathErr
}

// ResolveOpenClaw exposes the fixed native discovery policy to the trusted
// Manager launcher. HTTP requests and Skills cannot call this function or
// provide a command path.
func ResolveOpenClaw(ctx context.Context, runner CommandRunner) (string, error) {
	if runner == nil {
		return "", errors.New("OpenClaw runner is unavailable")
	}
	return findOpenClaw(ctx, runner)
}

// LookPath keeps the standard PATH behavior and adds only fixed Windows npm
// shim locations. It never searches inside LongHub's installation directory.
func (OSCommandRunner) LookPath(file string) (string, error) {
	path, err := exec.LookPath(file)
	if err == nil || file != "openclaw" {
		return path, err
	}
	for _, candidate := range nativeOpenClawCandidates(os.Getenv, "") {
		if isRegularFile(candidate) {
			return candidate, nil
		}
	}
	return "", err
}

// ResolveOpenClaw additionally asks the fixed npm executable for its global
// prefix. The prefix is treated as discovery data only; no package is copied
// or installed by this method.
func (r OSCommandRunner) ResolveOpenClaw(ctx context.Context) (string, error) {
	if path, err := r.LookPath("openclaw"); err == nil {
		return path, nil
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		return "", errors.New("openclaw and npm are not on PATH")
	}
	output, err := exec.CommandContext(ctx, npm, "prefix", "-g").Output()
	if err != nil {
		return "", errors.New("npm global prefix unavailable")
	}
	prefix := strings.TrimSpace(string(output))
	if prefix == "" || strings.ContainsAny(prefix, "\x00\r\n") || !filepath.IsAbs(prefix) {
		return "", errors.New("npm global prefix is invalid")
	}
	for _, candidate := range nativeOpenClawCandidates(os.Getenv, filepath.Clean(prefix)) {
		if isRegularFile(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("openclaw is not installed in npm global prefix")
}

func nativeOpenClawCandidates(getenv func(string) string, npmPrefix string) []string {
	if runtime.GOOS != "windows" && npmPrefix == "" {
		return nil
	}
	roots := make([]string, 0, 5)
	if npmPrefix != "" {
		roots = append(roots, npmPrefix)
	}
	for _, value := range []string{
		getenv("APPDATA") + `\npm`,
		getenv("LOCALAPPDATA") + `\npm`,
		getenv("USERPROFILE") + `\.local\bin`,
	} {
		if strings.TrimSpace(value) != "\\npm" && strings.TrimSpace(value) != "\\.local\\bin" && value != "" {
			roots = append(roots, value)
		}
	}
	seen := make(map[string]struct{})
	candidates := make([]string, 0, len(roots)*3)
	for _, root := range roots {
		for _, name := range []string{"openclaw.cmd", "openclaw.exe", "openclaw"} {
			candidate := filepath.Join(root, name)
			key := strings.ToLower(filepath.Clean(candidate))
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
