package runtime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRunner struct {
	path         string
	lookErr      error
	output       string
	nodePath     string
	nodeOut      string
	runErr       error
	openclawPath string
	openclawOut  string
	openclawErr  error
	npmPrefix    string
	diskFree     int64
	diskErr      error
	lastName     string
	lastArgs     []string
	lastEnv      []string
	installCalls int
}

func (f *fakeRunner) LookPath(file string) (string, error) {
	if f.lookErr != nil {
		return "", f.lookErr
	}
	switch file {
	case "node":
		if f.nodePath == "" {
			return "", exec.ErrNotFound
		}
		return f.nodePath, nil
	case "npm":
		if f.path != "npm" {
			return "", exec.ErrNotFound
		}
		return f.path, nil
	case "openclaw":
		if f.openclawPath != "" {
			return f.openclawPath, nil
		}
		if f.path == "openclaw" || strings.Contains(strings.ToLower(f.path), "openclaw") {
			return f.path, nil
		}
		return "", exec.ErrNotFound
	}
	return f.path, nil
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.lastName = name
	f.lastArgs = append([]string(nil), args...)
	if len(args) > 0 && args[0] == "install" {
		f.installCalls++
	}
	if name == f.nodePath {
		return []byte(f.nodeOut), nil
	}
	if len(args) == 2 && args[0] == "prefix" && args[1] == "-g" {
		return []byte(f.npmPrefix), nil
	}
	if f.openclawPath != "" && name == f.openclawPath {
		output := f.openclawOut
		if output == "" {
			output = f.output
		}
		return []byte(output), f.openclawErr
	}
	if name == "openclaw" && f.path == "openclaw" {
		output := f.openclawOut
		if output == "" {
			output = f.output
		}
		return []byte(output), f.openclawErr
	}
	return []byte(f.output), f.runErr
}

func (f *fakeRunner) InstallFreeBytes(context.Context, string) (int64, error) {
	if f.diskErr != nil {
		return 0, f.diskErr
	}
	if f.diskFree == 0 {
		return 1 << 40, nil
	}
	return f.diskFree, nil
}

func (f *fakeRunner) RunWithEnv(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.lastEnv = append([]string(nil), env...)
	return f.Run(context.Background(), name, args...)
}

type preflightProbeRunner struct {
	*fakeRunner
	prefixWritable *bool
	configReadable *bool
}

type preflightResolverRunner struct {
	*preflightProbeRunner
	resolvePath string
	resolveErr  error
}

func (r *preflightResolverRunner) ResolveOpenClaw(context.Context) (string, error) {
	return r.resolvePath, r.resolveErr
}

type preflightDirectErrorRunner struct {
	*preflightProbeRunner
	openclawErr error
}

func (r *preflightDirectErrorRunner) LookPath(file string) (string, error) {
	if file == "openclaw" {
		return "", r.openclawErr
	}
	return r.preflightProbeRunner.LookPath(file)
}

func (r *preflightProbeRunner) InspectInstallPath(ctx context.Context, path string, kind InstallPathKind) (bool, bool, error) {
	if kind == InstallPathNpmPrefix && r.prefixWritable != nil {
		return true, *r.prefixWritable, nil
	}
	if kind == InstallPathConfig && r.configReadable != nil {
		return *r.configReadable, false, nil
	}
	return (OSCommandRunner{}).InspectInstallPath(ctx, path, kind)
}

func testPreflightOptions(prefix string) InstallPreflightOptions {
	return InstallPreflightOptions{
		NpmPrefix:     prefix,
		ConfigPath:    filepath.Join(prefix, "openclaw.json"),
		WorkspacePath: filepath.Join(prefix, "workspace"),
		MinFreeBytes:  1,
	}
}

