package runtime

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeGatewayController struct {
	observation GatewayObservation
	err         error
	startErr    error
	restartErr  error
	starts      int
	stops       int
	restarts    int
}

func (f *fakeGatewayController) Inspect(context.Context) (GatewayObservation, error) {
	return f.observation, f.err
}

func (f *fakeGatewayController) Start(context.Context) error {
	f.starts++
	if f.startErr != nil {
		return f.startErr
	}
	f.observation.Running = true
	f.observation.RunningKnown = true
	f.observation.Health = GatewayHealthHealthy
	return nil
}

func (f *fakeGatewayController) Stop(context.Context) error {
	f.stops++
	f.observation.Running = false
	f.observation.RunningKnown = true
	f.observation.Health = GatewayHealthUnknown
	return nil
}

func (f *fakeGatewayController) Restart(context.Context) error {
	f.restarts++
	if f.restartErr != nil {
		return f.restartErr
	}
	f.observation.Running = true
	f.observation.RunningKnown = true
	f.observation.Health = GatewayHealthHealthy
	return nil
}

func TestGatewayLaunchHooksRunOnlyAroundAnAttemptedLaunch(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		RunningKnown: true,
	}}
	manager := NewGatewayManagerWithController(controller)
	beforeCalls := 0
	afterResults := make([]bool, 0, 2)
	hooks := GatewayLaunchHooks{
		Before: func() { beforeCalls++ },
		After:  func(succeeded bool) { afterResults = append(afterResults, succeeded) },
	}

	if _, err := manager.ControlWithLaunchHooks(context.Background(), "start", false, hooks); !errors.Is(err, ErrGatewayConfirmationRequired) {
		t.Fatalf("unconfirmed start error = %v", err)
	}
	if beforeCalls != 0 || len(afterResults) != 0 {
		t.Fatal("launch hooks ran for a rejected start")
	}
	if _, err := manager.ControlWithLaunchHooks(context.Background(), "start", true, hooks); err != nil {
		t.Fatal(err)
	}
	if beforeCalls != 1 || !reflect.DeepEqual(afterResults, []bool{true}) {
		t.Fatalf("successful start hook results: before=%d after=%v", beforeCalls, afterResults)
	}
	if _, err := manager.ControlWithLaunchHooks(context.Background(), "start", true, hooks); err != nil {
		t.Fatal(err)
	}
	if beforeCalls != 1 || len(afterResults) != 1 {
		t.Fatal("launch hooks ran for an idempotent start")
	}
}

func TestGatewayLaunchHooksRollbackSignalOnCommandFailure(t *testing.T) {
	controller := &fakeGatewayController{
		observation: GatewayObservation{Installed: true, RunningKnown: true},
		startErr:    errors.New("fixture start failed"),
	}
	manager := NewGatewayManagerWithController(controller)
	beforeCalls := 0
	afterResults := make([]bool, 0, 1)
	_, err := manager.ControlWithLaunchHooks(context.Background(), "start", true, GatewayLaunchHooks{
		Before: func() { beforeCalls++ },
		After:  func(succeeded bool) { afterResults = append(afterResults, succeeded) },
	})
	if !errors.Is(err, ErrGatewayActionFailed) {
		t.Fatalf("failed start error = %v", err)
	}
	if beforeCalls != 1 || !reflect.DeepEqual(afterResults, []bool{false}) {
		t.Fatalf("failed start hook results: before=%d after=%v", beforeCalls, afterResults)
	}
}

func TestGatewayManagerClassifiesPreExistingGatewayAsExternal(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		Command:      `C:\Users\demo\AppData\Roaming\npm\openclaw.cmd`,
		Version:      "2026.7.1-2",
		Running:      true,
		RunningKnown: true,
		Health:       GatewayHealthHealthy,
	}}
	manager := NewGatewayManagerWithController(controller)
	status := manager.Discover(context.Background())
	if status.State != GatewayRunningExternal || !status.Running || status.Managed {
		t.Fatalf("expected external running state, got %+v", status)
	}
	if controller.starts != 0 || controller.stops != 0 || controller.restarts != 0 {
		t.Fatal("discovery must not mutate an externally managed Gateway")
	}
}

func TestGatewayManagerStartRequiresConfirmationAndMarksOwnership(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		Version:      "2026.7.1-2",
		Running:      false,
		RunningKnown: true,
	}}
	manager := NewGatewayManagerWithController(controller)
	status, err := manager.Start(context.Background(), false)
	if !errors.Is(err, ErrGatewayConfirmationRequired) || status.State != GatewayInstalledStopped {
		t.Fatalf("expected confirmation gate, got status=%+v err=%v", status, err)
	}
	if controller.starts != 0 {
		t.Fatal("start command ran before confirmation")
	}
	status, err = manager.Start(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != GatewayRunningManaged || !status.Managed || controller.starts != 1 {
		t.Fatalf("expected Manager-owned running state, got %+v (starts=%d)", status, controller.starts)
	}
}

