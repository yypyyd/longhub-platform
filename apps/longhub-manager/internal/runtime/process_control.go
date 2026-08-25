package runtime

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	stdRuntime "runtime"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// ProcessSpec is reserved for a future platform process adapter. GatewayManager
// currently uses OpenClaw's fixed public CLI, so no ProcessSpec is accepted from
// HTTP, a Skill, or an OpenClaw model.
type ProcessSpec struct {
	Command string
	Args    []string
}

// ManagedProcess is an opaque ownership handle. A PID alone is never enough to
// authorize a stop operation; a future implementation must also retain its
// manager-issued identity.
type ManagedProcess struct {
	Identity string
	PID      int
}

type ProcessController interface {
	Start(context.Context, ProcessSpec) (ManagedProcess, error)
	Stop(context.Context, ManagedProcess) error
	IsRunning(context.Context, ManagedProcess) (bool, error)
}

var (
	ErrNativeProcessControlUnavailable = errors.New("native process control is not available")
	// ErrWindowsTaskIntegrationPending is kept for the existing lifecycle seam.
	// This slice adds a read-only ownership probe; task creation, stop and
	// restart remain deliberately unavailable until a separate lifecycle review.
	ErrWindowsTaskIntegrationPending = errors.New("Windows Scheduled Task lifecycle control is not implemented")

	// These errors are intentionally stable.  Callers must not expose the
	// underlying Task Scheduler, XML, PowerShell or Windows error text.
	ErrScheduledTaskNotFound         = errors.New("scheduled task not found")
	ErrScheduledTaskInspectionFailed = errors.New("scheduled task inspection failed")
	ErrScheduledTaskIdentityMismatch = errors.New("scheduled task identity contract mismatch")

	// Lifecycle errors are equally stable. A same-name task that fails the v1
	// identity proof is a foreign owner: it is never overwritten or deleted.
	ErrScheduledTaskForeignOwner    = errors.New("scheduled task exists with a foreign identity")
	ErrScheduledTaskOperationFailed = errors.New("scheduled task lifecycle operation failed")
	ErrScheduledTaskInvalidCommand  = errors.New("scheduled task command is not a native OpenClaw executable")
)

// LongHubGatewayTaskPath and LongHubGatewayTaskOwnerMarker are the only task
// identity values this package will ever probe.  They are intentionally not
// configurable through HTTP, environment variables, or a ProcessSpec.
const (
	LongHubGatewayTaskPath        = `\LongHub\OpenClaw Gateway`
	LongHubGatewayTaskOwnerMarker = "longhub/manager-gateway/v2"
	LongHubGatewayTaskArguments   = "--autostart-gateway"
	maxScheduledTaskXMLBytes      = 128 << 10
)

// ScheduledTaskOwnership describes provenance, not merely whether a process
// happens to be listening.  A missing fixed task is external; a present task
// whose marker/action cannot be proven is unknown and must remain fail-closed.
type ScheduledTaskOwnership string

const (
	ScheduledTaskOwnershipUnknown     ScheduledTaskOwnership = "unknown"
	ScheduledTaskOwnershipExternal    ScheduledTaskOwnership = "external"
	ScheduledTaskOwnershipLongHub     ScheduledTaskOwnership = "longhub"
	ScheduledTaskOwnershipUnsupported ScheduledTaskOwnership = "unsupported"
)

// Short aliases keep the ownership vocabulary easy to use inside runtime
// callers while the longer names remain self-documenting at API boundaries.
const (
	TaskOwnershipUnknown     = ScheduledTaskOwnershipUnknown
	TaskOwnershipExternal    = ScheduledTaskOwnershipExternal
	TaskOwnershipLongHub     = ScheduledTaskOwnershipLongHub
	TaskOwnershipUnsupported = ScheduledTaskOwnershipUnsupported
)

// ScheduledTaskIdentity is the immutable identity contract for the one task
// LongHub may recognize.  The action is validated separately because the
// native OpenClaw executable path is user-specific and must be absolute.
type ScheduledTaskIdentity struct {
	TaskPath    string
	OwnerMarker string
}

func DefaultLongHubGatewayTaskIdentity() ScheduledTaskIdentity {
	return ScheduledTaskIdentity{
		TaskPath:    LongHubGatewayTaskPath,
		OwnerMarker: LongHubGatewayTaskOwnerMarker,
	}
}

// ScheduledTaskDefinition is the bounded, non-secret subset of Task Scheduler
// XML needed for ownership validation.  No PID, port, trigger, user name or
// local path is returned to the HTTP layer.
type ScheduledTaskDefinition struct {
	TaskPath        string
	OwnerMarker     string
	ActionCommand   string
	ActionArguments string
}

