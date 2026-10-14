package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func compatibleModel(id string) object {
	return object{"id": id, "vendor": "OpenAI", "supported_endpoints": []any{"/responses"}, "capabilities": object{"type": "chat", "supports": object{"streaming": true, "tool_calls": true, "reasoning_effort": []any{"low", "max"}}}}
}
func BenchmarkModelStatus(b *testing.B) {
	for _, count := range []int{10, 50} {
		b.Run(fmt.Sprintf("%d-models", count), func(b *testing.B) {
			m := newModelRegistry(nil)
			for i := 0; i < count; i++ {
				id := fmt.Sprintf("gpt-%d", i+1)
				model := compatibleModel(id)
				model["description"] = strings.Repeat("Model metadata. ", 20)
				m.latest[id] = modelEntry{Model: model}
				m.records[id] = &modelRecord{ID: id, State: "verified"}
			}
			if m.status()["verified"] != count {
				b.Fatal("model status benchmark did not count the fixture models")
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				m.status()
			}
		})
	}
}

func successfulProbe() *http.Response {
	r := response(200, nil)
	r.Header.Set("Content-Type", "text/event-stream")
	r.Body = io.NopCloser(strings.NewReader(`data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"kobashi_capability_check","arguments":"{\"value\":\"OK\"}"}]}}` + "\n\n"))
	return r
}
func TestProbeRequiresCompletedStreamingToolCall(t *testing.T) {
	for _, kind := range []string{"json", "missing-tool", "unfinished", "success"} {
		t.Run(kind, func(t *testing.T) {
			a := testApp(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.github.com" {
					return response(200, object{"token": "bearer", "expires_at": time.Now().Add(time.Hour).Unix()}), nil
				}
				result := successfulProbe()
				switch kind {
				case "json":
					result = response(200, object{"output": []any{}})
				case "missing-tool":
					result.Body = io.NopCloser(strings.NewReader("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"))
				case "unfinished":
					result.Body = io.NopCloser(strings.NewReader("data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"name\":\"kobashi_capability_check\",\"arguments\":\"{\\\"value\\\":\\\"OK\\\"}\"}}\n\n"))
				}
				return result, nil
			})
			a.state.Token = "account"
			result := a.probe(context.Background(), modelEntry{Model: compatibleModel("gpt-test")})
			if (result.State == "verified") != (kind == "success") {
				t.Fatal(kind, result)
			}
			if kind == "unfinished" && result.State != "transient" {
				t.Fatal("interrupted streams must retain verified snapshots")
			}
		})
	}
}
func completedProbe(items ...any) *http.Response {
	result := successfulProbe()
	result.Body = io.NopCloser(strings.NewReader("data: " + string(jsonBytes(object{"type": "response.completed",
		"response": object{"status": "completed", "output": items}})) + "\n\n"))
	return result
}
func TestProbeVerifiesAgentMessageReplay(t *testing.T) {
	for _, kind := range []string{"encrypted", "plaintext", "decrypt-failure", "wrong-payload", "unfinished", "missing-call", "network", "no-native"} {
		t.Run(kind, func(t *testing.T) {
			calls := 0
			var plaintext string
			a := testApp(t, func(r *http.Request) (*http.Response, error) {
				calls++
				var body object
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				wantEffort := "max"
				if kind == "no-native" {
					wantEffort = "low"
				}
				if body["model"] != "gpt-test" || number(body["max_output_tokens"]) != 1024 ||
					nested(body, "reasoning", "effort") != wantEffort {
					t.Fatal("probe changed the model or verified request settings", body)
				}
				switch calls {
				case 1:
					return successfulProbe(), nil
				case 2:
					if kind == "network" {
						return nil, errors.New("probe network failure")
					}
					tools := arr(body["tools"])
					if len(tools) != 1 || obj(tools[0])["name"] != "collaboration" ||
						nested(obj(arr(obj(tools[0])["tools"])[0]), "parameters", "properties", "message", "encrypted") != true {
						t.Fatal("probe did not request native encrypted agent arguments")
					}
					instruction := str(obj(arr(body["input"])[0])["content"])
					quoted := strings.TrimSuffix(strings.SplitN(instruction, " and message ", 2)[1], ". Do not answer or use other tools.")
					if err := json.Unmarshal([]byte(quoted), &plaintext); err != nil {
						t.Fatal(err)
					}
					call := object{"type": "function_call", "namespace": "collaboration", "name": "send_message"}
					payload := "encrypted-probe-payload"
					if kind == "plaintext" {
						payload = plaintext
						call["encrypted_function_args"] = []any{}
					}
					call["arguments"] = string(jsonBytes(object{"target": "/root", "message": payload}))
					if kind == "missing-call" {
						return completedProbe(), nil
					}
					return completedProbe(call), nil
				case 3:
					if body["tools"] != nil {
						t.Fatal("agent replay must not request tools")
					}
					item := obj(arr(body["input"])[0])
					content := obj(arr(item["content"])[0])
					if item["type"] != "agent_message" {
						t.Fatal("agent message was not replayed")
					}
					if kind == "plaintext" {
						if content["type"] != "input_text" || content["text"] != plaintext {
							t.Fatal("explicit plaintext message was not preserved")
						}
					} else if content["type"] != "encrypted_content" || content["encrypted_content"] != "encrypted-probe-payload" {
						t.Fatal("encrypted message was changed")
					}
					if kind == "decrypt-failure" {
						result := successfulProbe()
						result.Body = io.NopCloser(strings.NewReader("data: " + string(jsonBytes(object{"type": "response.failed",
							"response": object{"status": "failed", "error": nil}})) + "\n\ndata: " + string(jsonBytes(object{
							"type": "error", "code": "invalid_request_body",
							"message": "Encrypted function output content could not be decrypted or decoded."})) + "\n\n"))
						return result, nil
					}
					if kind == "unfinished" {
						result := successfulProbe()
						result.Body = io.NopCloser(strings.NewReader("data: " + string(jsonBytes(object{"type": "response.incomplete",
							"response": object{"status": "incomplete", "incomplete_details": object{"reason": "max_output_tokens"}}})) + "\n\n"))
						return result, nil
					}
					if kind == "wrong-payload" {
						plaintext = "different message"
					}
					return completedProbe(object{"type": "message", "role": "assistant",
						"content": []any{object{"type": "output_text", "text": plaintext}}}), nil
				}
				t.Fatal("unbounded agent probe retry")
				return nil, nil
			})
			a.state.Token, a.bearer = "account", "valid"
			a.expiry = float64(time.Now().Add(time.Hour).Unix())
			native := object{"supported_reasoning_levels": []any{object{"effort": "ultra"}}}
			if kind == "no-native" {
				native = nil
			}
			result := a.probe(context.Background(), modelEntry{Model: compatibleModel("gpt-test"), Native: native})
			want := kind == "encrypted" || kind == "plaintext"
			if result.State != "verified" || result.MultiAgentV2Verified != want {
				t.Fatal("agent failure affected normal inference or unsupported V2 was verified", result)
			}
			wantCalls := 3
			if kind == "network" || kind == "missing-call" {
				wantCalls = 2
			} else if kind == "no-native" {
				wantCalls = 1
			}
			if calls != wantCalls {
				t.Fatal("unexpected number of checks", calls, wantCalls)
			}
		})
	}
}
func TestCatalogRequiresVerifiedAgentCapabilities(t *testing.T) {
	native := fallbackModel("gpt-test", "Native model", 1)
	native["supported_reasoning_levels"] = []any{object{"effort": "low"}, object{"effort": "ultra"}}
	native["default_reasoning_level"] = "ultra"
	native["multi_agent_version"] = "v2"
	native["native_extension"] = "preserved"
	for _, verified := range []any{nil, false, true} {
		model := compatibleModel("gpt-test")
		model["kobashi_verified"] = object{"native": native, "multiAgentV2": verified}
		record := obj(arr(buildCatalog([]object{native}, []object{model})["models"])[0])
		want := verified == true
		wantLevels := 2
		if want {
			wantLevels++
		}
		if nativeHasUltra(record) != want || (record["multi_agent_version"] == "v2") != want {
			t.Fatal("Ultra or V2 was advertised without verified message replay", record)
		}
		if record["native_extension"] != "preserved" || record["supported_in_api"] != true ||
			len(arr(record["supported_reasoning_levels"])) != wantLevels {
			t.Fatal("ordinary model capabilities were changed", record)
		}
		if !want && record["default_reasoning_level"] == "ultra" {
			t.Fatal("unsupported Ultra remained the default")
		}
	}
	model := compatibleModel("gpt-test")
	record := obj(arr(buildCatalog([]object{native}, []object{model})["models"])[0])
	if nativeHasUltra(record) || record["multi_agent_version"] != "v1" {
		t.Fatal("missing verification did not select V1", record)
	}
}
func TestAgentCapabilityCacheAndRuntimeFailure(t *testing.T) {
	a := testApp(t, nil)
	a.models.setAccount("account")
	model := compatibleModel("gpt-test")
	native := fallbackModel("gpt-test", "Native model", 1)
	native["supported_reasoning_levels"] = []any{object{"effort": "low"}, object{"effort": "ultra"}}
	native["multi_agent_version"] = "v2"
	a.models.mu.Lock()
	a.models.latest["gpt-test"] = modelEntry{Model: model, Native: native, Signature: "signature"}
	a.models.records["gpt-test"] = &modelRecord{ID: "gpt-test", Signature: "signature", State: "verified",
		Constraints: constraints{}, VerifiedModel: model, VerifiedNative: native, MultiAgentV2Verified: true, CheckedAt: time.Now().UnixMilli()}
	a.models.persistLocked()
	a.models.mu.Unlock()
	reloaded, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	reloaded.models.setAccount("account")
	_, token := reloaded.models.requestRules("gpt-test")
	if nested(reloaded.models.visible()[0], "kobashi_verified", "multiAgentV2") != true {
		t.Fatal("verified agent capability did not survive a cache reload")
	}
	reloaded.models.observe("gpt-test", token, 200, object{"type": "error", "code": "invalid_request_body", "message": "Unrelated validation failure"}, nil)
	if nested(reloaded.models.visible()[0], "kobashi_verified", "multiAgentV2") != true {
		t.Fatal("unrelated failure disabled agent capabilities")
	}
	reloaded.models.observe("gpt-test", token, 200, object{"type": "error", "code": "invalid_request_body",
		"message": "Encrypted function output content could not be decrypted or decoded."}, nil)
	visible := reloaded.models.visible()
	if len(visible) != 1 || nested(visible[0], "kobashi_verified", "multiAgentV2") != false {
		t.Fatal("decrypt failure did not retain normal inference with V1", visible)
	}
	data, err := os.ReadFile(reloaded.path("codex-model-catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog object
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	record := obj(arr(catalog["models"])[0])
	if nativeHasUltra(record) || record["multi_agent_version"] != "v1" {
		t.Fatal("runtime failure was not persisted to the native catalog", record)
	}
	legacyData, err := os.ReadFile(a.path("codex-model-capabilities.json"))
	if err != nil {
		t.Fatal(err)
	}
	var legacy object
	if err := json.Unmarshal(legacyData, &legacy); err != nil {
		t.Fatal(err)
	}
	for _, value := range arr(legacy["records"]) {
		delete(obj(value), "multiAgentV2Verified")
	}
	if err := writeJSON(a.path("codex-model-capabilities.json"), legacy); err != nil {
		t.Fatal(err)
	}
	oldCache, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	defer oldCache.Stop()
	oldCache.models.setAccount("account")
	if nested(oldCache.models.visible()[0], "kobashi_verified", "multiAgentV2") != false {
		t.Fatal("legacy cache implicitly verified agent capabilities")
	}
}

func TestAgentProbeSharesAuthenticationRetry(t *testing.T) {
	calls, refreshes := 0, 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			refreshes++
			return response(200, object{"token": "fresh", "expires_at": time.Now().Add(time.Hour).Unix()}), nil
		}
		calls++
		if calls == 1 {
			return successfulProbe(), nil
		}
		if calls == 2 {
			var body object
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			instruction := str(obj(arr(body["input"])[0])["content"])
			quoted := strings.TrimSuffix(strings.SplitN(instruction, " and message ", 2)[1], ". Do not answer or use other tools.")
			var plaintext string
			if err := json.Unmarshal([]byte(quoted), &plaintext); err != nil {
				t.Fatal(err)
			}
			return completedProbe(object{"type": "function_call", "namespace": "collaboration", "name": "send_message",
				"encrypted_function_args": []any{}, "arguments": string(jsonBytes(object{"target": "/root", "message": plaintext}))}), nil
		}
		return response(401, object{"error": object{"message": "Expired token"}}), nil
	})
	a.state.Token, a.bearer = "account", "valid"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	result := a.probe(context.Background(), modelEntry{Model: compatibleModel("gpt-test"), Native: object{"multi_agent_version": "v2"}})
	if result.State != "verified" || result.MultiAgentV2Verified || calls != 4 || refreshes != 1 {
		t.Fatal("agent probe exceeded the authentication budget or revoked ordinary inference", result, calls, refreshes)
	}
}

