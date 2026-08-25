//go:build windows

package managerupdate

import (
	"os/exec"
	"syscall"
)

func LaunchInstaller(path, mode string) error {
	argument := "/UPDATE=1"
	if mode == "rollback" {
		argument = "/ROLLBACK=1"
	} else if mode != "update" {
		return ErrUpdateUnavailable
	}
	command := exec.Command(path, "/S", argument)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Start(); err != nil {
		return ErrUpdateUnavailable
	}
	return nil
}
