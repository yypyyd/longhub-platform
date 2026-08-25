package runtime

import (
	"context"
	"errors"
	"testing"
)

// scheduledTaskFakeLifecycleRunner simulates the Task Scheduler store: Query
// serves whatever XML was last registered, Register refuses overwrites (like
// schtasks /Create without /F) and Delete removes the stored definition.
type scheduledTaskFakeLifecycleRunner struct {
	xml         []byte
	queryErr    error
	registerErr error
	deleteErr   error
	// registeredXML lets a test corrupt what registration actually persists,
	// exercising the post-registration verification failure path.
	registeredXML []byte
	registerCalls int
	deleteCalls   int
	paths         []string
}

func (f *scheduledTaskFakeLifecycleRunner) Query(_ context.Context, taskPath string) ([]byte, error) {
	f.paths = append(f.paths, taskPath)
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	if len(f.xml) == 0 {
		return nil, ErrScheduledTaskNotFound
	}
	return append([]byte(nil), f.xml...), nil
}

func (f *scheduledTaskFakeLifecycleRunner) Register(_ context.Context, taskPath string, taskXML []byte) error {
	f.registerCalls++
	if taskPath != LongHubGatewayTaskPath {
		return ErrScheduledTaskIdentityMismatch
	}
	if f.registerErr != nil {
		return f.registerErr
	}
	if len(f.xml) != 0 {
		return ErrScheduledTaskOperationFailed
	}
	if f.registeredXML != nil {
		f.xml = append([]byte(nil), f.registeredXML...)
	} else {
		f.xml = append([]byte(nil), taskXML...)
	}
	return nil
}

func (f *scheduledTaskFakeLifecycleRunner) Delete(_ context.Context, taskPath string) error {
	f.deleteCalls++
	if taskPath != LongHubGatewayTaskPath {
		return ErrScheduledTaskIdentityMismatch
	}
	if f.deleteErr != nil {
		return f.deleteErr
	}
	if len(f.xml) == 0 {
		return ErrScheduledTaskOperationFailed
	}
	f.xml = nil
	return nil
}

const lifecycleTestCommand = `C:\Program Files\LongHub Manager\LongHubManager.exe`

func TestBuildLongHubGatewayTaskXMLSatisfiesOwnershipContract(t *testing.T) {
	taskXML, err := BuildLongHubGatewayTaskXML(lifecycleTestCommand)
	if err != nil {
		t.Fatal(err)
	}
	definition, err := ParseScheduledTaskXML(taskXML)
	if err != nil {
		t.Fatal(err)
	}
	if definition.TaskPath != LongHubGatewayTaskPath ||
		definition.OwnerMarker != LongHubGatewayTaskOwnerMarker ||
		definition.ActionCommand != lifecycleTestCommand ||
		definition.ActionArguments != LongHubGatewayTaskArguments {
		t.Fatalf("built XML violates the fixed contract: %+v", definition)
	}
}

func TestBuildLongHubGatewayTaskXMLRejectsForeignCommands(t *testing.T) {
	for _, command := range []string{
		"",
		"LongHubManager.exe",                // relative
		`C:\tools\evil.exe`,                 // wrong binary name
		`\\server\share\LongHubManager.exe`, // UNC
		`C:\tools\LongHubManager.exe" /bad`, // quote injection
		"C:\\tools\\LongHubManager.exe\n",   // control character
	} {
		if _, err := BuildLongHubGatewayTaskXML(command); !errors.Is(err, ErrScheduledTaskInvalidCommand) {
			t.Fatalf("command %q must be rejected, got %v", command, err)
		}
	}
}

func TestEnsureScheduledTaskRegistersWhenMissing(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{}
	controller := NewWindowsProcessControllerWithRunner(runner)
	if err := controller.EnsureScheduledTask(context.Background(), lifecycleTestCommand); err != nil {
		t.Fatal(err)
	}
	if runner.registerCalls != 1 {
		t.Fatalf("expected exactly one registration, got %d", runner.registerCalls)
	}
	observation, err := controller.InspectOwnership(context.Background())
	if err != nil || observation.Ownership != ScheduledTaskOwnershipLongHub {
		t.Fatalf("registered task must prove LongHub ownership, got %+v %v", observation, err)
	}
}

func TestEnsureScheduledTaskIsIdempotentForProvenTask(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{
		xml: validScheduledTaskXML(lifecycleTestCommand, LongHubGatewayTaskArguments,
			LongHubGatewayTaskOwnerMarker, LongHubGatewayTaskPath),
	}
	controller := NewWindowsProcessControllerWithRunner(runner)
	if err := controller.EnsureScheduledTask(context.Background(), lifecycleTestCommand); err != nil {
		t.Fatal(err)
	}
	if runner.registerCalls != 0 {
		t.Fatal("an already-proven task must not be re-registered")
	}
}

