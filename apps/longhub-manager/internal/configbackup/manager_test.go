package configbackup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackupAndValidatedAtomicRestore(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "native", "openclaw.json")
	backupPath := filepath.Join(root, "manager-backups")
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("{\n  // user JSON5\n  \"gateway\": { \"mode\": \"local\" }\n}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := New(configPath, backupPath)
	if err != nil {
		t.Fatal(err)
	}
	first, err := m.Backup()
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.Bytes == 0 || len(first.Digest) != 64 {
		t.Fatalf("bad snapshot: %+v", first)
	}

	if err := os.WriteFile(configPath, []byte("{\"gateway\":{\"mode\":\"remote\"}}"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := m.Restore(first.ID, func(candidate string) error {
		data, readErr := os.ReadFile(candidate)
		if readErr != nil {
			return readErr
		}
		if !strings.Contains(string(data), "local") {
			return os.ErrInvalid
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Restored.ID != first.ID || result.SafetyBackup == nil {
		t.Fatalf("unexpected restore result: %+v", result)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "local") {
		t.Fatalf("restore did not replace config: %s", data)
	}
	list, err := m.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected original + safety backups, got %d", len(list))
	}
}

func TestRestoreRejectsMissingValidatorAndTamperedBackup(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "native.json")
	backupPath := filepath.Join(root, "backups")
	if err := os.WriteFile(configPath, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := New(configPath, backupPath)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := m.Backup()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Restore(snapshot.ID, nil); err == nil {
		t.Fatal("expected validator requirement")
	}
	if err := os.WriteFile(filepath.Join(backupPath, snapshot.ID+".json5"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Restore(snapshot.ID, func(string) error { return nil }); err == nil {
		t.Fatal("expected integrity failure")
	}
}

func TestRejectsOverlappingPathsAndSymlinkConfig(t *testing.T) {
	root := t.TempDir()
	if _, err := New(filepath.Join(root, "backups", "config.json"), filepath.Join(root, "backups")); err == nil {
		t.Fatal("expected overlapping paths to fail")
	}
	config := filepath.Join(root, "config.json")
	target := filepath.Join(root, "real.json")
	if err := os.WriteFile(target, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, config); err != nil {
		t.Skip("symlinks unavailable on this Windows runner")
	}
	m, err := New(config, filepath.Join(root, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Backup(); err == nil {
		t.Fatal("expected symlink config rejection")
	}
}