func TestGatewayManagerProtectsExternalStopAndRestart(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		Running:      true,
		RunningKnown: true,
		Health:       GatewayHealthHealthy,
	}}
	manager := NewGatewayManagerWithController(controller)
	status, err := manager.Stop(context.Background(), false)
	if !errors.Is(err, ErrExternalGateway) || status.State != GatewayRunningExternal {
		t.Fatalf("expected external stop gate, got status=%+v err=%v", status, err)
	}
	status, err = manager.Restart(context.Background(), false)
	if !errors.Is(err, ErrExternalGateway) || status.State != GatewayRunningExternal {
		t.Fatalf("expected external restart gate, got status=%+v err=%v", status, err)
	}
	if controller.stops != 0 || controller.restarts != 0 {
		t.Fatal("external Gateway must not be changed without explicit confirmation")
	}
	status, err = manager.Stop(context.Background(), true)
	if err != nil || status.State != GatewayInstalledStopped || controller.stops != 1 {
		t.Fatalf("confirmed external stop failed: status=%+v err=%v", status, err)
	}
}

func TestGatewayManagerPreservesManagedOwnershipAcrossRestart(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		Running:      false,
		RunningKnown: true,
	}}
	manager := NewGatewayManagerWithController(controller)
	if _, err := manager.Start(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	status, err := manager.Restart(context.Background(), true)
	if err != nil || status.State != GatewayRunningManaged || !status.Managed || controller.restarts != 1 {
		t.Fatalf("managed restart lost ownership: status=%+v err=%v", status, err)
	}
	status, err = manager.Stop(context.Background(), true)
	if err != nil || status.State != GatewayInstalledStopped || status.Managed {
		t.Fatalf("managed stop did not clear ownership: status=%+v err=%v", status, err)
	}
}

func TestGatewayManagerRestartFromStoppedMarksNewProcessManaged(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		Running:      false,
		RunningKnown: true,
	}}
	manager := NewGatewayManagerWithController(controller)
	status, err := manager.Restart(context.Background(), true)
	if err != nil || status.State != GatewayRunningManaged || !status.Managed {
		t.Fatalf("restart from stopped lost Manager ownership: status=%+v err=%v", status, err)
	}
	if controller.restarts != 1 {
		t.Fatalf("restart calls=%d, want one", controller.restarts)
	}
}

func TestNativeAdapterExposesGatewayOwnershipManager(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{Installed: true, RunningKnown: true}}
	manager := NewGatewayManagerWithController(controller)
	if manager.Status(context.Background()).State != GatewayInstalledStopped {
		t.Fatal("unexpected injected manager status")
	}
	// The adapter-facing methods are covered by constructing a native adapter
	// with the same command seam; no private OpenClaw path is introduced.
	runner := &gatewayFakeRunner{
		path: "openclaw",
		outputs: map[string]string{
			"--version":      "OpenClaw 2026.7.1-2",
			"gateway status": "stopped",
			"gateway start":  "started",
		},
		errors: map[string]error{},
	}
	adapter := NewNativeAdapter(runner)
	if status := adapter.GatewayStatus(context.Background()); status.State != GatewayInstalledStopped {
		t.Fatalf("unexpected adapter gateway status: %+v", status)
	}
}

func TestGatewayManagerInspectionFailsClosedWithoutRawError(t *testing.T) {
	controller := &fakeGatewayController{
		err: errors.New("secret path C:\\private\\token=abc"),
	}
	status := NewGatewayManagerWithController(controller).Discover(context.Background())
	if status.State != GatewayUnknown || status.ErrorCode != "GATEWAY_STATUS_UNAVAILABLE" {
		t.Fatalf("expected fixed unknown status, got %+v", status)
	}
	if strings.Contains(status.Message, "secret") || strings.Contains(status.Message, "token") {
		t.Fatalf("raw inspection error leaked: %+v", status)
	}
}

func TestGatewayManagerDoesNotTreatUnknownInstalledStateAsStopped(t *testing.T) {
	controller := &fakeGatewayController{observation: GatewayObservation{Installed: true, Version: "2026.7.1-2"}}
	manager := NewGatewayManagerWithController(controller)
	status := manager.Discover(context.Background())
	if status.State != GatewayUnknown || status.ErrorCode != "GATEWAY_STATUS_UNAVAILABLE" {
		t.Fatalf("unknown running state was not fail-closed: %+v", status)
	}
	if _, err := manager.Start(context.Background(), true); !errors.Is(err, ErrGatewayInspectionFailed) {
		t.Fatalf("action should be blocked when state is unknown, got %v", err)
	}
}