func TestEnsureScheduledTaskNeverOverwritesForeignTask(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{
		xml: validScheduledTaskXML(lifecycleTestCommand, LongHubGatewayTaskArguments,
			"someone-else/task/v9", LongHubGatewayTaskPath),
	}
	controller := NewWindowsProcessControllerWithRunner(runner)
	err := controller.EnsureScheduledTask(context.Background(), lifecycleTestCommand)
	if !errors.Is(err, ErrScheduledTaskForeignOwner) {
		t.Fatalf("expected foreign owner refusal, got %v", err)
	}
	if runner.registerCalls != 0 || runner.deleteCalls != 0 {
		t.Fatal("foreign task must not be touched")
	}
}

func TestEnsureScheduledTaskRejectsInvalidCommandBeforeAnyQuery(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{}
	controller := NewWindowsProcessControllerWithRunner(runner)
	err := controller.EnsureScheduledTask(context.Background(), `C:\evil\not-openclaw.exe`)
	if !errors.Is(err, ErrScheduledTaskInvalidCommand) {
		t.Fatalf("expected invalid command refusal, got %v", err)
	}
	if len(runner.paths) != 0 || runner.registerCalls != 0 {
		t.Fatal("invalid command must be rejected before any Task Scheduler access")
	}
}

func TestEnsureScheduledTaskNeverDeletesUnverifiableRegistration(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{
		registeredXML: validScheduledTaskXML(lifecycleTestCommand, LongHubGatewayTaskArguments,
			"drifted/marker/v0", LongHubGatewayTaskPath),
	}
	controller := NewWindowsProcessControllerWithRunner(runner)
	err := controller.EnsureScheduledTask(context.Background(), lifecycleTestCommand)
	if !errors.Is(err, ErrScheduledTaskOperationFailed) {
		t.Fatalf("expected operation failure, got %v", err)
	}
	if runner.deleteCalls != 0 {
		t.Fatal("unverifiable registration must never trigger a name-only delete")
	}
	if len(runner.xml) == 0 {
		t.Fatal("the unproven task must remain available for safe inspection")
	}
}

func TestEnsureScheduledTaskFailsClosedWhenQueryFails(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{queryErr: errors.New("boom")}
	controller := NewWindowsProcessControllerWithRunner(runner)
	err := controller.EnsureScheduledTask(context.Background(), lifecycleTestCommand)
	if !errors.Is(err, ErrScheduledTaskInspectionFailed) {
		t.Fatalf("expected inspection failure, got %v", err)
	}
	if runner.registerCalls != 0 {
		t.Fatal("registration must not proceed on an unproven store")
	}
}

func TestRemoveScheduledTaskDeletesOnlyProvenTask(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{
		xml: validScheduledTaskXML(lifecycleTestCommand, LongHubGatewayTaskArguments,
			LongHubGatewayTaskOwnerMarker, LongHubGatewayTaskPath),
	}
	controller := NewWindowsProcessControllerWithRunner(runner)
	if err := controller.RemoveScheduledTask(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.deleteCalls != 1 || len(runner.xml) != 0 {
		t.Fatal("proven task must be deleted exactly once")
	}
}

func TestRemoveScheduledTaskIsIdempotentWhenMissing(t *testing.T) {
	runner := &scheduledTaskFakeLifecycleRunner{}
	controller := NewWindowsProcessControllerWithRunner(runner)
	if err := controller.RemoveScheduledTask(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.deleteCalls != 0 {
		t.Fatal("missing task must not trigger a delete")
	}
}

func TestRemoveScheduledTaskRefusesForeignOrUnprovenTask(t *testing.T) {
	foreign := &scheduledTaskFakeLifecycleRunner{
		xml: validScheduledTaskXML(`C:\other\tool.exe`, "serve",
			LongHubGatewayTaskOwnerMarker, LongHubGatewayTaskPath),
	}
	controller := NewWindowsProcessControllerWithRunner(foreign)
	if err := controller.RemoveScheduledTask(context.Background()); !errors.Is(err, ErrScheduledTaskForeignOwner) {
		t.Fatalf("expected foreign owner refusal, got %v", err)
	}
	if foreign.deleteCalls != 0 {
		t.Fatal("foreign task must never be deleted")
	}

	failing := &scheduledTaskFakeLifecycleRunner{queryErr: errors.New("boom")}
	controller = NewWindowsProcessControllerWithRunner(failing)
	if err := controller.RemoveScheduledTask(context.Background()); !errors.Is(err, ErrScheduledTaskInspectionFailed) {
		t.Fatalf("expected inspection failure, got %v", err)
	}
	if failing.deleteCalls != 0 {
		t.Fatal("unproven store must never be deleted from")
	}
}

func TestLifecycleUnavailableWithQueryOnlyRunner(t *testing.T) {
	controller := NewWindowsProcessControllerWithRunner(&scheduledTaskFakeRunner{})
	if err := controller.EnsureScheduledTask(context.Background(), lifecycleTestCommand); !errors.Is(err, ErrNativeProcessControlUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
	if err := controller.RemoveScheduledTask(context.Background()); !errors.Is(err, ErrNativeProcessControlUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}