func TestCopilotAgentMessageCompatibility(t *testing.T) {
	sessionPath, modelID := os.Getenv("KOBASHI_TEST_COPILOT_SESSION"), os.Getenv("KOBASHI_TEST_COPILOT_MODEL")
	if sessionPath == "" || modelID == "" {
		t.Skip("set KOBASHI_TEST_COPILOT_SESSION and KOBASHI_TEST_COPILOT_MODEL to opt in to live checks")
	}
	data, err := os.ReadFile(sessionPath)
	if err != nil {
		t.Fatal(err)
	}
	var account session
	if err := json.Unmarshal(data, &account); err != nil || account.Token == "" {
		t.Fatal("the supplied session does not contain a GitHub token")
	}
	upstream := newHTTPClient()
	defer upstream.CloseIdleConnections()
	replayed, decryptFailed := false, false
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.GetBody != nil && r.URL.Path == "/v1/responses" {
			body, err := r.GetBody()
			if err != nil {
				return nil, err
			}
			var request object
			err = json.NewDecoder(body).Decode(&request)
			body.Close()
			if err != nil {
				return nil, err
			}
			for _, value := range arr(request["input"]) {
				if obj(value)["type"] == "agent_message" {
					replayed = true
				}
			}
		}
		response, err := upstream.Transport.RoundTrip(r)
		if err != nil || r.URL.Path != "/v1/responses" {
			return response, err
		}
		data, err := readResponse(response, 512<<10)
		if err != nil {
			return nil, err
		}
		if err := readSSE(strings.NewReader(string(data)), func(e sseEvent) error {
			value, _ := e.data()
			decryptFailed = decryptFailed || encryptedAgentError(value)
			return nil
		}); err != nil {
			return nil, err
		}
		response.Body = io.NopCloser(strings.NewReader(string(data)))
		return response, nil
	})
	a.state.Token = account.Token
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	models, err := a.discover(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	native, err := loadNativeCatalog(ctx, a.options.Home)
	if err != nil {
		t.Fatal(err)
	}
	entry := modelEntry{}
	for _, model := range selectModels(models) {
		if model["id"] == modelID {
			entry.Model = model
		}
	}
	for _, model := range native {
		if model["slug"] == modelID {
			entry.Native = model
		}
	}
	if entry.Model == nil || entry.Native == nil || !nativeHasUltra(entry.Native) && entry.Native["multi_agent_version"] != "v2" {
		t.Fatal("the requested model must be available and declare native Ultra or V2")
	}
	result := a.probe(ctx, entry)
	if result.State != "verified" || !replayed {
		t.Fatalf("ordinary inference or a fresh agent-message replay was not observed: state=%s replayed=%t", result.State, replayed)
	}
	if !result.MultiAgentV2Verified && !decryptFailed {
		t.Fatal("the live agent check did not complete or report a conclusive decryption failure")
	}
	t.Logf("ordinary inference verified; fresh agent replay observed; agent capability verified=%t; decryption failure=%t",
		result.MultiAgentV2Verified, decryptFailed)
}

