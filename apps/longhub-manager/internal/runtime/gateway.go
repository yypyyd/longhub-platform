package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// GatewayState describes ownership as well as whether a native Gateway is
// running. A running process discovered before this Manager starts is always
// reported as external; Manager never infers ownership from a port or PID.
type GatewayState string

const (
	GatewayNotInstalled     GatewayState = "not_installed"
	GatewayInstalledStopped GatewayState = "installed_stopped"
	GatewayRunningExternal  GatewayState = "running_external"
	GatewayRunningManaged   GatewayState = "running_managed"
	GatewayUnknown          GatewayState = "unknown"
)

type GatewayHealth string

const (
	GatewayHealthUnknown   GatewayHealth = "unknown"
	GatewayHealthHealthy   GatewayHealth = "healthy"
	GatewayHealthUnhealthy GatewayHealth = "unhealthy"
)

// GatewayStatus is deliberately metadata-only. CLI output, process IDs and
// local workspace paths are not returned to the Manager page.
type GatewayStatus struct {
	State     GatewayState  `json:"state"`
	Health    GatewayHealth `json:"health"`
	Installed bool          `json:"installed"`
	Running   bool          `json:"running"`
	Managed   bool          `json:"managed"`
	Command   string        `json:"command,omitempty"`
	Version   string        `json:"version,omitempty"`
	Message   string        `json:"message,omitempty"`
	ErrorCode string        `json:"error_code,omitempty"`
}

// ScheduledTaskState is the public, metadata-only view of the fixed Windows
// autostart task. It deliberately omits task XML, command paths, trigger data
// and scheduler diagnostics.
type ScheduledTaskState string

const (
	ScheduledTaskUnsupported ScheduledTaskState = "unsupported"
	ScheduledTaskNotEnrolled ScheduledTaskState = "not_enrolled"
	ScheduledTaskEnrolled    ScheduledTaskState = "enrolled"
	ScheduledTaskConflict    ScheduledTaskState = "conflict"
	ScheduledTaskUnavailable ScheduledTaskState = "unavailable"
)

type ScheduledTaskStatus struct {
	State     ScheduledTaskState `json:"state"`
	Supported bool               `json:"supported"`
	Enrolled  bool               `json:"enrolled"`
	ErrorCode string             `json:"error_code,omitempty"`
}

// GatewayObservation is the bounded result produced by a platform/CLI
// controller. It contains no untrusted raw command output.
type GatewayObservation struct {
	Installed    bool
	Command      string
	Version      string
	Running      bool
	RunningKnown bool
	Health       GatewayHealth
	Message      string
}

// GatewayController is the cross-platform control seam. The first Manager
// implementation delegates to OpenClaw's public CLI; a future Windows
// Scheduled Task adapter can implement the same interface without changing
// ownership rules in GatewayManager.
type GatewayController interface {
	Inspect(context.Context) (GatewayObservation, error)
	Start(context.Context) error
	Stop(context.Context) error
	Restart(context.Context) error
}

var (
	ErrGatewayConfirmationRequired = errors.New("gateway action requires explicit confirmation")
	ErrExternalGateway             = errors.New("gateway is managed externally")
	ErrGatewayNotInstalled         = errors.New("native OpenClaw is not installed")
	ErrGatewayInspectionFailed     = errors.New("gateway status is unavailable")
	ErrGatewayActionFailed         = errors.New("gateway action failed")
)

// OpenClawGatewayController calls only fixed, documented OpenClaw commands.
// It never starts an arbitrary executable supplied by a page or model.
type OpenClawGatewayController struct {
	runner  CommandRunner
	timeout time.Duration
}

func NewOpenClawGatewayController(runner CommandRunner) *OpenClawGatewayController {
	return &OpenClawGatewayController{runner: runner, timeout: 15 * time.Second}
}

