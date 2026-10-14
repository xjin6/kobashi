package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body any) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(jsonBytes(body)))}
}
func testApp(t *testing.T, transport roundTripFunc) *App {
	t.Helper()
	var mu sync.Mutex
	env := map[string]string{}
	home := t.TempDir()
	a, err := New(Options{Home: home, CodexHome: filepath.Join(home, ".codex"), Client: &http.Client{Transport: transport}, Startup: func(bool) error { return nil },
		ReadEnvironment: func(key string) (*string, error) {
			mu.Lock()
			defer mu.Unlock()
			v, ok := env[key]
			if !ok {
				return nil, nil
			}
			return &v, nil
		},
		WriteEnvironment: func(key string, v *string) error {
			mu.Lock()
			defer mu.Unlock()
			if v == nil {
				delete(env, key)
			} else {
				env[key] = *v
			}
			return nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Stop(); err != nil {
			t.Error(err)
		}
	})
	return a
}
func controlCall(a *App, path string, body object) *httptest.ResponseRecorder {
	method := "GET"
	if body != nil {
		method = "POST"
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(jsonBytes(body)))
	r.Header.Set("Authorization", "Bearer "+a.ControlToken())
	w := httptest.NewRecorder()
	a.control(w, r)
	return w
}
func TestNativeSettingsDefaultsPersistenceAndRollback(t *testing.T) {
	a := testApp(t, func(*http.Request) (*http.Response, error) { return nil, errors.New("network must not be used") })
	if a.Settings() != (Settings{true, true}) {
		t.Fatal(a.Settings())
	}
	if r := controlCall(a, "/api/settings", object{"startAtLogin": false}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	if a.Settings() != (Settings{false, true}) {
		t.Fatal(a.Settings())
	}
	reloaded, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	if reloaded.Settings() != a.Settings() {
		t.Fatal("settings not persisted")
	}
	for _, patch := range []object{{"unknown": true}, {"closeToTray": "yes"}} {
		if r := controlCall(a, "/api/settings", patch); r.Code != 400 {
			t.Fatalf("invalid settings accepted: %s", r.Body.String())
		}
	}
	a.options.Desktop = true
	calls := []bool{}
	a.options.Startup = func(v bool) error { calls = append(calls, v); return nil }
	path := a.path("settings.json")
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if r := controlCall(a, "/api/settings", object{"startAtLogin": true}); r.Code != 400 {
		t.Fatal("save failure was hidden")
	}
	if len(calls) != 2 || !calls[0] || calls[1] {
		t.Fatal("startup was not rolled back", calls)
	}
	if a.Settings().StartAtLogin {
		t.Fatal("failed save changed live settings")
	}
}
func TestControlRejectsUnauthenticatedAndForeignOrigin(t *testing.T) {
	a := testApp(t, nil)
	r := httptest.NewRequest("POST", "/api/settings", strings.NewReader(`{"closeToTray":false}`))
	w := httptest.NewRecorder()
	a.control(w, r)
	if w.Code != 401 || !a.Settings().CloseToTray {
		t.Fatal("unauthorized mutation")
	}
	r.Header.Set("Authorization", "Bearer "+a.ControlToken())
	r.Header.Set("Origin", "https://untrusted.invalid")
	w = httptest.NewRecorder()
	a.control(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestFailedTokenPastePreservesWorkingAccount(t *testing.T) {
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		return response(401, object{"message": "Bad credentials"}), nil
	})
	a.state = session{Token: "working-account", Username: "working-user", Method: "device"}
	r := controlCall(a, "/api/token-login", object{"token": "invalid"})
	if r.Code != 200 || !strings.Contains(r.Body.String(), "invalid_token") {
		t.Fatal(r.Body.String())
	}
	if a.snapshot().Token != "working-account" || a.snapshot().Username != "working-user" {
		t.Fatal("failed paste changed session")
	}
}
func TestLoginUsesSupportedGitHubAPIVersion(t *testing.T) {
	for _, method := range []string{"device", "token"} {
		t.Run(method, func(t *testing.T) {
			a := testApp(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "github.com" && r.URL.Path == "/login/oauth/access_token" {
					return response(200, object{"access_token": "candidate"}), nil
				}
				if r.URL.Host == "api.githubcopilot.com" && r.URL.Path == "/models" {
					if r.Header.Get("X-GitHub-Api-Version") != "2025-10-01" {
						t.Fatal("GitHub login changed the Copilot API version")
					}
					return response(200, object{"data": []any{}}), nil
				}
				if r.URL.Host != "api.github.com" {
					t.Fatalf("unexpected login request: %s", r.URL)
				}
				if r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
					return response(400, object{"message": "Unsupported API version"}), nil
				}
				if r.Header.Get("Authorization") != "token candidate" {
					t.Fatal("candidate GitHub token was not sent")
				}
				switch r.URL.Path {
				case "/user":
					return response(200, object{"login": "valid-user"}), nil
				case "/copilot_internal/v2/token":
					return response(200, object{"token": "copilot-bearer", "expires_at": time.Now().Add(time.Hour).Unix()}), nil
				default:
					t.Fatalf("unexpected GitHub login endpoint: %s", r.URL.Path)
					return nil, errors.New("unexpected GitHub login endpoint")
				}
			})
			path, body := "/api/token-login", object{"token": "candidate"}
			if method == "device" {
				path, body = "/api/poll", object{"device_code": "test-device-code"}
			}
			r := controlCall(a, path, body)
			if r.Code != 200 || !strings.Contains(r.Body.String(), `"ok":true`) {
				t.Fatalf("login failed: %d %s", r.Code, r.Body.String())
			}
			if state := a.snapshot(); state.Token != "candidate" || state.Username != "valid-user" || state.Method != method {
				t.Fatal("successful login did not persist the account", state.Username, state.Method)
			}
			if headers("copilot-bearer").Get("X-GitHub-Api-Version") != "2025-10-01" {
				t.Fatal("GitHub API version changed the Copilot inference contract")
			}
		})
	}
}
func TestCandidateEntitlementAndTokenRefreshAccountIsolation(t *testing.T) {
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/user" {
			return response(200, object{"login": "valid-user"}), nil
		}
		return response(403, object{"message": "No entitlement"}), nil
	})
	value, err := a.validateToken(context.Background(), "candidate", "token")
	if err != nil || value["reason"] != "no_copilot" || a.snapshot().Token != "" {
		t.Fatal(value, err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	a.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return response(200, object{"token": "old-account-bearer", "expires_at": time.Now().Add(time.Hour).Unix()}), nil
	})}
	a.state.Token = "old"
	result := make(chan error, 1)
	go func() { _, err := a.ensureToken(context.Background()); result <- err }()
	<-entered
	a.mu.Lock()
	a.state.Token = "new"
	a.accountGeneration++
	a.bearer = "new-account-bearer"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.mu.Unlock()
	close(release)
	if err := <-result; err == nil {
		t.Fatal("late token refresh accepted")
	}
	if a.bearer != "new-account-bearer" {
		t.Fatal("late token overwrote new account")
	}
}
func TestCodexTransportAuthAndCompatibilityRetry(t *testing.T) {
	var calls int
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			return response(200, object{"token": "fresh", "expires_at": time.Now().Add(time.Hour).Unix()}), nil
		}
		calls++
		if calls == 1 {
			return response(401, object{"error": object{"message": "Expired"}}), nil
		}
		var body object
		_ = json.NewDecoder(r.Body).Decode(&body)
		if calls == 2 {
			return response(400, object{"error": object{"message": "Unsupported value: 'all_turns'. Supported values are: 'current_turn'.", "param": "reasoning.context"}}), nil
		}
		if nested(body, "reasoning", "context") != "current_turn" || body["model"] != "gpt-test" || str(body["input"]) != "unchanged" {
			t.Errorf("incorrect repair: %v", body)
		}
		result := response(200, nil)
		result.Header.Set("Content-Type", "text/event-stream")
		result.Body = io.NopCloser(strings.NewReader("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[]}}\n\n"))
		return result, nil
	})
	a.state = session{Token: "account", Codex: true}
	a.bearer = "expired"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.models.sessionStarted = true
	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-test","input":"unchanged","reasoning":{"context":"all_turns"},"stream":true}`))
	w := httptest.NewRecorder()
	a.codex(w, r)
	if calls != 3 || w.Code != 200 || !strings.Contains(w.Body.String(), "response.completed") {
		t.Fatal(calls, w.Code, w.Body.String())
	}
}
func TestNonAuth400NeverRefreshesOrChangesInvalidJSON(t *testing.T) {
	calls := 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host == "api.github.com" {
			t.Fatal("unexpected authentication retry")
		}
		data, _ := io.ReadAll(r.Body)
		if string(data) != "{invalid" {
			t.Fatal("original bytes changed")
		}
		return response(400, object{"error": object{"message": "Invalid JSON"}}), nil
	})
	a.state = session{Token: "account", Codex: true}
	a.bearer = "valid"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	w := httptest.NewRecorder()
	a.codex(w, httptest.NewRequest("POST", "/v1/responses", strings.NewReader("{invalid")))
	if calls != 1 || w.Code != 400 {
		t.Fatal(calls, w.Code)
	}
}
func TestCodexEncryptedAgentFailurePreservesRequest(t *testing.T) {
	body := `{"model":"gpt-test","stream":true,"max_output_tokens":256,"input":[{"type":"agent_message","id":"amsg-test","author":"/root/worker","recipient":"/root","content":[{"type":"input_text","text":"Message Type: MESSAGE\nPayload:\n"},{"type":"encrypted_content","encrypted_content":"opaque-agent-body"}]},{"type":"reasoning","id":"rs-test","encrypted_content":"opaque-reasoning"},{"type":"function_call","call_id":"call-test","name":"read","arguments":"{}"},{"type":"function_call_output","call_id":"call-test","output":"preserved"}],"reasoning":{"effort":"xhigh","context":"all_turns"}}`
	message := "Encrypted function output content could not be decrypted or decoded."
	calls := 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "api.githubcopilot.com" {
			t.Fatal("unexpected authentication or discovery request")
		}
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != body {
			t.Fatal("model, tools, reasoning, token budget, or conversation data changed")
		}
		result := response(200, nil)
		result.Header.Set("Content-Type", "text/event-stream")
		result.Header.Set("Content-Length", "1")
		result.Body = io.NopCloser(strings.NewReader(
			"data: {\"type\":\"response.failed\",\"response\":{\"id\":\"r\",\"status\":\"failed\",\"error\":null}}\n\n" +
				"data: " + string(jsonBytes(object{"type": "error", "code": "invalid_request_body", "message": message})) + "\n\n"))
		return result, nil
	})
	a.state = session{Token: "account", Codex: true}
	a.bearer = "valid"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.models.sessionStarted = true
	w := httptest.NewRecorder()
	a.codex(w, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
	if calls != 1 || w.Code != 200 || w.Header().Get("Content-Length") != "" {
		t.Fatal("encrypted content was retried or invalid streaming headers were retained", calls, w.Code)
	}
	if strings.Contains(w.Body.String(), "response.completed") {
		t.Fatal("failure was reported as success")
	}
	count := 0
	if err := readSSE(w.Body, func(e sseEvent) error {
		event, _ := e.data()
		if event["type"] == "response.failed" {
			count++
			if nested(event, "response", "error", "code") != "invalid_request_body" ||
				nested(event, "response", "error", "message") != message {
				t.Fatal("native client would lose the upstream error", event)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("missing or duplicated failure event", count)
	}
}
func TestSurgicalConfigAndClaudeRestorePreserveUserEdits(t *testing.T) {
	a := testApp(t, nil)
	base := "model_provider = \"openai\"\nnotify = [\"original\"]\n\n[plugins.custom]\nenabled = true\n"
	live := injectConfig(base, 18921, a.path("codex-model-catalog.json")) + "\n[mcp_servers.user]\ncommand = \"new\"\n"
	if err := writeAtomic(filepath.Join(a.options.CodexHome, "config.toml"), []byte(live)); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(filepath.Join(a.options.CodexHome, "config.toml.bak"), []byte(base)); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(a.options.CodexHome, "auth.json"), object{"OPENAI_API_KEY": "user-new-key"}); err != nil {
		t.Fatal(err)
	}
	if err := a.restoreCodex(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(a.options.CodexHome, "config.toml"))
	if !strings.Contains(string(data), "mcp_servers.user") || !strings.Contains(string(data), `model_provider = "openai"`) || strings.Contains(string(data), "model_providers.kobashi") {
		t.Fatal(string(data))
	}
	auth, _ := os.ReadFile(filepath.Join(a.options.CodexHome, "auth.json"))
	if !strings.Contains(string(auth), "user-new-key") {
		t.Fatal("user auth was replaced")
	}
	path := filepath.Join(a.options.Home, ".claude", "settings.json")
	if err := writeJSON(path, object{"theme": "old", "env": object{"CUSTOM": "kept", "ANTHROPIC_MODEL": "old-model"}}); err != nil {
		t.Fatal(err)
	}
	if err := a.injectClaude(); err != nil {
		t.Fatal(err)
	}
	current, _, _ := readSettingsObject(path)
	current["theme"] = "user-edited"
	obj(current["env"])["EXTRA"] = "new"
	_ = writeJSON(path, current)
	if err := a.restoreClaude(); err != nil {
		t.Fatal(err)
	}
	current, _, _ = readSettingsObject(path)
	if current["theme"] != "user-edited" || nested(current, "env", "EXTRA") != "new" || nested(current, "env", "CUSTOM") != "kept" || nested(current, "env", "ANTHROPIC_MODEL") != "old-model" || nested(current, "env", "ANTHROPIC_AUTH_TOKEN") != nil {
		t.Fatal(current)
	}
}
func TestClaudeTranslationToolsThinkingImagesAndEffort(t *testing.T) {
	body := object{"model": "claude-sonnet-4-6", "stream": true, "max_tokens": 1000, "output_config": object{"effort": "xhigh"},
		"messages": []any{
			object{"role": "assistant", "content": []any{object{"type": "thinking", "thinking": "interrupted"}, object{"type": "tool_use", "id": "tool-1", "name": "read", "input": object{"path": "image.png"}}}},
			object{"role": "user", "content": []any{object{"type": "tool_result", "tool_use_id": "tool-1", "is_error": true, "content": []any{object{"type": "text", "text": "failed"}, object{"type": "image", "source": object{"type": "base64", "media_type": "image/png", "data": "AA=="}}}}}}},
		"tools": []any{object{"name": "read", "input_schema": object{"type": "object"}}}, "tool_choice": object{"type": "any", "disable_parallel_tool_use": true}}
	out := anthropicToOpenAI(body)
	if out["reasoning_effort"] != "xhigh" || out["tool_choice"] != "required" || out["parallel_tool_calls"] != false {
		t.Fatal(out)
	}
	messages := arr(out["messages"])
	if !strings.Contains(str(obj(messages[0])["content"]), "interrupted") || nested(obj(messages[1]), "content") != "[tool error] failed" || nested(obj(arr(obj(messages[2])["content"])[0]), "image_url", "url") != "data:image/png;base64,AA==" {
		t.Fatal(messages)
	}
	if estimateTokens(body) < 1 {
		t.Fatal("invalid count")
	}
}
func TestClaudeStreamUTF8ThinkingToolsUsageAndFailure(t *testing.T) {
	events := []object{
		{"choices": []any{object{"delta": object{"reasoning_text": "思考", "reasoning_opaque": "signature"}}}},
		{"choices": []any{object{"delta": object{"content": "hello"}}}},
		{"choices": []any{object{"delta": object{"tool_calls": []any{object{"index": 0, "id": "call-1", "function": object{"name": "read", "arguments": "{\"path\":\"x\"}"}}}}}}},
		{"choices": []any{object{"delta": object{}, "finish_reason": "tool_calls"}}, "usage": object{"prompt_tokens": 12, "completion_tokens": 7}},
	}
	var source strings.Builder
	for _, e := range events {
		source.WriteString("data: " + string(jsonBytes(e)) + "\r\n\r\n")
	}
	source.WriteString("data: [DONE]\r\n\r\n")
	w := httptest.NewRecorder()
	if err := translateStream(oneByteReader{strings.NewReader(source.String())}, w, "claude-test", 5); err != nil {
		t.Fatal(err)
	}
	stream := w.Body.String()
	for _, s := range []string{"思考", "signature_delta", "thinking_delta", "text_delta", "input_json_delta", `"stop_reason":"tool_use"`, `"input_tokens":12`, `"output_tokens":7`, "message_stop"} {
		if !strings.Contains(stream, s) {
			t.Fatal("missing", s, stream)
		}
	}
	w = httptest.NewRecorder()
	if err := translateStream(strings.NewReader("data: {\"error\":{\"message\":\"stream failed\"}}\n\n"), w, "claude-test", 1); err == nil || !strings.Contains(w.Body.String(), "event: error") || strings.Contains(w.Body.String(), "message_stop") {
		t.Fatal("upstream failure reported as success")
	}
}

type oneByteReader struct{ io.Reader }

func (r oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.Reader.Read(p)
}

func TestShutdownFailureIsNotLostOnRepeatedCalls(t *testing.T) {
	home := t.TempDir()
	a, err := New(Options{Home: home, CodexHome: filepath.Join(home, ".codex")})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(a.options.CodexHome, "auth.json"), 0700); err != nil {
		t.Fatal(err)
	}
	a.state.Codex = true
	first := a.Stop()
	if first == nil || a.Stop() != first {
		t.Fatal("shutdown error was lost")
	}
}

func TestClaudeInterruptedStreamDoesNotReportSuccess(t *testing.T) {
	w := httptest.NewRecorder()
	err := translateStream(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"), w, "claude-test", 1)
	if err == nil || !strings.Contains(w.Body.String(), "event: error") || strings.Contains(w.Body.String(), "message_stop") {
		t.Fatal("interrupted stream was reported as completed")
	}
}

func TestCompatibilityPreservesExactJSONNumbers(t *testing.T) {
	body, err := readObject(strings.NewReader(`{"model":"gpt-test","input":{"integer":9007199254740993},"max_output_tokens":1.00e3,"reasoning":{"context":"all_turns"}}`), 4096)
	if err != nil {
		t.Fatal(err)
	}
	next, _, changed := repairRequest(body, object{"error": object{"param": "reasoning.context", "message": "Unsupported value: 'all_turns'. Supported values are: 'current_turn'."}})
	data := string(jsonBytes(next))
	if !changed || !strings.Contains(data, "9007199254740993") || !strings.Contains(data, `"max_output_tokens":1.00e3`) {
		t.Fatal("request data or token budget changed", data)
	}
}
