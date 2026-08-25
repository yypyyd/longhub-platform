//go:build !windows

package main

import "context"

func startPlatformTray(context.Context, context.CancelFunc, string, bool) error { return nil }