func (c *OpenClawGatewayController) Inspect(ctx context.Context) (GatewayObservation, error) {
	command, err := findOpenClaw(ctx, c.runner)
	if err != nil {
		return GatewayObservation{Message: "未发现原生 OpenClaw"}, nil
	}
	versionOutput, versionErr := c.run(ctx, command, "--version")
	if versionErr != nil {
		return GatewayObservation{Installed: true, Command: command, Message: "OpenClaw 版本检测失败"}, fmt.Errorf("%w: version", ErrGatewayInspectionFailed)
	}
	version := parseVersion(versionOutput)
	if version == "" {
		return GatewayObservation{Installed: true, Command: command, Message: "OpenClaw 版本输出无法识别"}, fmt.Errorf("%w: version", ErrGatewayInspectionFailed)
	}
	statusOutput, statusErr := c.run(ctx, command, "gateway", "status")
	running, known := parseGatewayRunning(statusOutput)
	if statusErr != nil && !known {
		return GatewayObservation{Installed: true, Command: command, Version: version, Message: "Gateway 状态检测失败"}, fmt.Errorf("%w: status", ErrGatewayInspectionFailed)
	}
	observation := GatewayObservation{
		Installed:    true,
		Command:      command,
		Version:      version,
		Running:      running,
		RunningKnown: known,
		Health:       GatewayHealthUnknown,
		Message:      "已发现原生 OpenClaw；Gateway 由公开 CLI 检查",
	}
	if !running {
		observation.Health = GatewayHealthUnknown
		return observation, nil
	}
	healthOutput, healthErr := c.run(ctx, command, "gateway", "health")
	health, healthKnown := parseGatewayHealth(healthOutput)
	if !healthKnown || healthErr != nil {
		observation.Health = GatewayHealthUnknown
		observation.Message = "Gateway 正在运行，但健康状态暂不可确认"
		return observation, nil
	}
	observation.Health = health
	if health == GatewayHealthHealthy {
		observation.Message = "Gateway 正在运行且健康"
	} else {
		observation.Message = "Gateway 正在运行但健康检查未通过"
	}
	return observation, nil
}

func (c *OpenClawGatewayController) Start(ctx context.Context) error {
	return c.action(ctx, "start")
}

func (c *OpenClawGatewayController) Stop(ctx context.Context) error {
	return c.action(ctx, "stop")
}

func (c *OpenClawGatewayController) Restart(ctx context.Context) error {
	return c.action(ctx, "restart")
}

func (c *OpenClawGatewayController) action(ctx context.Context, action string) error {
	command, err := findOpenClaw(ctx, c.runner)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrGatewayNotInstalled, err)
	}
	_, runErr := c.run(ctx, command, "gateway", action)
	if runErr != nil {
		return fmt.Errorf("%w: %s", ErrGatewayActionFailed, safeCommandError(runErr, ""))
	}
	return nil
}

func (c *OpenClawGatewayController) run(parent context.Context, command string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, c.timeout)
	defer cancel()
	output, err := c.runner.Run(ctx, command, args...)
	return string(output), err
}

// GatewayManager adds ownership and confirmation policy around a controller.
// Ownership is process-local and intentionally lost on Manager restart; a
// previously running Gateway is then treated as external unless the optional
// read-only Scheduled Task ownership probe proves the fixed LongHub task
// contract. Probe results never mutate the process-local launch flag and any
// probe error, unknown or unsupported result keeps the external classification.
type GatewayManager struct {
	controller     GatewayController
	ownershipProbe ScheduledTaskOwnershipProbe
	taskLifecycle  ScheduledTaskLifecycle
	actionMu       sync.Mutex
	stateMu        sync.RWMutex
	managed        bool
	taskCommand    string
}

// scheduledTaskProbeTimeout bounds one status inspection so a slow Task
// Scheduler query cannot stall the Manager status API.
const scheduledTaskProbeTimeout = 5 * time.Second

// GatewayLaunchHooks let the Manager coordinate startup-only configuration
// with the exact Start/Restart command while actionMu is held. Hooks are never
// called for status, stop, rejected, or idempotent start operations.
type GatewayLaunchHooks struct {
	Before func()
	After  func(succeeded bool)
}

// ScheduledTaskOwnershipProbe 定义见 process_control.go。ScheduledTaskLifecycle
// is the narrow enroll/remove seam implemented by WindowsProcessController; the
// GatewayManager never sees task names, paths, XML or trigger data.
type ScheduledTaskLifecycle interface {
	EnsureScheduledTask(ctx context.Context, command string) error
	RemoveScheduledTask(ctx context.Context) error
}

func NewGatewayManager(runner CommandRunner) *GatewayManager {
	taskCommand := ""
	if executable, err := os.Executable(); err == nil {
		if absolute, absoluteErr := filepath.Abs(executable); absoluteErr == nil {
			taskCommand = absolute
		}
	}
	return newGatewayManagerWithOwnershipProbe(
		NewOpenClawGatewayController(runner),
		platformScheduledTaskOwnershipProbe(),
		taskCommand,
	)
}

