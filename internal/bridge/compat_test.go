package bridge

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestServiceTierUnsupportedParameterRepair(t *testing.T) {
	body := object{"model": "gpt-test", "service_tier": "priority", "stream": true,
		"input":     []any{object{"role": "user", "content": "preserved"}},
		"tools":     []any{object{"type": "function", "name": "read", "parameters": object{"type": "object"}}},
		"reasoning": object{"effort": "high", "context": "current_turn"}, "max_output_tokens": 4096}
	original := jsonBytes(body)
	want := clone(body)
	delete(want, "service_tier")
	for _, message := range []string{
		"Unknown parameter: 'service_tier'.",
		"Unrecognized parameter: \"service_tier\".",
		"Unsupported parameter: service_tier",
		"service_tier is not supported.",
		"'service_tier' is not supported",
		"The parameter 'service_tier' is not supported.",
	} {
		for _, param := range []string{"", "service_tier"} {
			t.Run(message+"/"+param, func(t *testing.T) {
				next, rules, changed := repairRequest(body, object{"error": object{"message": message, "param": param}})
				if !changed || !bytes.Equal(jsonBytes(next), jsonBytes(want)) {
					t.Fatalf("unsupported service tier was not removed surgically: %s", jsonBytes(next))
				}
				values, learned := rules["service_tier"]
				if !learned || values != nil {
					t.Fatal("the field rejection was not learned", rules)
				}
				if !bytes.Equal(jsonBytes(body), original) {
					t.Fatal("the original request was mutated")
				}
				if _, _, changed := repairRequest(next, object{"error": object{"message": message, "param": param}}); changed {
					t.Fatal("an absent service tier caused another retry")
				}
			})
		}
	}
}

func TestServiceTierRepairRejectsAmbiguousErrors(t *testing.T) {
	body := object{"model": "gpt-test", "service_tier": "priority", "input": "preserved"}
	for _, detail := range []object{
		{"message": "service_tier is not supported.", "param": "model"},
		{"message": "Unsupported value: 'priority'. Supported values are: 'default'.", "param": "service_tier"},
		{"message": "Something is not supported.", "param": "service_tier"},
		{"message": "Service unavailable", "param": "service_tier"},
		{"message": "Unknown parameter: 'tools'."},
		{"message": "Unknown parameter: 'max_output_tokens'."},
		{"message": "Unknown parameter: 'input'."},
		{"message": "Unknown parameter: 'model'."},
	} {
		next, rules, changed := repairRequest(body, object{"error": detail})
		if changed || len(rules) != 0 || !bytes.Equal(jsonBytes(next), jsonBytes(body)) {
			t.Fatal("an unrelated error changed the request", detail, next, rules)
		}
	}
	if next, changed := applyConstraints(body, nil); changed || !bytes.Equal(jsonBytes(next), jsonBytes(body)) {
		t.Fatal("service tier was removed without upstream evidence")
	}
	if _, changed := applyConstraints(body, constraints{"service_tier": {"default"}}); changed {
		t.Fatal("a service tier was silently substituted")
	}
}

func TestCodexSupportedServiceTierIsPreserved(t *testing.T) {
	body := object{"model": "gpt-test", "service_tier": "priority", "input": "preserved", "stream": true}
	calls := 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.githubcopilot.com" {
			t.Fatal("a supported request caused authentication or discovery")
		}
		calls++
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(data, jsonBytes(body)) {
			t.Fatal("a supported service tier request changed", string(data))
		}
		return successfulProbe(), nil
	})
	a.state = session{Token: "account", Codex: true}
	a.bearer = "valid"
	a.expiry = float64(time.Now().Add(time.Hour).Unix())
	a.models.setAccount("account")
	a.models.sessionStarted = true
	for range 2 {
		w := httptest.NewRecorder()
		a.codex(w, httptest.NewRequest("POST", "/v1/responses", bytes.NewReader(jsonBytes(body))))
		if w.Code != 200 || !strings.Contains(w.Body.String(), "response.completed") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls != 2 {
		t.Fatal("successful inference was replayed", calls)
	}
}

