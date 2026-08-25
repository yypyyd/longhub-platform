package managerupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type PublicStatus struct {
	State          string `json:"state"`
	CurrentVersion string `json:"current_version"`
	TargetVersion  string `json:"target_version,omitempty"`
	Available      bool   `json:"available"`
	Eligible       bool   `json:"eligible"`
	Downloaded     bool   `json:"downloaded"`
	ErrorCode      string `json:"error_code,omitempty"`
}

type CoordinatorOptions struct {
	Client            *Client
	RecoveryStore     *RecoveryStore
	CurrentVersion    string
	Channel           string
	Identity          string
	UpdateRoot        string
	RecoveryInstaller string
	Launch            func(path, mode string) error
	Stop              context.CancelFunc
	HealthDelay       time.Duration
}

type Coordinator struct {
	client            *Client
	recoveryStore     *RecoveryStore
	currentVersion    string
	channel           string
	identity          string
	updateRoot        string
	recoveryInstaller string
	launch            func(path, mode string) error
	stop              context.CancelFunc
	healthDelay       time.Duration

	mu             sync.Mutex
	candidate      Candidate
	downloadedPath string
	state          string
	errorCode      string
}

func NewCoordinator(options CoordinatorOptions) (*Coordinator, error) {
	if options.Client == nil || options.RecoveryStore == nil ||
		!versionPattern.MatchString(options.CurrentVersion) ||
		(options.Channel != "stable" && options.Channel != "beta") ||
		!identityPattern.MatchString(options.Identity) || !filepath.IsAbs(options.UpdateRoot) ||
		!filepath.IsAbs(options.RecoveryInstaller) {
		return nil, ErrUpdateUnavailable
	}
	if options.Launch == nil {
		options.Launch = LaunchInstaller
	}
	if options.HealthDelay <= 0 {
		options.HealthDelay = 30 * time.Second
	}
	return &Coordinator{
		client: options.Client, recoveryStore: options.RecoveryStore,
		currentVersion: options.CurrentVersion, channel: options.Channel, identity: options.Identity,
		updateRoot: filepath.Clean(options.UpdateRoot), recoveryInstaller: filepath.Clean(options.RecoveryInstaller),
		launch: options.Launch, healthDelay: options.HealthDelay, state: "current",
		stop: options.Stop,
	}, nil
}

func (coordinator *Coordinator) Status() PublicStatus {
	if coordinator == nil {
		return PublicStatus{State: "unavailable", ErrorCode: "MANAGER_UPDATE_NOT_CONFIGURED"}
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	return coordinator.statusLocked()
}

func (coordinator *Coordinator) Refresh(ctx context.Context) (PublicStatus, error) {
	if coordinator == nil {
		return PublicStatus{State: "unavailable", ErrorCode: "MANAGER_UPDATE_NOT_CONFIGURED"}, ErrUpdateUnavailable
	}
	candidate, err := coordinator.client.Check(ctx, coordinator.currentVersion, coordinator.channel, coordinator.identity)
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if err != nil {
		coordinator.state = "unavailable"
		coordinator.errorCode = "MANAGER_UPDATE_CHECK_FAILED"
		return coordinator.statusLocked(), err
	}
	coordinator.candidate = candidate
	coordinator.downloadedPath = ""
	coordinator.errorCode = ""
	switch {
	case !candidate.Available:
		coordinator.state = "current"
	case !candidate.Eligible:
		coordinator.state = "rollout_pending"
	default:
		coordinator.state = "available"
	}
	return coordinator.statusLocked(), nil
}

func (coordinator *Coordinator) Download(ctx context.Context, confirm bool) (PublicStatus, error) {
	if coordinator == nil || !confirm {
		return coordinatorStatusOrUnavailable(coordinator), ErrUpdateUnavailable
	}
	coordinator.mu.Lock()
	candidate := coordinator.candidate
	coordinator.mu.Unlock()
	if !candidate.Available || !candidate.Eligible {
		return coordinator.Status(), ErrUpdateUnavailable
	}
	path, err := coordinator.client.Download(ctx, candidate, coordinator.updateRoot)
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if err != nil {
		coordinator.state = "unavailable"
		coordinator.errorCode = "MANAGER_UPDATE_DOWNLOAD_FAILED"
		return coordinator.statusLocked(), err
	}
	coordinator.downloadedPath = path
	coordinator.state = "ready"
	coordinator.errorCode = ""
	return coordinator.statusLocked(), nil
}

func (coordinator *Coordinator) Apply(ctx context.Context, confirm bool) (PublicStatus, error) {
	if coordinator == nil || !confirm {
		return coordinatorStatusOrUnavailable(coordinator), ErrUpdateUnavailable
	}
	coordinator.mu.Lock()
	candidate := coordinator.candidate
	targetPath := coordinator.downloadedPath
	coordinator.mu.Unlock()
	if targetPath == "" || !candidate.Available || !candidate.Eligible {
		return coordinator.Status(), ErrUpdateUnavailable
	}
	rollback, err := coordinator.client.Exact(ctx, coordinator.currentVersion, coordinator.channel)
	if err != nil {
		return coordinator.fail("MANAGER_UPDATE_ROLLBACK_UNAVAILABLE", err)
	}
	if err := VerifyInstaller(coordinator.recoveryInstaller, rollback.Manifest); err != nil {
		return coordinator.fail("MANAGER_UPDATE_ROLLBACK_UNAVAILABLE", err)
	}
	if _, err := coordinator.recoveryStore.Prepare(
		coordinator.currentVersion,
		candidate.Envelope,
		targetPath,
		rollback,
		coordinator.recoveryInstaller,
	); err != nil {
		return coordinator.fail("MANAGER_UPDATE_PREPARE_FAILED", err)
	}
	if err := coordinator.launch(targetPath, "update"); err != nil {
		return coordinator.fail("MANAGER_UPDATE_LAUNCH_FAILED", err)
	}
	coordinator.mu.Lock()
	coordinator.state = "applying"
	coordinator.errorCode = ""
	status := coordinator.statusLocked()
	coordinator.mu.Unlock()
	if coordinator.stop != nil {
		time.AfterFunc(750*time.Millisecond, coordinator.stop)
	}
	return status, nil
}

// RecoverOnStartup increments the target's bounded health attempt before the
// service is exposed. A third unhealthy start launches the already verified
// previous installer. A live target clears pending state only after remaining
// up for the configured health window.
func (coordinator *Coordinator) RecoverOnStartup(ctx context.Context, stop context.CancelFunc) error {
	if coordinator == nil {
		return nil
	}
	pending, rollbackRequired, err := coordinator.recoveryStore.RecordTargetStartup(coordinator.currentVersion)
	if err != nil {
		return err
	}
	if pending.SchemaVersion == "" {
		return nil
	}
	if rollbackRequired {
		if err := VerifyInstaller(pending.RollbackInstaller, pending.RollbackMetadata.Manifest); err != nil {
			return err
		}
		if _, err := coordinator.recoveryStore.BeginRollback("startup_health_timeout"); err != nil {
			return err
		}
		if err := coordinator.launch(pending.RollbackInstaller, "rollback"); err != nil {
			return err
		}
		if stop != nil {
			stop()
		}
		return nil
	}
	if pending.TargetVersion != coordinator.currentVersion {
		return nil
	}
	go func() {
		timer := time.NewTimer(coordinator.healthDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			_ = coordinator.recoveryStore.MarkHealthy(coordinator.currentVersion)
		}
	}()
	return nil
}

func (coordinator *Coordinator) fail(code string, err error) (PublicStatus, error) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	coordinator.state = "unavailable"
	coordinator.errorCode = code
	return coordinator.statusLocked(), err
}

