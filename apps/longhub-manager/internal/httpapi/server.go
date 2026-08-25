package httpapi

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/longhub/longhub-manager/internal/configbackup"
	"github.com/longhub/longhub-manager/internal/managerupdate"
	"github.com/longhub/longhub-manager/internal/runtime"
)

//go:embed web/index.html
var webFS embed.FS

type Server struct {
	adapter       *runtime.NativeAdapter
	token         string
	configBackups *configbackup.Manager
	managerUpdate *managerupdate.Coordinator
	http          *http.Server
}

// ServerOptions contains startup-fixed local Manager dependencies. Cloud Skill
// configuration intentionally does not exist on this surface.
type ServerOptions struct {
	ConfigBackups *configbackup.Manager
	ManagerUpdate *managerupdate.Coordinator
}

func NewServer(adapter *runtime.NativeAdapter, token string) *Server {
	return NewServerWithOptions(adapter, token, ServerOptions{})
}

func NewServerWithOptions(adapter *runtime.NativeAdapter, token string, options ServerOptions) *Server {
	s := &Server{
		adapter:       adapter,
		token:         token,
		configBackups: options.ConfigBackups,
		managerUpdate: options.ManagerUpdate,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/runtime/status", s.handleStatus)
	mux.HandleFunc("/api/v1/runtime/install-plan", s.handleInstallPlan)
	mux.HandleFunc("/api/v1/runtime/install", s.handleInstall)
	mux.HandleFunc("/api/v1/runtime/control", s.handleControl)
	mux.HandleFunc("/api/v1/config/backups", s.handleConfigBackups)
	mux.HandleFunc("/api/v1/config/restore", s.handleConfigRestore)
	mux.HandleFunc("/api/v1/cloud-skill", s.handleRemovedCloudSkill)
	mux.HandleFunc("/api/v1/cloud-skill/", s.handleRemovedCloudSkill)
	mux.HandleFunc("/api/v1/cloud", s.handleRemovedCloudSkill)
	mux.HandleFunc("/api/v1/cloud/", s.handleRemovedCloudSkill)
	mux.HandleFunc("/api/v1/manager-update", s.handleManagerUpdate)
	mux.HandleFunc("/", s.handleWeb)
	s.http = &http.Server{Handler: s.auth(mux)}
	return s
}

// The standalone longhub-cloud CLI/plugin owns pairing, credentials, releases
// and Cloud execution. Retired Manager routes have no dependencies or side
// effects and remain only as an explicit migration response.
func (s *Server) handleRemovedCloudSkill(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusGone, "CLOUD_SKILL_MOVED_TO_PLUGIN")
}

