// Package configbackup provides an atomic, metadata-only backup/restore
// boundary for the user's native OpenClaw configuration.  It deliberately
// treats the file as opaque JSON5: OpenClaw remains the source of truth for
// parsing and validation.  The Manager never copies the runtime or workspace.
package configbackup

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	SchemaVersion         = "longhub/native-config-backup/v1"
	DefaultMaxBytes int64 = 4 * 1024 * 1024
	maxIDLength           = 96
)

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Snapshot is safe to return to a UI.  It contains no config bytes and no
// absolute paths, which prevents accidental disclosure of local user data.
type Snapshot struct {
	SchemaVersion string `json:"schema_version"`
	ID            string `json:"backup_id"`
	Digest        string `json:"sha256"`
	Bytes         int64  `json:"bytes"`
	CreatedAt     string `json:"created_at"`
}

type metadata struct {
	SchemaVersion string `json:"schema_version"`
	ID            string `json:"backup_id"`
	Digest        string `json:"sha256"`
	Bytes         int64  `json:"bytes"`
	CreatedAt     string `json:"created_at"`
}

// RestoreResult identifies the restored snapshot and the automatic safety
// snapshot made immediately before replacing the active config.
type RestoreResult struct {
	Restored     Snapshot  `json:"restored"`
	SafetyBackup *Snapshot `json:"safety_backup,omitempty"`
}

// Validator is called with a temporary file containing the candidate config.
// The callback should invoke the native OpenClaw validator with its config
// path overridden to candidatePath.  A nil validator is rejected by Restore:
// restoring an unvalidated JSON5 document would make the Gateway unsafe.
type Validator func(candidatePath string) error

type Manager struct {
	configPath string
	backupDir  string
	maxBytes   int64
	now        func() time.Time
}

// New validates and canonicalizes paths.  Both paths must be absolute and the
// active config itself must not be a symlink; this avoids following a link
// supplied by an untrusted process during a write.
func New(configPath, backupDir string) (*Manager, error) {
	if configPath == "" || backupDir == "" {
		return nil, errors.New("config path and backup directory are required")
	}
	configPath, err := filepath.Abs(configPath)
	if err != nil {
		return nil, fmt.Errorf("resolve config path: %w", err)
	}
	backupDir, err = filepath.Abs(backupDir)
	if err != nil {
		return nil, fmt.Errorf("resolve backup directory: %w", err)
	}
	configPath = filepath.Clean(configPath)
	backupDir = filepath.Clean(backupDir)
	if configPath == backupDir || isWithin(configPath, backupDir) || isWithin(backupDir, configPath) {
		return nil, errors.New("config path and backup directory must be separate")
	}
	return &Manager{
		configPath: configPath,
		backupDir:  backupDir,
		maxBytes:   DefaultMaxBytes,
		now:        time.Now,
	}, nil
}

// WithMaxBytes changes the bounded read limit used for native config files.
func (m *Manager) WithMaxBytes(maxBytes int64) *Manager {
	if maxBytes > 0 {
		m.maxBytes = maxBytes
	}
	return m
}

// Backup copies the active config into a private, 0600 metadata+content pair.
// The operation is atomic and the returned value contains only safe metadata.
func (m *Manager) Backup() (Snapshot, error) {
	data, err := m.readActive()
	if err != nil {
		return Snapshot{}, err
	}
	return m.writeBackup(data)
}

// Restore validates a backup candidate before atomically replacing the active
// native config.  A safety backup is created first and retained for rollback.
func (m *Manager) Restore(id string, validate Validator) (RestoreResult, error) {
	if validate == nil {
		return RestoreResult{}, errors.New("config validator is required")
	}
	data, snapshot, err := m.readBackup(id)
	if err != nil {
		return RestoreResult{}, err
	}
	var safety *Snapshot
	if _, statErr := os.Lstat(m.configPath); statErr == nil {
		current, readErr := m.readActive()
		if readErr != nil {
			return RestoreResult{}, readErr
		}
		backup, writeErr := m.writeBackup(current)
		if writeErr != nil {
			return RestoreResult{}, writeErr
		}
		safety = &backup
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return RestoreResult{}, fmt.Errorf("inspect active config: %w", statErr)
	}

	if err := os.MkdirAll(filepath.Dir(m.configPath), 0700); err != nil {
		return RestoreResult{}, fmt.Errorf("create config directory: %w", err)
	}
	tmp, err := m.writeTempConfig(data)
	if err != nil {
		return RestoreResult{}, err
	}
	defer os.Remove(tmp)
	if err := validate(tmp); err != nil {
		return RestoreResult{}, fmt.Errorf("config validation failed: %w", err)
	}
	if err := atomicRename(tmp, m.configPath); err != nil {
		return RestoreResult{}, err
	}
	return RestoreResult{Restored: snapshot, SafetyBackup: safety}, nil
}