func (coordinator *Coordinator) statusLocked() PublicStatus {
	status := PublicStatus{
		State: coordinator.state, CurrentVersion: coordinator.currentVersion,
		Available: coordinator.candidate.Available, Eligible: coordinator.candidate.Eligible,
		Downloaded: coordinator.downloadedPath != "", ErrorCode: coordinator.errorCode,
	}
	if coordinator.candidate.Envelope.Manifest.Version != "" {
		status.TargetVersion = coordinator.candidate.Envelope.Manifest.Version
	}
	return status
}

func coordinatorStatusOrUnavailable(coordinator *Coordinator) PublicStatus {
	if coordinator == nil {
		return PublicStatus{State: "unavailable", ErrorCode: "MANAGER_UPDATE_NOT_CONFIGURED"}
	}
	return coordinator.Status()
}

func IsConfirmationError(err error) bool {
	return errors.Is(err, ErrUpdateUnavailable)
}

func RecoveryInstallerPath(executablePath, version string) (string, error) {
	if !filepath.IsAbs(executablePath) || !versionPattern.MatchString(version) {
		return "", ErrUnsafeUpdatePath
	}
	return filepath.Join(filepath.Dir(executablePath), "recovery", "LongHub-Manager-Setup-"+version+".exe"), nil
}

func UpdateRoot(configDir string) (string, error) {
	if !filepath.IsAbs(configDir) {
		return "", ErrUnsafeUpdatePath
	}
	return filepath.Join(configDir, "LongHub", "updates"), nil
}

func EnsureStableIdentity(path string, randomBytes []byte) (string, error) {
	if !filepath.IsAbs(path) || len(randomBytes) < 32 {
		return "", ErrUnsafeUpdatePath
	}
	if data, err := os.ReadFile(path); err == nil {
		identity := string(data)
		if identityPattern.MatchString(identity) {
			return identity, nil
		}
		return "", ErrMetadataInvalid
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", ErrUnsafeUpdatePath
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", ErrUnsafeUpdatePath
	}
	identity := "manager-" + DigestBytes(randomBytes)[:40]
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", ErrUnsafeUpdatePath
	}
	if _, err := file.WriteString(identity); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", ErrUnsafeUpdatePath
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", ErrUnsafeUpdatePath
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", ErrUnsafeUpdatePath
	}
	return identity, nil
}