func (s *Server) handleManagerUpdate(w http.ResponseWriter, r *http.Request) {
	if s.managerUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "MANAGER_UPDATE_NOT_CONFIGURED")
		return
	}
	w.Header().Set("cache-control", "no-store")
	switch r.Method {
	case http.MethodGet:
		status, err := s.managerUpdate.Refresh(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, status)
			return
		}
		writeJSON(w, http.StatusOK, status)
	case http.MethodPost:
		var body *struct {
			Action  string `json:"action"`
			Confirm bool   `json:"confirm"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil || body == nil || !jsonEOF(decoder) {
			writeError(w, http.StatusBadRequest, "INVALID_JSON")
			return
		}
		if !body.Confirm {
			writeError(w, http.StatusPreconditionRequired, "USER_CONFIRMATION_REQUIRED")
			return
		}
		var status managerupdate.PublicStatus
		var err error
		switch body.Action {
		case "download":
			status, err = s.managerUpdate.Download(r.Context(), true)
		case "apply":
			status, err = s.managerUpdate.Apply(r.Context(), true)
		default:
			writeError(w, http.StatusBadRequest, "UNSUPPORTED_ACTION")
			return
		}
		if err != nil {
			code := status.ErrorCode
			if code == "" {
				code = "MANAGER_UPDATE_UNAVAILABLE"
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"state": status.State, "current_version": status.CurrentVersion,
				"target_version": status.TargetVersion, "error_code": code,
			})
			return
		}
		writeJSON(w, http.StatusOK, status)
	default:
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
	}
}

func (s *Server) Serve(listener net.Listener) error { return s.http.Serve(listener) }

func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r) {
			writeError(w, http.StatusForbidden, "LOCAL_ONLY")
			return
		}
		if !isAllowedOrigin(r) {
			writeError(w, http.StatusForbidden, "ORIGIN_NOT_ALLOWED")
			return
		}
		if r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/") || isRemovedCloudPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		provided, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok || subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
			writeError(w, http.StatusUnauthorized, "MANAGER_AUTH_REQUIRED")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isRemovedCloudPath(path string) bool {
	return path == "/api/v1/cloud" || path == "/api/v1/cloud-skill" ||
		strings.HasPrefix(path, "/api/v1/cloud/") || strings.HasPrefix(path, "/api/v1/cloud-skill/")
}

func (s *Server) handleInstallPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	plan, err := s.adapter.NativeInstallPlan(r.Context())
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"code": "OPENCLAW_INSTALL_UNAVAILABLE", "message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) handleInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	var body struct {
		Confirm bool `json:"confirm"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || !jsonEOF(decoder) {
		writeError(w, http.StatusBadRequest, "INVALID_JSON")
		return
	}
	if !body.Confirm {
		writeError(w, http.StatusPreconditionRequired, "USER_CONFIRMATION_REQUIRED")
		return
	}
	output, err := s.adapter.InstallNative(r.Context())
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"code": "OPENCLAW_INSTALL_FAILED", "message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"package": runtime.OpenClawPackage, "output": output})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	writeJSON(w, http.StatusOK, s.adapter.Discover(r.Context()))
}

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	var body *struct {
		Action  string `json:"action"`
		Confirm bool   `json:"confirm"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || body == nil || !jsonEOF(decoder) {
		writeError(w, http.StatusBadRequest, "INVALID_JSON")
		return
	}

	switch body.Action {
	case "status", "health":
		writeJSON(w, http.StatusOK, s.adapter.GatewayStatus(r.Context()))
	case "task-status":
		writeJSON(w, http.StatusOK, map[string]any{
			"action": body.Action, "status": s.adapter.GatewayScheduledTaskStatus(r.Context()),
		})
	case "start", "stop", "restart":
		status, err := s.adapter.GatewayControl(r.Context(), body.Action, body.Confirm)
		if err != nil {
			writeGatewayControlError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"action": body.Action, "status": status})
	case "enroll-task", "remove-task":
		var status runtime.GatewayStatus
		var err error
		if body.Action == "enroll-task" {
			status, err = s.adapter.GatewayEnrollScheduledTask(r.Context(), body.Confirm)
		} else {
			status, err = s.adapter.GatewayRemoveScheduledTask(r.Context(), body.Confirm)
		}
		if err != nil {
			writeGatewayControlError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"action": body.Action, "status": status})
	case "doctor", "skills":
		output, err := s.adapter.RunControl(r.Context(), body.Action)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "OPENCLAW_ACTION_FAILED"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"action": body.Action, "output": output})
	default:
		writeError(w, http.StatusBadRequest, "UNSUPPORTED_ACTION")
	}
}

func writeGatewayControlError(w http.ResponseWriter, err error) {
	code := "GATEWAY_ACTION_FAILED"
	status := http.StatusUnprocessableEntity
	switch {
	case errors.Is(err, runtime.ErrGatewayConfirmationRequired):
		code = "USER_CONFIRMATION_REQUIRED"
		status = http.StatusPreconditionRequired
	case errors.Is(err, runtime.ErrExternalGateway):
		code = "EXTERNAL_GATEWAY_CONFIRMATION_REQUIRED"
		status = http.StatusPreconditionRequired
	case errors.Is(err, runtime.ErrGatewayNotInstalled):
		code = "OPENCLAW_NOT_INSTALLED"
	case errors.Is(err, runtime.ErrGatewayInspectionFailed):
		code = "GATEWAY_STATUS_UNAVAILABLE"
		status = http.StatusServiceUnavailable
	case errors.Is(err, runtime.ErrScheduledTaskForeignOwner):
		code = "SCHEDULED_TASK_FOREIGN_OWNER"
		status = http.StatusConflict
	case errors.Is(err, runtime.ErrNativeProcessControlUnavailable):
		code = "SCHEDULED_TASK_LIFECYCLE_UNSUPPORTED"
	case errors.Is(err, runtime.ErrScheduledTaskOperationFailed),
		errors.Is(err, runtime.ErrScheduledTaskInvalidCommand),
		errors.Is(err, runtime.ErrScheduledTaskInspectionFailed):
		code = "SCHEDULED_TASK_OPERATION_FAILED"
	}
	writeError(w, status, code)
}

func (s *Server) handleConfigBackups(w http.ResponseWriter, r *http.Request) {
	if s.configBackups == nil {
		writeError(w, http.StatusServiceUnavailable, "CONFIG_BACKUP_NOT_CONFIGURED")
		return
	}
	switch r.Method {
	case http.MethodGet:
		backups, err := s.configBackups.List()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "CONFIG_BACKUP_UNAVAILABLE")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"backups": backups})
	case http.MethodPost:
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024))
		decoder.DisallowUnknownFields()
		var body map[string]any
		if err := decoder.Decode(&body); err != nil || body == nil || len(body) != 0 || !jsonEOF(decoder) {
			writeError(w, http.StatusBadRequest, "INVALID_JSON")
			return
		}
		backup, err := s.configBackups.Backup()
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, configBackupErrorCode(err))
			return
		}
		writeJSON(w, http.StatusCreated, backup)
	default:
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
	}
}

func (s *Server) handleConfigRestore(w http.ResponseWriter, r *http.Request) {
	if s.configBackups == nil {
		writeError(w, http.StatusServiceUnavailable, "CONFIG_BACKUP_NOT_CONFIGURED")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024))
	decoder.DisallowUnknownFields()
	var body struct {
		BackupID string `json:"backup_id"`
	}
	if err := decoder.Decode(&body); err != nil || body.BackupID == "" || !jsonEOF(decoder) {
		writeError(w, http.StatusBadRequest, "INVALID_RESTORE_REQUEST")
		return
	}
	result, err := s.configBackups.Restore(body.BackupID, func(candidatePath string) error {
		return s.adapter.ValidateConfigCandidate(r.Context(), candidatePath)
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, configBackupErrorCode(err))
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func jsonEOF(decoder *json.Decoder) bool {
	var extra any
	return decoder.Decode(&extra) == io.EOF
}

func configBackupErrorCode(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "not found"):
		return "NATIVE_CONFIG_NOT_FOUND"
	case strings.Contains(message, "validator") || strings.Contains(message, "validation"):
		return "CONFIG_VALIDATION_FAILED"
	case strings.Contains(message, "integrity"):
		return "CONFIG_BACKUP_INTEGRITY_FAILED"
	case strings.Contains(message, "size limit") || strings.Contains(message, "exceeds"):
		return "CONFIG_TOO_LARGE"
	default:
		return "CONFIG_BACKUP_FAILED"
	}
}

func (s *Server) handleWeb(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		writeError(w, http.StatusNotFound, "NOT_FOUND")
		return
	}
	w.Header().Set("content-type", "text/html; charset=utf-8")
	data, err := webFS.ReadFile("web/index.html")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "WEB_ASSET_MISSING")
		return
	}
	_, _ = w.Write(data)
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isAllowedOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" || origin == "null" {
		return origin != "null"
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func bearerToken(header string) (string, bool) {
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	return token, token != "" && !strings.ContainsAny(token, " \t\r\n")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"code": code})
}
