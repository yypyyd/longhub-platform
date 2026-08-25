package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"

	managerRuntime "github.com/longhub/longhub-manager/internal/runtime"
)

type managerStartupMode uint8

const (
	managerStartupInteractive managerStartupMode = iota
	managerStartupGateway
	managerStartupRemoveAutostart
)

func parseManagerStartupMode(arguments []string) (managerStartupMode, error) {
	if len(arguments) == 0 {
		return managerStartupInteractive, nil
	}
	if len(arguments) != 1 {
		return managerStartupInteractive, errors.New("Manager 启动参数无效")
	}
	switch arguments[0] {
	case managerRuntime.LongHubGatewayTaskArguments:
		return managerStartupGateway, nil
	case "--remove-autostart":
		return managerStartupRemoveAutostart, nil
	default:
		return managerStartupInteractive, errors.New("Manager 启动参数无效")
	}
}

func removeManagerAutostart(ctx context.Context) error {
	return managerRuntime.NewWindowsProcessController().RemoveScheduledTask(ctx)
}

// superviseAutostartGateway keeps the task action process alive and restarts a
// failed foreground Gateway at most three times. Task Scheduler provides the
// outer process restart; this inner bound handles a transient OpenClaw crash
// without creating an unbounded local loop.
func superviseAutostartGateway(
	ctx context.Context,
	adapter *managerRuntime.NativeAdapter,
) error {
	if adapter == nil {
		return errors.New("Gateway 自动启动不可用")
	}
	statusCtx, cancelStatus := context.WithTimeout(ctx, 15*time.Second)
	status := adapter.GatewayStatus(statusCtx)
	cancelStatus()
	if status.Running {
		return nil
	}
	runner := managerRuntime.OSCommandRunner{}
	command, err := managerRuntime.ResolveOpenClaw(ctx, runner)
	if err != nil {
		return errors.New("未发现原生 OpenClaw")
	}
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		runErr := runAutostartGateway(ctx, command)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if runErr == nil {
			return nil
		}
		delay := time.Duration(attempt+1) * 5 * time.Second
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
	return errors.New("Gateway 自动启动连续失败")
}

func runAutostartGateway(
	ctx context.Context,
	command string,
) error {
	process := exec.CommandContext(ctx, command, "gateway", "run")
	process.Stdin = nil
	process.Stdout = io.Discard
	process.Stderr = io.Discard
	configureGatewayCommand(process)
	if err := process.Run(); err != nil {
		return errors.New("Gateway 进程退出")
	}
	return nil
}
func managerPageURL(listenerAddress, token string) string {
	return fmt.Sprintf("http://%s/#token=%s", listenerAddress, token)
}
