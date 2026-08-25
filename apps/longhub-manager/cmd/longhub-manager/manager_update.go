package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/longhub/longhub-manager/internal/managerupdate"
)

var version = "0.1.1"

//go:embed assets/manager-update-trusted-keys.json
var embeddedManagerUpdateTrustAsset []byte

type managerUpdateTrustManifest struct {
	SchemaVersion string                  `json:"schema_version"`
	Status        string                  `json:"status"`
	ApprovedBy    *string                 `json:"approved_by"`
	ApprovedAt    *string                 `json:"approved_at"`
	Keys          []managerUpdateTrustKey `json:"keys"`
}

type managerUpdateTrustKey struct {
	KeyID        string `json:"key_id"`
	PublicKeyPEM string `json:"public_key_pem"`
}

func loadEmbeddedManagerUpdateTrustedKeys() (map[string]ed25519.PublicKey, error) {
	return parseManagerUpdateTrustManifest(embeddedManagerUpdateTrustAsset)
}

func parseManagerUpdateTrustManifest(data []byte) (map[string]ed25519.PublicKey, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest managerUpdateTrustManifest
	if err := decoder.Decode(&manifest); err != nil {
		return nil, errors.New("Manager 更新信任清单格式无效")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("Manager 更新信任清单包含尾随数据")
	}
	if manifest.SchemaVersion != "longhub/manager-update-trust/v1" ||
		(manifest.Status != "pending" && manifest.Status != "approved") || len(manifest.Keys) > 16 {
		return nil, errors.New("Manager 更新信任清单字段无效")
	}
	if manifest.Status == "pending" {
		if manifest.ApprovedBy != nil || manifest.ApprovedAt != nil || len(manifest.Keys) != 0 {
			return nil, errors.New("待审批的 Manager 更新信任清单不得包含密钥")
		}
		return nil, errors.New("Manager 更新信任尚未审批")
	}
	if manifest.ApprovedBy == nil || strings.TrimSpace(*manifest.ApprovedBy) == "" ||
		manifest.ApprovedAt == nil {
		return nil, errors.New("Manager 更新信任清单缺少审批信息")
	}
	if _, err := time.Parse(time.RFC3339, *manifest.ApprovedAt); err != nil {
		return nil, errors.New("Manager 更新信任清单审批时间无效")
	}
	keys := make(map[string]ed25519.PublicKey, len(manifest.Keys))
	for _, record := range manifest.Keys {
		if strings.Contains(record.PublicKeyPEM, "PRIVATE KEY") {
			return nil, errors.New("Manager 更新信任清单包含私钥")
		}
		key, err := managerupdate.ParseTrustedPublicKey(record.PublicKeyPEM)
		if err != nil || len(key) != ed25519.PublicKeySize {
			return nil, errors.New("Manager 更新信任公钥无效")
		}
		if _, exists := keys[record.KeyID]; exists {
			return nil, errors.New("Manager 更新信任公钥重复")
		}
		keys[record.KeyID] = key
	}
	if len(keys) == 0 {
		return nil, errors.New("Manager 更新信任清单没有公钥")
	}
	return keys, nil
}

func newManagerUpdateCoordinator(
	cloudBaseURL string,
	stop context.CancelFunc,
) (*managerupdate.Coordinator, error) {
	if strings.TrimSpace(cloudBaseURL) == "" {
		return nil, errors.New("Manager 更新云地址未配置")
	}
	keys, err := loadEmbeddedManagerUpdateTrustedKeys()
	if err != nil {
		return nil, err
	}
	configDir, err := os.UserConfigDir()
	if err != nil || !filepath.IsAbs(configDir) {
		return nil, errors.New("Manager 更新目录不可用")
	}
	updateRoot, err := managerupdate.UpdateRoot(configDir)
	if err != nil {
		return nil, err
	}
	store, err := managerupdate.NewRecoveryStore(updateRoot, keys)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, errors.New("Manager 安装路径不可用")
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return nil, errors.New("Manager 安装路径不可用")
	}
	recoveryInstaller, err := managerupdate.RecoveryInstallerPath(executable, version)
	if err != nil {
		return nil, err
	}
	randomValue := make([]byte, 32)
	if _, err := rand.Read(randomValue); err != nil {
		return nil, errors.New("Manager 更新身份生成失败")
	}
	identity, err := managerupdate.EnsureStableIdentity(filepath.Join(updateRoot, "identity"), randomValue)
	clear(randomValue)
	if err != nil {
		return nil, err
	}
	client, err := managerupdate.NewClient(cloudBaseURL, keys, nil)
	if err != nil {
		return nil, err
	}
	return managerupdate.NewCoordinator(managerupdate.CoordinatorOptions{
		Client: client, RecoveryStore: store, CurrentVersion: version, Channel: "stable",
		Identity: identity, UpdateRoot: updateRoot, RecoveryInstaller: recoveryInstaller,
		Stop: stop,
	})
}
