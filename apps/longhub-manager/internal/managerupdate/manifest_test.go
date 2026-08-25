package managerupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func testManifest() Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion, ProductSurface: ProductSurface, Sequence: 7,
		Version: "0.2.0", Channel: "stable", Platform: "win32", Arch: "x64",
		Filename: "LongHub-Manager-Setup-0.2.0.exe", Size: 12,
		SHA256: strings.Repeat("a", 64), URLPath: "/downloads/LongHub-Manager-Setup-0.2.0.exe",
		PublishedAt: "2026-08-16T13:00:00Z", RollbackDataStrategy: "snapshot_required",
		Rollout: Rollout{Status: "active", BasisPoints: 10_000, Seed: strings.Repeat("b", 64), UpdatedAt: "2026-08-16T13:00:00Z"},
	}
}

func signedEnvelope(t *testing.T, manifest Manifest) (Envelope, map[string]ed25519.PublicKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signTestEnvelope(t, manifest, privateKey, "manager-update-test"),
		map[string]ed25519.PublicKey{"manager-update-test": publicKey}
}

func signTestEnvelope(t *testing.T, manifest Manifest, privateKey ed25519.PrivateKey, keyID string) Envelope {
	t.Helper()
	payload, err := SignaturePayload(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return Envelope{
		Manifest: manifest, SignatureKeyID: keyID,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
	}
}

func TestSignaturePayloadMatchesCanonicalClientContract(t *testing.T) {
	payload, err := SignaturePayload(testManifest())
	if err != nil {
		t.Fatal(err)
	}
	want := `longhub-client-update-v2
{"arch":"x64","channel":"stable","filename":"LongHub-Manager-Setup-0.2.0.exe","platform":"win32","product_surface":"longhub-manager","published_at":"2026-08-16T13:00:00Z","rollback_data_strategy":"snapshot_required","rollout":{"basis_points":10000,"seed":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"active","updated_at":"2026-08-16T13:00:00Z"},"schema_version":"longhub/client-update/v2","sequence":7,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":12,"url_path":"/downloads/LongHub-Manager-Setup-0.2.0.exe","version":"0.2.0"}`
	if string(payload) != want {
		t.Fatalf("canonical payload mismatch:\n%s", payload)
	}
}

func TestParseAndVerifyRejectsTamperUnknownFieldsAndWrongSurface(t *testing.T) {
	envelope, keys := signedEnvelope(t, testManifest())
	data, _ := json.Marshal(envelope)
	if _, err := ParseAndVerify(data, keys); err != nil {
		t.Fatal(err)
	}

	tampered := envelope
	tampered.Manifest.Size++
	tamperedData, _ := json.Marshal(tampered)
	if _, err := ParseAndVerify(tamperedData, keys); err == nil {
		t.Fatal("tampered manifest passed")
	}

	withUnknown := append(data[:len(data)-1], []byte(`,"extra":true}`)...)
	if _, err := ParseAndVerify(withUnknown, keys); err == nil {
		t.Fatal("unknown envelope field passed")
	}

	wrong := testManifest()
	wrong.ProductSurface = "longhub-desktop"
	if err := ValidateManifest(wrong); err == nil {
		t.Fatal("wrong product surface passed")
	}
}

func TestVersionAndRolloutPolicy(t *testing.T) {
	if comparison, err := CompareVersions("0.10.0", "0.9.9"); err != nil || comparison != 1 {
		t.Fatalf("comparison=%d err=%v", comparison, err)
	}
	rollout := testManifest().Rollout
	if eligible, err := RolloutEligible(rollout, "device:test-1"); err != nil || !eligible {
		t.Fatalf("eligible=%t err=%v", eligible, err)
	}
	rollout.Status = "paused"
	if eligible, err := RolloutEligible(rollout, "device:test-1"); err != nil || eligible {
		t.Fatalf("paused eligible=%t err=%v", eligible, err)
	}
}