func TestCodexServiceTierRejectionLearnsAndPersists(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(map[bool]string{false: "http", true: "stream"}[streaming], func(t *testing.T) {
			body := object{"model": "gpt-test", "service_tier": "priority", "input": "preserved", "stream": true}
			calls := 0
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "api.githubcopilot.com" {
					t.Fatal("parameter rejection caused an authentication or discovery request")
				}
				calls++
				var request object
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Fatal(err)
				}
				if calls == 1 {
					if request["service_tier"] != "priority" {
						t.Fatal("the original service tier was not forwarded")
					}
					detail := object{"code": "unsupported_parameter", "param": "service_tier", "message": "service_tier is not supported."}
					if !streaming {
						return response(400, object{"error": detail}), nil
					}
					detail["type"] = "error"
					result := response(200, nil)
					result.Header.Set("Content-Type", "text/event-stream")
					result.Body = io.NopCloser(strings.NewReader(
						"data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":null}}\n\n" +
							"data: " + string(jsonBytes(detail)) + "\n\n"))
					return result, nil
				}
				if _, exists := request["service_tier"]; exists {
					t.Fatal("a rejected service tier was forwarded again")
				}
				want := clone(body)
				delete(want, "service_tier")
				if !bytes.Equal(jsonBytes(request), jsonBytes(want)) {
					t.Fatal("other request fields changed", request)
				}
				return successfulProbe(), nil
			})
			a := testApp(t, transport)
			a.state = session{Token: "account", Codex: true}
			a.bearer = "valid"
			a.expiry = float64(time.Now().Add(time.Hour).Unix())
			a.models.setAccount("account")
			model := compatibleModel("gpt-test")
			a.models.latest["gpt-test"] = modelEntry{Model: model, Signature: "signature"}
			a.models.records["gpt-test"] = &modelRecord{ID: "gpt-test", Signature: "signature", State: "verified",
				Constraints: constraints{}, VerifiedModel: model, MultiAgentV2Verified: true, CheckedAt: time.Now().UnixMilli()}
			a.models.sessionStarted = true
			call := func(app *App) *httptest.ResponseRecorder {
				w := httptest.NewRecorder()
				app.codex(w, httptest.NewRequest("POST", "/v1/responses", bytes.NewReader(jsonBytes(body))))
				return w
			}
			first := call(a)
			if streaming {
				if calls != 1 || first.Code != 200 || !strings.Contains(first.Body.String(), "service_tier is not supported.") ||
					strings.Contains(first.Body.String(), "response.completed") {
					t.Fatal("a committed streaming failure was replayed or hidden", calls, first.Code, first.Body.String())
				}
			} else if calls != 2 || first.Code != 200 || !strings.Contains(first.Body.String(), "response.completed") {
				t.Fatal("the HTTP rejection was not recovered", calls, first.Code, first.Body.String())
			}
			rules, _ := a.models.requestRules("gpt-test")
			if values, learned := rules["service_tier"]; !learned || values != nil || len(a.models.visible()) != 1 ||
				!a.models.records["gpt-test"].MultiAgentV2Verified {
				t.Fatal("the rejection removed model capabilities or was not cached", rules)
			}
			reloaded, err := New(a.options)
			if err != nil {
				t.Fatal(err)
			}
			defer reloaded.Stop()
			reloaded.state = a.state
			reloaded.bearer, reloaded.expiry = a.bearer, a.expiry
			reloaded.models.setAccount("account")
			reloaded.models.sessionStarted = true
			before := calls
			if result := call(reloaded); calls != before+1 || result.Code != 200 {
				t.Fatal("the next request did not reuse the persisted field rejection", calls, result.Code)
			}
		})
	}
}