// ScheduledTaskObservation is an internal read-only result.  It deliberately
// contains only fixed task metadata and validation booleans; it is not part of
// the Manager HTTP JSON contract.
type ScheduledTaskObservation struct {
	Ownership     ScheduledTaskOwnership
	TaskPresent   bool
	TaskPathValid bool
	MarkerValid   bool
	ActionValid   bool
	ErrorCode     string
}

// ScheduledTaskQueryRunner is a narrow read-only seam. Implementations must
// query the fixed task path supplied by the controller; they must not expose a
// generic command runner to pages, Skills, or models.
type ScheduledTaskQueryRunner interface {
	Query(context.Context, string) ([]byte, error)
}

// ScheduledTaskLifecycleRunner extends the read-only query seam with the two
// fixed lifecycle primitives. Register must refuse to overwrite an existing
// task (no force flag) and Delete removes exactly the fixed task path; both
// reject any path other than the compile-time LongHub contract.
type ScheduledTaskLifecycleRunner interface {
	ScheduledTaskQueryRunner
	Register(ctx context.Context, taskPath string, taskXML []byte) error
	Delete(ctx context.Context, taskPath string) error
}

// ScheduledTaskOwnershipProbe is intentionally separate from ProcessController:
// lifecycle control is still pending, while callers can safely inspect task
// provenance without gaining a stop/kill capability.
type ScheduledTaskOwnershipProbe interface {
	InspectOwnership(context.Context) (ScheduledTaskObservation, error)
}

// WindowsProcessController retains the old lifecycle methods for the existing
// seam, but its new ownership operation is read-only.  The query runner is
// injected only for deterministic tests; production construction uses the
// platform-specific fixed Task Scheduler runner.
type WindowsProcessController struct {
	query     ScheduledTaskQueryRunner
	lifecycle ScheduledTaskLifecycleRunner
	identity  ScheduledTaskIdentity
}

func NewWindowsProcessController() *WindowsProcessController {
	return NewWindowsProcessControllerWithRunner(newNativeScheduledTaskQueryRunner())
}

// NewWindowsProcessControllerWithRunner is a test seam. It does not loosen
// the task identity: the controller still queries and validates only the
// compile-time LongHub task contract. A runner that also implements the
// lifecycle seam enables EnsureScheduledTask/RemoveScheduledTask; a
// query-only runner keeps lifecycle operations fail-closed.
func NewWindowsProcessControllerWithRunner(runner ScheduledTaskQueryRunner) *WindowsProcessController {
	if runner == nil {
		runner = newNativeScheduledTaskQueryRunner()
	}
	controller := &WindowsProcessController{
		query:    runner,
		identity: DefaultLongHubGatewayTaskIdentity(),
	}
	if lifecycle, ok := runner.(ScheduledTaskLifecycleRunner); ok {
		controller.lifecycle = lifecycle
	}
	return controller
}

// InspectOwnership performs one bounded, read-only task XML query. A missing
// task is classified as external (the normal state for a user-managed
// Gateway). A same-name task with a mismatched marker/action is unknown and
// returns an error so a future lifecycle caller cannot treat it as managed.
func (c *WindowsProcessController) InspectOwnership(ctx context.Context) (ScheduledTaskObservation, error) {
	unknown := ScheduledTaskObservation{
		Ownership: ScheduledTaskOwnershipUnknown,
		ErrorCode: "SCHEDULED_TASK_INSPECTION_FAILED",
	}
	if c == nil || c.query == nil {
		unknown.Ownership = ScheduledTaskOwnershipUnsupported
		unknown.ErrorCode = "SCHEDULED_TASK_UNSUPPORTED"
		return unknown, ErrNativeProcessControlUnavailable
	}
	if err := ctx.Err(); err != nil {
		return unknown, err
	}
	xmlBytes, err := c.query.Query(ctx, c.identity.TaskPath)
	if err != nil {
		switch {
		case errors.Is(err, ErrScheduledTaskNotFound):
			return ScheduledTaskObservation{
				Ownership:   ScheduledTaskOwnershipExternal,
				TaskPresent: false,
				ErrorCode:   "SCHEDULED_TASK_NOT_FOUND",
			}, nil
		case errors.Is(err, ErrNativeProcessControlUnavailable):
			unknown.Ownership = ScheduledTaskOwnershipUnsupported
			unknown.ErrorCode = "SCHEDULED_TASK_UNSUPPORTED"
			return unknown, ErrNativeProcessControlUnavailable
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			return unknown, err
		default:
			return unknown, ErrScheduledTaskInspectionFailed
		}
	}
	definition, parseErr := ParseScheduledTaskXML(xmlBytes)
	if parseErr != nil {
		return unknown, ErrScheduledTaskInspectionFailed
	}
	observation := ScheduledTaskObservation{
		Ownership:     ScheduledTaskOwnershipUnknown,
		TaskPresent:   true,
		TaskPathValid: windowsTaskPathEqual(definition.TaskPath, c.identity.TaskPath),
		MarkerValid:   definition.OwnerMarker == c.identity.OwnerMarker,
		ActionValid:   validLongHubGatewayTaskAction(definition.ActionCommand, definition.ActionArguments),
		ErrorCode:     "SCHEDULED_TASK_IDENTITY_MISMATCH",
	}
	if !observation.TaskPathValid || !observation.MarkerValid || !observation.ActionValid {
		return observation, ErrScheduledTaskIdentityMismatch
	}
	observation.Ownership = ScheduledTaskOwnershipLongHub
	observation.ErrorCode = ""
	return observation, nil
}

