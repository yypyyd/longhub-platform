package runtime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	stdRuntime "runtime"
	"strconv"
	"strings"
	"time"
)

// State describes only the native OpenClaw installation. LongHub manager state
// must never be confused with the user's OpenClaw workspace or config.
type State string

const (
	StateUninstalled       State = "uninstalled"
	StateDiscovered        State = "discovered"
	StateManagedExternally State = "managed_externally"
	StateUnsupported       State = "unsupported"
)

type Status struct {
	State       State  `json:"state"`
	Command     string `json:"command,omitempty"`
	Version     string `json:"version,omitempty"`
	NodeVersion string `json:"node_version,omitempty"`
	NodeOK      bool   `json:"node_compatible"`
	Message     string `json:"message,omitempty"`
}

// OpenClawPackage is pinned to the upstream release reviewed for the first
// Windows Manager milestone. The Manager never accepts a package name from a
// page or an OpenClaw model; changing this value requires a reviewed release.
const OpenClawPackage = "openclaw@2026.7.1-2"

// DefaultInstallMinFreeBytes is an explicit, conservative disk budget for a
// native OpenClaw installation.  It is a preflight threshold only: the
// Manager never reserves space or creates a probe file in the user's profile.
const DefaultInstallMinFreeBytes int64 = 512 * 1024 * 1024

// InstallPreflightOptions are resolved at Manager construction/startup time,
// never from an HTTP request.  Empty paths use the native OpenClaw defaults
// (OPENCLAW_* environment variables, then the current user's home directory).
// NpmPrefix is primarily useful for a reviewed platform adapter or tests; the
// ordinary Windows path is discovered with `npm prefix -g`.
type InstallPreflightOptions struct {
	ConfigPath    string
	WorkspacePath string
	NpmPrefix     string
	MinFreeBytes  int64
}

// InstallPathKind tells an optional platform probe what kind of path is being
// checked.  Probes must be read-only and must not create, delete, or rename
// anything in the user's directories.
type InstallPathKind string

const (
	InstallPathConfig    InstallPathKind = "config"
	InstallPathWorkspace InstallPathKind = "workspace"
	InstallPathNpmPrefix InstallPathKind = "npm_prefix"
)

// InstallPathProbe is an optional OS-specific seam.  The default implementation
// uses Lstat/Open and permission metadata; a Windows adapter can provide a
// stronger ACL check without changing the preflight contract.
type InstallPathProbe interface {
	InspectInstallPath(context.Context, string, InstallPathKind) (readable bool, writable bool, err error)
}

// DiskSpaceProbe is an optional platform seam used to obtain free bytes on the
// volume containing the npm prefix.  It must be read-only.
type DiskSpaceProbe interface {
	InstallFreeBytes(context.Context, string) (int64, error)
}

// InstallPreflightReport is intentionally metadata-only.  Absolute paths are
// retained for in-process diagnostics but are excluded from JSON so a future
// HTTP route cannot disclose the user's profile accidentally.
type InstallPreflightReport struct {
	Ready                bool   `json:"ready"`
	NodeVersion          string `json:"node_version,omitempty"`
	NodeCompatible       bool   `json:"node_compatible"`
	NpmCommandFound      bool   `json:"npm_found"`
	OpenClawCommandFound bool   `json:"openclaw_found"`
	OpenClawVersion      string `json:"openclaw_version,omitempty"`
	OpenClawCompatible   bool   `json:"openclaw_compatible"`
	NpmPrefix            string `json:"-"`
	NpmPrefixWritable    bool   `json:"npm_prefix_writable"`
	ConfigPresent        bool   `json:"config_present"`
	ConfigReadable       bool   `json:"config_readable"`
	WorkspacePresent     bool   `json:"workspace_present"`
	WorkspaceReadable    bool   `json:"workspace_readable"`
	FreeBytes            int64  `json:"free_bytes"`
	MinFreeBytes         int64  `json:"min_free_bytes"`
	ConfigPath           string `json:"-"`
	WorkspacePath        string `json:"-"`
	DiskPath             string `json:"-"`
	WritableCheckPath    string `json:"-"`
}

