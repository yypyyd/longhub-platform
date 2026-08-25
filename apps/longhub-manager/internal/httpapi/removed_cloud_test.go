package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/longhub/longhub-manager/internal/runtime"
)

func TestRemovedCloudRoutesFailClosedWithoutCredentials(t *testing.T) {
	server := NewServer(runtime.NewNativeAdapter(runtime.OSCommandRunner{}), "manager-secret-that-is-long-enough")
	for _, path := range []string{
		"/api/v1/cloud/pairing",
		"/api/v1/cloud/pairing/challenge",
		"/api/v1/cloud-skill/enroll",
		"/api/v1/cloud-skill/execute",
		"/api/v1/cloud-skill/plugin",
		"/api/v1/cloud-skill/execution-environment",
	} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		res := httptest.NewRecorder()
		server.http.Handler.ServeHTTP(res, req)
		if res.Code != http.StatusGone || !strings.Contains(res.Body.String(), "CLOUD_SKILL_MOVED_TO_PLUGIN") {
			t.Fatalf("path %s returned %d %s", path, res.Code, res.Body.String())
		}
	}
}