// ProbeOwnership and InspectScheduledTask are descriptive aliases for callers
// that prefer probe- or task-oriented terminology. They share the exact same
// fail-closed implementation.
func (c *WindowsProcessController) ProbeOwnership(ctx context.Context) (ScheduledTaskObservation, error) {
	return c.InspectOwnership(ctx)
}

func (c *WindowsProcessController) InspectScheduledTask(ctx context.Context) (ScheduledTaskObservation, error) {
	return c.InspectOwnership(ctx)
}

// EnsureScheduledTask registers the fixed LongHub Gateway task when it is
// absent. An already-proven LongHub task is an idempotent success; a same-name
// task that fails the identity proof is never overwritten. After registration
// the controller re-runs the ownership probe. An unverifiable result is left
// untouched: deleting by name at that point could remove a task that another
// local process replaced between registration and verification.
func (c *WindowsProcessController) EnsureScheduledTask(ctx context.Context, command string) error {
	if c == nil || c.lifecycle == nil {
		return ErrNativeProcessControlUnavailable
	}
	// Validate before probing so an invalid command never reaches Register.
	taskXML, buildErr := BuildLongHubGatewayTaskXML(command)
	if buildErr != nil {
		return buildErr
	}
	observation, err := c.InspectOwnership(ctx)
	switch {
	case err == nil && observation.Ownership == ScheduledTaskOwnershipLongHub:
		return nil
	case err == nil && !observation.TaskPresent:
		// Missing task: the only state in which registration may proceed.
	case errors.Is(err, ErrScheduledTaskIdentityMismatch):
		return ErrScheduledTaskForeignOwner
	case err != nil:
		return err
	default:
		return ErrScheduledTaskForeignOwner
	}
	if registerErr := c.lifecycle.Register(ctx, c.identity.TaskPath, taskXML); registerErr != nil {
		if errors.Is(registerErr, ErrNativeProcessControlUnavailable) {
			return registerErr
		}
		return ErrScheduledTaskOperationFailed
	}
	verification, verifyErr := c.InspectOwnership(ctx)
	if verifyErr != nil || verification.Ownership != ScheduledTaskOwnershipLongHub {
		// Never attempt a name-only rollback without a complete ownership
		// proof. A later retry can prove this task and treat it as idempotent,
		// while an operator can inspect a conflicting definition safely.
		return ErrScheduledTaskOperationFailed
	}
	return nil
}

// RemoveScheduledTask deletes the fixed task only after a fresh, complete v1
// ownership proof. A missing task is an idempotent success; anything the probe
// cannot prove (mismatch, unknown, query failure) refuses deletion.
func (c *WindowsProcessController) RemoveScheduledTask(ctx context.Context) error {
	if c == nil || c.lifecycle == nil {
		return ErrNativeProcessControlUnavailable
	}
	observation, err := c.InspectOwnership(ctx)
	switch {
	case err == nil && !observation.TaskPresent:
		return nil
	case err == nil && observation.Ownership == ScheduledTaskOwnershipLongHub &&
		observation.TaskPathValid && observation.MarkerValid && observation.ActionValid:
		// Complete proof: deletion may proceed.
	case errors.Is(err, ErrScheduledTaskIdentityMismatch):
		return ErrScheduledTaskForeignOwner
	case err != nil:
		return err
	default:
		return ErrScheduledTaskForeignOwner
	}
	if deleteErr := c.lifecycle.Delete(ctx, c.identity.TaskPath); deleteErr != nil {
		if errors.Is(deleteErr, ErrNativeProcessControlUnavailable) {
			return deleteErr
		}
		return ErrScheduledTaskOperationFailed
	}
	return nil
}