func NewGatewayManagerWithController(controller GatewayController) *GatewayManager {
	return NewGatewayManagerWithOwnershipProbe(controller, nil)
}

// NewGatewayManagerWithOwnershipProbe injects the read-only Scheduled Task
// ownership probe. A nil probe keeps the pure process-local ownership policy;
// the probe can only upgrade a running Gateway to managed, never authorize a
// lifecycle action by itself. A probe that also implements
// ScheduledTaskLifecycle (the Windows controller does) additionally enables
// the confirm-gated enroll/remove task actions against the same fixed
// contract instance; probing and lifecycle never diverge on identity.
func NewGatewayManagerWithOwnershipProbe(
	controller GatewayController,
	probe ScheduledTaskOwnershipProbe,
) *GatewayManager {
	return newGatewayManagerWithOwnershipProbe(controller, probe, "")
}

// NewGatewayManagerWithOwnershipProbeAndTaskCommand is the deterministic
// lifecycle constructor used by tests and reviewed platform launchers. The
// command is still checked against the fixed Manager executable contract
// before Task Scheduler is touched.
func NewGatewayManagerWithOwnershipProbeAndTaskCommand(
	controller GatewayController,
	probe ScheduledTaskOwnershipProbe,
	taskCommand string,
) *GatewayManager {
	return newGatewayManagerWithOwnershipProbe(controller, probe, taskCommand)
}

func newGatewayManagerWithOwnershipProbe(
	controller GatewayController,
	probe ScheduledTaskOwnershipProbe,
	taskCommand string,
) *GatewayManager {
	if controller == nil {
		controller = unavailableGatewayController{}
	}
	manager := &GatewayManager{controller: controller, ownershipProbe: probe, taskCommand: taskCommand}
	if lifecycle, ok := probe.(ScheduledTaskLifecycle); ok {
		manager.taskLifecycle = lifecycle
	}
	return manager
}

// platformScheduledTaskOwnershipProbe returns the fixed-contract probe on
// Windows. Other platforms return nil so inspection never reports a
// misleading unsupported error for every status call.
func platformScheduledTaskOwnershipProbe() ScheduledTaskOwnershipProbe {
	if controller, ok := NewPlatformProcessController().(*WindowsProcessController); ok {
		return controller
	}
	return nil
}

// Discover never changes a running external process. If inspection fails, it
// returns a fixed unknown state and no raw command output.
func (m *GatewayManager) Discover(ctx context.Context) GatewayStatus {
	status, _ := m.inspect(ctx)
	return status
}

// Status is an explicit alias for callers that expose a status-oriented API.
func (m *GatewayManager) Status(ctx context.Context) GatewayStatus { return m.Discover(ctx) }

// ScheduledTaskStatus returns a bounded view of the fixed Windows autostart
// task. It shares the lifecycle action lock so a page refresh cannot observe
// the task halfway through a confirmed registration or removal transaction.
func (m *GatewayManager) ScheduledTaskStatus(ctx context.Context) ScheduledTaskStatus {
	m.actionMu.Lock()
	defer m.actionMu.Unlock()
	if m.ownershipProbe == nil {
		return ScheduledTaskStatus{
			State:     ScheduledTaskUnsupported,
			ErrorCode: "SCHEDULED_TASK_LIFECYCLE_UNSUPPORTED",
		}
	}
	if err := ctx.Err(); err != nil {
		return ScheduledTaskStatus{
			State:     ScheduledTaskUnavailable,
			Supported: true,
			ErrorCode: "SCHEDULED_TASK_STATUS_UNAVAILABLE",
		}
	}
	probeCtx, cancel := context.WithTimeout(ctx, scheduledTaskProbeTimeout)
	defer cancel()
	observation, err := m.ownershipProbe.InspectOwnership(probeCtx)
	if err != nil {
		switch {
		case errors.Is(err, ErrNativeProcessControlUnavailable):
			return ScheduledTaskStatus{
				State:     ScheduledTaskUnsupported,
				ErrorCode: "SCHEDULED_TASK_LIFECYCLE_UNSUPPORTED",
			}
		case errors.Is(err, ErrScheduledTaskIdentityMismatch):
			return ScheduledTaskStatus{
				State:     ScheduledTaskConflict,
				Supported: true,
				ErrorCode: "SCHEDULED_TASK_FOREIGN_OWNER",
			}
		default:
			return ScheduledTaskStatus{
				State:     ScheduledTaskUnavailable,
				Supported: true,
				ErrorCode: "SCHEDULED_TASK_STATUS_UNAVAILABLE",
			}
		}
	}
	if observation.Ownership == ScheduledTaskOwnershipLongHub && observation.TaskPresent &&
		observation.TaskPathValid && observation.MarkerValid && observation.ActionValid {
		return ScheduledTaskStatus{State: ScheduledTaskEnrolled, Supported: true, Enrolled: true}
	}
	if observation.Ownership == ScheduledTaskOwnershipExternal && !observation.TaskPresent {
		return ScheduledTaskStatus{State: ScheduledTaskNotEnrolled, Supported: true}
	}
	return ScheduledTaskStatus{
		State:     ScheduledTaskUnavailable,
		Supported: true,
		ErrorCode: "SCHEDULED_TASK_STATUS_UNAVAILABLE",
	}
}

