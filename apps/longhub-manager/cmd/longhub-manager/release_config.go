package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const managerReleaseConfigSchema = "longhub/manager-release-config/v1"

type managerReleaseConfig struct {
	SchemaVersion   string `json:"schema_version"`
	CloudAPIBaseURL string `json:"cloud_api_base_url"`
}

func resolveCloudBaseURL(executablePath func() (string, error), getenv func(string) string) (string, error) {
	if executablePath == nil || getenv == nil {
		return "", errors.New("Manager 发行配置不可用")
	}
	executable, err := executablePath()
	if err == nil && filepath.IsAbs(executable) {
		configPath := filepath.Join(filepath.Dir(filepath.Clean(executable)), "release-config.json")
		if info, statErr := os.Lstat(configPath); statErr == nil {
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > 4096 {
				return "", errors.New("Manager 发行配置文件无效")
			}
			data, readErr := os.ReadFile(configPath)
			if readErr != nil {
				return "", errors.New("Manager 发行配置无法读取")
			}
			return parseManagerReleaseConfig(data)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return "", errors.New("Manager 发行配置无法检查")
		}
	}
	value := strings.TrimSpace(getenv("LONGHUB_CLOUD_API_BASE_URL"))
	if value == "" {
		return "", nil
	}
	if !validManagerCloudBaseURL(value, true) {
		return "", errors.New("开发 Cloud API 地址无效")
	}
	return strings.TrimRight(value, "/"), nil
}

func parseManagerReleaseConfig(data []byte) (string, error) {
	if len(data) == 0 || len(data) > 4096 {
		return "", errors.New("Manager 发行配置格式无效")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config managerReleaseConfig
	if err := decoder.Decode(&config); err != nil {
		return "", errors.New("Manager 发行配置格式无效")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return "", errors.New("Manager 发行配置包含尾随数据")
	}
	if config.SchemaVersion != managerReleaseConfigSchema ||
		!validManagerCloudBaseURL(config.CloudAPIBaseURL, false) ||
		strings.HasSuffix(config.CloudAPIBaseURL, "/") {
		return "", errors.New("Manager 发行配置字段无效")
	}
	return config.CloudAPIBaseURL, nil
}

func validManagerCloudBaseURL(value string, allowLoopbackHTTP bool) bool {
	if strings.TrimSpace(value) != value || value == "" {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" || parsed.Path != "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" || !allowLoopbackHTTP {
		return false
	}
	if strings.EqualFold(parsed.Hostname(), "localhost") {
		return true
	}
	ip := net.ParseIP(parsed.Hostname())
	return ip != nil && ip.IsLoopback()
}
