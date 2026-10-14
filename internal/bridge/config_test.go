package bridge

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexLoginRecovery(t *testing.T) {
	oauth := syntheticChatGPTAuth()
	managed := []byte(`{"OPENAI_API_KEY":"PROXY_MANAGED"}`)
	apiKey := []byte(`{"OPENAI_API_KEY":"synthetic-user-key"}`)
	mixed := []byte(`{"auth_mode":"chatgpt","OPENAI_API_KEY":"PROXY_MANAGED","tokens":{"access_token":"synthetic-access","id_token":"synthetic-id"}}`)
	for _, tc := range []struct {
		name               string
		live, backup, want []byte
		wantError, warning bool
		backupConsumed     bool
	}{
		{name: "preserve-chatgpt", live: oauth, backup: apiKey, want: oauth},
		{name: "preserve-user-api-key", live: apiKey, backup: oauth, want: apiKey},
		{name: "preserve-mixed-login", live: mixed, backup: oauth, want: mixed},
		{name: "recover-chatgpt", live: managed, backup: oauth, want: oauth, backupConsumed: true},
		{name: "recover-user-api-key", live: managed, backup: apiKey, want: apiKey, backupConsumed: true},
		{name: "missing-backup", live: managed, warning: true},
		{name: "placeholder-backup", live: managed, backup: managed, warning: true},
		{name: "empty-backup", live: managed, backup: []byte(`{}`), warning: true},
		{name: "invalid-backup", live: managed, backup: []byte(`{invalid`), want: managed, wantError: true},
		{name: "signed-out-with-unpaired-backup", backup: oauth},
		{name: "signed-out"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testApp(t, nil)
			path := filepath.Join(a.options.CodexHome, "auth.json")
			for file, data := range map[string][]byte{path: tc.live, path + ".bak": tc.backup} {
				if data != nil {
					if err := writeAtomic(file, data); err != nil {
						t.Fatal(err)
					}
				}
			}
			for i := 0; i < 2; i++ {
				if err := a.migrateCodexAuth(); (err != nil) != tc.wantError {
					t.Fatal("unexpected recovery result", err)
				}
				data, err := readOptional(path)
				if err != nil || string(data) != string(tc.want) {
					t.Fatal("login was not safely preserved or recovered", err)
				}
			}
			backup, err := readOptional(path + ".bak")
			wantBackup := tc.backup
			if tc.backupConsumed {
				wantBackup = nil
			}
			if err != nil || string(backup) != string(wantBackup) {
				t.Fatal("login backup was discarded without recovery", err)
			}
			if strings.Contains(a.lastError, "sign in to Codex again") != tc.warning {
				t.Fatal("missing explicit re-login notice")
			}
		})
	}
}

func TestCodexEnvironmentRecoveryPreservesUserValues(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		live, previous, want *string
		journal              bool
	}{
		{name: "journal", live: stringPtr("PROXY_MANAGED"), previous: stringPtr("synthetic-original-key"), want: stringPtr("synthetic-original-key"), journal: true},
		{name: "new-user-key", live: stringPtr("synthetic-new-key"), previous: stringPtr("synthetic-original-key"), want: stringPtr("synthetic-new-key"), journal: true},
		{name: "user-removed-key", previous: stringPtr("synthetic-original-key"), journal: true},
		{name: "nested-placeholder", live: stringPtr("PROXY_MANAGED"), previous: stringPtr("PROXY_MANAGED"), journal: true},
		{name: "unrecorded-placeholder", live: stringPtr("PROXY_MANAGED")},
		{name: "unrecorded-user-key", live: stringPtr("synthetic-user-key"), want: stringPtr("synthetic-user-key")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testApp(t, nil)
			if err := a.writeEnvironment("OPENAI_API_KEY", tc.live); err != nil {
				t.Fatal(err)
			}
			originalBase := "http://127.0.0.1:18921/v1"
			if err := a.writeEnvironment("OPENAI_BASE_URL", &originalBase); err != nil {
				t.Fatal(err)
			}
			if err := a.writeEnvironment("CODEX_API_KEY", stringPtr("synthetic-codex-user-key")); err != nil {
				t.Fatal(err)
			}
			if tc.journal {
				if err := writeJSON(a.path("environment.json"), map[string]environmentRecord{
					"OPENAI_API_KEY":  {Previous: tc.previous, Injected: "PROXY_MANAGED"},
					"OPENAI_BASE_URL": {Previous: &originalBase, Injected: originalBase},
				}); err != nil {
					t.Fatal(err)
				}
			}
			for i := 0; i < 2; i++ {
				if err := a.migrateCodexEnvironment(); err != nil {
					t.Fatal(err)
				}
			}
			key, err := a.readEnvironment("OPENAI_API_KEY")
			if err != nil || (key == nil) != (tc.want == nil) || (key != nil && *key != *tc.want) {
				t.Fatal("user API key was not preserved", err)
			}
			base, err := a.readEnvironment("OPENAI_BASE_URL")
			if err != nil || (!tc.journal && tc.live != nil && *tc.live == "PROXY_MANAGED") != (base == nil) {
				t.Fatal("base URL ownership was not respected", err)
			}
			codexKey, err := a.readEnvironment("CODEX_API_KEY")
			if err != nil || codexKey == nil || *codexKey != "synthetic-codex-user-key" {
				t.Fatal("user CODEX_API_KEY was modified", err)
			}
		})
	}
}

