//go:build !windows

package main

import "os/exec"

func configureGatewayCommand(*exec.Cmd) {}