var (
	ErrInstallPreflight            = errors.New("native OpenClaw install preflight failed")
	ErrInstallNodeUnavailable      = errors.New("Node.js is unavailable")
	ErrInstallNodeIncompatible     = errors.New("Node.js version is incompatible")
	ErrInstallNpmUnavailable       = errors.New("npm is unavailable")
	ErrInstallOpenClawIncompatible = errors.New("existing OpenClaw version is incompatible")
	ErrInstallPrefixUnavailable    = errors.New("npm global prefix is unavailable")
	ErrInstallPrefixNotWritable    = errors.New("npm global prefix is not writable")
	ErrInstallConfigUnreadable     = errors.New("native OpenClaw config is not readable")
	ErrInstallWorkspaceUnreadable  = errors.New("native OpenClaw workspace is not readable")
	ErrInstallDiskUnavailable      = errors.New("free disk space is unavailable")
	ErrInstallDiskInsufficient     = errors.New("free disk space is below the install threshold")
	ErrInstallOpenClawUnavailable  = errors.New("native OpenClaw command is unavailable")
	// ErrOpenClawCommandNotFound is the only discovery result that permits a
	// fresh install to proceed without an existing OpenClaw command.  Resolver,
	// permission, malformed-prefix, and runner failures are deliberately kept
	// distinct and fail closed.
	ErrOpenClawCommandNotFound = errors.New("native OpenClaw command not found")
)

type openClawDiscoveryState uint8

const (
	openClawDiscoveryMissing openClawDiscoveryState = iota
	openClawDiscoveryFound
	openClawDiscoveryUnavailable
)

type openClawDiscoveryResult struct {
	state   openClawDiscoveryState
	command string
	err     error
}

