package managerupdate

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const pendingSchema = "longhub/manager-update-pending/v1"

type PendingUpdate struct {
	SchemaVersion     string   `json:"schema_version"`
	PreviousVersion   string   `json:"previous_version"`
	TargetVersion     string   `json:"target_version"`
	TargetSequence    int64    `json:"target_sequence"`
	TargetInstaller   string   `json:"target_installer"`
	RollbackInstaller string   `json:"rollback_installer"`
	TargetMetadata    Envelope `json:"target_metadata"`
	RollbackMetadata  Envelope `json:"rollback_metadata"`
	Attempts          int      `json:"attempts"`
	Phase             string   `json:"phase"`
	Reason            string   `json:"reason,omitempty"`
	CreatedAt         string   `json:"created_at"`
}

type RecoveryStore struct {
	root        string
	pendingPath string
	trustedKeys map[string]ed25519.PublicKey
}

func NewRecoveryStore(root string, trustedKeys map[string]ed25519.PublicKey) (*RecoveryStore, error) {
	prepared, err := preparePrivateRoot(root)
	if err != nil {
		return nil, err
	}
	if len(trustedKeys) == 0 {
		return nil, ErrUpdateUnavailable
	}
	keys := make(map[string]ed25519.PublicKey, len(trustedKeys))
	for keyID, key := range trustedKeys {
		if !keyIDPattern.MatchString(keyID) || len(key) != ed25519.PublicKeySize {
			return nil, ErrUpdateUnavailable
		}
		keys[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	return &RecoveryStore{
		root: prepared, pendingPath: filepath.Join(prepared, "pending-update.json"), trustedKeys: keys,
	}, nil
}

func (store *RecoveryStore) Prepare(
	previousVersion string,
	target Envelope,
	targetInstaller string,
	rollback Envelope,
	rollbackInstaller string,
) (PendingUpdate, error) {
	if store == nil || target.Manifest.Version == previousVersion ||
		rollback.Manifest.Version != previousVersion || target.Manifest.Channel != rollback.Manifest.Channel {
		return PendingUpdate{}, ErrMetadataInvalid
	}
	if err := store.verifyEnvelope(target); err != nil {
		return PendingUpdate{}, err
	}
	if err := store.verifyEnvelope(rollback); err != nil {
		return PendingUpdate{}, err
	}
	if comparison, err := CompareVersions(target.Manifest.Version, previousVersion); err != nil || comparison <= 0 {
		return PendingUpdate{}, ErrMetadataInvalid
	}
	if err := VerifyInstaller(targetInstaller, target.Manifest); err != nil {
		return PendingUpdate{}, err
	}
	if err := VerifyInstaller(rollbackInstaller, rollback.Manifest); err != nil {
		return PendingUpdate{}, err
	}
	if !pathWithin(store.root, targetInstaller) {
		return PendingUpdate{}, ErrUnsafeUpdatePath
	}
	if _, err := store.Read(); err == nil {
		return PendingUpdate{}, errors.New("manager update is already pending")
	} else if !errors.Is(err, os.ErrNotExist) {
		return PendingUpdate{}, err
	}
	pending := PendingUpdate{
		SchemaVersion: pendingSchema, PreviousVersion: previousVersion,
		TargetVersion: target.Manifest.Version, TargetSequence: target.Manifest.Sequence,
		TargetInstaller: filepath.Clean(targetInstaller), RollbackInstaller: filepath.Clean(rollbackInstaller),
		TargetMetadata: target, RollbackMetadata: rollback, Phase: "installing",
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := store.write(pending); err != nil {
		return PendingUpdate{}, err
	}
	return pending, nil
}

func (store *RecoveryStore) Read() (PendingUpdate, error) {
	if store == nil {
		return PendingUpdate{}, ErrUnsafeUpdatePath
	}
	data, err := os.ReadFile(store.pendingPath)
	if err != nil {
		return PendingUpdate{}, err
	}
	if len(data) == 0 || len(data) > 512*1024 {
		return PendingUpdate{}, ErrMetadataInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var pending PendingUpdate
	if err := decoder.Decode(&pending); err != nil || pending.SchemaVersion != pendingSchema ||
		!versionPattern.MatchString(pending.PreviousVersion) || !versionPattern.MatchString(pending.TargetVersion) ||
		pending.TargetSequence <= 0 || pending.Attempts < 0 || pending.Attempts > 3 ||
		(pending.Phase != "installing" && pending.Phase != "rollback") {
		return PendingUpdate{}, ErrMetadataInvalid
	}
	if err := ValidateManifest(pending.TargetMetadata.Manifest); err != nil {
		return PendingUpdate{}, err
	}
	if err := ValidateManifest(pending.RollbackMetadata.Manifest); err != nil {
		return PendingUpdate{}, err
	}
	if err := store.verifyEnvelope(pending.TargetMetadata); err != nil {
		return PendingUpdate{}, err
	}
	if err := store.verifyEnvelope(pending.RollbackMetadata); err != nil {
		return PendingUpdate{}, err
	}
	if pending.TargetMetadata.Manifest.Version != pending.TargetVersion ||
		pending.RollbackMetadata.Manifest.Version != pending.PreviousVersion ||
		pending.TargetMetadata.Manifest.Sequence != pending.TargetSequence ||
		!pathWithin(store.root, pending.TargetInstaller) {
		return PendingUpdate{}, ErrMetadataInvalid
	}
	return pending, nil
}

func (store *RecoveryStore) verifyEnvelope(envelope Envelope) error {
	data, err := json.Marshal(envelope)
	if err != nil {
		return ErrMetadataInvalid
	}
	_, err = ParseAndVerify(data, store.trustedKeys)
	return err
}

func (store *RecoveryStore) RecordTargetStartup(currentVersion string) (PendingUpdate, bool, error) {
	pending, err := store.Read()
	if errors.Is(err, os.ErrNotExist) {
		return PendingUpdate{}, false, nil
	}
	if err != nil {
		return PendingUpdate{}, false, err
	}
	if pending.Phase == "rollback" && currentVersion == pending.PreviousVersion {
		if err := os.Remove(store.pendingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return PendingUpdate{}, false, ErrUnsafeUpdatePath
		}
		return pending, false, nil
	}
	if pending.Phase != "installing" || currentVersion != pending.TargetVersion {
		return PendingUpdate{}, false, ErrMetadataInvalid
	}
	pending.Attempts++
	if err := store.write(pending); err != nil {
		return PendingUpdate{}, false, err
	}
	return pending, pending.Attempts >= 3, nil
}

func (store *RecoveryStore) BeginRollback(reason string) (PendingUpdate, error) {
	pending, err := store.Read()
	if err != nil {
		return PendingUpdate{}, err
	}
	pending.Phase = "rollback"
	pending.Reason = reason
	if err := store.write(pending); err != nil {
		return PendingUpdate{}, err
	}
	return pending, nil
}

func (store *RecoveryStore) MarkHealthy(currentVersion string) error {
	pending, err := store.Read()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if pending.Phase != "installing" || pending.TargetVersion != currentVersion {
		return ErrMetadataInvalid
	}
	if err := os.Remove(store.pendingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrUnsafeUpdatePath
	}
	return nil
}

func (store *RecoveryStore) write(pending PendingUpdate) error {
	data, err := json.MarshalIndent(pending, "", "  ")
	if err != nil {
		return ErrMetadataInvalid
	}
	temporary, err := os.CreateTemp(store.root, ".pending-update-*.tmp")
	if err != nil {
		return ErrUnsafeUpdatePath
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return ErrUnsafeUpdatePath
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		_ = temporary.Close()
		return ErrUnsafeUpdatePath
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return ErrUnsafeUpdatePath
	}
	if err := temporary.Close(); err != nil {
		return ErrUnsafeUpdatePath
	}
	if err := os.Rename(temporaryPath, store.pendingPath); err != nil {
		return ErrUnsafeUpdatePath
	}
	return nil
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && relative != "." && relative != "" && !filepath.IsAbs(relative) &&
		relative != ".." && !stringsHasDotDotPrefix(relative)
}

func stringsHasDotDotPrefix(value string) bool {
	return len(value) >= 3 && value[:2] == ".." && os.IsPathSeparator(value[2])
}
