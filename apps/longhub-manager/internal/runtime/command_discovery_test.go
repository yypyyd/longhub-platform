package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestNativeOpenClawCandidatesUseOnlyGlobalRoots(t *testing.T) {
	env := map[string]string{
		"APPDATA":      `C:\Users\demo\AppData\Roaming`,
		"LOCALAPPDATA": `C:\Users\demo\AppData\Local`,
		"USERPROFILE":  `C:\Users\demo`,
	}
	getenv := func(name string) string { return env[name] }
	candidates := nativeOpenClawCandidates(getenv, `C:\Users\demo\AppData\Local\npm`)
	if len(candidates) == 0 {
		t.Fatal("expected npm global candidates")
	}
	joined := strings.ToLower(strings.Join(candidates, "|"))
	for _, expected := range []string{"appdata\\roaming\\npm", "appdata\\local\\npm", ".local\\bin", "openclaw.cmd"} {
		if !strings.Contains(joined, strings.ToLower(expected)) {
			t.Fatalf("missing candidate root %q in %s", expected, joined)
		}
	}
	for _, candidate := range candidates {
		if strings.Contains(strings.ToLower(candidate), "longhub") {
			t.Fatalf("discovery must not search LongHub private directories: %s", candidate)
		}
	}
}

type resolverRunner struct {
	path    string
	resolve string
	output  string
}

func (r *resolverRunner) LookPath(string) (string, error) { return "", errors.New("not on PATH") }

func (r *resolverRunner) ResolveOpenClaw(context.Context) (string, error) { return r.resolve, nil }

func (r *resolverRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return []byte(r.output), nil
}

func TestNativeAdapterUsesTrustedGlobalResolverSeam(t *testing.T) {
	runner := &resolverRunner{resolve: `C:\Users\demo\AppData\Roaming\npm\openclaw.cmd`, output: "OpenClaw 2026.7.1-2"}
	status := NewNativeAdapter(runner).Discover(context.Background())
	if status.State != StateDiscovered || status.Command != runner.resolve {
		t.Fatalf("resolver path was not used: %+v", status)
	}
}
