package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Ports struct{ Codex, Control, Claude int }
type Options struct {
	Home, CodexHome, Executable, AppPath, Version, ControlToken string
	Ports                                                       Ports
	Desktop                                                     bool
	Client                                                      *http.Client
	NativeCatalog                                               func(context.Context, string) ([]object, error)
	Startup                                                     func(bool) error
	ReadEnvironment                                             func(string) (*string, error)
	WriteEnvironment                                            func(string, *string) error
}
type Settings struct {
	StartAtLogin bool `json:"startAtLogin"`
	CloseToTray  bool `json:"closeToTray"`
}
type session struct {
	Token    string `json:"github_token"`
	Username string `json:"username"`
	Codex    bool   `json:"codexEnabled"`
	Claude   bool   `json:"claudeEnabled"`
	Method   string `json:"authMethod"`
}
type App struct {
	options                       Options
	mu                            sync.RWMutex
	actions, tokenMu, discoveryMu sync.Mutex
	state                         session
	bearer                        string
	expiry                        float64
	settings                      Settings
	settingsError, lastError      string
	usage                         object
	usageAt                       time.Time
	rawModels                     []object
	rawAt                         time.Time
	accountGeneration             uint64
	lastEffort                    object
	appearance                    string
	models                        *modelRegistry
	client                        *http.Client
	ctx                           context.Context
	cancel                        context.CancelFunc
	servers                       []*http.Server
	wg                            sync.WaitGroup
	stopOnce                      sync.Once
	stopError                     error
	watchOnce                     sync.Once
	closed                        chan struct{}
}

