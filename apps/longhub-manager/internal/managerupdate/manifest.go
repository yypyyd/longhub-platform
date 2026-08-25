package managerupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

const (
	SchemaVersion           = "longhub/client-update/v2"
	ProductSurface          = "longhub-manager"
	SignatureDomain         = "longhub-client-update-v2\n"
	MaxInstallerBytes int64 = 1024 * 1024 * 1024
	maxSafeInteger    int64 = 9_007_199_254_740_991
)

var (
	ErrMetadataInvalid   = errors.New("manager update metadata is invalid")
	ErrSignatureInvalid  = errors.New("manager update signature is invalid")
	ErrUnknownSigningKey = errors.New("manager update signing key is not trusted")
	versionPattern       = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	hexDigestPattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	keyIDPattern         = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	identityPattern      = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
)

type Rollout struct {
	Status      string `json:"status"`
	BasisPoints int    `json:"basis_points"`
	Seed        string `json:"seed"`
	UpdatedAt   string `json:"updated_at"`
}

type Manifest struct {
	SchemaVersion        string  `json:"schema_version"`
	ProductSurface       string  `json:"product_surface"`
	Sequence             int64   `json:"sequence"`
	Version              string  `json:"version"`
	Channel              string  `json:"channel"`
	Platform             string  `json:"platform"`
	Arch                 string  `json:"arch"`
	Filename             string  `json:"filename"`
	Size                 int64   `json:"size"`
	SHA256               string  `json:"sha256"`
	URLPath              string  `json:"url_path"`
	PublishedAt          string  `json:"published_at"`
	RollbackDataStrategy string  `json:"rollback_data_strategy"`
	Rollout              Rollout `json:"rollout"`
}

type Envelope struct {
	Manifest       Manifest `json:"manifest"`
	SignatureKeyID string   `json:"signature_key_id"`
	Signature      string   `json:"signature"`
}

func ParseTrustedPublicKey(publicKeyPEM string) (ed25519.PublicKey, error) {
	block, rest := pem.Decode([]byte(publicKeyPEM))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, ErrMetadataInvalid
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, ErrMetadataInvalid
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, ErrMetadataInvalid
	}
	return append(ed25519.PublicKey(nil), key...), nil
}

