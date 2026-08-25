package managerupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var (
	ErrUpdateUnavailable = errors.New("manager update is unavailable")
	ErrDownloadInvalid   = errors.New("manager update download is invalid")
	ErrUnsafeUpdatePath  = errors.New("manager update path is unsafe")
)

type Candidate struct {
	Envelope  Envelope
	Available bool
	Eligible  bool
}

type Client struct {
	baseURL     *url.URL
	trustedKeys map[string]ed25519.PublicKey
	httpClient  *http.Client
}

func NewClient(baseURL string, trustedKeys map[string]ed25519.PublicKey, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, ErrUpdateUnavailable
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopbackHost(parsed.Hostname())) {
		return nil, ErrUpdateUnavailable
	}
	if len(trustedKeys) == 0 {
		return nil, ErrUpdateUnavailable
	}
	keys := make(map[string]ed25519.PublicKey, len(trustedKeys))
	for keyID, key := range trustedKeys {
		if !keyIDPattern.MatchString(keyID) || len(key) != ed25519.PublicKeySize {
			return nil, ErrUpdateUnavailable
		}
		keys[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	clone := *httpClient
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{baseURL: parsed, trustedKeys: keys, httpClient: &clone}, nil
}

func (client *Client) Check(
	ctx context.Context,
	currentVersion string,
	channel string,
	identity string,
) (Candidate, error) {
	if client == nil || (channel != "stable" && channel != "beta") || !versionPattern.MatchString(currentVersion) {
		return Candidate{}, ErrUpdateUnavailable
	}
	envelope, found, err := client.fetchEnvelope(ctx, "/v1/client-releases/latest", channel)
	if err != nil {
		return Candidate{}, err
	}
	if !found {
		return Candidate{}, nil
	}
	comparison, err := CompareVersions(envelope.Manifest.Version, currentVersion)
	if err != nil || envelope.Manifest.Channel != channel {
		return Candidate{}, ErrMetadataInvalid
	}
	eligible, err := RolloutEligible(envelope.Manifest.Rollout, identity)
	if err != nil {
		return Candidate{}, err
	}
	return Candidate{Envelope: envelope, Available: comparison > 0, Eligible: comparison > 0 && eligible}, nil
}

// Exact returns signed metadata for the installed version so the retained
// recovery installer can be re-verified immediately before an update.
func (client *Client) Exact(ctx context.Context, version, channel string) (Envelope, error) {
	if client == nil || !versionPattern.MatchString(version) || (channel != "stable" && channel != "beta") {
		return Envelope{}, ErrUpdateUnavailable
	}
	envelope, found, err := client.fetchEnvelope(
		ctx,
		"/v1/client-releases/versions/"+url.PathEscape(version),
		channel,
	)
	if err != nil {
		return Envelope{}, err
	}
	if !found || envelope.Manifest.Version != version || envelope.Manifest.Channel != channel {
		return Envelope{}, ErrUpdateUnavailable
	}
	return envelope, nil
}

func (client *Client) fetchEnvelope(ctx context.Context, path, channel string) (Envelope, bool, error) {
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	query := endpoint.Query()
	query.Set("channel", channel)
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return Envelope{}, false, ErrUpdateUnavailable
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return Envelope{}, false, ErrUpdateUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return Envelope{}, false, nil
	}
	if response.StatusCode != http.StatusOK || response.ContentLength > 256*1024 {
		return Envelope{}, false, ErrUpdateUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(body) > 256*1024 {
		return Envelope{}, false, ErrUpdateUnavailable
	}
	var wrapper struct {
		Release json.RawMessage `json:"release"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wrapper); err != nil || len(wrapper.Release) == 0 {
		return Envelope{}, false, ErrUpdateUnavailable
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Envelope{}, false, ErrUpdateUnavailable
	}
	if string(wrapper.Release) == "null" {
		return Envelope{}, false, nil
	}
	envelope, err := ParseAndVerify(wrapper.Release, client.trustedKeys)
	if err != nil {
		return Envelope{}, false, err
	}
	return envelope, true, nil
}

func (client *Client) Download(ctx context.Context, candidate Candidate, root string) (string, error) {
	if client == nil || !candidate.Available || !candidate.Eligible {
		return "", ErrUpdateUnavailable
	}
	if err := ValidateManifest(candidate.Envelope.Manifest); err != nil {
		return "", err
	}
	root, err := preparePrivateRoot(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(root, candidate.Envelope.Manifest.Filename)
	if existing, verifyErr := verifyInstaller(target, candidate.Envelope.Manifest); verifyErr == nil && existing {
		return target, nil
	}
	if _, statErr := os.Lstat(target); statErr == nil {
		return "", ErrUnsafeUpdatePath
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", ErrUnsafeUpdatePath
	}
	endpoint := *client.baseURL
	endpoint.Path = candidate.Envelope.Manifest.URLPath
	endpoint.RawPath = ""
	endpoint.RawQuery = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", ErrUpdateUnavailable
	}
	request.Header.Set("Accept", "application/octet-stream, application/x-msdownload")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return "", ErrUpdateUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > MaxInstallerBytes ||
		response.ContentLength >= 0 && response.ContentLength != candidate.Envelope.Manifest.Size {
		return "", ErrDownloadInvalid
	}
	temporary, err := os.CreateTemp(root, ".manager-update-*.tmp")
	if err != nil {
		return "", ErrUnsafeUpdatePath
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	defer cleanup()
	if err := temporary.Chmod(0o600); err != nil {
		return "", ErrUnsafeUpdatePath
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, MaxInstallerBytes+1))
	if copyErr != nil || written != candidate.Envelope.Manifest.Size || written > MaxInstallerBytes ||
		hex.EncodeToString(hash.Sum(nil)) != candidate.Envelope.Manifest.SHA256 {
		return "", ErrDownloadInvalid
	}
	if err := temporary.Sync(); err != nil {
		return "", ErrDownloadInvalid
	}
	if err := temporary.Close(); err != nil {
		return "", ErrDownloadInvalid
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return "", ErrUnsafeUpdatePath
	}
	return target, nil
}

func preparePrivateRoot(root string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", ErrUnsafeUpdatePath
	}
	root = filepath.Clean(root)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", ErrUnsafeUpdatePath
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", ErrUnsafeUpdatePath
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", ErrUnsafeUpdatePath
	}
	return root, nil
}

func verifyInstaller(path string, manifest Manifest) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != manifest.Size {
		return false, ErrDownloadInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return false, ErrDownloadInvalid
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, MaxInstallerBytes+1))
	if err != nil || written != manifest.Size || hex.EncodeToString(hash.Sum(nil)) != manifest.SHA256 {
		return false, ErrDownloadInvalid
	}
	return true, nil
}

func VerifyInstaller(path string, manifest Manifest) error {
	verified, err := verifyInstaller(path, manifest)
	if err != nil || !verified {
		return ErrDownloadInvalid
	}
	return nil
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func contentLengthHeader(value int64) string { return strconv.FormatInt(value, 10) }

func candidateSummary(candidate Candidate) string {
	if !candidate.Available {
		return "current"
	}
	return fmt.Sprintf("%s:%t", candidate.Envelope.Manifest.Version, candidate.Eligible)
}
