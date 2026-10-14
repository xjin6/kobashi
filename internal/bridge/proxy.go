package bridge

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

func (a *App) codex(w http.ResponseWriter, r *http.Request) {
	state := a.snapshot()
	if state.Token == "" || !state.Codex {
		respond(w, 401, object{"error": "Codex bridge not active"})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/models" {
		if err := a.models.ensureSession(r.Context()); err != nil {
			log.Printf("Codex model startup: %v", err)
		}
		out := []any{}
		for _, m := range a.models.visible() {
			vendor := strings.ToLower(str(m["vendor"]))
			if vendor == "" {
				vendor = "copilot"
			}
			vendor = strings.Join(strings.Fields(vendor), "-")
			out = append(out, object{"id": m["id"], "object": "model", "created": number(m["created"]), "owned_by": vendor})
		}
		respond(w, 200, object{"object": "list", "data": out})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256<<20+1))
	if err != nil {
		respond(w, 400, object{"error": err.Error()})
		return
	}
	if len(body) > 256<<20 {
		respond(w, 413, object{"error": "Request exceeds 256 MiB"})
		return
	}
	var requestBody object
	token := ""
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if r.Method == "POST" && strings.Contains(r.URL.Path, "/responses") && decoder.Decode(&requestBody) == nil && requestBody != nil && decoder.Decode(new(any)) == io.EOF {
		if err := a.models.ensureSession(r.Context()); err != nil {
			log.Printf("Codex capability lookup: %v", err)
		}
		rules, t := a.models.requestRules(str(requestBody["model"]))
		token = t
		if normalized, changed := applyConstraints(requestBody, rules); changed {
			requestBody = normalized
			body = jsonBytes(normalized)
		}
	}
	path := r.URL.RequestURI()
	if !strings.HasPrefix(path, "/v1") {
		path = "/v1" + path
	}
	authRetried := false
	for attempt := 0; attempt < 4; attempt++ {
		response, err := a.copilotWithRetry(r.Context(), r.Method, path, body, &authRetried)
		if err != nil {
			respond(w, 502, object{"error": err.Error()})
			return
		}
		if response.StatusCode == 400 || response.StatusCode == 403 || response.StatusCode == 404 || response.StatusCode == 410 {
			data, e := readResponse(response, 16<<20)
			if e != nil {
				respond(w, 502, object{"error": e.Error()})
				return
			}
			var errorBody object
			_ = json.Unmarshal(data, &errorBody)
			a.models.observe(str(requestBody["model"]), token, response.StatusCode, errorBody, nil)
			if response.StatusCode == 400 && attempt < 3 && requestBody != nil {
				next, rules, changed := repairRequest(requestBody, errorBody)
				if changed {
					log.Printf("Codex request compatibility (model %s): %v", str(requestBody["model"]), rules)
					a.models.observe(str(requestBody["model"]), token, response.StatusCode, errorBody, rules)
					requestBody = next
					body = jsonBytes(next)
					continue
				}
			}
			contentType := response.Header.Get("Content-Type")
			if contentType == "" {
				contentType = "application/json"
			}
			w.Header().Set("Content-Type", contentType)
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(data)
			return
		}
		normalize := response.StatusCode == 200 && strings.Contains(path, "/responses") && strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") &&
			(response.Header.Get("Content-Encoding") == "" || response.Header.Get("Content-Encoding") == "identity")
		for key, values := range response.Header {
			if strings.EqualFold(key, "Connection") || strings.EqualFold(key, "Transfer-Encoding") || (normalize && strings.EqualFold(key, "Content-Length")) {
				continue
			}
			w.Header()[key] = values
		}
		w.WriteHeader(response.StatusCode)
		if normalize {
			failureLogged := false
			err = normalizeSSE(response.Body, w, func(event object) {
				detail := parseError(event)
				if detail == nil {
					return
				}
				if !failureLogged {
					log.Printf("Codex upstream failure (model %s, code %s): %s", str(requestBody["model"]), str(detail["code"]), str(detail["message"]))
					failureLogged = true
				}
				if requestBody == nil {
					return
				}
				_, rules, _ := repairRequest(requestBody, event)
				a.models.observe(str(requestBody["model"]), token, 400, event, rules)
			})
		} else {
			_, err = io.Copy(w, response.Body)
		}
		response.Body.Close()
		if err != nil {
			log.Printf("Codex upstream stream: %v", err)
		}
		return
	}
}
func claudeError(w http.ResponseWriter, status int, message string) {
	typ := map[int]string{400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error"}[status]
	if typ == "" {
		typ = "api_error"
	}
	respond(w, status, object{"type": "error", "error": object{"type": typ, "message": message}})
}
func (a *App) claude(w http.ResponseWriter, r *http.Request) {
	state := a.snapshot()
	if state.Token == "" || !state.Claude {
		claudeError(w, 401, "Claude bridge not active")
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/models" {
		raw, err := a.discover(r.Context(), false)
		if err != nil {
			claudeError(w, 502, err.Error())
			return
		}
		models := claudeModels(raw)
		out := []any{}
		var first, last any
		for _, m := range models {
			delete(m, "copilot")
			m["type"] = "model"
			m["created_at"] = timeISO()
			out = append(out, m)
		}
		if len(models) > 0 {
			first = models[0]["id"]
			last = models[len(models)-1]["id"]
		}
		respond(w, 200, object{"data": out, "has_more": false, "first_id": first, "last_id": last})
		return
	}
	if r.Method != "POST" || (r.URL.Path != "/v1/messages" && r.URL.Path != "/v1/messages/count_tokens") {
		claudeError(w, 404, "Not found")
		return
	}
	body, err := readObject(r.Body, 256<<20)
	if err != nil {
		claudeError(w, 400, "Invalid JSON: "+err.Error())
		return
	}
	if r.URL.Path == "/v1/messages/count_tokens" {
		respond(w, 200, object{"input_tokens": estimateTokens(body)})
		return
	}
	request := anthropicToOpenAI(body)
	raw, err := a.discover(r.Context(), false)
	if err != nil {
		log.Printf("Claude model discovery: %v", err)
		request["model"] = defaultClaude
	} else {
		request["model"] = mapClaude(str(request["model"]), raw)
	}
	model := str(request["model"])
	if effort := str(request["reasoning_effort"]); effort != "" {
		a.mu.Lock()
		a.lastEffort = object{"source": "output_config.effort", "requested": nested(body, "output_config", "effort"), "effort": effort}
		a.mu.Unlock()
	}
	response, err := a.copilot(r.Context(), "POST", "/chat/completions", jsonBytes(request))
	if err != nil {
		claudeError(w, 502, err.Error())
		return
	}
	if response.StatusCode != 200 {
		data, e := readResponse(response, 16<<20)
		if e != nil {
			claudeError(w, 502, e.Error())
			return
		}
		var value object
		_ = json.Unmarshal(data, &value)
		message := str(nested(value, "error", "message"))
		if message == "" {
			message = str(value["message"])
		}
		if message == "" {
			message = string(data)
		}
		claudeError(w, response.StatusCode, message)
		return
	}
	if body["stream"] == true {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		err = translateStream(response.Body, w, model, estimateTokens(body))
		response.Body.Close()
		if err != nil {
			log.Printf("Claude upstream stream: %v", err)
		}
		return
	}
	data, err := readResponse(response, 64<<20)
	if err != nil {
		claudeError(w, 502, err.Error())
		return
	}
	var value object
	if json.Unmarshal(data, &value) != nil || value == nil {
		claudeError(w, 502, "Bad upstream JSON")
		return
	}
	respond(w, 200, anthropicResponse(value, model))
}

func timeISO() string { return time.Now().UTC().Format(time.RFC3339Nano) }