func (WindowsProcessController) Start(context.Context, ProcessSpec) (ManagedProcess, error) {
	return ManagedProcess{}, ErrWindowsTaskIntegrationPending
}

func (WindowsProcessController) Stop(context.Context, ManagedProcess) error {
	return ErrWindowsTaskIntegrationPending
}

func (WindowsProcessController) IsRunning(context.Context, ManagedProcess) (bool, error) {
	return false, ErrWindowsTaskIntegrationPending
}

// UnsupportedProcessController makes platform gaps visible instead of falling
// back to PID/port killing. It is useful for macOS/Linux until their adapters
// are designed, and also documents the seam used by the Windows implementation.
type UnsupportedProcessController struct{ Platform string }

func NewPlatformProcessController() ProcessController {
	if stdRuntime.GOOS == "windows" {
		return NewWindowsProcessController()
	}
	return UnsupportedProcessController{Platform: stdRuntime.GOOS}
}

func (c UnsupportedProcessController) Start(context.Context, ProcessSpec) (ManagedProcess, error) {
	return ManagedProcess{}, c.err()
}

func (c UnsupportedProcessController) Stop(context.Context, ManagedProcess) error { return c.err() }

func (c UnsupportedProcessController) IsRunning(context.Context, ManagedProcess) (bool, error) {
	return false, c.err()
}

func (c UnsupportedProcessController) InspectOwnership(context.Context) (ScheduledTaskObservation, error) {
	return ScheduledTaskObservation{
		Ownership: ScheduledTaskOwnershipUnsupported,
		ErrorCode: "SCHEDULED_TASK_UNSUPPORTED",
	}, c.err()
}

func (c UnsupportedProcessController) err() error {
	if c.Platform == "" {
		return ErrNativeProcessControlUnavailable
	}
	return fmt.Errorf("%s: %w", c.Platform, ErrNativeProcessControlUnavailable)
}

// ParseScheduledTaskXML extracts only the fields required by the fixed
// ownership contract. It accepts UTF-8 and the UTF-16 encodings emitted by
// Windows Task Scheduler, rejects oversized/malformed input, and never
// returns raw XML in an error.
func ParseScheduledTaskXML(data []byte) (ScheduledTaskDefinition, error) {
	data, err := normalizeScheduledTaskXML(data)
	if err != nil {
		return ScheduledTaskDefinition{}, ErrScheduledTaskInspectionFailed
	}
	type execAction struct {
		Command   string `xml:"Command"`
		Arguments string `xml:"Arguments"`
	}
	var document struct {
		XMLName          xml.Name `xml:"Task"`
		RegistrationInfo struct {
			Description string `xml:"Description"`
			URI         string `xml:"URI"`
		} `xml:"RegistrationInfo"`
		Actions struct {
			Exec []execAction `xml:"Exec"`
		} `xml:"Actions"`
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	if err := decoder.Decode(&document); err != nil || !strings.EqualFold(document.XMLName.Local, "Task") {
		return ScheduledTaskDefinition{}, ErrScheduledTaskInspectionFailed
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return ScheduledTaskDefinition{}, ErrScheduledTaskInspectionFailed
	}
	if len(document.Actions.Exec) != 1 {
		return ScheduledTaskDefinition{}, ErrScheduledTaskInspectionFailed
	}
	action := document.Actions.Exec[0]
	return ScheduledTaskDefinition{
		// Keep element text byte-for-byte (after XML decoding). The contract is
		// intentionally exact; surrounding whitespace is drift, not a cosmetic
		// formatting difference that should be accepted for ownership.
		TaskPath:        document.RegistrationInfo.URI,
		OwnerMarker:     document.RegistrationInfo.Description,
		ActionCommand:   action.Command,
		ActionArguments: action.Arguments,
	}, nil
}

func normalizeScheduledTaskXML(data []byte) ([]byte, error) {
	if len(data) == 0 || len(data) > maxScheduledTaskXMLBytes {
		return nil, ErrScheduledTaskInspectionFailed
	}
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		data = data[3:]
	}
	if len(data) >= 2 && ((data[0] == 0xFF && data[1] == 0xFE) || (data[0] == 0xFE && data[1] == 0xFF)) {
		littleEndian := data[0] == 0xFF
		data = data[2:]
		if len(data)%2 != 0 {
			return nil, ErrScheduledTaskInspectionFailed
		}
		units := make([]uint16, len(data)/2)
		for index := range units {
			if littleEndian {
				units[index] = binary.LittleEndian.Uint16(data[index*2:])
			} else {
				units[index] = binary.BigEndian.Uint16(data[index*2:])
			}
		}
		data = []byte(string(utf16.Decode(units)))
	}
	// Some Task Scheduler shims omit the BOM but retain the UTF-16 byte
	// pattern. Detect it without accepting arbitrary NUL-containing payloads.
	if len(data) >= 4 && data[1] == 0 && data[3] == 0 && data[0] == '<' && data[2] != 0 {
		if len(data)%2 != 0 {
			return nil, ErrScheduledTaskInspectionFailed
		}
		units := make([]uint16, len(data)/2)
		for index := range units {
			units[index] = binary.LittleEndian.Uint16(data[index*2:])
		}
		data = []byte(string(utf16.Decode(units)))
	} else if len(data) >= 4 && data[0] == 0 && data[2] == 0 && data[1] == '<' && data[3] != 0 {
		if len(data)%2 != 0 {
			return nil, ErrScheduledTaskInspectionFailed
		}
		units := make([]uint16, len(data)/2)
		for index := range units {
			units[index] = binary.BigEndian.Uint16(data[index*2:])
		}
		data = []byte(string(utf16.Decode(units)))
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return nil, ErrScheduledTaskInspectionFailed
	}
	return data, nil
}

