package managerupdate

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClientChecksAndDownloadsVerifiedInstaller(t *testing.T) {
	installer := []byte("manager-exe")
	manifest := testManifest()
	manifest.Size = int64(len(installer))
	manifest.SHA256 = DigestBytes(installer)
	envelope, keys := signedEnvelope(t, manifest)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/client-releases/latest":
			_ = json.NewEncoder(response).Encode(map[string]any{"release": envelope})
		case manifest.URLPath:
			response.Header().Set("Content-Length", contentLengthHeader(int64(len(installer))))
			_, _ = response.Write(installer)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, keys, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := client.Check(t.Context(), "0.1.0", "stable", "device:test-1")
	if err != nil || !candidate.Available || !candidate.Eligible {
		t.Fatalf("candidate=%+v err=%v", candidate, err)
	}
	root := filepath.Join(t.TempDir(), "updates")
	path, err := client.Download(t.Context(), candidate, root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(installer) {
		t.Fatalf("download=%q err=%v", got, err)
	}
}

func TestClientRefusesRedirectAndDigestMismatch(t *testing.T) {
	manifest := testManifest()
	manifest.Size = 4
	manifest.SHA256 = strings.Repeat("0", 64)
	envelope, keys := signedEnvelope(t, manifest)
	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v1/client-releases/latest" {
			_ = json.NewEncoder(response).Encode(map[string]any{"release": envelope})
			return
		}
		http.Redirect(response, request, "https://example.invalid/installer.exe", http.StatusFound)
	}))
	defer redirect.Close()
	client, err := NewClient(redirect.URL, keys, redirect.Client())
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := client.Check(t.Context(), "0.1.0", "stable", "device:test-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Download(t.Context(), candidate, filepath.Join(t.TempDir(), "updates")); err == nil {
		t.Fatal("redirected installer passed")
	}

	mismatch := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v1/client-releases/latest" {
			_ = json.NewEncoder(response).Encode(map[string]any{"release": envelope})
			return
		}
		response.Header().Set("Content-Length", "4")
		_, _ = response.Write([]byte("evil"))
	}))
	defer mismatch.Close()
	client, _ = NewClient(mismatch.URL, keys, mismatch.Client())
	candidate, _ = client.Check(t.Context(), "0.1.0", "stable", "device:test-1")
	if _, err := client.Download(t.Context(), candidate, filepath.Join(t.TempDir(), "updates")); err == nil {
		t.Fatal("digest mismatch passed")
	}
}
