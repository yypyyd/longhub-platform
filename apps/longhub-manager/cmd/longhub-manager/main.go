package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/longhub/longhub-manager/internal/configbackup"
	"github.com/longhub/longhub-manager/internal/httpapi"
	"github.com/longhub/longhub-manager/internal/managerupdate"
	"github.com/longhub/longhub-manager/internal/runtime"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	mode, modeErr := parseManagerStartupMode(os.Args[1:])
	if modeErr != nil {
		log.Fatalf("启动失败: %v", modeErr)
	}
	if mode == managerStartupRemoveAutostart {
		removeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := removeManagerAutostart(removeCtx); err != nil {
			log.Fatalf("移除自动启动失败: %v", err)
		}
		return
	}

	token, err := startupToken()
	if err != nil {
		log.Fatalf("生成本地管理令牌失败: %v", err)
	}

	commandRunner := runtime.OSCommandRunner{}
	adapter := runtime.NewNativeAdapter(commandRunner)
	cloudBaseURL, cloudConfigErr := resolveCloudBaseURL(os.Executable, os.Getenv)
	if cloudConfigErr != nil {
		log.Printf("Manager 更新配置不可用")
		cloudBaseURL = ""
	}
	var managerUpdater *managerupdate.Coordinator
	if updater, updateErr := newManagerUpdateCoordinator(cloudBaseURL, stop); updateErr != nil {
		log.Printf("Manager 签名更新暂不可用")
	} else {
		managerUpdater = updater
		if recoveryErr := managerUpdater.RecoverOnStartup(ctx, stop); recoveryErr != nil {
			log.Printf("Manager 更新恢复状态不可用")
		}
		if ctx.Err() != nil {
			return
		}
	}
	var configBackups *configbackup.Manager
	if manager, backupErr := newConfigBackupManager(os.Getenv, os.UserHomeDir, os.UserConfigDir); backupErr != nil {
		// A malformed optional path must not stop the free local runtime manager;
		// only the backup endpoints stay fail-closed and report a fixed code.
		log.Printf("原生配置备份暂不可用: %v", backupErr)
	} else {
		configBackups = manager
	}
	port := envPort("LONGHUB_MANAGER_PORT", 19527)
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		log.Fatalf("无法绑定本地管家端口: %v", err)
	}
	defer listener.Close()

	server := httpapi.NewServerWithOptions(adapter, token, httpapi.ServerOptions{
		ConfigBackups: configBackups,
		ManagerUpdate: managerUpdater,
	})

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logManagerListening(listener.Addr().String())
	log.Printf("本地管理令牌只通过 URL fragment 传递，不进入 HTTP 请求，不接受局域网请求")
	if err := startPlatformTray(ctx, stop, managerPageURL(listener.Addr().String(), token), mode == managerStartupInteractive); err != nil {
		log.Printf("系统托盘暂不可用")
	}
	if mode == managerStartupGateway {
		go func() {
			if launchErr := superviseAutostartGateway(ctx, adapter); launchErr != nil && !errors.Is(launchErr, context.Canceled) {
				log.Printf("Gateway 自动启动失败")
			}
		}()
	}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("管家服务退出: %v", err)
	}
}

func resolveNativeOpenClawStateDir(
	getenv func(string) string,
	userHomeDir func() (string, error),
) (string, error) {
	if getenv == nil || userHomeDir == nil {
		return "", errors.New("OpenClaw 状态目录解析不可用")
	}
	home, err := resolveOpenClawHome(getenv, userHomeDir)
	if err != nil {
		return "", err
	}
	if configured := strings.TrimSpace(getenv("OPENCLAW_STATE_DIR")); configured != "" {
		resolved, resolveErr := resolveOpenClawPath(configured, home)
		if resolveErr != nil {
			return "", errors.New("OPENCLAW_STATE_DIR 必须是绝对路径或用户目录路径")
		}
		return resolved, nil
	}
	return filepath.Join(home, ".openclaw"), nil
}

func resolveOpenClawHome(getenv func(string) string, userHomeDir func() (string, error)) (string, error) {
	raw := strings.TrimSpace(getenv("OPENCLAW_HOME"))
	if raw == "" {
		resolved, err := userHomeDir()
		if err != nil || strings.TrimSpace(resolved) == "" {
			return "", errors.New("无法确定 OpenClaw 用户目录")
		}
		raw = resolved
	} else if raw == "~" || strings.HasPrefix(raw, "~/") || strings.HasPrefix(raw, "~\\") {
		base, err := userHomeDir()
		if err != nil || strings.TrimSpace(base) == "" {
			return "", errors.New("无法确定 OpenClaw 用户目录")
		}
		raw = filepath.Join(base, strings.TrimLeft(raw[1:], `/\\`))
	}
	if !filepath.IsAbs(raw) {
		return "", errors.New("OPENCLAW_HOME 必须是绝对路径")
	}
	return filepath.Clean(raw), nil
}

func resolveOpenClawPath(raw, home string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "~" || strings.HasPrefix(value, "~/") || strings.HasPrefix(value, "~\\") {
		value = filepath.Join(home, strings.TrimLeft(value[1:], `/\\`))
	}
	if !filepath.IsAbs(value) {
		return "", errors.New("path is not absolute")
	}
	return filepath.Clean(value), nil
}

// logManagerListening deliberately does not accept the management token. The
// token is a bearer secret and must never be copied into process logs, which
// may be collected by a host or desktop runtime outside the manager's trust
// boundary.
func logManagerListening(addr string) {
	log.Printf("LongHub Manager listening on http://%s/", addr)
}

// newConfigBackupManager resolves the user's native OpenClaw config.  These
// values are read once at startup; no HTTP request can select an arbitrary
// path. OPENCLAW_CONFIG_PATH wins, then OPENCLAW_STATE_DIR, then the upstream
// default under the current user's home directory.
func newConfigBackupManager(
	getenv func(string) string,
	userHomeDir func() (string, error),
	userConfigDir func() (string, error),
) (*configbackup.Manager, error) {
	configPath := strings.TrimSpace(getenv("OPENCLAW_CONFIG_PATH"))
	if configPath == "" {
		stateDir, err := resolveNativeOpenClawStateDir(getenv, userHomeDir)
		if err != nil {
			return nil, errors.New("无法确定当前 OpenClaw 状态目录")
		}
		configPath = filepath.Join(stateDir, "openclaw.json")
	} else if !filepath.IsAbs(configPath) {
		return nil, errors.New("OPENCLAW_CONFIG_PATH 必须是绝对路径")
	}
	configDir, err := userConfigDir()
	if err != nil || strings.TrimSpace(configDir) == "" {
		return nil, errors.New("无法确定 LongHub Manager 配置目录")
	}
	if !filepath.IsAbs(configDir) {
		return nil, errors.New("用户配置目录必须是绝对路径")
	}
	return configbackup.New(configPath, filepath.Join(configDir, "LongHub", "backups"))
}

func startupToken() (string, error) {
	if supplied := os.Getenv("LONGHUB_MANAGER_TOKEN"); supplied != "" {
		if len(supplied) < 32 || len(supplied) > 128 {
			return "", errors.New("LONGHUB_MANAGER_TOKEN 必须为 32—128 个字符")
		}
		for _, r := range supplied {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
				(r >= '0' && r <= '9') || r == '_' || r == '-') {
				return "", errors.New("LONGHUB_MANAGER_TOKEN 只能包含 URL 安全字符")
			}
		}
		return supplied, nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func envPort(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < 1 || value > 65535 {
		return fallback
	}
	return value
}
