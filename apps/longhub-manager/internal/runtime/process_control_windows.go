//go:build windows

package runtime

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const (
	scheduledTaskQueryTimeout     = 5 * time.Second
	scheduledTaskLifecycleTimeout = 10 * time.Second
)

// nativeWindowsScheduledTaskQueryRunner talks to Task Scheduler through a
// fixed, encoded PowerShell COM probe.  The script contains only compile-time
// task identity values; no request, environment variable, PID or port is
// interpolated into a shell command.
type nativeWindowsScheduledTaskQueryRunner struct{}

func newNativeScheduledTaskQueryRunner() ScheduledTaskQueryRunner {
	return nativeWindowsScheduledTaskQueryRunner{}
}

func (nativeWindowsScheduledTaskQueryRunner) Query(parent context.Context, taskPath string) ([]byte, error) {
	if taskPath != LongHubGatewayTaskPath {
		return nil, ErrScheduledTaskIdentityMismatch
	}
	powershellPath, err := windowsPowerShellPath()
	if err != nil {
		return nil, ErrScheduledTaskInspectionFailed
	}
	queryCtx, cancel := context.WithTimeout(parent, scheduledTaskQueryTimeout)
	defer cancel()
	command := exec.CommandContext(
		queryCtx,
		powershellPath,
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		encodePowerShell(taskSchedulerXMLProbeScript),
	)
	var stdout, stderr boundedTaskOutput
	command.Stdout = &stdout
	command.Stderr = &stderr
	runErr := command.Run()
	if runErr != nil {
		if queryCtx.Err() != nil {
			return nil, queryCtx.Err()
		}
		// The script uses exit code 3 only for ERROR_FILE_NOT_FOUND or
		// ERROR_PATH_NOT_FOUND, which means the fixed task/folder is absent.
		if exitCode(runErr) == 3 {
			return nil, ErrScheduledTaskNotFound
		}
		return nil, ErrScheduledTaskInspectionFailed
	}
	if stdout.exceeded || stderr.exceeded || len(stdout.data) > maxScheduledTaskXMLBytes {
		return nil, ErrScheduledTaskInspectionFailed
	}
	if len(stdout.data) == 0 {
		return nil, ErrScheduledTaskInspectionFailed
	}
	return append([]byte(nil), stdout.data...), nil
}

// Register writes the fixed task XML to a Manager-private temporary file and
// asks schtasks.exe to create exactly the compile-time task path. The /F
// (force/overwrite) flag is deliberately absent: a same-name task makes the
// system reject the creation, which is a second line of defense behind the
// controller's foreign-owner probe.
func (nativeWindowsScheduledTaskQueryRunner) Register(parent context.Context, taskPath string, taskXML []byte) error {
	if taskPath != LongHubGatewayTaskPath {
		return ErrScheduledTaskIdentityMismatch
	}
	if len(taskXML) == 0 || len(taskXML) > maxScheduledTaskXMLBytes {
		return ErrScheduledTaskOperationFailed
	}
	schtasksPath, err := windowsSchtasksPath()
	if err != nil {
		return ErrScheduledTaskOperationFailed
	}
	xmlFile, err := os.CreateTemp("", "longhub-gateway-task-*.xml")
	if err != nil {
		return ErrScheduledTaskOperationFailed
	}
	xmlPath := xmlFile.Name()
	defer os.Remove(xmlPath)
	_, writeErr := xmlFile.Write(taskXML)
	closeErr := xmlFile.Close()
	if writeErr != nil || closeErr != nil {
		return ErrScheduledTaskOperationFailed
	}
	return runScheduledTaskLifecycleCommand(parent, schtasksPath,
		"/Create", "/TN", LongHubGatewayTaskPath, "/XML", xmlPath)
}

// Delete removes exactly the compile-time task path. Callers must already hold
// a fresh, complete ownership proof; the runner never re-checks identity by
// itself and therefore refuses any other path outright.
func (nativeWindowsScheduledTaskQueryRunner) Delete(parent context.Context, taskPath string) error {
	if taskPath != LongHubGatewayTaskPath {
		return ErrScheduledTaskIdentityMismatch
	}
	schtasksPath, err := windowsSchtasksPath()
	if err != nil {
		return ErrScheduledTaskOperationFailed
	}
	return runScheduledTaskLifecycleCommand(parent, schtasksPath,
		"/Delete", "/TN", LongHubGatewayTaskPath, "/F")
}

func runScheduledTaskLifecycleCommand(parent context.Context, executable string, args ...string) error {
	ctx, cancel := context.WithTimeout(parent, scheduledTaskLifecycleTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	// Output is discarded but bounded so a hostile localized schtasks build
	// cannot balloon memory; no raw text is surfaced to callers either way.
	var stdout, stderr boundedTaskOutput
	command.Stdout = &stdout
	command.Stderr = &stderr
	if runErr := command.Run(); runErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrScheduledTaskOperationFailed
	}
	return nil
}

func windowsSchtasksPath() (string, error) {
	systemDirectory, err := windowsSystemDirectory()
	if err != nil {
		return "", err
	}
	path := filepath.Join(systemDirectory, "schtasks.exe")
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", errors.New("schtasks.exe is unavailable")
	}
	return path, nil
}

const taskSchedulerXMLProbeScript = `$ErrorActionPreference='Stop'
try {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\LongHub')
  $task = $folder.GetTask('OpenClaw Gateway')
  [Console]::Out.Write($task.Xml)
  exit 0
} catch {
  $hresult = $_.Exception.HResult
  if ($hresult -eq -2147024894 -or $hresult -eq -2147024893) { exit 3 }
  exit 4
}`

func encodePowerShell(script string) string {
	units := utf16.Encode([]rune(script))
	data := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(data[index*2:], unit)
	}
	return base64.StdEncoding.EncodeToString(data)
}

func exitCode(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

type boundedTaskOutput struct {
	data     []byte
	exceeded bool
}

func (b *boundedTaskOutput) Write(data []byte) (int, error) {
	if len(b.data)+len(data) > maxScheduledTaskXMLBytes {
		b.exceeded = true
		return 0, errors.New("scheduled task output exceeds limit")
	}
	b.data = append(b.data, data...)
	return len(data), nil
}

var (
	kernel32GetSystemDirectory = syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemDirectoryW")
)

func windowsSystemDirectory() (string, error) {
	buffer := make([]uint16, 260)
	for {
		length, _, callErr := kernel32GetSystemDirectory.Call(
			uintptr(unsafe.Pointer(&buffer[0])),
			uintptr(len(buffer)),
		)
		if length == 0 {
			if callErr != nil {
				return "", callErr
			}
			return "", errors.New("GetSystemDirectoryW failed")
		}
		if length < uintptr(len(buffer)) {
			return syscall.UTF16ToString(buffer[:length]), nil
		}
		buffer = make([]uint16, int(length)+1)
	}
}

func windowsPowerShellPath() (string, error) {
	systemDirectory, err := windowsSystemDirectory()
	if err != nil {
		return "", err
	}
	path := filepath.Join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return "", errors.New("Windows PowerShell is unavailable")
	}
	return path, nil
}