type InstallPlan struct {
	Package string   `json:"package"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Reason  string   `json:"reason"`
}

type CommandRunner interface {
	LookPath(file string) (string, error)
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type OSCommandRunner struct{}

func (OSCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// RunWithEnv is used only for validation against a staged config candidate.
// It never accepts environment entries from an HTTP request.
func (OSCommandRunner) RunWithEnv(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = mergeEnvironment(os.Environ(), env)
	return command.CombinedOutput()
}

// InspectInstallPath is deliberately read-only.  It validates the object
// type, rejects a symlink at the selected path, and opens it to prove basic
// read access.  Permission bits are a conservative local signal; a platform
// adapter may implement stronger ACL evaluation through InstallPathProbe.
func (OSCommandRunner) InspectInstallPath(_ context.Context, path string, kind InstallPathKind) (bool, bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, false, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return false, false, errors.New("install path must not be a symlink")
	}
	wantDir := kind == InstallPathWorkspace || kind == InstallPathNpmPrefix
	if wantDir && !info.IsDir() {
		return false, false, errors.New("install path must be a directory")
	}
	if !wantDir && !info.Mode().IsRegular() {
		return false, false, errors.New("install path must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, false, err
	}
	defer file.Close()
	if wantDir {
		if _, readErr := file.Readdirnames(1); readErr != nil && !errors.Is(readErr, io.EOF) {
			return false, false, readErr
		}
	} else {
		var one [1]byte
		if _, readErr := file.Read(one[:]); readErr != nil && !errors.Is(readErr, io.EOF) {
			return false, false, readErr
		}
	}
	return true, info.Mode().Perm()&0222 != 0, nil
}

// InstallFreeBytes obtains free space without creating a probe file.  Windows
// uses the inbox PowerShell DriveInfo API; POSIX platforms use fixed `df -Pk`
// arguments.  The command and script are constants, and the path is passed as
// a positional argument rather than interpolated into shell source.
func (OSCommandRunner) InstallFreeBytes(ctx context.Context, path string) (int64, error) {
	if stdRuntime.GOOS == "windows" {
		powershell, err := exec.LookPath("powershell.exe")
		if err != nil {
			return 0, err
		}
		script := `& { param([string]$target); $root = [System.IO.Path]::GetPathRoot($target); if ([string]::IsNullOrWhiteSpace($root)) { exit 2 }; $drive = [System.IO.DriveInfo]::new($root); [Console]::Out.Write([int64]$drive.AvailableFreeSpace) }`
		output, err := exec.CommandContext(ctx, powershell, "-NoProfile", "-NonInteractive", "-Command", script, path).Output()
		if err != nil {
			return 0, err
		}
		return strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	}
	df, err := exec.LookPath("df")
	if err != nil {
		return 0, err
	}
	output, err := exec.CommandContext(ctx, df, "-Pk", "--", path).Output()
	if err != nil {
		return 0, err
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) < 2 {
		return 0, errors.New("df output is invalid")
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 4 {
		return 0, errors.New("df output is invalid")
	}
	kib, err := strconv.ParseInt(fields[3], 10, 64)
	if err != nil || kib < 0 || kib > (int64(^uint64(0)>>1)/1024) {
		return 0, errors.New("df free space is invalid")
	}
	return kib * 1024, nil
}

type environmentCommandRunner interface {
	RunWithEnv(ctx context.Context, env []string, name string, args ...string) ([]byte, error)
}

type NativeAdapter struct {
	runner    CommandRunner
	timeout   time.Duration
	gateway   *GatewayManager
	preflight InstallPreflightOptions
}

func NewNativeAdapter(runner CommandRunner) *NativeAdapter {
	return NewNativeAdapterWithOptions(runner, InstallPreflightOptions{})
}

// NewNativeAdapterWithOptions injects startup-only preflight paths and policy.
// The HTTP layer intentionally has no way to change these values.
func NewNativeAdapterWithOptions(runner CommandRunner, options InstallPreflightOptions) *NativeAdapter {
	return &NativeAdapter{
		runner:    runner,
		timeout:   15 * time.Second,
		gateway:   NewGatewayManager(runner),
		preflight: options,
	}
}

// GatewayStatus exposes the native Gateway manager without exposing a second
// OpenClaw UI. Ownership state is retained only for this Manager process.
func (a *NativeAdapter) GatewayStatus(ctx context.Context) GatewayStatus {
	return a.gateway.Status(ctx)
}

// GatewayScheduledTaskStatus exposes only the bounded fixed-task state; task
// XML, local command paths and scheduler diagnostics stay inside runtime.
func (a *NativeAdapter) GatewayScheduledTaskStatus(ctx context.Context) ScheduledTaskStatus {
	return a.gateway.ScheduledTaskStatus(ctx)
}

// GatewayControl executes only the fixed status/start/stop/restart actions;
// destructive actions require explicit confirmation from the Manager page.
func (a *NativeAdapter) GatewayControl(ctx context.Context, action string, confirm bool) (GatewayStatus, error) {
	return a.gateway.Control(ctx, action, confirm)
}

// GatewayControlWithLaunchHooks coordinates a caller-owned startup
// transaction with the fixed Gateway command. The runtime layer never sees
// the configuration or credential carried by those hooks.
func (a *NativeAdapter) GatewayControlWithLaunchHooks(
	ctx context.Context,
	action string,
	confirm bool,
	hooks GatewayLaunchHooks,
) (GatewayStatus, error) {
	return a.gateway.ControlWithLaunchHooks(ctx, action, confirm, hooks)
}

// GatewayEnrollScheduledTask and GatewayRemoveScheduledTask expose the fixed
// autostart-task lifecycle. Task identity is compile-time constant; the HTTP
// layer supplies only the confirmation boolean.
func (a *NativeAdapter) GatewayEnrollScheduledTask(ctx context.Context, confirm bool) (GatewayStatus, error) {
	return a.gateway.EnrollScheduledTask(ctx, confirm)
}

func (a *NativeAdapter) GatewayRemoveScheduledTask(ctx context.Context, confirm bool) (GatewayStatus, error) {
	return a.gateway.RemoveScheduledTask(ctx, confirm)
}

func (a *NativeAdapter) Discover(ctx context.Context) Status {
	command, err := findOpenClaw(ctx, a.runner)
	if err != nil {
		status := Status{State: StateUninstalled, Message: "未发现原生 OpenClaw；可从官方 npm 安装"}
		if nodeVersion, nodeErr := a.lookupNodeVersion(ctx); nodeErr == nil {
			status.NodeVersion = nodeVersion
			status.NodeOK = supportedNodeVersion(nodeVersion)
		} else {
			status.Message += "；同时未发现可用 Node.js"
		}
		return status
	}

	versionOutput, err := a.run(ctx, command, "--version")
	if err != nil {
		return Status{State: StateUnsupported, Command: command, Message: safeCommandError(err, versionOutput)}
	}
	version := parseVersion(versionOutput)
	if version == "" {
		return Status{State: StateUnsupported, Command: command, Message: "OpenClaw 版本输出无法识别"}
	}
	nodeVersion, nodeErr := a.lookupNodeVersion(ctx)
	nodeOK := nodeErr == nil && supportedNodeVersion(nodeVersion)
	message := "已发现用户系统中的原生 OpenClaw；LongHub 不接管其安装目录"
	if nodeErr != nil {
		message += "；未发现可用 Node.js，运行/升级前请先安装兼容版本"
	} else if !nodeOK {
		message += "；当前 Node.js 版本不在 OpenClaw 支持区间"
	}
	return Status{
		State:       StateDiscovered,
		Command:     command,
		Version:     version,
		NodeVersion: nodeVersion,
		NodeOK:      nodeOK,
		Message:     message,
	}
}

// NativeInstallPlan is a dry-run description. It is intentionally fixed to
// the reviewed upstream npm package and contains no user-controlled command
// fragments.
func (a *NativeAdapter) NativeInstallPlan(ctx context.Context) (InstallPlan, error) {
	npm, err := a.runner.LookPath("npm")
	if err != nil {
		return InstallPlan{}, errors.New("未发现 npm；请先安装受支持的 Node.js")
	}
	if nodeVersion, nodeErr := a.lookupNodeVersion(ctx); nodeErr != nil || !supportedNodeVersion(nodeVersion) {
		return InstallPlan{}, errors.New("当前 Node.js 版本不满足 OpenClaw 要求")
	}
	return InstallPlan{
		Package: OpenClawPackage,
		Command: npm,
		Args:    []string{"install", "--global", "--no-fund", "--no-audit", OpenClawPackage},
		Reason:  "使用官方 npm 包安装到用户系统的原生全局位置；LongHub 不复制运行时",
	}, nil
}

// InstallNative executes only the fixed official npm command after the caller
// has obtained an explicit user confirmation in the Manager UI.
func (a *NativeAdapter) InstallNative(ctx context.Context) (string, error) {
	if _, err := a.InstallPreflight(ctx); err != nil {
		return "", err
	}
	plan, err := a.NativeInstallPlan(ctx)
	if err != nil {
		return "", err
	}
	output, runErr := a.run(ctx, plan.Command, plan.Args...)
	if runErr != nil {
		return "", fmt.Errorf("原生 OpenClaw 安装失败: %s", safeCommandError(runErr, output))
	}
	return strings.TrimSpace(output), nil
}

// discoverOpenClawForInstall preserves the distinction between a normal
// first-install miss and a discovery failure.  The older findOpenClaw helper
// intentionally returns a single error for its callers; an installer cannot
// safely treat every such error as "not installed" because npm prefix,
// permission, and resolver failures would otherwise be followed by a write.
func discoverOpenClawForInstall(ctx context.Context, runner CommandRunner) openClawDiscoveryResult {
	command, pathErr := runner.LookPath("openclaw")
	if pathErr == nil {
		if strings.TrimSpace(command) == "" {
			return openClawDiscoveryResult{state: openClawDiscoveryUnavailable, err: errors.New("empty OpenClaw command path")}
		}
		return openClawDiscoveryResult{state: openClawDiscoveryFound, command: command}
	}
	if !isCommandNotFound(pathErr) {
		return openClawDiscoveryResult{state: openClawDiscoveryUnavailable, err: pathErr}
	}
	resolver, hasResolver := runner.(OpenClawResolver)
	if !hasResolver {
		return openClawDiscoveryResult{state: openClawDiscoveryMissing, err: ErrOpenClawCommandNotFound}
	}
	command, resolveErr := resolver.ResolveOpenClaw(ctx)
	if resolveErr == nil {
		if strings.TrimSpace(command) == "" {
			return openClawDiscoveryResult{state: openClawDiscoveryUnavailable, err: errors.New("resolver returned an empty OpenClaw path")}
		}
		return openClawDiscoveryResult{state: openClawDiscoveryFound, command: command}
	}
	if isKnownOpenClawMissing(resolveErr) {
		return openClawDiscoveryResult{state: openClawDiscoveryMissing, err: ErrOpenClawCommandNotFound}
	}
	return openClawDiscoveryResult{state: openClawDiscoveryUnavailable, err: resolveErr}
}

func isCommandNotFound(err error) bool {
	if err == nil || errors.Is(err, exec.ErrNotFound) {
		return err != nil
	}
	var pathErr *exec.Error
	if errors.As(err, &pathErr) && errors.Is(pathErr.Err, exec.ErrNotFound) {
		return true
	}
	// Small test/platform seams often use this exact stable text instead of
	// constructing exec.Error.  Do not broaden this to arbitrary "not found"
	// substrings: resolver failures must fail closed.
	return strings.EqualFold(strings.TrimSpace(err.Error()), "openclaw not found")
}

func isKnownOpenClawMissing(err error) bool {
	if errors.Is(err, ErrOpenClawCommandNotFound) || isCommandNotFound(err) {
		return true
	}
	// This is the one not-installed result emitted by the current native
	// resolver.  Other resolver messages (prefix unavailable/invalid, access
	// denied, malformed output) are intentionally not accepted as a miss.
	return strings.EqualFold(strings.TrimSpace(err.Error()), "openclaw is not installed in npm global prefix")
}

// InstallPreflight performs a read-only, fail-closed inspection immediately
// before a native npm install.  Missing OpenClaw is an expected state for a
// fresh install and is reported as such; when a command is present its version
// must match the pinned release before the Manager will overwrite it.  No
// operation in this method creates, deletes, renames, or modifies user files.
func (a *NativeAdapter) InstallPreflight(ctx context.Context) (InstallPreflightReport, error) {
	report := InstallPreflightReport{MinFreeBytes: a.preflight.MinFreeBytes}
	if report.MinFreeBytes == 0 {
		report.MinFreeBytes = DefaultInstallMinFreeBytes
	}
	if report.MinFreeBytes < 0 {
		return report, installPreflightFailure(ErrInstallDiskInsufficient)
	}

	npm, err := a.runner.LookPath("npm")
	if err != nil || strings.TrimSpace(npm) == "" {
		return report, installPreflightFailure(ErrInstallNpmUnavailable)
	}
	report.NpmCommandFound = true

	nodeVersion, nodeErr := a.lookupNodeVersion(ctx)
	if nodeErr != nil {
		return report, installPreflightFailure(ErrInstallNodeUnavailable)
	}
	report.NodeVersion = nodeVersion
	report.NodeCompatible = supportedNodeVersion(nodeVersion)
	if !report.NodeCompatible {
		return report, installPreflightFailure(ErrInstallNodeIncompatible)
	}

	// Resolve OpenClaw independently from npm.  A missing command is the normal
	// first-install state, while an existing but unrecognisable/incompatible
	// release is blocked to prevent silent replacement of user data.  Resolver
	// failures are *not* treated as a miss.
	discovery := discoverOpenClawForInstall(ctx, a.runner)
	switch discovery.state {
	case openClawDiscoveryUnavailable:
		return report, installPreflightFailure(ErrInstallOpenClawUnavailable)
	case openClawDiscoveryFound:
		report.OpenClawCommandFound = true
		output, versionErr := a.run(ctx, discovery.command, "--version")
		if versionErr != nil {
			return report, installPreflightFailure(ErrInstallOpenClawUnavailable)
		}
		report.OpenClawVersion = parseVersion(output)
		report.OpenClawCompatible = report.OpenClawVersion == pinnedOpenClawVersion()
		if !report.OpenClawCompatible {
			return report, installPreflightFailure(ErrInstallOpenClawIncompatible)
		}
	case openClawDiscoveryMissing:
		// Fresh-install path: no existing command is data to preserve.
	}

	configPath, workspacePath, pathErr := a.installPreflightPaths()
	if pathErr != nil {
		return report, installPreflightFailure(ErrInstallConfigUnreadable)
	}
	report.ConfigPath = configPath
	report.WorkspacePath = workspacePath

	configPresent, configReadable, _, configErr := a.inspectOptionalPath(ctx, configPath, InstallPathConfig)
	if configErr != nil || (configPresent && !configReadable) {
		return report, installPreflightFailure(ErrInstallConfigUnreadable)
	}
	report.ConfigPresent = configPresent
	report.ConfigReadable = !configPresent || configReadable

	workspacePresent, workspaceReadable, _, workspaceErr := a.inspectOptionalPath(ctx, workspacePath, InstallPathWorkspace)
	if workspaceErr != nil || (workspacePresent && !workspaceReadable) {
		return report, installPreflightFailure(ErrInstallWorkspaceUnreadable)
	}
	report.WorkspacePresent = workspacePresent
	report.WorkspaceReadable = !workspacePresent || workspaceReadable

	prefix, prefixErr := a.resolveNpmPrefix(ctx, npm)
	if prefixErr != nil {
		return report, installPreflightFailure(ErrInstallPrefixUnavailable)
	}
	report.NpmPrefix = prefix
	writablePath, writableErr := nearestExistingDirectory(prefix)
	if writableErr != nil {
		return report, installPreflightFailure(ErrInstallPrefixUnavailable)
	}
	report.WritableCheckPath = writablePath
	_, prefixReadable, prefixWritable, inspectErr := a.inspectExistingPath(ctx, writablePath, InstallPathNpmPrefix)
	if inspectErr != nil || !prefixReadable || !prefixWritable {
		return report, installPreflightFailure(ErrInstallPrefixNotWritable)
	}
	report.NpmPrefixWritable = true

	diskPath := writablePath
	report.DiskPath = diskPath
	freeBytes, diskErr := a.installFreeBytes(ctx, diskPath)
	if diskErr != nil {
		return report, installPreflightFailure(ErrInstallDiskUnavailable)
	}
	report.FreeBytes = freeBytes
	if freeBytes < report.MinFreeBytes {
		return report, installPreflightFailure(ErrInstallDiskInsufficient)
	}

	report.Ready = true
	return report, nil
}

func installPreflightFailure(reason error) error {
	return fmt.Errorf("%w: %w", ErrInstallPreflight, reason)
}

func pinnedOpenClawVersion() string {
	return strings.TrimPrefix(OpenClawPackage, "openclaw@")
}

func (a *NativeAdapter) installPreflightPaths() (string, string, error) {
	configPath := strings.TrimSpace(a.preflight.ConfigPath)
	if configPath == "" {
		configPath = strings.TrimSpace(os.Getenv("OPENCLAW_CONFIG_PATH"))
	}
	stateDir := strings.TrimSpace(os.Getenv("OPENCLAW_STATE_DIR"))
	if configPath == "" {
		if stateDir == "" {
			home, err := os.UserHomeDir()
			if err != nil || strings.TrimSpace(home) == "" {
				return "", "", errors.New("native OpenClaw home is unavailable")
			}
			stateDir = filepath.Join(home, ".openclaw")
		}
		if !filepath.IsAbs(stateDir) {
			return "", "", errors.New("OPENCLAW_STATE_DIR must be absolute")
		}
		configPath = filepath.Join(stateDir, "openclaw.json")
	} else if !filepath.IsAbs(configPath) {
		return "", "", errors.New("OPENCLAW_CONFIG_PATH must be absolute")
	}
	configPath = filepath.Clean(configPath)

	workspacePath := strings.TrimSpace(a.preflight.WorkspacePath)
	if workspacePath == "" {
		for _, envName := range []string{"OPENCLAW_WORKSPACE_PATH", "OPENCLAW_WORKSPACE_DIR"} {
			if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
				workspacePath = value
				break
			}
		}
	}
	if workspacePath == "" {
		if stateDir == "" {
			stateDir = filepath.Dir(configPath)
		}
		if !filepath.IsAbs(stateDir) {
			return "", "", errors.New("OPENCLAW_STATE_DIR must be absolute")
		}
		workspacePath = filepath.Join(stateDir, "workspace")
	} else if !filepath.IsAbs(workspacePath) {
		return "", "", errors.New("OPENCLAW_WORKSPACE_PATH must be absolute")
	}
	return configPath, filepath.Clean(workspacePath), nil
}

func (a *NativeAdapter) resolveNpmPrefix(ctx context.Context, npm string) (string, error) {
	if configured := strings.TrimSpace(a.preflight.NpmPrefix); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", errors.New("configured npm prefix must be absolute")
		}
		return filepath.Clean(configured), nil
	}
	output, err := a.run(ctx, npm, "prefix", "-g")
	if err != nil {
		return "", err
	}
	prefix := strings.TrimSpace(output)
	if prefix == "" || strings.ContainsAny(prefix, "\x00\r\n") || !filepath.IsAbs(prefix) {
		return "", errors.New("npm prefix is invalid")
	}
	return filepath.Clean(prefix), nil
}

func (a *NativeAdapter) inspectOptionalPath(ctx context.Context, path string, kind InstallPathKind) (bool, bool, bool, error) {
	_, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		// A fresh install may not have created either file yet.  Absence is
		// reported explicitly and is safe because there is no user data to read.
		return false, true, false, nil
	}
	if err != nil {
		return false, false, false, err
	}
	return a.inspectExistingPath(ctx, path, kind)
}

func (a *NativeAdapter) inspectExistingPath(ctx context.Context, path string, kind InstallPathKind) (bool, bool, bool, error) {
	if probe, ok := a.runner.(InstallPathProbe); ok {
		readable, writable, err := probe.InspectInstallPath(ctx, path, kind)
		if err != nil {
			return true, false, false, err
		}
		return true, readable, writable, nil
	}
	readable, writable, err := (OSCommandRunner{}).InspectInstallPath(ctx, path, kind)
	if err != nil {
		return true, false, false, err
	}
	return true, readable, writable, nil
}

func nearestExistingDirectory(path string) (string, error) {
	candidate := filepath.Clean(path)
	if !filepath.IsAbs(candidate) {
		return "", errors.New("path must be absolute")
	}
	for {
		info, err := os.Lstat(candidate)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("path must not contain a symlink")
			}
			if !info.IsDir() {
				return "", errors.New("path must resolve to a directory")
			}
			return candidate, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return "", errors.New("no existing parent directory")
		}
		candidate = parent
	}
}

func (a *NativeAdapter) installFreeBytes(ctx context.Context, path string) (int64, error) {
	if probe, ok := a.runner.(DiskSpaceProbe); ok {
		return probe.InstallFreeBytes(ctx, path)
	}
	return 0, errors.New("platform disk probe unavailable")
}

// ValidateConfigCandidate asks the native OpenClaw CLI to parse and validate a
// staged JSON5 file before Config Manager atomically restores it. The file path
// comes from Manager-owned temporary storage, never from a page or model.
func (a *NativeAdapter) ValidateConfigCandidate(ctx context.Context, candidatePath string) error {
	abs, err := filepath.Abs(candidatePath)
	if err != nil {
		return errors.New("候选配置路径无效")
	}
	info, err := os.Lstat(abs)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("候选配置必须是普通非符号链接文件")
	}
	runner, ok := a.runner.(environmentCommandRunner)
	if !ok {
		return errors.New("当前运行器不支持候选配置校验")
	}
	command, err := findOpenClaw(ctx, a.runner)
	if err != nil {
		return errors.New("未发现原生 OpenClaw")
	}
	validateCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()
	output, runErr := runner.RunWithEnv(validateCtx, []string{"OPENCLAW_CONFIG_PATH=" + abs}, command, "config", "validate", "--json")
	if runErr != nil {
		return fmt.Errorf("OpenClaw 配置校验失败: %s", safeCommandError(runErr, string(output)))
	}
	return nil
}

// RunControl calls only the documented OpenClaw CLI. It never kills a process
// by PID or edits a private database, so an externally managed instance is not
// accidentally destroyed by the manager.
func (a *NativeAdapter) RunControl(ctx context.Context, action string) (string, error) {
	if action == "start" || action == "stop" || action == "restart" {
		// The legacy string API has no confirmation parameter. Route lifecycle
		// calls through GatewayManager so it cannot stop an external instance.
		_, err := a.GatewayControl(ctx, action, false)
		return "", err
	}
	allowed := map[string][]string{
		"status": {"gateway", "status"},
		"health": {"gateway", "health"},
		"doctor": {"doctor", "--non-interactive"},
		"skills": {"skills", "list"},
	}
	args, ok := allowed[action]
	if !ok {
		return "", fmt.Errorf("不允许的 OpenClaw 管理动作: %s", action)
	}
	command, err := findOpenClaw(ctx, a.runner)
	if err != nil {
		return "", errors.New("未发现原生 OpenClaw")
	}
	output, runErr := a.run(ctx, command, args...)
	if runErr != nil {
		return "", fmt.Errorf("OpenClaw %s 失败: %s", action, safeCommandError(runErr, output))
	}
	return strings.TrimSpace(output), nil
}

func (a *NativeAdapter) run(parent context.Context, command string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, a.timeout)
	defer cancel()
	output, err := a.runner.Run(ctx, command, args...)
	return string(output), err
}

func (a *NativeAdapter) lookupNodeVersion(ctx context.Context) (string, error) {
	command, err := a.runner.LookPath("node")
	if err != nil {
		return "", err
	}
	output, runErr := a.run(ctx, command, "--version")
	if runErr != nil {
		return "", runErr
	}
	version := parseVersion(output)
	if version == "" {
		return "", errors.New("Node.js 版本输出无法识别")
	}
	return version, nil
}

var versionPattern = regexp.MustCompile(`(?i)(?:openclaw\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)`)

func parseVersion(output string) string {
	match := versionPattern.FindStringSubmatch(output)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func supportedNodeVersion(version string) bool {
	match := regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)`).FindStringSubmatch(version)
	if len(match) != 4 {
		return false
	}
	major, minor, patch := 0, 0, 0
	if _, err := fmt.Sscanf(match[1]+" "+match[2]+" "+match[3], "%d %d %d", &major, &minor, &patch); err != nil {
		return false
	}
	if major == 22 {
		return minor > 22 || (minor == 22 && patch >= 3)
	}
	if major == 24 {
		return minor > 15 || (minor == 15 && patch >= 0)
	}
	return major >= 25 && (major > 25 || minor > 9 || (minor == 9 && patch >= 0))
}

func safeCommandError(err error, output string) string {
	// Keep diagnostics short and never echo arbitrary command output to the UI.
	if len(output) > 240 {
		output = output[:240]
	}
	output = strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r == '\t' || (r >= 0x20 && r != 0x7f) {
			return r
		}
		return ' '
	}, output)
	if output == "" {
		return "命令返回错误: " + err.Error()
	}
	return "命令返回错误: " + strings.TrimSpace(output)
}

func mergeEnvironment(base, overrides []string) []string {
	keys := make(map[string]struct{}, len(overrides))
	for _, entry := range overrides {
		key, _, _ := strings.Cut(entry, "=")
		keys[strings.ToUpper(key)] = struct{}{}
	}
	merged := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		if _, replaced := keys[strings.ToUpper(key)]; !replaced {
			merged = append(merged, entry)
		}
	}
	return append(merged, overrides...)
}
