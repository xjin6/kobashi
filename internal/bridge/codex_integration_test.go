package bridge

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func syntheticChatGPTAuth() []byte {
	claims := object{"email": "synthetic@example.test", "exp": 4102444800,
		"https://api.openai.com/auth": object{"chatgpt_account_id": "synthetic-account", "chatgpt_user_id": "synthetic-user", "chatgpt_plan_type": "plus"}}
	token := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(jsonBytes(claims)) + ".synthetic"
	return jsonBytes(object{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil,
		"tokens":       object{"id_token": token, "access_token": "synthetic-chatgpt-access", "refresh_token": "synthetic-chatgpt-refresh", "account_id": "synthetic-account"},
		"last_refresh": "2099-01-01T00:00:00Z"})
}

func TestInstalledCodexProviderAuthentication(t *testing.T) {
	source := os.Getenv("KOBASHI_TEST_CODEX_EXE")
	if source == "" {
		t.Skip("set KOBASHI_TEST_CODEX_EXE to opt in to isolated native Codex checks")
	}
	// The live bridge's process watcher must not treat this probe as a user client startup.
	path := filepath.Join(t.TempDir(), "provider-compat.exe")
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	if err = errors.Join(copyErr, input.Close(), output.Close()); err != nil {
		t.Fatal(err)
	}
	for _, requireAuth := range []bool{false, true} {
		for _, loggedIn := range []bool{true, false} {
			t.Run(fmt.Sprintf("requires_auth_%t/login_%t", requireAuth, loggedIn), func(t *testing.T) {
				home := t.TempDir()
				var mu sync.Mutex
				var inference []http.Header
				var pluginAuth []string
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.HasSuffix(r.URL.Path, "/responses") {
						mu.Lock()
						inference = append(inference, r.Header.Clone())
						mu.Unlock()
						w.Header().Set("Content-Type", "text/event-stream")
						message := object{"type": "message", "id": "msg-test", "role": "assistant", "status": "completed",
							"content": []any{object{"type": "output_text", "text": "OK", "annotations": []any{}}}}
						result := object{"id": "resp-test", "object": "response", "status": "completed", "output": []any{message},
							"usage": object{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
						fmt.Fprintf(w, "event: response.completed\ndata: %s\n\n", jsonBytes(object{"type": "response.completed", "response": result}))
						return
					}
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, `{"data":[],"models":[],"items":[]}`)
				}))
				defer server.Close()
				var accountServer *httptest.Server
				accountServer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if strings.Contains(r.URL.Path, "accounts") {
						fmt.Fprint(w, string(jsonBytes(object{"accounts": []any{object{"id": "synthetic-account", "plan_type": "plus",
							"workspace_backend_origin": strings.Replace(accountServer.URL, "http://", "https://", 1), "account_routing_override": "NO_CONSTRAINT"}},
							"account_ordering": []any{"synthetic-account"}, "default_account_id": "synthetic-account"})))
						return
					}
					if strings.Contains(r.URL.Path, "plugins") {
						mu.Lock()
						pluginAuth = append(pluginAuth, r.Header.Get("Authorization"))
						mu.Unlock()
					}
					io.WriteString(w, `{"data":[],"models":[],"items":[],"plugins":[],"pagination":{"next_page_token":null}}`)
				}))
				defer accountServer.Close()
				port := server.Listener.Addr().(*net.TCPAddr).Port
				config := injectConfig("cli_auth_credentials_store = \"file\"\nchatgpt_base_url = "+string(jsonBytes(accountServer.URL))+
					"\nmodel = \"gpt-5.4\"\n", port, "")
				config = strings.Replace(config, "requires_openai_auth = true", fmt.Sprintf("requires_openai_auth = %t", requireAuth), 1)
				if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
					t.Fatal(err)
				}
				authPath := filepath.Join(home, "auth.json")
				auth := syntheticChatGPTAuth()
				if loggedIn {
					if err := os.WriteFile(authPath, auth, 0600); err != nil {
						t.Fatal(err)
					}
				}
				ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, path, "app-server", "--stdio", "--strict-config")
				for _, entry := range os.Environ() {
					key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
					if !contains([]string{"CODEX_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
						"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"}, key) {
						command.Env = append(command.Env, entry)
					}
				}
				command.Env = append(command.Env, "CODEX_HOME="+home, "HOME="+home, "USERPROFILE="+home, "APPDATA="+home, "LOCALAPPDATA="+home,
					"HTTP_PROXY=http://127.0.0.1:1", "HTTPS_PROXY=http://127.0.0.1:1", "ALL_PROXY=http://127.0.0.1:1", "NO_PROXY=127.0.0.1,localhost")
				command.Dir = home
				stdin, err := command.StdinPipe()
				if err != nil {
					t.Fatal(err)
				}
				stdout, err := command.StdoutPipe()
				if err != nil {
					t.Fatal(err)
				}
				stderr, err := command.StderrPipe()
				if err != nil {
					t.Fatal(err)
				}
				if err = command.Start(); err != nil {
					t.Fatal(err)
				}
				go io.Copy(io.Discard, stderr)
				defer func() {
					stdin.Close()
					if err := command.Wait(); err != nil && !t.Failed() {
						t.Error("isolated Codex shutdown:", err)
					}
				}()
				scanner := bufio.NewScanner(stdout)
				scanner.Buffer(make([]byte, 4096), 4<<20)
				next := func() object {
					t.Helper()
					if !scanner.Scan() {
						t.Fatal("isolated Codex stopped before responding", scanner.Err(), ctx.Err())
					}
					var message object
					if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
						t.Fatal("invalid native protocol response:", err)
					}
					return message
				}
				id := 0
				call := func(method string, params object) object {
					t.Helper()
					id++
					if _, err := fmt.Fprintln(stdin, string(jsonBytes(object{"id": id, "method": method, "params": params}))); err != nil {
						t.Fatal(err)
					}
					for {
						message := next()
						if number(message["id"]) != float64(id) {
							continue
						}
						if message["error"] != nil {
							t.Fatal(method, message["error"])
						}
						return obj(message["result"])
					}
				}
				call("initialize", object{"clientInfo": object{"name": "kobashi-compat-test", "version": "1"}, "capabilities": object{"experimentalApi": true}})
				fmt.Fprintln(stdin, `{"method":"initialized"}`)
				account := call("account/read", object{"refreshToken": false})
				gotChatGPT := nested(account, "account", "type") == "chatgpt"
				t.Logf("account/read: requiresOpenaiAuth=%v, ChatGPT=%t", account["requiresOpenaiAuth"], gotChatGPT)
				if gotChatGPT != (requireAuth && loggedIn) {
					t.Fatal("unexpected native account classification", account)
				}
				if requireAuth && loggedIn {
					catalog := call("plugin/list", object{"marketplaceKinds": []any{"vertical"}, "forceRefetch": true})
					if len(arr(catalog["marketplaceLoadErrors"])) != 0 {
						t.Fatal("mock remote plugin catalog failed", catalog["marketplaceLoadErrors"])
					}
					mu.Lock()
					if len(pluginAuth) == 0 {
						mu.Unlock()
						t.Fatal("remote plugin auth path was not exercised")
					}
					for _, bearer := range pluginAuth {
						if bearer != "Bearer synthetic-chatgpt-access" {
							mu.Unlock()
							t.Fatal("plugin catalog did not use the stored ChatGPT account")
						}
					}
					mu.Unlock()
				}
				thread := call("thread/start", object{"cwd": home, "model": "gpt-5.4", "modelProvider": "kobashi", "approvalPolicy": "never", "sandbox": "read-only"})
				call("turn/start", object{"threadId": nested(thread, "thread", "id"), "input": []any{object{"type": "text", "text": "Reply OK.", "text_elements": []any{}}}})
				for {
					event := next()
					if event["method"] == "turn/completed" {
						if nested(event, "params", "turn", "status") != "completed" {
							t.Fatal("mock inference failed", nested(event, "params", "turn", "error"))
						}
						break
					}
				}
				mu.Lock()
				defer mu.Unlock()
				if len(inference) == 0 {
					t.Fatal("no model-provider request was captured")
				}
				for _, header := range inference {
					if header.Get("Authorization") != "Bearer PROXY_MANAGED" || header.Get("ChatGPT-Account-ID") != "" ||
						strings.Contains(fmt.Sprint(header), "synthetic-chatgpt") {
						t.Fatal("model-provider request inherited account credentials")
					}
				}
				if loggedIn {
					current, err := os.ReadFile(authPath)
					if err != nil || string(current) != string(auth) {
						t.Fatal("native probe changed stored ChatGPT login", err)
					}
				}
			})
		}
	}
}
