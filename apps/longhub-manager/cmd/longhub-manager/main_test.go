package main

import (
	"testing"

	managerRuntime "github.com/longhub/longhub-manager/internal/runtime"
)

func TestParseManagerStartupModeIsFixed(t *testing.T) {
	tests := []struct {
		args  []string
		want  managerStartupMode
		valid bool
	}{
		{valid: true, want: managerStartupInteractive},
		{args: []string{managerRuntime.LongHubGatewayTaskArguments}, valid: true, want: managerStartupGateway},
		{args: []string{"--remove-autostart"}, valid: true, want: managerStartupRemoveAutostart},
		{args: []string{"--port", "1234"}},
	}
	for _, test := range tests {
		got, err := parseManagerStartupMode(test.args)
		if (err == nil) != test.valid || (test.valid && got != test.want) {
			t.Fatalf("args=%v got=%v err=%v", test.args, got, err)
		}
	}
}