type gatewayFakeRunner struct {
	path    string
	outputs map[string]string
	errors  map[string]error
	calls   [][]string
}

func (f *gatewayFakeRunner) LookPath(string) (string, error) {
	if f.path == "" {
		return "", errors.New("openclaw not found")
	}
	return f.path, nil
}

func (f *gatewayFakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	call := append([]string{name}, args...)
	f.calls = append(f.calls, call)
	key := strings.Join(args, " ")
	return []byte(f.outputs[key]), f.errors[key]
}

func TestOpenClawGatewayControllerUsesOnlyFixedCLIAndParsesHealth(t *testing.T) {
	runner := &gatewayFakeRunner{
		path: "openclaw",
		outputs: map[string]string{
			"--version":       "OpenClaw 2026.7.1-2",
			"gateway status":  `{"running":true}`,
			"gateway health":  `{"ok":true}`,
			"gateway start":   "started",
			"gateway stop":    "stopped",
			"gateway restart": "restarted",
		},
		errors: map[string]error{},
	}
	controller := NewOpenClawGatewayController(runner)
	observation, err := controller.Inspect(context.Background())
	if err != nil || !observation.Installed || !observation.Running || observation.Health != GatewayHealthHealthy {
		t.Fatalf("unexpected inspection: %+v err=%v", observation, err)
	}
	if err := controller.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := controller.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := controller.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"openclaw", "--version"},
		{"openclaw", "gateway", "status"},
		{"openclaw", "gateway", "health"},
		{"openclaw", "gateway", "start"},
		{"openclaw", "gateway", "stop"},
		{"openclaw", "gateway", "restart"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("unexpected CLI calls: %#v", runner.calls)
	}
}

func TestOpenClawGatewayControllerMissingRuntimeIsNotInstalled(t *testing.T) {
	observation, err := NewOpenClawGatewayController(&gatewayFakeRunner{}).Inspect(context.Background())
	if err != nil || observation.Installed || observation.Running {
		t.Fatalf("expected not-installed observation, got %+v err=%v", observation, err)
	}
}

func TestGatewayStateParsersFailClosedOnUnknownText(t *testing.T) {
	if running, known := parseGatewayRunning("service exists"); running || known {
		t.Fatal("unknown status must not be treated as running")
	}
	if running, known := parseGatewayRunning("Gateway is not running"); running || !known {
		t.Fatal("negative running status must not be classified as active")
	}
	if running, known := parseGatewayRunning("Gateway is not installed"); running || !known {
		t.Fatal("negative installation status must remain stopped")
	}
	if health, known := parseGatewayHealth("service exists"); health != GatewayHealthUnknown || known {
		t.Fatal("unknown health must remain unknown")
	}
	if health, known := parseGatewayHealth("not healthy"); health != GatewayHealthUnhealthy || !known {
		t.Fatal("negative health status must not be classified as healthy")
	}
	if running, known := parseGatewayRunning(`{"status":"stopped"}`); running || !known {
		t.Fatal("JSON stopped status was not parsed")
	}
}

type fakeOwnershipProbe struct {
	observation ScheduledTaskObservation
	err         error
	calls       int
	contexts    []context.Context
}

func (f *fakeOwnershipProbe) InspectOwnership(ctx context.Context) (ScheduledTaskObservation, error) {
	f.calls++
	f.contexts = append(f.contexts, ctx)
	return f.observation, f.err
}

func runningGatewayObservation() GatewayObservation {
	return GatewayObservation{
		Installed:    true,
		Version:      "2026.7.1-2",
		Running:      true,
		RunningKnown: true,
		Health:       GatewayHealthHealthy,
	}
}

func TestGatewayManagerUpgradesOwnershipFromVerifiedScheduledTask(t *testing.T) {
	probe := &fakeOwnershipProbe{observation: ScheduledTaskObservation{
		Ownership:     ScheduledTaskOwnershipLongHub,
		TaskPresent:   true,
		TaskPathValid: true,
		MarkerValid:   true,
		ActionValid:   true,
	}}
	controller := &fakeGatewayController{observation: runningGatewayObservation()}
	manager := NewGatewayManagerWithOwnershipProbe(controller, probe)
	status := manager.Discover(context.Background())
	if status.State != GatewayRunningManaged || !status.Managed {
		t.Fatalf("verified LongHub task must classify as managed, got %+v", status)
	}
	if probe.calls != 1 {
		t.Fatalf("probe calls=%d, want one", probe.calls)
	}
	if len(probe.contexts) != 1 {
		t.Fatal("probe context missing")
	}
	if _, ok := probe.contexts[0].Deadline(); !ok {
		t.Fatal("probe must run under a bounded deadline")
	}
	// Probe-based ownership changes classification, not the confirmation gate.
	if _, err := manager.Stop(context.Background(), false); !errors.Is(err, ErrGatewayConfirmationRequired) {
		t.Fatalf("unconfirmed stop must still be gated, got %v", err)
	}
	if controller.stops != 0 {
		t.Fatal("stop command ran without confirmation")
	}
	if status, err := manager.Stop(context.Background(), true); err != nil || controller.stops != 1 {
		t.Fatalf("confirmed managed stop failed: status=%+v err=%v", status, err)
	}
}