func (m *GatewayManager) Start(ctx context.Context, confirm bool) (GatewayStatus, error) {
	return m.control(ctx, "start", confirm, GatewayLaunchHooks{})
}

func (m *GatewayManager) Stop(ctx context.Context, confirm bool) (GatewayStatus, error) {
	return m.control(ctx, "stop", confirm, GatewayLaunchHooks{})
}

func (m *GatewayManager) Restart(ctx context.Context, confirm bool) (GatewayStatus, error) {
	return m.control(ctx, "restart", confirm, GatewayLaunchHooks{})
}

// Control is the fixed action entry point used by a future Manager HTTP route.
// The action string is allowlisted here; callers cannot provide CLI arguments.
func (m *GatewayManager) Control(ctx context.Context, action string, confirm bool) (GatewayStatus, error) {
	return m.control(ctx, action, confirm, GatewayLaunchHooks{})
}

// ControlWithLaunchHooks is the startup-transaction entry point used by the
// local Manager HTTP server. The hooks execute inside the same action lock as
// inspection and the fixed Gateway command.
func (m *GatewayManager) ControlWithLaunchHooks(
	ctx context.Context,
	action string,
	confirm bool,
	hooks GatewayLaunchHooks,
) (GatewayStatus, error) {
	return m.control(ctx, action, confirm, hooks)
}

// EnrollScheduledTask registers the fixed LongHub Gateway autostart task. It
// requires explicit confirmation, uses the absolute installed Manager
// launcher captured at construction (never from a request), and deliberately does not set the
// process-local managed flag: classification is upgraded only by the next
// ownership probe proving the on-disk contract.
func (m *GatewayManager) EnrollScheduledTask(ctx context.Context, confirm bool) (GatewayStatus, error) {
	m.actionMu.Lock()
	defer m.actionMu.Unlock()
	before, err := m.inspect(ctx)
	if err != nil {
		return before, err
	}
	if !confirm {
		return before, ErrGatewayConfirmationRequired
	}
	if m.taskLifecycle == nil {
		return before, ErrNativeProcessControlUnavailable
	}
	if !before.Installed {
		return before, ErrGatewayNotInstalled
	}
	command, commandErr := absoluteGatewayTaskCommand(m.taskCommand)
	if commandErr != nil {
		return before, commandErr
	}
	if enrollErr := m.taskLifecycle.EnsureScheduledTask(ctx, command); enrollErr != nil {
		return before, enrollErr
	}
	return m.inspect(ctx)
}

// RemoveScheduledTask deletes the fixed task after a fresh complete ownership
// proof inside the controller. Confirmation is required even though the task
// may not be running: removal changes the user's autostart behavior.
func (m *GatewayManager) RemoveScheduledTask(ctx context.Context, confirm bool) (GatewayStatus, error) {
	m.actionMu.Lock()
	defer m.actionMu.Unlock()
	before, err := m.inspect(ctx)
	if err != nil {
		return before, err
	}
	if !confirm {
		return before, ErrGatewayConfirmationRequired
	}
	if m.taskLifecycle == nil {
		return before, ErrNativeProcessControlUnavailable
	}
	if removeErr := m.taskLifecycle.RemoveScheduledTask(ctx); removeErr != nil {
		return before, removeErr
	}
	return m.inspect(ctx)
}

// absoluteGatewayTaskCommand validates the installed Manager command captured
// during trusted process construction. It deliberately does not resolve a
// PATH-relative name, because Task Scheduler must retain an immutable absolute
// launcher identity across logon and reboot.
func absoluteGatewayTaskCommand(command string) (string, error) {
	command = strings.TrimSpace(command)
	if !validLongHubGatewayTaskAction(command, LongHubGatewayTaskArguments) {
		return "", ErrScheduledTaskInvalidCommand
	}
	return command, nil
}