// List returns valid metadata records newest first.  Corrupt/incomplete
// records are ignored rather than exposed to the UI.
func (m *Manager) List() ([]Snapshot, error) {
	entries, err := os.ReadDir(m.backupDir)
	if errors.Is(err, os.ErrNotExist) {
		return []Snapshot{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list backups: %w", err)
	}
	result := make([]Snapshot, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".meta.json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".meta.json")
		if !idPattern.MatchString(id) {
			continue
		}
		value, readErr := m.readMetadata(id)
		if readErr != nil || value.SchemaVersion != SchemaVersion || value.ID != id {
			continue
		}
		result = append(result, toSnapshot(value))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt > result[j].CreatedAt })
	return result, nil
}

func (m *Manager) readActive() ([]byte, error) {
	info, err := os.Lstat(m.configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("native OpenClaw config not found")
		}
		return nil, fmt.Errorf("inspect native config: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("native OpenClaw config must be a regular non-symlink file")
	}
	return readBounded(m.configPath, m.maxBytes)
}

func (m *Manager) readBackup(id string) ([]byte, Snapshot, error) {
	if !idPattern.MatchString(id) || len(id) > maxIDLength {
		return nil, Snapshot{}, errors.New("invalid backup id")
	}
	meta, err := m.readMetadata(id)
	if err != nil {
		return nil, Snapshot{}, err
	}
	if meta.SchemaVersion != SchemaVersion || meta.ID != id || meta.Bytes < 0 || meta.Bytes > m.maxBytes {
		return nil, Snapshot{}, errors.New("backup metadata invalid")
	}
	data, err := readBounded(filepath.Join(m.backupDir, id+".json5"), m.maxBytes)
	if err != nil {
		return nil, Snapshot{}, fmt.Errorf("read backup: %w", err)
	}
	if int64(len(data)) != meta.Bytes || digest(data) != meta.Digest {
		return nil, Snapshot{}, errors.New("backup integrity check failed")
	}
	return data, toSnapshot(meta), nil
}

func (m *Manager) readMetadata(id string) (metadata, error) {
	data, err := readBounded(filepath.Join(m.backupDir, id+".meta.json"), 16*1024)
	if err != nil {
		return metadata{}, err
	}
	var value metadata
	if err := json.Unmarshal(data, &value); err != nil {
		return metadata{}, fmt.Errorf("parse backup metadata: %w", err)
	}
	return value, nil
}

func (m *Manager) writeBackup(data []byte) (Snapshot, error) {
	if int64(len(data)) > m.maxBytes {
		return Snapshot{}, errors.New("native config exceeds backup size limit")
	}
	if err := os.MkdirAll(m.backupDir, 0700); err != nil {
		return Snapshot{}, fmt.Errorf("create backup directory: %w", err)
	}
	id, err := newID()
	if err != nil {
		return Snapshot{}, err
	}
	created := m.now().UTC().Format(time.RFC3339Nano)
	value := metadata{SchemaVersion: SchemaVersion, ID: id, Digest: digest(data), Bytes: int64(len(data)), CreatedAt: created}
	contentPath := filepath.Join(m.backupDir, id+".json5")
	metaPath := filepath.Join(m.backupDir, id+".meta.json")
	if err := writeAtomic(contentPath, data, 0600); err != nil {
		return Snapshot{}, fmt.Errorf("write backup: %w", err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		_ = os.Remove(contentPath)
		return Snapshot{}, err
	}
	if err := writeAtomic(metaPath, encoded, 0600); err != nil {
		_ = os.Remove(contentPath)
		return Snapshot{}, fmt.Errorf("write backup metadata: %w", err)
	}
	return toSnapshot(value), nil
}

func (m *Manager) writeTempConfig(data []byte) (string, error) {
	dir := filepath.Dir(m.configPath)
	file, err := os.CreateTemp(dir, ".longhub-config-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temporary config: %w", err)
	}
	path := file.Name()
	defer func() { _ = file.Close() }()
	if err := file.Chmod(0600); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("set temporary config permissions: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("write temporary config: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("sync temporary config: %w", err)
	}
	return path, nil
}

func readBounded(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := io.LimitReader(file, maxBytes+1)
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("file exceeds size limit")
	}
	return data, nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".longhub-backup-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return atomicRename(tmpPath, path)
}

func atomicRename(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return fmt.Errorf("atomic replace failed: %w", err)
	}
	return nil
}

func newID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate backup id: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func toSnapshot(value metadata) Snapshot {
	return Snapshot{SchemaVersion: value.SchemaVersion, ID: value.ID, Digest: value.Digest, Bytes: value.Bytes, CreatedAt: value.CreatedAt}
}

func isWithin(path, parent string) bool {
	rel, err := filepath.Rel(parent, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