func newPreflightFixture(t *testing.T) (*preflightProbeRunner, InstallPreflightOptions) {
	t.Helper()
	prefix := t.TempDir()
	options := testPreflightOptions(prefix)
	if err := os.WriteFile(options.ConfigPath, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(options.WorkspacePath, 0700); err != nil {
		t.Fatal(err)
	}
	runner := &preflightProbeRunner{fakeRunner: &fakeRunner{
		path:     "npm",
		nodePath: "node",
		nodeOut:  "v24.15.0",
		diskFree: 1 << 30,
	}}
	return runner, options
}

func TestInstallPreflightPassesReadOnlyForFreshNativeInstall(t *testing.T) {
	runner, options := newPreflightFixture(t)
	entriesBefore, err := os.ReadDir(filepath.Dir(options.ConfigPath))
	if err != nil {
		t.Fatal(err)
	}
	report, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.Ready || !report.NodeCompatible || !report.NpmCommandFound || report.OpenClawCommandFound {
		t.Fatalf("unexpected preflight report: %+v", report)
	}
	entriesAfter, err := os.ReadDir(filepath.Dir(options.ConfigPath))
	if err != nil {
		t.Fatal(err)
	}
	if len(entriesBefore) != len(entriesAfter) {
		t.Fatalf("preflight must not write user directory: before=%v after=%v", entriesBefore, entriesAfter)
	}
}

func TestInstallPreflightRejectsIncompatibleExistingOpenClaw(t *testing.T) {
	runner, options := newPreflightFixture(t)
	runner.openclawPath = "openclaw"
	runner.openclawOut = "OpenClaw 2026.7.1-1"
	_, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if !errors.Is(err, ErrInstallOpenClawIncompatible) {
		t.Fatalf("expected pinned OpenClaw version gate, got %v", err)
	}
}

func TestInstallPreflightDoesNotTreatResolverFailureAsFreshInstall(t *testing.T) {
	base, options := newPreflightFixture(t)
	runner := &preflightResolverRunner{
		preflightProbeRunner: base,
		resolveErr:           errors.New("npm global prefix is unavailable"),
	}
	_, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if !errors.Is(err, ErrInstallOpenClawUnavailable) {
		t.Fatalf("expected resolver failure to fail closed, got %v", err)
	}
	if base.installCalls != 0 {
		t.Fatal("preflight resolver failure must not execute npm install")
	}
}

func TestInstallPreflightAcceptsExplicitNotFoundResolverSentinel(t *testing.T) {
	base, options := newPreflightFixture(t)
	runner := &preflightResolverRunner{
		preflightProbeRunner: base,
		resolveErr:           ErrOpenClawCommandNotFound,
	}
	report, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if err != nil || !report.Ready || report.OpenClawCommandFound {
		t.Fatalf("explicit not-found sentinel should permit fresh install: report=%+v err=%v", report, err)
	}
}

func TestInstallPreflightRejectsNonNotFoundDiscoveryError(t *testing.T) {
	base, options := newPreflightFixture(t)
	runner := &preflightDirectErrorRunner{
		preflightProbeRunner: base,
		openclawErr:          errors.New("permission denied while inspecting shim"),
	}
	_, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if !errors.Is(err, ErrInstallOpenClawUnavailable) {
		t.Fatalf("expected non-not-found discovery error to fail closed, got %v", err)
	}
}

func TestInstallPreflightRejectsMissingNpmAndNode(t *testing.T) {
	_, options := newPreflightFixture(t)
	npmMissing := &fakeRunner{nodePath: "node", nodeOut: "v24.15.0", diskFree: 1 << 30}
	if _, err := NewNativeAdapterWithOptions(npmMissing, options).InstallPreflight(context.Background()); !errors.Is(err, ErrInstallNpmUnavailable) {
		t.Fatalf("expected missing npm gate, got %v", err)
	}
	nodeMissing := &fakeRunner{path: "npm", diskFree: 1 << 30}
	if _, err := NewNativeAdapterWithOptions(nodeMissing, options).InstallPreflight(context.Background()); !errors.Is(err, ErrInstallNodeUnavailable) {
		t.Fatalf("expected missing Node gate, got %v", err)
	}
}

func TestInstallPreflightRejectsNonWritablePrefix(t *testing.T) {
	runner, options := newPreflightFixture(t)
	writable := false
	runner.prefixWritable = &writable
	_, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if !errors.Is(err, ErrInstallPrefixNotWritable) {
		t.Fatalf("expected npm prefix permission gate, got %v", err)
	}
}

func TestInstallPreflightRejectsUnreadableWorkspaceAndConfig(t *testing.T) {
	runner, options := newPreflightFixture(t)
	if err := os.Remove(options.ConfigPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(options.ConfigPath, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background()); !errors.Is(err, ErrInstallConfigUnreadable) {
		t.Fatalf("expected config type/readability gate, got %v", err)
	}

	if err := os.RemoveAll(options.ConfigPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(options.ConfigPath, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(options.WorkspacePath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(options.WorkspacePath, []byte("not-a-directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background()); !errors.Is(err, ErrInstallWorkspaceUnreadable) {
		t.Fatalf("expected workspace type/readability gate, got %v", err)
	}
}

func TestInstallPreflightRejectsSymlinkConfig(t *testing.T) {
	runner, options := newPreflightFixture(t)
	target := filepath.Join(filepath.Dir(options.ConfigPath), "real-config.json")
	if err := os.WriteFile(target, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(options.ConfigPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, options.ConfigPath); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background()); !errors.Is(err, ErrInstallConfigUnreadable) {
		t.Fatalf("expected symlink config gate, got %v", err)
	}
}

func TestInstallPreflightRejectsLowDisk(t *testing.T) {
	runner, options := newPreflightFixture(t)
	runner.diskFree = 1
	options.MinFreeBytes = 2
	_, err := NewNativeAdapterWithOptions(runner, options).InstallPreflight(context.Background())
	if !errors.Is(err, ErrInstallDiskInsufficient) {
		t.Fatalf("expected disk threshold gate, got %v", err)
	}
}

func TestDiscoverNativeOpenClaw(t *testing.T) {
	adapter := NewNativeAdapter(&fakeRunner{path: `C:\Users\demo\AppData\Roaming\npm\openclaw.cmd`, output: "OpenClaw 2026.7.1-2\n"})
	status := adapter.Discover(context.Background())
	if status.State != StateDiscovered || status.Version != "2026.7.1-2" {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestDiscoverMissingRuntimeDoesNotInventInstall(t *testing.T) {
	status := NewNativeAdapter(&fakeRunner{lookErr: errors.New("not found")}).Discover(context.Background())
	if status.State != StateUninstalled {
		t.Fatalf("expected uninstalled, got %+v", status)
	}
}

func TestRunControlUsesAllowlistedOfficialCommand(t *testing.T) {
	runner := &fakeRunner{path: "openclaw", output: "ok"}
	_, err := NewNativeAdapter(runner).RunControl(context.Background(), "doctor")
	if err != nil {
		t.Fatal(err)
	}
	if runner.lastName != "openclaw" || len(runner.lastArgs) != 2 || runner.lastArgs[0] != "doctor" || runner.lastArgs[1] != "--non-interactive" {
		t.Fatalf("unexpected command: %s %v", runner.lastName, runner.lastArgs)
	}
}

func TestRunControlRejectsUnknownAction(t *testing.T) {
	_, err := NewNativeAdapter(&fakeRunner{path: "openclaw"}).RunControl(context.Background(), "shell")
	if err == nil {
		t.Fatal("expected unknown action to fail")
	}
}

func TestDiscoverReportsCompatibleNode(t *testing.T) {
	runner := &fakeRunner{
		path:     "openclaw",
		output:   "OpenClaw 2026.7.1-2",
		nodePath: "node",
		nodeOut:  "v22.22.3",
	}
	status := NewNativeAdapter(runner).Discover(context.Background())
	if !status.NodeOK || status.NodeVersion != "22.22.3" {
		t.Fatalf("expected compatible Node, got %+v", status)
	}
}

func TestNativeInstallUsesFixedOfficialPackage(t *testing.T) {
	prefix := t.TempDir()
	runner := &fakeRunner{
		path:     "npm",
		output:   "installed",
		nodePath: "node",
		nodeOut:  "v24.15.0",
	}
	adapter := NewNativeAdapterWithOptions(runner, InstallPreflightOptions{
		NpmPrefix:     prefix,
		ConfigPath:    filepath.Join(prefix, "openclaw.json"),
		WorkspacePath: filepath.Join(prefix, "workspace"),
		MinFreeBytes:  1,
	})
	plan, err := adapter.NativeInstallPlan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Package != OpenClawPackage || len(plan.Args) != 5 || plan.Args[4] != OpenClawPackage {
		t.Fatalf("unexpected install plan: %+v", plan)
	}
	if _, err := adapter.InstallNative(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.lastName != "npm" || runner.lastArgs[0] != "install" || runner.lastArgs[1] != "--global" {
		t.Fatalf("unexpected install command: %s %v", runner.lastName, runner.lastArgs)
	}
}

func TestUnsupportedNodeIsRejectedForInstallPlan(t *testing.T) {
	runner := &fakeRunner{path: "npm", nodePath: "node", nodeOut: "v23.0.0"}
	if _, err := NewNativeAdapter(runner).NativeInstallPlan(context.Background()); err == nil {
		t.Fatal("expected unsupported Node to reject install plan")
	}
}

func TestValidateConfigCandidateUsesNativeOpenClawValidator(t *testing.T) {
	config := t.TempDir() + "/candidate.json"
	if err := os.WriteFile(config, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{path: "openclaw", output: `{"valid":true}`}
	if err := NewNativeAdapter(runner).ValidateConfigCandidate(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	if runner.lastName != "openclaw" || len(runner.lastArgs) != 3 || runner.lastArgs[0] != "config" || runner.lastArgs[1] != "validate" || runner.lastArgs[2] != "--json" {
		t.Fatalf("unexpected validator command: %s %v", runner.lastName, runner.lastArgs)
	}
	if len(runner.lastEnv) != 1 || runner.lastEnv[0] == "OPENCLAW_CONFIG_PATH=" {
		t.Fatalf("missing candidate config override: %v", runner.lastEnv)
	}
}

func TestMergeEnvironmentReplacesConfigPathCaseInsensitively(t *testing.T) {
	merged := mergeEnvironment(
		[]string{"Path=C:\\Windows", "openclaw_config_path=old", "KEEP=yes"},
		[]string{"OPENCLAW_CONFIG_PATH=new"},
	)
	joined := strings.Join(merged, "|")
	if strings.Contains(joined, "=old") || !strings.Contains(joined, "OPENCLAW_CONFIG_PATH=new") || !strings.Contains(joined, "KEEP=yes") {
		t.Fatalf("unexpected merged environment: %v", merged)
	}
}
