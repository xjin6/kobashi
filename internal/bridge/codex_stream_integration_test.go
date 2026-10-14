package bridge

import (
	"bufio"
	"bytes"
	"context"
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
	"sync/atomic"
	"testing"
	"time"
)

func TestInstalledCodexStreamingFailureDetails(t *testing.T) {
	checkInstalledCodexStream(t, false)
}

func TestInstalledCodexCopilotDelegation(t *testing.T) {
	checkInstalledCodexStream(t, true)
}

func checkInstalledCodexStream(t *testing.T, live bool) {
	t.Helper()
	source := os.Getenv("KOBASHI_TEST_CODEX_EXE")
	if source == "" {
		t.Skip("set KOBASHI_TEST_CODEX_EXE to opt in to isolated native Codex checks")
	}
	modelID := "gpt-5.4"
	account := session{Token: "account", Codex: true}
	upstream := newHTTPClient()
	defer upstream.CloseIdleConnections()
	if live {
		sessionPath := os.Getenv("KOBASHI_TEST_COPILOT_SESSION")
		modelID = os.Getenv("KOBASHI_TEST_COPILOT_MODEL")
		if sessionPath == "" || modelID == "" {
			t.Skip("set KOBASHI_TEST_COPILOT_SESSION and KOBASHI_TEST_COPILOT_MODEL to opt in to live checks")
		}
		data, err := os.ReadFile(sessionPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &account); err != nil || account.Token == "" {
			t.Fatal("the supplied session does not contain a GitHub token")
		}
		account.Codex = true
	}
	home := t.TempDir()
	path := filepath.Join(home, "provider-stream-check.exe")
	files := [][2]string{{source, path}}
	if live {
		name := "codex-code-mode-host.exe"
		files = append(files, [2]string{filepath.Join(filepath.Dir(source), name), filepath.Join(home, name)})
	}
	for _, file := range files {
		input, err := os.Open(file[0])
		if err != nil {
			t.Fatal(err)
		}
		output, err := os.OpenFile(file[1], os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			input.Close()
			t.Fatal(err)
		}
		_, copyErr := io.Copy(output, input)
		if err = errors.Join(copyErr, input.Close(), output.Close()); err != nil {
			t.Fatal(err)
		}
	}
	message := "Encrypted function output content could not be decrypted or decoded."
	const answer = "KOBASHI_V1_DELEGATION_OK_61b2"
	var v1Tools atomic.Bool
	var spawned atomic.Bool
	var childAnswered atomic.Bool
	var requests atomic.Int32
	var exposedTools atomic.Value
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if live && (r.URL.Host == "api.github.com" || r.URL.Path == "/models") {
			return upstream.Transport.RoundTrip(r)
		}
		if r.URL.Host != "api.githubcopilot.com" {
			return nil, fmt.Errorf("unexpected upstream request: %s", r.URL.Host)
		}
		if requests.Add(1) > 12 {
			return nil, errors.New("isolated delegation check exceeded its request limit")
		}
		data, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(data))
		var request object
		if err := json.Unmarshal(data, &request); err != nil {
			return nil, err
		}
		names := []string{}
		tools := arr(request["tools"])
		for _, value := range arr(request["input"]) {
			item := obj(value)
			if item["type"] == "additional_tools" {
				tools = append(tools, arr(item["tools"])...)
			}
		}
		for _, value := range tools {
			tool := obj(value)
			names = append(names, str(tool["type"])+":"+str(tool["name"]))
			if tool["name"] == "collaboration" {
				return nil, errors.New("native Codex used V2 despite the V1 catalog")
			}
			if tool["name"] == "multi_agent_v1" {
				v1Tools.Store(true)
			}
			for _, value := range arr(tool["tools"]) {
				function := obj(value)
				name := str(function["name"])
				names = append(names, str(tool["name"])+"."+name)
				if name == "send_message" || name == "followup_task" {
					return nil, errors.New("native Codex exposed V2 communication tools for the gated model")
				}
				if strings.HasSuffix(name, "spawn_agent") && nested(function, "parameters", "properties", "prompt", "type") == "string" {
					v1Tools.Store(true)
				}
			}
		}
		exposedTools.Store(names)
		if live {
			response, err := upstream.Transport.RoundTrip(r)
			if err != nil {
				return nil, err
			}
			data, err := readResponse(response, 4<<20)
			if err != nil {
				return nil, err
			}
			if err := readSSE(bytes.NewReader(data), func(e sseEvent) error {
				value, _ := e.data()
				if detail := parseError(value); detail != nil {
					logMessage := str(detail["code"])
					t.Logf("isolated upstream failure: %s", logMessage)
				}
				return nil
			}); err != nil {
				return nil, err
			}
			response.Body = io.NopCloser(bytes.NewReader(data))
			return response, nil
		}
		result := response(200, nil)
		result.Header.Set("Content-Type", "text/event-stream")
		failure := object{"type": "response.failed", "response": object{"id": "resp-test", "object": "response", "status": "failed", "output": []any{}, "error": nil}}
		detail := object{"type": "error", "code": "invalid_request_body", "message": message, "param": nil}
		result.Body = io.NopCloser(strings.NewReader("data: " + string(jsonBytes(failure)) + "\n\ndata: " + string(jsonBytes(detail)) + "\n\n"))
		return result, nil
	})
	a.state = account
	if !live {
		a.bearer = "valid"
		a.expiry = float64(time.Now().Add(time.Hour).Unix())
	}
	a.models.sessionStarted = true
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/responses") {
			a.codex(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "accounts") {
			fmt.Fprint(w, string(jsonBytes(object{"accounts": []any{object{"id": "synthetic-account", "plan_type": "plus",
				"workspace_backend_origin": strings.Replace(server.URL, "http://", "https://", 1), "account_routing_override": "NO_CONSTRAINT"}},
				"account_ordering": []any{"synthetic-account"}, "default_account_id": "synthetic-account"})))
			return
		}
		io.WriteString(w, `{"data":[],"models":[],"items":[]}`)
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	native := fallbackModel(modelID, "Test model", 1)
	native["supports_search_tool"] = false
	native["multi_agent_version"] = "v2"
	native["supported_reasoning_levels"] = []any{object{"effort": "low"}, object{"effort": "ultra"}}
	model := compatibleModel(modelID)
	if live {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		models, err := a.discover(ctx, true)
		if err != nil {
			t.Fatal(err)
		}
		catalog, err := loadNativeCatalog(ctx, a.options.Home)
		if err != nil {
			t.Fatal(err)
		}
		model, native = nil, nil
		for _, value := range selectModels(models) {
			if value["id"] == modelID {
				model = value
			}
		}
		for _, value := range catalog {
			if value["slug"] == modelID {
				native = value
			}
		}
		if model == nil || native == nil {
			t.Fatal("the requested model must be present in both live and native catalogs")
		}
	}
	model["kobashi_verified"] = object{"native": native, "multiAgentV2": false}
	catalogPath := filepath.Join(home, "models.json")
	if err := writeJSON(catalogPath, buildCatalog([]object{native}, []object{model})); err != nil {
		t.Fatal(err)
	}
	config := injectConfig("cli_auth_credentials_store = \"file\"\nchatgpt_base_url = "+string(jsonBytes(server.URL))+
		"\nmodel = "+string(jsonBytes(modelID))+"\nmodel_reasoning_effort = \"low\"\n[features]\nmulti_agent = true\n", port, catalogPath)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), syntheticChatGPTAuth(), 0600); err != nil {
		t.Fatal(err)
	}
	duration := time.Minute
	if live {
		duration = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration)
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
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		stdin.Close()
		if err := command.Wait(); err != nil && !t.Failed() {
			t.Error("isolated Codex shutdown:", err)
		}
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	completedTypes := []string{}
	next := func() object {
		t.Helper()
		if !scanner.Scan() {
			t.Fatal("isolated Codex stopped before responding", scanner.Err(), ctx.Err())
		}
		var event object
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal("invalid native protocol response:", err)
		}
		if event["method"] == "item/completed" {
			item := obj(nested(event, "params", "item"))
			completedTypes = append(completedTypes, str(item["type"])+":"+str(item["tool"])+":"+str(item["status"]))
			if item["type"] == "collabAgentToolCall" && item["status"] == "completed" {
				if item["tool"] == "spawnAgent" && len(arr(item["receiverThreadIds"])) == 1 {
					spawned.Store(true)
				}
				for _, value := range obj(item["agentsStates"]) {
					state := obj(value)
					if state["status"] == "completed" && strings.TrimSpace(str(state["message"])) == answer {
						childAnswered.Store(true)
					}
				}
			}
		}
		return event
	}
	id := 0
	var threadID any
	call := func(method string, params object) object {
		t.Helper()
		id++
		if _, err := fmt.Fprintln(stdin, string(jsonBytes(object{"id": id, "method": method, "params": params}))); err != nil {
			t.Fatal(err)
		}
		for {
			event := next()
			if number(event["id"]) == float64(id) {
				if event["error"] != nil {
					t.Fatal(method, event["error"])
				}
				return obj(event["result"])
			}
		}
	}
	call("initialize", object{"clientInfo": object{"name": "kobashi-stream-test", "version": "1"}, "capabilities": object{"experimentalApi": true}})
	fmt.Fprintln(stdin, `{"method":"initialized"}`)
	expectedLevels := len(efforts(model))
	models := arr(call("model/list", object{})["data"])
	found := false
	for _, value := range models {
		model := obj(value)
		if model["model"] != modelID {
			continue
		}
		found = true
		levels := arr(model["supportedReasoningEfforts"])
		if len(levels) != expectedLevels {
			t.Fatal("native Codex did not retain ordinary reasoning efforts", model)
		}
		for _, value := range levels {
			if obj(value)["reasoningEffort"] == "ultra" {
				t.Fatal("native Codex advertised unverified Ultra")
			}
		}
	}
	if !found {
		t.Fatal("native Codex did not accept the V1 catalog", models)
	}
	thread := call("thread/start", object{"cwd": home, "model": modelID, "modelProvider": "kobashi", "approvalPolicy": "never", "sandbox": "read-only"})
	threadID = nested(thread, "thread", "id")
	prompt := "Reply OK."
	if live {
		prompt = "Spawn exactly one sub-agent with prompt: Reply only " + answer +
			". Wait for that agent to finish, then return only its exact answer. Do not answer without spawning an agent. Do not use shell commands, files, or network tools."
	}
	call("turn/start", object{"threadId": threadID, "input": []any{object{"type": "text", "text": prompt, "text_elements": []any{}}}})
	var finalAnswer string
	for {
		event := next()
		if event["method"] == "item/completed" && nested(event, "params", "threadId") == threadID &&
			nested(event, "params", "item", "type") == "agentMessage" {
			finalAnswer = str(nested(event, "params", "item", "text"))
		}
		if event["method"] == "turn/completed" && nested(event, "params", "threadId") == threadID {
			if live {
				if nested(event, "params", "turn", "status") != "completed" || strings.TrimSpace(finalAnswer) != answer ||
					!spawned.Load() || !childAnswered.Load() {
					t.Fatal("real native delegation did not finish with the expected child answer",
						nested(event, "params", "turn", "status"), nested(event, "params", "turn", "error"),
						"spawned", spawned.Load(), "child answered", childAnswered.Load(), "answer", finalAnswer, "items", completedTypes)
				}
			} else if nested(event, "params", "turn", "status") != "failed" ||
				!strings.Contains(str(nested(event, "params", "turn", "error", "message")), message) {
				t.Fatal("native Codex lost the upstream failure details", nested(event, "params", "turn", "error"))
			}
			if !v1Tools.Load() && !childAnswered.Load() {
				t.Fatal("native Codex did not expose V1 delegation for the gated model", exposedTools.Load())
			}
			return
		}
	}
}