func TestGatewayManagerKeepsExternalOnProbeFailureUnknownOrMismatch(t *testing.T) {
	for _, test := range []struct {
		name  string
		probe *fakeOwnershipProbe
	}{
		{name: "nil-probe", probe: nil},
		{name: "query-error", probe: &fakeOwnershipProbe{
			observation: ScheduledTaskObservation{Ownership: ScheduledTaskOwnershipUnknown},
			err:         ErrScheduledTaskInspectionFailed,
		}},
		{name: "identity-mismatch", probe: &fakeOwnershipProbe{
			observation: ScheduledTaskObservation{
				Ownership:   ScheduledTaskOwnershipUnknown,
				TaskPresent: true,
				MarkerValid: false,
			},
			err: ErrScheduledTaskIdentityMismatch,
		}},
		{name: "unsupported", probe: &fakeOwnershipProbe{
			observation: ScheduledTaskObservation{Ownership: ScheduledTaskOwnershipUnsupported},
			err:         ErrNativeProcessControlUnavailable,
		}},
		{name: "missing-task-external", probe: &fakeOwnershipProbe{
			observation: ScheduledTaskObservation{Ownership: ScheduledTaskOwnershipExternal},
		}},
		{name: "longhub-claim-without-proof", probe: &fakeOwnershipProbe{
			observation: ScheduledTaskObservation{Ownership: ScheduledTaskOwnershipLongHub},
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			controller := &fakeGatewayController{observation: runningGatewayObservation()}
			var probe ScheduledTaskOwnershipProbe
			if test.probe != nil {
				probe = test.probe
			}
			manager := NewGatewayManagerWithOwnershipProbe(controller, probe)
			status := manager.Discover(context.Background())
			if status.State != GatewayRunningExternal || status.Managed {
				t.Fatalf("probe result must fail closed to external, got %+v", status)
			}
			if _, err := manager.Stop(context.Background(), false); !errors.Is(err, ErrExternalGateway) {
				t.Fatalf("external gate lost: %v", err)
			}
			if controller.stops != 0 {
				t.Fatal("stop ran on an external Gateway without confirmation")
			}
		})
	}
}

func TestGatewayManagerSkipsProbeWhenNotRunningOrAlreadyManaged(t *testing.T) {
	probe := &fakeOwnershipProbe{observation: ScheduledTaskObservation{
		Ownership:     ScheduledTaskOwnershipLongHub,
		TaskPresent:   true,
		TaskPathValid: true,
		MarkerValid:   true,
		ActionValid:   true,
	}}
	controller := &fakeGatewayController{observation: GatewayObservation{
		Installed:    true,
		Running:      false,
		RunningKnown: true,
	}}
	manager := NewGatewayManagerWithOwnershipProbe(controller, probe)
	if status := manager.Discover(context.Background()); status.State != GatewayInstalledStopped {
		t.Fatalf("unexpected stopped status: %+v", status)
	}
	if probe.calls != 0 {
		t.Fatal("probe must not run for a stopped Gateway")
	}
	if _, err := manager.Start(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	probe.calls = 0
	if status := manager.Discover(context.Background()); status.State != GatewayRunningManaged {
		t.Fatalf("unexpected managed status: %+v", status)
	}
	if probe.calls != 0 {
		t.Fatal("probe must not run when process-local ownership is already known")
	}
}

func TestWindowsProcessControllerIsExplicitPlaceholder(t *testing.T) {
	controller := NewWindowsProcessController()
	if _, err := controller.Start(context.Background(), ProcessSpec{Command: "openclaw"}); !errors.Is(err, ErrWindowsTaskIntegrationPending) {
		t.Fatalf("expected Windows placeholder error, got %v", err)
	}
	if _, err := NewPlatformProcessController().IsRunning(context.Background(), ManagedProcess{}); err == nil {
		t.Fatal("platform process seam must not silently claim ownership")
	}
}