func TestModelRoundsLimitConcurrencyAndDiscardLateAccounts(t *testing.T) {
	var active, max, requests atomic.Int32
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/models" {
			return response(200, object{"data": []any{compatibleModel("gpt-1"), compatibleModel("gpt-2"), compatibleModel("gpt-3"), compatibleModel("gpt-4")}}), nil
		}
		count := active.Add(1)
		requests.Add(1)
		for old := max.Load(); count > old && !max.CompareAndSwap(old, count); old = max.Load() {
		}
		defer active.Add(-1)
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
		return successfulProbe(), nil
	})
	a.state.Token = "account-a"
	a.bearer = "bearer"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.options.NativeCatalog = func(context.Context, string) ([]object, error) { return nil, nil }
	a.models.setAccount("account-a")
	if err := a.models.beginRound(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("workers did not start")
		}
	}
	if max.Load() != 2 || a.models.status()["queued"] != 2 {
		t.Fatal(max.Load(), a.models.status())
	}
	if err := a.models.ensureSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatal("duplicate startup round")
	}
	a.models.setAccount("account-b")
	close(release)
	a.models.wg.Wait()
	if len(a.models.visible()) != 0 || max.Load() != 2 {
		t.Fatal("late account results were published")
	}
}
func TestModelMetadataAndAccountCache(t *testing.T) {
	a := testApp(t, nil)
	model := compatibleModel("gpt-6-sol-2029-01-01")
	if modelLess(str(model["id"]), "gpt-6.1-sol") {
		t.Fatal("variant date treated as a model version")
	}
	model["vendor"] = "NotOpenAI"
	if len(selectModels([]object{model})) != 0 {
		t.Fatal("unrelated vendor accepted")
	}
	model["vendor"] = "OpenAI"
	model["kobashi_verified"] = object{"native": nil, "constraints": object{"text.verbosity": nil, "reasoning.summary": []any{"concise"}}}
	catalog := buildCatalog(nil, []object{model})
	record := obj(arr(catalog["models"])[0])
	if record["support_verbosity"] != false || record["default_reasoning_summary"] != "concise" {
		t.Fatal("JSON constraints ignored", record)
	}
	a.models.setAccount("a")
	a.models.mu.Lock()
	a.models.latest["gpt-6-sol"] = modelEntry{Model: compatibleModel("gpt-6-sol"), Signature: "fingerprint"}
	a.models.records["gpt-6-sol"] = &modelRecord{ID: "gpt-6-sol", Signature: "fingerprint", State: "verified", Constraints: constraints{}, CheckedAt: time.Now().UnixMilli()}
	a.models.persistLocked()
	a.models.mu.Unlock()
	reloaded, err := New(a.options)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	reloaded.models.setAccount("a")
	if len(reloaded.models.visible()) != 1 {
		t.Fatal("verified cache not restored")
	}
	reloaded.models.setAccount("b")
	if len(reloaded.models.visible()) != 0 {
		t.Fatal("cache crossed accounts")
	}
}
func TestCodexAuthRetryIsSharedAcrossCompatibilityAttempts(t *testing.T) {
	calls, refreshes := 0, 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			refreshes++
			return response(200, object{"token": "fresh", "expires_at": time.Now().Add(time.Hour).Unix()}), nil
		}
		calls++
		if calls == 2 {
			return response(400, object{"error": object{"param": "text.verbosity", "message": "Unknown parameter: 'text.verbosity'."}}), nil
		}
		return response(401, object{"error": object{"message": "Expired token"}}), nil
	})
	a.state = session{Token: "account", Codex: true}
	a.bearer = "expired"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.models.sessionStarted = true
	w := httptest.NewRecorder()
	a.codex(w, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"gpt-test","input":"unchanged","text":{"verbosity":"low"}}`)))
	if calls != 3 || refreshes != 1 || w.Code != 401 {
		t.Fatal(calls, refreshes, w.Code)
	}
}