func (m *GatewayManager) control(
	ctx context.Context,
	action string,
	confirm bool,
	hooks GatewayLaunchHooks,
) (GatewayStatus, error) {
	m.actionMu.Lock()
	defer m.actionMu.Unlock()
	before, err := m.inspect(ctx)
	if err != nil {
		return before, err
	}
	if before.State == GatewayUnknown {
		return before, ErrGatewayInspectionFailed
	}
	switch action {
	case "start":
		if !before.Installed {
			return before, ErrGatewayNotInstalled
		}
		if before.Running {
			return before, nil
		}
		if !confirm {
			return before, ErrGatewayConfirmationRequired
		}
		runLaunchHook(hooks.Before)
		actionErr := m.controller.Start(ctx)
		runLaunchFinalizer(hooks.After, actionErr == nil)
		if actionErr != nil {
			return before, fmt.Errorf("%w: %v", ErrGatewayActionFailed, actionErr)
		}
		m.setManaged(true)
	case "stop":
		if !before.Running {
			return before, nil
		}
		if !before.Managed && !confirm {
			return before, ErrExternalGateway
		}
		if !confirm {
			return before, ErrGatewayConfirmationRequired
		}
		if err := m.controller.Stop(ctx); err != nil {
			return before, fmt.Errorf("%w: %v", ErrGatewayActionFailed, err)
		}
		m.setManaged(false)
	case "restart":
		if !before.Installed {
			return before, ErrGatewayNotInstalled
		}
		if !confirm {
			if !before.Managed && before.Running {
				return before, ErrExternalGateway
			}
			return before, ErrGatewayConfirmationRequired
		}
		wasManaged := before.Managed
		runLaunchHook(hooks.Before)
		actionErr := m.controller.Restart(ctx)
		runLaunchFinalizer(hooks.After, actionErr == nil)
		if actionErr != nil {
			return before, fmt.Errorf("%w: %v", ErrGatewayActionFailed, actionErr)
		}
		// A confirmed restart from a stopped Gateway starts a process that this
		// Manager owns even though there was no prior managed instance.
		m.setManaged(wasManaged || !before.Running)
	default:
		return before, fmt.Errorf("不允许的 Gateway 管理动作: %s", action)
	}
	after, inspectErr := m.inspect(ctx)
	if inspectErr != nil {
		return after, inspectErr
	}
	return after, nil
}

func runLaunchHook(hook func()) {
	if hook != nil {
		hook()
	}
}

func runLaunchFinalizer(finalize func(bool), succeeded bool) {
	if finalize != nil {
		finalize(succeeded)
	}
}

func (m *GatewayManager) inspect(ctx context.Context) (GatewayStatus, error) {
	observation, err := m.controller.Inspect(ctx)
	if err != nil {
		return GatewayStatus{
			State:     GatewayUnknown,
			Health:    GatewayHealthUnknown,
			Message:   "无法读取 Gateway 状态",
			ErrorCode: "GATEWAY_STATUS_UNAVAILABLE",
		}, err
	}
	managed := m.isManaged()
	if !observation.Running {
		managed = false
		m.setManaged(false)
	}
	state := GatewayInstalledStopped
	if !observation.Installed {
		state = GatewayNotInstalled
	} else if !observation.RunningKnown {
		return GatewayStatus{
			State:     GatewayUnknown,
			Health:    GatewayHealthUnknown,
			Installed: true,
			Command:   observation.Command,
			Version:   observation.Version,
			Message:   "无法确认 Gateway 是否运行",
			ErrorCode: "GATEWAY_STATUS_UNAVAILABLE",
		}, nil
	} else if observation.Running && managed {
		state = GatewayRunningManaged
	} else if observation.Running {
		if m.probeScheduledTaskOwnership(ctx) {
			state = GatewayRunningManaged
			managed = true
		} else {
			state = GatewayRunningExternal
		}
	}
	return GatewayStatus{
		State:     state,
		Health:    observation.Health,
		Installed: observation.Installed,
		Running:   observation.Running,
		Managed:   managed && observation.Running,
		Command:   observation.Command,
		Version:   observation.Version,
		Message:   observation.Message,
	}, nil
}