func New(options Options) (*App, error) {
	if options.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		options.Home = home
	}
	if options.CodexHome == "" {
		options.CodexHome = os.Getenv("CODEX_HOME")
		if options.CodexHome == "" {
			options.CodexHome = filepath.Join(options.Home, ".codex")
		}
	}
	if options.Ports == (Ports{}) {
		options.Ports = Ports{18921, 18922, 18923}
	}
	if options.ControlToken == "" {
		options.ControlToken = rand.Text()
	}
	if options.Client == nil {
		options.Client = newHTTPClient()
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{options: options, ctx: ctx, cancel: cancel, client: options.Client, settings: Settings{true, true}, appearance: "system", closed: make(chan struct{})}
	a.models = newModelRegistry(a)
	data, err := readOptional(a.path("settings.json"))
	if err == nil && data != nil {
		var patch object
		if err = json.Unmarshal(data, &patch); err == nil {
			a.settings, err = patchSettings(a.settings, patch)
		}
	}
	if err != nil {
		a.settingsError = err.Error()
		a.report(err)
	}
	data, err = readOptional(a.path("appearance.json"))
	if err == nil && data != nil {
		var value string
		if err = json.Unmarshal(data, &value); err == nil && contains([]string{"system", "light", "dark"}, value) {
			a.appearance = value
		}
	}
	if err != nil {
		a.report(err)
	}
	return a, nil
}
func (a *App) ControlToken() string    { return a.options.ControlToken }
func (a *App) ControlURL() string      { return fmt.Sprintf("http://127.0.0.1:%d", a.options.Ports.Control) }
func (a *App) Closed() <-chan struct{} { return a.closed }
func (a *App) path(name string) string { return filepath.Join(a.options.Home, ".kobashi", name) }
func (a *App) report(err error) {
	if err == nil {
		return
	}
	log.Printf("Kobashi: %v", err)
	a.mu.Lock()
	a.lastError = err.Error()
	a.mu.Unlock()
}
func (a *App) Start() error {
	handlers := []http.Handler{http.HandlerFunc(a.codex), http.HandlerFunc(a.control), http.HandlerFunc(a.claude)}
	ports := []int{a.options.Ports.Codex, a.options.Ports.Control, a.options.Ports.Claude}
	listeners := []net.Listener{}
	for _, port := range ports {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			for _, l := range listeners {
				l.Close()
			}
			return fmt.Errorf("port %d is already in use; quit the existing Kobashi yourself before switching versions: %w", port, err)
		}
		listeners = append(listeners, listener)
	}
	for i, handler := range handlers {
		server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second,
			BaseContext: func(net.Listener) context.Context { return a.ctx }}
		a.servers = append(a.servers, server)
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			if err := server.Serve(listeners[i]); err != nil && !errors.Is(err, http.ErrServerClosed) {
				a.report(err)
			}
		}()
	}
	a.wg.Add(1)
	go func() { defer a.wg.Done(); a.initialize() }()
	return nil
}
func (a *App) initialize() {
	a.actions.Lock()
	defer a.actions.Unlock()
	if a.ctx.Err() != nil {
		return
	}
	var err error
	if a.options.Desktop && a.settingsError == "" {
		settings := a.Settings()
		if err = a.configureStartup(settings.StartAtLogin); err == nil {
			err = writeJSON(a.path("settings.json"), settings)
		}
		if err != nil {
			a.report(err)
			a.mu.Lock()
			a.settingsError = err.Error()
			a.mu.Unlock()
		}
	}
	legacy := filepath.Join(a.options.Home, ".codex", "ccb-session.json")
	data, err := readOptional(a.path("session.json"))
	if err == nil && data == nil {
		data, err = readOptional(legacy)
		if err == nil && data != nil {
			err = writeAtomic(a.path("session.json"), data)
			if err == nil {
				err = removeOptional(legacy)
			}
		}
	}
	if err != nil {
		a.report(err)
		return
	}
	if data == nil {
		return
	}
	var saved session
	if err = json.Unmarshal(data, &saved); err != nil {
		a.report(err)
		return
	}
	if saved.Token == "" {
		return
	}
	var fields object
	_ = json.Unmarshal(data, &fields)
	if _, ok := fields["codexEnabled"]; !ok {
		saved.Codex = fields["bridgeEnabled"] != false
	}
	if saved.Method != "token" {
		saved.Method = "device"
	}
	a.mu.Lock()
	a.state = saved
	a.mu.Unlock()
	a.models.setAccount(saved.Token)
	if saved.Codex {
		if err = a.injectCodex(); err != nil {
			a.report(err)
		}
	}
	if saved.Claude {
		if err = a.injectClaude(); err != nil {
			a.report(err)
		}
	}
	a.startWatcher()
}
func (a *App) configureStartup(enabled bool) error {
	if a.options.Startup != nil {
		return a.options.Startup(enabled)
	}
	return configureStartup(a.options, enabled)
}
func patchSettings(previous Settings, patch object) (Settings, error) {
	if patch == nil {
		return previous, errors.New("settings must be a JSON object")
	}
	next := previous
	for key, value := range patch {
		b, ok := value.(bool)
		if !ok {
			return previous, fmt.Errorf("%s must be a boolean", key)
		}
		switch key {
		case "startAtLogin":
			next.StartAtLogin = b
		case "closeToTray":
			next.CloseToTray = b
		default:
			return previous, fmt.Errorf("unknown setting: %s", key)
		}
	}
	return next, nil
}
func (a *App) saveSettings(patch object) error {
	a.mu.RLock()
	previous := a.settings
	retry := a.settingsError != ""
	a.mu.RUnlock()
	next, err := patchSettings(previous, patch)
	if err != nil {
		return err
	}
	change := next.StartAtLogin != previous.StartAtLogin || retry
	if change && a.options.Desktop {
		if err = a.configureStartup(next.StartAtLogin); err != nil {
			return err
		}
	}
	if err = writeJSON(a.path("settings.json"), next); err != nil {
		if change && a.options.Desktop {
			a.report(a.configureStartup(previous.StartAtLogin))
		}
		return err
	}
	a.mu.Lock()
	a.settings = next
	a.settingsError = ""
	a.mu.Unlock()
	return nil
}
func (a *App) Settings() Settings { a.mu.RLock(); defer a.mu.RUnlock(); return a.settings }
func (a *App) Stop() error {
	var result error
	a.stopOnce.Do(func() {
		a.cancel()
		a.models.pause()
		a.actions.Lock()
		a.actions.Unlock()
		for _, server := range a.servers {
			if err := server.Close(); err != nil {
				result = errors.Join(result, err)
			}
		}
		a.wg.Wait()
		a.models.wg.Wait()
		a.actions.Lock()
		a.mu.RLock()
		state := a.state
		a.mu.RUnlock()
		if state.Codex {
			result = errors.Join(result, a.restoreCodex())
		}
		if state.Claude {
			result = errors.Join(result, a.restoreClaude())
		}
		a.actions.Unlock()
		a.stopError = result
		a.report(result)
		close(a.closed)
	})
	return a.stopError
}
func (a *App) snapshot() session  { a.mu.RLock(); defer a.mu.RUnlock(); return a.state }
func (a *App) saveSession() error { return writeJSON(a.path("session.json"), a.snapshot()) }
func (a *App) disconnect() error {
	state := a.snapshot()
	var err error
	if state.Codex {
		err = errors.Join(err, a.restoreCodex())
	}
	if state.Claude {
		err = errors.Join(err, a.restoreClaude())
	}
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.state = session{Method: state.Method}
	a.bearer = ""
	a.expiry = 0
	a.rawModels = nil
	a.usage = nil
	a.lastEffort = nil
	a.accountGeneration++
	a.mu.Unlock()
	a.models.setAccount("")
	return errors.Join(removeOptional(a.path("session.json")), removeOptional(filepath.Join(a.options.Home, ".codex", "ccb-session.json")))
}
func headers(token string) http.Header {
	h := http.Header{"Content-Type": {"application/json"}, "Accept": {"application/json"}, "User-Agent": {"GitHubCopilotChat/0.38.2"},
		"Editor-Version": {"vscode/1.110.1"}, "Editor-Plugin-Version": {"copilot-chat/0.38.2"},
		"Copilot-Integration-Id": {"vscode-chat"}, "X-Github-Api-Version": {"2025-10-01"}}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	return h
}
func (a *App) request(ctx context.Context, method, address string, body []byte, h http.Header) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header = h.Clone()
	return a.client.Do(request)
}
func readResponse(response *http.Response, limit int64) ([]byte, error) {
	defer response.Body.Close()
	b, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = errors.New("upstream response exceeds limit")
	}
	return b, err
}
func (a *App) github(ctx context.Context, path, token string) (int, object, error) {
	h := headers("")
	h.Set("X-GitHub-Api-Version", "2022-11-28")
	h.Set("Authorization", "token "+token)
	response, err := a.request(ctx, "GET", "https://api.github.com"+path, nil, h)
	if err != nil {
		return 0, nil, err
	}
	status := response.StatusCode
	b, err := readResponse(response, 4<<20)
	if err != nil {
		return status, nil, err
	}
	var value object
	if err = json.Unmarshal(b, &value); err != nil {
		return status, nil, fmt.Errorf("GitHub returned invalid JSON (%d)", status)
	}
	return status, value, nil
}
func (a *App) ensureToken(ctx context.Context) (string, error) {
	a.tokenMu.Lock()
	defer a.tokenMu.Unlock()
	a.mu.RLock()
	account, gen, bearer, expiry := a.state.Token, a.accountGeneration, a.bearer, a.expiry
	a.mu.RUnlock()
	if account == "" {
		return "", errors.New("GitHub account is not connected")
	}
	if bearer != "" && float64(time.Now().Unix()) < expiry-120 {
		return bearer, nil
	}
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	status, value, err := a.github(bounded, "/copilot_internal/v2/token", account)
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if gen != a.accountGeneration || account != a.state.Token {
		return "", errors.New("GitHub account changed during token refresh")
	}
	if status != 200 || str(value["token"]) == "" {
		a.bearer = ""
		a.expiry = 0
		if status == 401 || status == 403 {
			// The action queue restores configs; it cannot run while holding the token lock.
			go func() {
				a.actions.Lock()
				defer a.actions.Unlock()
				a.mu.RLock()
				same := a.accountGeneration == gen && a.state.Token == account
				a.mu.RUnlock()
				if same && a.ctx.Err() == nil {
					a.report(a.disconnect())
				}
			}()
		}
		return "", fmt.Errorf("Copilot token rejected (%d)", status)
	}
	a.bearer = str(value["token"])
	a.expiry = number(value["expires_at"])
	return a.bearer, nil
}
func (a *App) invalidateToken(token string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.bearer == token {
		a.bearer = ""
		a.expiry = 0
	}
}
func (a *App) validateToken(ctx context.Context, token, method string) (object, error) {
	bounded, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	status, who, err := a.github(bounded, "/user", token)
	if err != nil {
		return object{"ok": false, "reason": "network"}, err
	}
	if status == 401 {
		return object{"ok": false, "reason": "invalid_token"}, nil
	}
	if status != 200 || str(who["login"]) == "" {
		return object{"ok": false, "reason": "github_error"}, fmt.Errorf("GitHub returned %d", status)
	}
	status, value, err := a.github(bounded, "/copilot_internal/v2/token", token)
	if err != nil {
		return object{"ok": false, "reason": "network"}, err
	}
	if status == 401 || status == 403 {
		return object{"ok": false, "reason": "no_copilot", "login": who["login"]}, nil
	}
	if status != 200 || str(value["token"]) == "" {
		return object{"ok": false, "reason": "github_error"}, fmt.Errorf("Copilot returned %d", status)
	}
	a.models.pause()
	a.mu.Lock()
	a.state = session{token, str(who["login"]), true, true, method}
	a.bearer = str(value["token"])
	a.expiry = number(value["expires_at"])
	a.rawModels = nil
	a.rawAt = time.Time{}
	a.usage = nil
	a.usageAt = time.Time{}
	a.accountGeneration++
	a.mu.Unlock()
	a.models.setAccount(token)
	if err = a.saveSession(); err != nil {
		return nil, err
	}
	if err = a.injectCodex(); err != nil {
		return nil, err
	}
	if err = a.injectClaude(); err != nil {
		return nil, err
	}
	return object{"ok": true, "username": who["login"]}, nil
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("Response write: %v", err)
	}
}
func (a *App) control(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Kobashi-Native", "1")
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(token), []byte(a.options.ControlToken)) != 1 {
		respond(w, 401, object{"error": "Native app authorization required"})
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != a.ControlURL() {
		respond(w, 403, object{"error": "Foreign origin rejected"})
		return
	}
	if r.Method == "GET" {
		switch r.URL.Path {
		case "/api/settings":
			a.mu.RLock()
			settings, errText := a.settings, a.settingsError
			a.mu.RUnlock()
			respond(w, 200, object{"startAtLogin": settings.StartAtLogin, "closeToTray": settings.CloseToTray, "error": errText})
		case "/api/status":
			a.mu.RLock()
			s := a.state
			status := object{"connected": s.Token != "", "username": s.Username, "authMethod": s.Method, "codexEnabled": s.Codex, "claudeEnabled": s.Claude,
				"version": a.options.Version, "error": a.lastError, "lastEffort": a.lastEffort, "usage": a.usage, "appearance": a.appearance}
			a.mu.RUnlock()
			status["codexModels"] = a.models.status()
			respond(w, 200, status)
		default:
			respond(w, 404, object{"error": "Not found"})
		}
		return
	}
	if r.Method != "POST" {
		respond(w, 405, object{"error": "POST required"})
		return
	}
	if r.URL.Path == "/api/quit" {
		respond(w, 200, object{"ok": true})
		if flush, ok := w.(http.Flusher); ok {
			flush.Flush()
		}
		go a.Stop()
		return
	}
	a.actions.Lock()
	defer a.actions.Unlock()
	if a.ctx.Err() != nil {
		respond(w, 503, object{"error": "Kobashi is shutting down"})
		return
	}
	var result any = object{"ok": true}
	var err error
	switch r.URL.Path {
	case "/api/appearance":
		var value object
		value, err = readObject(r.Body, 4096)
		if err == nil {
			mode := str(value["appearance"])
			if !contains([]string{"system", "light", "dark"}, mode) {
				err = errors.New("invalid appearance")
			} else {
				err = writeJSON(a.path("appearance.json"), mode)
				if err == nil {
					a.mu.Lock()
					a.appearance = mode
					a.mu.Unlock()
					result = object{"appearance": mode}
				}
			}
		}
	case "/api/settings":
		var patch object
		patch, err = readObject(r.Body, 4096)
		if err == nil {
			err = a.saveSettings(patch)
		}
		if err != nil {
			a.mu.Lock()
			a.settingsError = err.Error()
			a.mu.Unlock()
		}
		result = a.Settings()
	case "/api/token-login":
		var body object
		body, err = readObject(r.Body, 8192)
		if err == nil {
			token := strings.TrimSpace(str(body["token"]))
			if token == "" {
				result = object{"ok": false, "reason": "invalid_token"}
			} else {
				result, err = a.validateToken(r.Context(), token, "token")
			}
		}
	case "/api/start":
		result, err = a.device(r.Context(), "/login/device/code", "client_id=Iv1.b507a08c87ecfe98&scope=read%3Auser")
	case "/api/poll":
		var body, value object
		body, err = readObject(r.Body, 8192)
		if err == nil {
			value, err = a.device(r.Context(), "/login/oauth/access_token", "client_id=Iv1.b507a08c87ecfe98&device_code="+urlEncode(str(body["device_code"]))+"&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
		}
		if err == nil {
			if token := str(value["access_token"]); token != "" {
				result, err = a.validateToken(r.Context(), token, "device")
			} else {
				result = object{"pending": true, "error": value["error"]}
			}
		}
	case "/api/toggle-codex", "/api/toggle-claude":
		state := a.snapshot()
		if state.Token == "" {
			err = errors.New("not connected")
			break
		}
		codex := r.URL.Path == "/api/toggle-codex"
		enabled := !state.Claude
		if codex {
			enabled = !state.Codex
		}
		a.mu.Lock()
		if codex {
			a.state.Codex = enabled
		} else {
			a.state.Claude = enabled
		}
		a.mu.Unlock()
		if codex {
			if enabled {
				err = a.injectCodex()
			} else {
				err = a.restoreCodex()
			}
		} else {
			if enabled {
				err = a.injectClaude()
			} else {
				err = a.restoreClaude()
			}
		}
		if err != nil {
			a.mu.Lock()
			if codex {
				a.state.Codex = state.Codex
			} else {
				a.state.Claude = state.Claude
			}
			a.mu.Unlock()
		} else {
			err = a.saveSession()
		}
		result = object{"codexEnabled": a.snapshot().Codex, "claudeEnabled": a.snapshot().Claude}
	case "/api/disconnect":
		err = a.disconnect()
	default:
		respond(w, 404, object{"error": "Not found"})
		return
	}
	if err != nil {
		a.report(err)
		respond(w, 400, object{"error": err.Error()})
		return
	}
	a.mu.Lock()
	a.lastError = ""
	a.mu.Unlock()
	respond(w, 200, result)
}
func (a *App) device(ctx context.Context, path, body string) (object, error) {
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	h := headers("")
	h.Set("Content-Type", "application/x-www-form-urlencoded")
	r, err := a.request(bounded, "POST", "https://github.com"+path, []byte(body), h)
	if err != nil {
		return nil, err
	}
	b, err := readResponse(r, 1<<20)
	if err != nil {
		return nil, err
	}
	var value object
	if err = json.Unmarshal(b, &value); err != nil {
		return nil, err
	}
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub device flow returned %d", r.StatusCode)
	}
	return value, nil
}
func urlEncode(value string) string { return url.QueryEscape(value) }
