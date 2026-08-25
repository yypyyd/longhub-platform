package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReleaseConfigOverridesDevelopmentEnvironment(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "LongHubManager.exe")
	if err := os.WriteFile(executable, []byte("exe"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := []byte(`{"schema_version":"longhub/manager-release-config/v1","cloud_api_base_url":"https://longhub.example"}`)
	if err := os.WriteFile(filepath.Join(root, "release-config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := resolveCloudBaseURL(
		func() (string, error) { return executable, nil },
		func(string) string { return "http://127.0.0.1:8081" },
	)
	if err != nil || got != "https://longhub.example" {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

func TestReleaseConfigRejectsHTTPUnknownAndPaths(t *testing.T) {
	for _, data := range []string{
		`{"schema_version":"longhub/manager-release-config/v1","cloud_api_base_url":"http://example.com"}`,
		`{"schema_version":"longhub/manager-release-config/v1","cloud_api_base_url":"https://example.com/v1"}`,
		`{"schema_version":"longhub/manager-release-config/v1","cloud_api_base_url":"https://example.com","extra":true}`,
		`{"schema_version":"wrong","cloud_api_base_url":"https://example.com"}`,
	} {
		if value, err := parseManagerReleaseConfig([]byte(data)); err == nil {
			t.Fatalf("invalid config passed: %q -> %q", data, value)
		}
	}
}

func TestDevelopmentFallbackAllowsOnlyLoopbackHTTP(t *testing.T) {
	value, err := resolveCloudBaseURL(
		func() (string, error) { return filepath.Join(t.TempDir(), "manager.exe"), nil },
		func(string) string { return "http://127.0.0.1:8081" },
	)
	if err != nil || value != "http://127.0.0.1:8081" {
		t.Fatalf("value=%q err=%v", value, err)
	}
	if _, err := resolveCloudBaseURL(
		func() (string, error) { return filepath.Join(t.TempDir(), "manager.exe"), nil },
		func(string) string { return "http://example.com" },
	); err == nil {
		t.Fatal("non-loopback development HTTP passed")
	}
}