func stringPtr(value string) *string { return &value }

func TestCodexTogglePreservesLoginAndProviderOnlyAuthentication(t *testing.T) {
	for _, loggedIn := range []bool{false, true} {
		t.Run(map[bool]string{true: "chatgpt", false: "signed-out"}[loggedIn], func(t *testing.T) {
			a := testApp(t, func(*http.Request) (*http.Response, error) { return nil, errors.New("no remote requests are allowed") })
			a.state = session{Token: "synthetic-github-account", Codex: true}
			a.models.setAccount(a.state.Token)
			a.models.latest["gpt-test"] = modelEntry{Model: compatibleModel("gpt-test"), Signature: "synthetic"}
			a.models.records["gpt-test"] = &modelRecord{ID: "gpt-test", Signature: "synthetic", State: "verified", Constraints: constraints{}}
			auth := syntheticChatGPTAuth()
			path := filepath.Join(a.options.CodexHome, "auth.json")
			if loggedIn {
				if err := writeAtomic(path, auth); err != nil {
					t.Fatal(err)
				}
			}
			base := "model_provider = \"openai\"\nforced_login_method = \"chatgpt\"\nnotify = [\"keep\"]\n\n[plugins.user]\nenabled = true\n"
			config := filepath.Join(a.options.CodexHome, "config.toml")
			if err := writeAtomic(config, []byte(base)); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "NO_PROXY"} {
				if err := a.writeEnvironment(key, stringPtr("synthetic-user-"+key)); err != nil {
					t.Fatal(err)
				}
			}
			for i := 0; i < 2; i++ {
				if err := a.injectCodex(); err != nil {
					t.Fatal(err)
				}
				live, err := os.ReadFile(config)
				if err != nil || !strings.Contains(string(live), `experimental_bearer_token = "PROXY_MANAGED"`) ||
					!strings.Contains(string(live), "requires_openai_auth = true") || strings.Contains(string(live), "env_key") ||
					!strings.Contains(string(live), `forced_login_method = "chatgpt"`) {
					t.Fatal("provider-only auth or user policy was lost", err)
				}
				if err := a.restoreCodex(); err != nil {
					t.Fatal(err)
				}
				current, err := readOptional(path)
				if err != nil || (loggedIn && string(current) != string(auth)) || (!loggedIn && current != nil) {
					t.Fatal("toggle changed account login", err)
				}
				if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
					t.Fatal("normal login must not be backed up", err)
				}
				live, err = os.ReadFile(config)
				if err != nil || !strings.Contains(string(live), "[plugins.user]") || !strings.Contains(string(live), `model_provider = "openai"`) ||
					strings.Contains(string(live), "[model_providers.kobashi]") {
					t.Fatal("config restoration was not surgical", err)
				}
				for _, key := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "NO_PROXY"} {
					value, err := a.readEnvironment(key)
					if err != nil || value == nil || *value != "synthetic-user-"+key {
						t.Fatal("toggle changed user environment", key, err)
					}
				}
			}
		})
	}
}

func TestCodexBridgeUsesOnlyCopilotAuthentication(t *testing.T) {
	requests := 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		requests++
		if r.URL.Host == "api.github.com" {
			t.Fatal("unexpected account or discovery request")
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-copilot-bearer" ||
			strings.Contains(r.Header.Get("Authorization"), "synthetic-chatgpt") {
			t.Fatal("upstream inference received ChatGPT credentials")
		}
		return response(200, object{"id": "synthetic-response"}), nil
	})
	a.state = session{Token: "synthetic-github-account", Codex: true}
	a.bearer = "synthetic-copilot-bearer"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.models.sessionStarted = true
	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-test","input":"synthetic"}`))
	r.Header.Set("Authorization", "Bearer PROXY_MANAGED")
	w := httptest.NewRecorder()
	a.codex(w, r)
	if requests != 1 || w.Code != 200 {
		t.Fatal("provider bearer is incompatible with the bridge", requests, w.Code)
	}
}