// probeScheduledTaskOwnership returns true only when the read-only probe
// proves the fixed LongHub task contract. Missing probe, unsupported
// platform, query errors, identity mismatch and unknown results all keep the
// running Gateway classified as external; the probe can never authorize a
// stop by itself because every lifecycle action still requires confirmation.
func (m *GatewayManager) probeScheduledTaskOwnership(ctx context.Context) bool {
	if m.ownershipProbe == nil {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, scheduledTaskProbeTimeout)
	defer cancel()
	observation, err := m.ownershipProbe.InspectOwnership(probeCtx)
	if err != nil {
		return false
	}
	return observation.Ownership == ScheduledTaskOwnershipLongHub &&
		observation.TaskPathValid && observation.MarkerValid && observation.ActionValid
}

func (m *GatewayManager) isManaged() bool {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return m.managed
}

func (m *GatewayManager) setManaged(value bool) {
	m.stateMu.Lock()
	m.managed = value
	m.stateMu.Unlock()
}

// unavailableGatewayController is used only when a caller forgets to inject
// a controller. It avoids silently falling back to process killing.
type unavailableGatewayController struct{}

func (unavailableGatewayController) Inspect(context.Context) (GatewayObservation, error) {
	return GatewayObservation{}, ErrGatewayInspectionFailed
}
func (unavailableGatewayController) Start(context.Context) error   { return ErrGatewayActionFailed }
func (unavailableGatewayController) Stop(context.Context) error    { return ErrGatewayActionFailed }
func (unavailableGatewayController) Restart(context.Context) error { return ErrGatewayActionFailed }

// Negative phrases must precede their positive suffixes. Otherwise a plain
// string such as "not running" would first match the trailing "running" and
// be misclassified as an active Gateway.
var gatewayStatePattern = regexp.MustCompile(`(?i)\b(not\s+running|not\s+installed|running|active|online|listening|ready|stopped|inactive|offline|failed|disabled)\b`)

func parseGatewayRunning(output string) (bool, bool) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return false, false
	}
	var object map[string]any
	if json.Unmarshal([]byte(trimmed), &object) == nil {
		for _, key := range []string{"running", "active", "online"} {
			if value, ok := object[key].(bool); ok {
				return value, true
			}
		}
		for _, key := range []string{"status", "state"} {
			if value, ok := object[key].(string); ok {
				return parseGatewayStateWord(value)
			}
		}
	}
	words := gatewayStatePattern.FindAllString(strings.ToLower(trimmed), -1)
	for _, word := range words {
		if word == "stopped" || word == "inactive" || word == "offline" || word == "failed" || word == "disabled" || word == "not running" || word == "not installed" {
			return false, true
		}
	}
	for _, word := range words {
		if word == "running" || word == "active" || word == "online" || word == "listening" || word == "ready" {
			return true, true
		}
	}
	return false, false
}

func parseGatewayStateWord(value string) (bool, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "running" || value == "active" || value == "online" || value == "ready" {
		return true, true
	}
	if value == "stopped" || value == "inactive" || value == "offline" || value == "failed" || value == "disabled" || value == "not running" {
		return false, true
	}
	return false, false
}

func parseGatewayHealth(output string) (GatewayHealth, bool) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return GatewayHealthUnknown, false
	}
	var object map[string]any
	if json.Unmarshal([]byte(trimmed), &object) == nil {
		for _, key := range []string{"ok", "healthy", "ready"} {
			if value, ok := object[key].(bool); ok {
				if value {
					return GatewayHealthHealthy, true
				}
				return GatewayHealthUnhealthy, true
			}
		}
		for _, key := range []string{"status", "state", "health"} {
			if value, ok := object[key].(string); ok {
				if healthy, known := parseHealthWord(value); known {
					return healthy, true
				}
			}
		}
	}
	return parseHealthWord(trimmed)
}

func parseHealthWord(value string) (GatewayHealth, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	if strings.Contains(value, "unhealthy") || strings.Contains(value, "not healthy") ||
		strings.Contains(value, "failed") || strings.Contains(value, "error") ||
		strings.Contains(value, "not ready") || strings.Contains(value, "not online") ||
		strings.Contains(value, "offline") {
		return GatewayHealthUnhealthy, true
	}
	if strings.Contains(value, "healthy") || value == "ok" || strings.Contains(value, "ready") || strings.Contains(value, "online") {
		return GatewayHealthHealthy, true
	}
	return GatewayHealthUnknown, false
}
