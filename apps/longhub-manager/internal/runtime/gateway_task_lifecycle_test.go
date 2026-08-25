package runtime

import (
	"context"
	"errors"
	"testing"
)

// fakeTaskLifecycleProbe implements both the ownership probe and the
// enroll/remove lifecycle seam, mirroring the Windows controller shape.
type fakeTaskLifecycleProbe struct {
	fakeOwnershipProbe
	ensureErr   error
	removeErr   error
	ensureCalls int
	removeCalls int
	commands    []string
}

func (f *fakeTaskLifecycleProbe) EnsureScheduledTask(_ context.Context, command string) error {
	f.ensureCalls++
	f.commands = append(f.commands, command)
	return f.ensureErr
}

func (f *fakeTaskLifecycleProbe) RemoveScheduledTask(context.Context) error {
	f.removeCalls++
	return f.removeErr
}

func installedStoppedObservation() GatewayObservation {
	return GatewayObservation{
		Installed:    true,
		Command:      `C:\Users\demo\.openclaw\bin\openclaw.exe`,
		Version:      "2026.7.1-2",
		RunningKnown: true,
		Health:       GatewayHealthUnknown,
	}
}

const gatewayTaskManagerCommand = `C:\Program Files\LongHub Manager\LongHubManager.exe`

func TestGatewayManagerEnrollTaskRequiresConfirmation(t *testing.T) {
	probe := &fakeTaskLifecycleProbe{}
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: installedStoppedObservation()}, probe, gatewayTaskManagerCommand)
	if _, err := manager.EnrollScheduledTask(context.Background(), false); !errors.Is(err, ErrGatewayConfirmationRequired) {
		t.Fatalf("unconfirmed enroll error = %v", err)
	}
	if probe.ensureCalls != 0 {
		t.Fatal("enroll ran without confirmation")
	}
}

func TestGatewayManagerEnrollTaskPassesTrustedManagerCommand(t *testing.T) {
	probe := &fakeTaskLifecycleProbe{}
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: installedStoppedObservation()}, probe, gatewayTaskManagerCommand)
	if _, err := manager.EnrollScheduledTask(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if probe.ensureCalls != 1 || probe.commands[0] != gatewayTaskManagerCommand {
		t.Fatalf("unexpected enroll invocation: %+v", probe.commands)
	}
}

func TestGatewayManagerEnrollTaskRejectsNonContractCommand(t *testing.T) {
	probe := &fakeTaskLifecycleProbe{}
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: installedStoppedObservation()}, probe, `C:\somewhere\other-tool.exe`)
	if _, err := manager.EnrollScheduledTask(context.Background(), true); !errors.Is(err, ErrScheduledTaskInvalidCommand) {
		t.Fatalf("expected invalid command refusal, got %v", err)
	}
	if probe.ensureCalls != 0 {
		t.Fatal("invalid command must never reach the lifecycle seam")
	}
}

func TestGatewayManagerEnrollTaskRequiresInstalledOpenClaw(t *testing.T) {
	probe := &fakeTaskLifecycleProbe{}
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: GatewayObservation{RunningKnown: true}}, probe, gatewayTaskManagerCommand)
	if _, err := manager.EnrollScheduledTask(context.Background(), true); !errors.Is(err, ErrGatewayNotInstalled) {
		t.Fatalf("expected not-installed refusal, got %v", err)
	}
	if probe.ensureCalls != 0 {
		t.Fatal("enroll ran without an installed OpenClaw")
	}
}

