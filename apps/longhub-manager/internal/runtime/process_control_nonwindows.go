//go:build !windows

package runtime

import "context"

// nonWindowsScheduledTaskQueryRunner is deliberately unavailable.  It is not
// an in-memory or shell fallback: a future platform must provide its own
// audited supervisor adapter before it can claim ownership.
type nonWindowsScheduledTaskQueryRunner struct{}

func newNativeScheduledTaskQueryRunner() ScheduledTaskQueryRunner {
	return nonWindowsScheduledTaskQueryRunner{}
}

func (nonWindowsScheduledTaskQueryRunner) Query(context.Context, string) ([]byte, error) {
	return nil, ErrNativeProcessControlUnavailable
}

func (nonWindowsScheduledTaskQueryRunner) Register(context.Context, string, []byte) error {
	return ErrNativeProcessControlUnavailable
}

func (nonWindowsScheduledTaskQueryRunner) Delete(context.Context, string) error {
	return ErrNativeProcessControlUnavailable
}