func windowsTaskPathEqual(actual, expected string) bool {
	if actual != strings.TrimSpace(actual) || expected != strings.TrimSpace(expected) {
		return false
	}
	actual = strings.ReplaceAll(actual, "/", `\`)
	expected = strings.ReplaceAll(expected, "/", `\`)
	return actual != "" && strings.EqualFold(actual, expected)
}

func validLongHubGatewayTaskAction(command, arguments string) bool {
	if command != strings.TrimSpace(command) || arguments != strings.TrimSpace(arguments) {
		return false
	}
	if command == "" || strings.IndexAny(command, "\x00\r\n\t\"") >= 0 || !isAbsoluteWindowsPath(command) {
		return false
	}
	normalized := strings.ReplaceAll(command, "/", `\`)
	base := normalized[strings.LastIndex(normalized, `\`)+1:]
	switch strings.ToLower(base) {
	case "longhubmanager.exe", "longhub-manager.exe":
		return strings.TrimSpace(arguments) == LongHubGatewayTaskArguments
	default:
		return false
	}
}

func isAbsoluteWindowsPath(value string) bool {
	if len(value) < 3 || value[1] != ':' || (value[2] != '\\' && value[2] != '/') {
		return false
	}
	// Reject device/UNC forms and control characters even if they look rooted;
	// the LongHub task must execute the installed Manager launcher.
	return value[0] >= 'A' && value[0] <= 'Z' || value[0] >= 'a' && value[0] <= 'z'
}

// BuildLongHubGatewayTaskXML renders the one fixed task definition the Manager
// may register. Every identity value is compile-time constant; only the
// absolute installed Manager command is caller-supplied, and it must pass the
// exact action contract used by the ownership probe. The rendered XML is
// re-parsed and re-validated so template drift can never silently produce a
// definition the probe would later reject.
func BuildLongHubGatewayTaskXML(command string) ([]byte, error) {
	if !validLongHubGatewayTaskAction(command, LongHubGatewayTaskArguments) {
		return nil, ErrScheduledTaskInvalidCommand
	}
	var escapedCommand bytes.Buffer
	if err := xml.EscapeText(&escapedCommand, []byte(command)); err != nil {
		return nil, ErrScheduledTaskInvalidCommand
	}
	taskXML := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>` + LongHubGatewayTaskOwnerMarker + `</Description>
    <URI>` + LongHubGatewayTaskPath + `</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + escapedCommand.String() + `</Command>
      <Arguments>` + LongHubGatewayTaskArguments + `</Arguments>
    </Exec>
  </Actions>
</Task>`)
	definition, err := ParseScheduledTaskXML(taskXML)
	if err != nil ||
		!windowsTaskPathEqual(definition.TaskPath, LongHubGatewayTaskPath) ||
		definition.OwnerMarker != LongHubGatewayTaskOwnerMarker ||
		definition.ActionCommand != command ||
		!validLongHubGatewayTaskAction(definition.ActionCommand, definition.ActionArguments) {
		return nil, ErrScheduledTaskInvalidCommand
	}
	return taskXML, nil
}