func TestGatewayManagerTaskLifecycleUnavailableWithoutSeam(t *testing.T) {
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: installedStoppedObservation()},
		&fakeOwnershipProbe{}, gatewayTaskManagerCommand)
	if _, err := manager.EnrollScheduledTask(context.Background(), true); !errors.Is(err, ErrNativeProcessControlUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
	if _, err := manager.RemoveScheduledTask(context.Background(), true); !errors.Is(err, ErrNativeProcessControlUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}

func TestGatewayManagerRemoveTaskRequiresConfirmationAndPropagatesRefusals(t *testing.T) {
	probe := &fakeTaskLifecycleProbe{removeErr: ErrScheduledTaskForeignOwner}
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: installedStoppedObservation()}, probe, gatewayTaskManagerCommand)
	if _, err := manager.RemoveScheduledTask(context.Background(), false); !errors.Is(err, ErrGatewayConfirmationRequired) {
		t.Fatalf("unconfirmed remove error = %v", err)
	}
	if probe.removeCalls != 0 {
		t.Fatal("remove ran without confirmation")
	}
	if _, err := manager.RemoveScheduledTask(context.Background(), true); !errors.Is(err, ErrScheduledTaskForeignOwner) {
		t.Fatalf("expected foreign owner propagation, got %v", err)
	}
	if probe.removeCalls != 1 {
		t.Fatalf("expected one remove attempt, got %d", probe.removeCalls)
	}
}

func TestGatewayManagerEnrollDoesNotFlipProcessLocalOwnership(t *testing.T) {
	probe := &fakeTaskLifecycleProbe{}
	manager := NewGatewayManagerWithOwnershipProbeAndTaskCommand(
		&fakeGatewayController{observation: installedStoppedObservation()}, probe, gatewayTaskManagerCommand)
	status, err := manager.EnrollScheduledTask(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if status.Managed || manager.isManaged() {
		t.Fatal("enrollment must not mark the stopped gateway as managed")
	}
}

func TestGatewayManagerScheduledTaskStatusIsBoundedAndFailClosed(t *testing.T) {
	verified := ScheduledTaskObservation{
		Ownership:     ScheduledTaskOwnershipLongHub,
		TaskPresent:   true,
		TaskPathValid: true,
		MarkerValid:   true,
		ActionValid:   true,
	}
	tests := []struct {
		name      string
		probe     ScheduledTaskOwnershipProbe
		wantState ScheduledTaskState
		wantCode  string
		enrolled  bool
	}{
		{name: "unsupported", wantState: ScheduledTaskUnsupported, wantCode: "SCHEDULED_TASK_LIFECYCLE_UNSUPPORTED"},
		{name: "not enrolled", probe: &fakeOwnershipProbe{observation: ScheduledTaskObservation{Ownership: ScheduledTaskOwnershipExternal}}, wantState: ScheduledTaskNotEnrolled},
		{name: "enrolled", probe: &fakeOwnershipProbe{observation: verified}, wantState: ScheduledTaskEnrolled, enrolled: true},
		{name: "foreign owner", probe: &fakeOwnershipProbe{err: ErrScheduledTaskIdentityMismatch}, wantState: ScheduledTaskConflict, wantCode: "SCHEDULED_TASK_FOREIGN_OWNER"},
		{name: "inspection failure", probe: &fakeOwnershipProbe{err: ErrScheduledTaskInspectionFailed}, wantState: ScheduledTaskUnavailable, wantCode: "SCHEDULED_TASK_STATUS_UNAVAILABLE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager := NewGatewayManagerWithOwnershipProbe(
				&fakeGatewayController{observation: installedStoppedObservation()}, test.probe)
			status := manager.ScheduledTaskStatus(context.Background())
			if status.State != test.wantState || status.ErrorCode != test.wantCode || status.Enrolled != test.enrolled {
				t.Fatalf("unexpected public task status: %+v", status)
			}
			if status.Supported != (test.probe != nil) {
				t.Fatalf("unexpected supported flag: %+v", status)
			}
		})
	}
}

func TestGatewayManagerScheduledTaskStatusHonorsCanceledContext(t *testing.T) {
	probe := &fakeOwnershipProbe{}
	manager := NewGatewayManagerWithOwnershipProbe(
		&fakeGatewayController{observation: installedStoppedObservation()}, probe)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	status := manager.ScheduledTaskStatus(ctx)
	if status.State != ScheduledTaskUnavailable || status.ErrorCode != "SCHEDULED_TASK_STATUS_UNAVAILABLE" {
		t.Fatalf("canceled status must fail closed: %+v", status)
	}
	if probe.calls != 0 {
		t.Fatal("canceled status must not reach Task Scheduler")
	}
}
