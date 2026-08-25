package managerupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryStoreRollsBackAfterThreeUnhealthyStarts(t *testing.T) {
	root := filepath.Join(t.TempDir(), "updates")
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]ed25519.PublicKey{"manager-update-test": publicKey}
	store, err := NewRecoveryStore(root, keys)
	if err != nil {
		t.Fatal(err)
	}
	targetBytes := []byte("target")
	rollbackBytes := []byte("rollback")
	targetManifest := testManifest()
	targetManifest.Size = int64(len(targetBytes))
	targetManifest.SHA256 = DigestBytes(targetBytes)
	rollbackManifest := testManifest()
	rollbackManifest.Version = "0.1.0"
	rollbackManifest.Filename = "LongHub-Manager-Setup-0.1.0.exe"
	rollbackManifest.URLPath = "/downloads/LongHub-Manager-Setup-0.1.0.exe"
	rollbackManifest.Sequence = 1
	rollbackManifest.Size = int64(len(rollbackBytes))
	rollbackManifest.SHA256 = DigestBytes(rollbackBytes)
	target := signTestEnvelope(t, targetManifest, privateKey, "manager-update-test")
	rollback := signTestEnvelope(t, rollbackManifest, privateKey, "manager-update-test")
	targetPath := filepath.Join(root, targetManifest.Filename)
	rollbackPath := filepath.Join(t.TempDir(), rollbackManifest.Filename)
	if err := os.WriteFile(targetPath, targetBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rollbackPath, rollbackBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Prepare("0.1.0", target, targetPath, rollback, rollbackPath); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		pending, rollbackRequired, err := store.RecordTargetStartup("0.2.0")
		if err != nil || pending.Attempts != attempt || rollbackRequired != (attempt == 3) {
			t.Fatalf("attempt=%d pending=%+v rollback=%t err=%v", attempt, pending, rollbackRequired, err)
		}
	}
	if _, err := store.BeginRollback("startup_health_timeout"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTargetStartup("0.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(); !os.IsNotExist(err) {
		t.Fatalf("rollback completion must clear pending state: %v", err)
	}
}

func TestRecoveryStoreHealthyTargetClearsPending(t *testing.T) {
	root := filepath.Join(t.TempDir(), "updates")
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]ed25519.PublicKey{"manager-update-test": publicKey}
	store, err := NewRecoveryStore(root, keys)
	if err != nil {
		t.Fatal(err)
	}
	targetBytes := []byte("target")
	rollbackBytes := []byte("rollback")
	targetManifest := testManifest()
	targetManifest.Size, targetManifest.SHA256 = int64(len(targetBytes)), DigestBytes(targetBytes)
	rollbackManifest := testManifest()
	rollbackManifest.Version = "0.1.0"
	rollbackManifest.Filename = "LongHub-Manager-Setup-0.1.0.exe"
	rollbackManifest.URLPath = "/downloads/LongHub-Manager-Setup-0.1.0.exe"
	rollbackManifest.Size, rollbackManifest.SHA256 = int64(len(rollbackBytes)), DigestBytes(rollbackBytes)
	target := signTestEnvelope(t, targetManifest, privateKey, "manager-update-test")
	rollback := signTestEnvelope(t, rollbackManifest, privateKey, "manager-update-test")
	targetPath := filepath.Join(root, targetManifest.Filename)
	rollbackPath := filepath.Join(t.TempDir(), rollbackManifest.Filename)
	_ = os.WriteFile(targetPath, targetBytes, 0o600)
	_ = os.WriteFile(rollbackPath, rollbackBytes, 0o600)
	if _, err := store.Prepare("0.1.0", target, targetPath, rollback, rollbackPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTargetStartup("0.2.0"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkHealthy("0.2.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(); !os.IsNotExist(err) {
		t.Fatalf("healthy target must clear pending state: %v", err)
	}
}
