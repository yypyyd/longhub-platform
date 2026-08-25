package runtime

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
	"unicode/utf16"
)

type scheduledTaskFakeRunner struct {
	xml      []byte
	err      error
	paths    []string
	contexts []context.Context
}

func (f *scheduledTaskFakeRunner) Query(ctx context.Context, taskPath string) ([]byte, error) {
	f.paths = append(f.paths, taskPath)
	f.contexts = append(f.contexts, ctx)
	if f.err != nil {
		return nil, f.err
	}
	return append([]byte(nil), f.xml...), nil
}

func validScheduledTaskXML(command, arguments, marker, uri string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>` + marker + `</Description>
    <URI>` + uri + `</URI>
  </RegistrationInfo>
  <Actions Context="Author">
    <Exec>
      <Command>` + command + `</Command>
      <Arguments>` + arguments + `</Arguments>
    </Exec>
  </Actions>
</Task>`)
}

func utf16XMLFixture(value []byte, littleEndian bool) []byte {
	decoded := string(value)
	units := utf16.Encode([]rune(decoded))
	result := make([]byte, 2+len(units)*2)
	if littleEndian {
		result[0], result[1] = 0xFF, 0xFE
	} else {
		result[0], result[1] = 0xFE, 0xFF
	}
	for index, unit := range units {
		if littleEndian {
			binary.LittleEndian.PutUint16(result[2+index*2:], unit)
		} else {
			binary.BigEndian.PutUint16(result[2+index*2:], unit)
		}
	}
	return result
}

func TestScheduledTaskIdentityContractIsFixed(t *testing.T) {
	identity := DefaultLongHubGatewayTaskIdentity()
	if identity.TaskPath != LongHubGatewayTaskPath || identity.OwnerMarker != LongHubGatewayTaskOwnerMarker {
		t.Fatalf("unexpected identity contract: %+v", identity)
	}
	if LongHubGatewayTaskPath != `\LongHub\OpenClaw Gateway` {
		t.Fatalf("task path must remain fixed, got %q", LongHubGatewayTaskPath)
	}
}

func TestParseScheduledTaskXMLAcceptsUTF8AndUTF16(t *testing.T) {
	fixture := validScheduledTaskXML(
		`C:\Users\demo\AppData\Local\LongHub Manager\LongHubManager.exe`,
		LongHubGatewayTaskArguments,
		LongHubGatewayTaskOwnerMarker,
		LongHubGatewayTaskPath,
	)
	for _, test := range []struct {
		name string
		data []byte
	}{
		{name: "utf8", data: fixture},
		{name: "utf16le", data: utf16XMLFixture(fixture, true)},
		{name: "utf16be", data: utf16XMLFixture(fixture, false)},
	} {
		t.Run(test.name, func(t *testing.T) {
			definition, err := ParseScheduledTaskXML(test.data)
			if err != nil {
				t.Fatalf("parse failed: %v", err)
			}
			if definition.TaskPath != LongHubGatewayTaskPath ||
				definition.OwnerMarker != LongHubGatewayTaskOwnerMarker ||
				definition.ActionArguments != LongHubGatewayTaskArguments {
				t.Fatalf("unexpected parsed definition: %+v", definition)
			}
			if !validLongHubGatewayTaskAction(definition.ActionCommand, definition.ActionArguments) {
				t.Fatal("expected trusted Manager launcher action to validate")
			}
		})
	}
}

func TestWindowsProcessControllerMissingTaskIsExternal(t *testing.T) {
	runner := &scheduledTaskFakeRunner{err: ErrScheduledTaskNotFound}
	controller := NewWindowsProcessControllerWithRunner(runner)
	observation, err := controller.InspectOwnership(context.Background())
	if err != nil {
		t.Fatalf("missing task should be a safe external result, got %v", err)
	}
	if observation.Ownership != ScheduledTaskOwnershipExternal || observation.TaskPresent || observation.ErrorCode != "SCHEDULED_TASK_NOT_FOUND" {
		t.Fatalf("unexpected missing-task observation: %+v", observation)
	}
	if len(runner.paths) != 1 || runner.paths[0] != LongHubGatewayTaskPath {
		t.Fatalf("controller queried a non-fixed task path: %v", runner.paths)
	}
}

func TestWindowsProcessControllerAcceptsOnlyVerifiedLongHubTask(t *testing.T) {
	runner := &scheduledTaskFakeRunner{xml: validScheduledTaskXML(
		`C:\Program Files\LongHub Manager\LongHubManager.exe`,
		LongHubGatewayTaskArguments,
		LongHubGatewayTaskOwnerMarker,
		LongHubGatewayTaskPath,
	)}
	observation, err := NewWindowsProcessControllerWithRunner(runner).InspectOwnership(context.Background())
	if err != nil || observation.Ownership != ScheduledTaskOwnershipLongHub || !observation.TaskPresent ||
		!observation.TaskPathValid || !observation.MarkerValid || !observation.ActionValid {
		t.Fatalf("valid task was not recognized: observation=%+v err=%v", observation, err)
	}
}

func TestWindowsProcessControllerRejectsMarkerAndActionDrift(t *testing.T) {
	cases := []struct {
		name    string
		command string
		args    string
		marker  string
		uri     string
	}{
		{name: "marker", command: `C:\Program Files\LongHub Manager\LongHubManager.exe`, args: LongHubGatewayTaskArguments, marker: "other-owner/v1", uri: LongHubGatewayTaskPath},
		{name: "relative command", command: "LongHubManager.exe", args: LongHubGatewayTaskArguments, marker: LongHubGatewayTaskOwnerMarker, uri: LongHubGatewayTaskPath},
		{name: "wrapper command", command: `C:\LongHub\gateway-wrapper.exe`, args: LongHubGatewayTaskArguments, marker: LongHubGatewayTaskOwnerMarker, uri: LongHubGatewayTaskPath},
		{name: "extra arguments", command: `C:\Program Files\LongHub Manager\LongHubManager.exe`, args: "--autostart-gateway --port 18789", marker: LongHubGatewayTaskOwnerMarker, uri: LongHubGatewayTaskPath},
		{name: "wrong task path", command: `C:\Program Files\LongHub Manager\LongHubManager.exe`, args: LongHubGatewayTaskArguments, marker: LongHubGatewayTaskOwnerMarker, uri: `\OpenClaw Gateway`},
		{name: "marker whitespace", command: `C:\Program Files\LongHub Manager\LongHubManager.exe`, args: LongHubGatewayTaskArguments, marker: " " + LongHubGatewayTaskOwnerMarker, uri: LongHubGatewayTaskPath},
		{name: "argument whitespace", command: `C:\Program Files\LongHub Manager\LongHubManager.exe`, args: " " + LongHubGatewayTaskArguments, marker: LongHubGatewayTaskOwnerMarker, uri: LongHubGatewayTaskPath},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			runner := &scheduledTaskFakeRunner{xml: validScheduledTaskXML(test.command, test.args, test.marker, test.uri)}
			observation, err := NewWindowsProcessControllerWithRunner(runner).InspectOwnership(context.Background())
			if !errors.Is(err, ErrScheduledTaskIdentityMismatch) || observation.Ownership != ScheduledTaskOwnershipUnknown || !observation.TaskPresent {
				t.Fatalf("drift must fail closed: observation=%+v err=%v", observation, err)
			}
			if observation.Ownership == ScheduledTaskOwnershipLongHub {
				t.Fatal("drift must never be reported as LongHub-owned")
			}
		})
	}
}

func TestWindowsProcessControllerFailsClosedOnMalformedOrOversizedXML(t *testing.T) {
	for _, test := range []struct {
		name string
		xml  []byte
	}{
		{name: "malformed", xml: []byte("<Task><Actions>")},
		{name: "empty", xml: nil},
		{name: "oversized", xml: bytes.Repeat([]byte("x"), maxScheduledTaskXMLBytes+1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			observation, err := NewWindowsProcessControllerWithRunner(&scheduledTaskFakeRunner{xml: test.xml}).InspectOwnership(context.Background())
			if !errors.Is(err, ErrScheduledTaskInspectionFailed) || observation.Ownership != ScheduledTaskOwnershipUnknown {
				t.Fatalf("expected bounded fail-closed result: observation=%+v err=%v", observation, err)
			}
		})
	}
}

func TestWindowsProcessControllerDoesNotExposeRunnerError(t *testing.T) {
	runner := &scheduledTaskFakeRunner{err: errors.New("access denied: secret=C:\\private\\token")}
	observation, err := NewWindowsProcessControllerWithRunner(runner).InspectOwnership(context.Background())
	if !errors.Is(err, ErrScheduledTaskInspectionFailed) || observation.Ownership != ScheduledTaskOwnershipUnknown {
		t.Fatalf("expected stable inspection failure: observation=%+v err=%v", observation, err)
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "token") {
		t.Fatalf("runner details leaked through error: %v", err)
	}
}

func TestUnsupportedProcessControllerOwnershipIsFailClosed(t *testing.T) {
	controller := UnsupportedProcessController{Platform: "linux"}
	observation, err := controller.InspectOwnership(context.Background())
	if !errors.Is(err, ErrNativeProcessControlUnavailable) || observation.Ownership != ScheduledTaskOwnershipUnsupported {
		t.Fatalf("expected unsupported ownership result: observation=%+v err=%v", observation, err)
	}
}
