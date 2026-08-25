package main

import (
	"testing"
)

func TestPendingManagerUpdateTrustFailsClosed(t *testing.T) {
	pending := []byte(`{"schema_version":"longhub/manager-update-trust/v1","status":"pending","approved_by":null,"approved_at":null,"keys":[]}`)
	if keys, err := parseManagerUpdateTrustManifest(pending); err == nil || len(keys) != 0 {
		t.Fatalf("pending trust unexpectedly enabled updates: keys=%d err=%v", len(keys), err)
	}
}