func ParseAndVerify(data []byte, trustedKeys map[string]ed25519.PublicKey) (Envelope, error) {
	if len(data) == 0 || len(data) > 256*1024 {
		return Envelope{}, ErrMetadataInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var envelope Envelope
	if err := decoder.Decode(&envelope); err != nil {
		return Envelope{}, ErrMetadataInvalid
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Envelope{}, ErrMetadataInvalid
	}
	if err := ValidateManifest(envelope.Manifest); err != nil {
		return Envelope{}, err
	}
	if !keyIDPattern.MatchString(envelope.SignatureKeyID) {
		return Envelope{}, ErrMetadataInvalid
	}
	key, ok := trustedKeys[envelope.SignatureKeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return Envelope{}, ErrUnknownSigningKey
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Envelope{}, ErrSignatureInvalid
	}
	payload, err := SignaturePayload(envelope.Manifest)
	if err != nil || !ed25519.Verify(key, payload, signature) {
		return Envelope{}, ErrSignatureInvalid
	}
	return envelope, nil
}

func ValidateManifest(manifest Manifest) error {
	if manifest.SchemaVersion != SchemaVersion || manifest.ProductSurface != ProductSurface ||
		manifest.Platform != "win32" || manifest.Arch != "x64" {
		return ErrMetadataInvalid
	}
	if manifest.Sequence <= 0 || manifest.Sequence > maxSafeInteger ||
		!versionPattern.MatchString(manifest.Version) {
		return ErrMetadataInvalid
	}
	if manifest.Channel != "stable" && manifest.Channel != "beta" {
		return ErrMetadataInvalid
	}
	expectedFilename := "LongHub-Manager-Setup-" + manifest.Version + ".exe"
	if manifest.Filename != expectedFilename || manifest.URLPath != "/downloads/"+expectedFilename {
		return ErrMetadataInvalid
	}
	if manifest.Size <= 0 || manifest.Size > MaxInstallerBytes || !hexDigestPattern.MatchString(manifest.SHA256) {
		return ErrMetadataInvalid
	}
	if _, err := time.Parse(time.RFC3339Nano, manifest.PublishedAt); err != nil {
		return ErrMetadataInvalid
	}
	if manifest.RollbackDataStrategy != "snapshot_required" &&
		manifest.RollbackDataStrategy != "backward_compatible" {
		return ErrMetadataInvalid
	}
	if manifest.Rollout.Status != "active" && manifest.Rollout.Status != "paused" {
		return ErrMetadataInvalid
	}
	if manifest.Rollout.BasisPoints < 0 || manifest.Rollout.BasisPoints > 10_000 ||
		manifest.Rollout.Status == "active" && manifest.Rollout.BasisPoints == 0 ||
		!hexDigestPattern.MatchString(manifest.Rollout.Seed) {
		return ErrMetadataInvalid
	}
	if _, err := time.Parse(time.RFC3339Nano, manifest.Rollout.UpdatedAt); err != nil {
		return ErrMetadataInvalid
	}
	return nil
}

func SignaturePayload(manifest Manifest) ([]byte, error) {
	if err := ValidateManifest(manifest); err != nil {
		return nil, err
	}
	canonical := map[string]any{
		"arch":                   manifest.Arch,
		"channel":                manifest.Channel,
		"filename":               manifest.Filename,
		"platform":               manifest.Platform,
		"product_surface":        manifest.ProductSurface,
		"published_at":           manifest.PublishedAt,
		"rollback_data_strategy": manifest.RollbackDataStrategy,
		"rollout": map[string]any{
			"basis_points": manifest.Rollout.BasisPoints,
			"seed":         manifest.Rollout.Seed,
			"status":       manifest.Rollout.Status,
			"updated_at":   manifest.Rollout.UpdatedAt,
		},
		"schema_version": manifest.SchemaVersion,
		"sequence":       manifest.Sequence,
		"sha256":         manifest.SHA256,
		"size":           manifest.Size,
		"url_path":       manifest.URLPath,
		"version":        manifest.Version,
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(canonical); err != nil {
		return nil, ErrMetadataInvalid
	}
	return []byte(SignatureDomain + strings.TrimSuffix(encoded.String(), "\n")), nil
}

func CompareVersions(left, right string) (int, error) {
	if !versionPattern.MatchString(left) || !versionPattern.MatchString(right) {
		return 0, ErrMetadataInvalid
	}
	var leftMajor, leftMinor, leftPatch int
	var rightMajor, rightMinor, rightPatch int
	if _, err := fmt.Sscanf(left, "%d.%d.%d", &leftMajor, &leftMinor, &leftPatch); err != nil {
		return 0, ErrMetadataInvalid
	}
	if _, err := fmt.Sscanf(right, "%d.%d.%d", &rightMajor, &rightMinor, &rightPatch); err != nil {
		return 0, ErrMetadataInvalid
	}
	leftParts := [3]int{leftMajor, leftMinor, leftPatch}
	rightParts := [3]int{rightMajor, rightMinor, rightPatch}
	for index := range leftParts {
		if leftParts[index] < rightParts[index] {
			return -1, nil
		}
		if leftParts[index] > rightParts[index] {
			return 1, nil
		}
	}
	return 0, nil
}

func RolloutEligible(rollout Rollout, identity string) (bool, error) {
	if rollout.Status != "active" || rollout.BasisPoints <= 0 {
		return false, nil
	}
	if !identityPattern.MatchString(identity) || !hexDigestPattern.MatchString(rollout.Seed) {
		return false, ErrMetadataInvalid
	}
	if rollout.BasisPoints == 10_000 {
		return true, nil
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte("longhub-client-rollout-v1\n"))
	_, _ = digest.Write([]byte(rollout.Seed))
	_, _ = digest.Write([]byte("\n"))
	_, _ = digest.Write([]byte(identity))
	sum := digest.Sum(nil)
	return int(binary.BigEndian.Uint32(sum[:4])%10_000) < rollout.BasisPoints, nil
}

func DigestBytes(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
