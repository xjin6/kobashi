package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type modelEntry struct {
	Model     object `json:"model"`
	Native    object `json:"native"`
	Signature string `json:"signature"`
}
type modelRecord struct {
	ID                   string      `json:"id"`
	Signature            string      `json:"signature"`
	State                string      `json:"state"`
	Constraints          constraints `json:"constraints"`
	CheckedAt            int64       `json:"checkedAt"`
	CheckedEffort        any         `json:"checkedEffort,omitempty"`
	Reason               any         `json:"reason"`
	VerifiedModel        object      `json:"verifiedModel,omitempty"`
	VerifiedNative       object      `json:"verifiedNative"`
	MultiAgentV2Verified bool        `json:"multiAgentV2Verified"`
	Revision             uint64      `json:"revision,omitempty"`
}
type modelCache struct {
	Version int            `json:"version"`
	Account string         `json:"account"`
	Records []*modelRecord `json:"records"`
	Latest  []modelEntry   `json:"latest"`
}
type modelRegistry struct {
	mu                             sync.Mutex
	wg                             sync.WaitGroup
	app                            *App
	account                        string
	generation                     uint64
	latest                         map[string]modelEntry
	records                        map[string]*modelRecord
	bundled                        []object
	roundCancel                    context.CancelFunc
	sessionStarted, awaitingClient bool
	discoveryDone                  chan struct{}
	active, queued                 int
	semaphore                      chan struct{}
}

func newModelRegistry(a *App) *modelRegistry {
	return &modelRegistry{app: a, latest: map[string]modelEntry{}, records: map[string]*modelRecord{}, semaphore: make(chan struct{}, 2)}
}
func digest(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	hash := sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte{'\n'}))
	return hex.EncodeToString(hash[:])
}

var internalModelPattern = regexp.MustCompile(`(?i)\binternal(?:\s+only)?\b`)
var openAIIDPattern = regexp.MustCompile(`(?i)^(?:gpt(?:-|$)|o\d+(?:-|$))`)
var versionPattern = regexp.MustCompile(`\d+`)
var gptVersionPattern = regexp.MustCompile(`(?i)^gpt-(\d+)(?:[.-](\d+))?(?:[.-](\d+))?`)
var oVersionPattern = regexp.MustCompile(`(?i)^o(\d+)(?:[.-](\d+))?`)
var openAIVendorPattern = regexp.MustCompile(`(?i)\bopenai\b`)

func selectModels(models []object) []object {
	seen := map[string]bool{}
	out := []object{}
	for _, m := range models {
		id := strings.TrimSpace(str(m["id"]))
		vendor := strings.ToLower(str(m["vendor"]))
		if id == "" || seen[id] || internalModelPattern.MatchString(id+" "+str(m["name"])+" "+str(m["description"])) {
			continue
		}
		if !openAIVendorPattern.MatchString(vendor) && !(vendor == "" && openAIIDPattern.MatchString(id)) {
			continue
		}
		if picker, ok := m["model_picker_enabled"]; ok && picker != true {
			continue
		}
		if policy := strings.ToLower(str(nested(m, "policy", "state"))); policy != "" && policy != "enabled" {
			continue
		}
		if !contains(stringsOf(m["supported_endpoints"]), "/responses") || nested(m, "capabilities", "type") != "chat" ||
			nested(m, "capabilities", "supports", "streaming") != true || nested(m, "capabilities", "supports", "tool_calls") != true {
			continue
		}
		seen[id] = true
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool { return modelLess(str(out[i]["id"]), str(out[j]["id"])) })
	return out
}
func modelVersion(id string) []int {
	if parts := gptVersionPattern.FindStringSubmatch(id); parts != nil {
		return []int{3, int(number(parts[1])), int(number(parts[2])), int(number(parts[3]))}
	}
	if parts := oVersionPattern.FindStringSubmatch(id); parts != nil {
		return []int{2, int(number(parts[1])), int(number(parts[2])), 0}
	}
	v := []int{1, 0, 0, 0}
	for i, n := range versionPattern.FindAllString(id, 3) {
		v[i+1] = int(number(n))
	}
	return v
}
func variantRank(id string) int {
	for i, word := range []string{"astra", "sol", "terra", "luna", "codex"} {
		if strings.Contains(strings.ToLower(id), word) {
			return 80 - i*10
		}
	}
	if strings.Contains(strings.ToLower(id), "mini") {
		return 10
	}
	return 30
}
func modelLess(a, b string) bool {
	x, y := modelVersion(a), modelVersion(b)
	for i := range x {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	if variantRank(a) != variantRank(b) {
		return variantRank(a) > variantRank(b)
	}
	return a < b
}
func efforts(model object) []string {
	given := stringsOf(nested(model, "capabilities", "supports", "reasoning_effort"))
	out := []string{}
	for _, value := range protocolValues["reasoning.effort"] {
		for _, g := range given {
			if strings.EqualFold(value, g) {
				out = append(out, value)
				break
			}
		}
	}
	return out
}
func (m *modelRegistry) setAccount(identity string) {
	account := ""
	if identity != "" {
		account = digest(identity)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if account == m.account {
		return
	}
	if m.roundCancel != nil {
		m.roundCancel()
	}
	m.account = account
	m.generation++
	m.latest = map[string]modelEntry{}
	m.records = map[string]*modelRecord{}
	m.sessionStarted = false
	m.awaitingClient = false
	m.queued = 0
	if account != "" {
		data, err := readOptional(m.app.path("codex-model-capabilities.json"))
		if err != nil {
			log.Printf("Capability cache: %v", err)
		}
		var cache modelCache
		if data != nil && json.Unmarshal(data, &cache) == nil && cache.Version == 1 && cache.Account == account {
			for _, r := range cache.Records {
				if r.ID != "" && r.Signature != "" && contains([]string{"verified", "unavailable", "unknown"}, r.State) && r.CheckedAt <= time.Now().UnixMilli() {
					if r.Constraints == nil {
						r.Constraints = constraints{}
					}
					m.records[r.ID] = r
				}
			}
			for _, entry := range cache.Latest {
				r := m.records[str(entry.Model["id"])]
				if len(selectModels([]object{entry.Model})) > 0 && r != nil && r.Signature == entry.Signature {
					m.latest[r.ID] = entry
				}
			}
		}
	}
	m.persistLocked()
}
func (m *modelRegistry) persistLocked() {
	cache := modelCache{Version: 1, Account: m.account, Records: []*modelRecord{}, Latest: []modelEntry{}}
	for _, entry := range m.latest {
		cache.Latest = append(cache.Latest, entry)
	}
	for _, record := range m.records {
		cache.Records = append(cache.Records, record)
	}
	sort.Slice(cache.Records, func(i, j int) bool { return cache.Records[i].ID < cache.Records[j].ID })
	sort.Slice(cache.Latest, func(i, j int) bool { return str(cache.Latest[i].Model["id"]) < str(cache.Latest[j].Model["id"]) })
	if err := writeJSON(m.app.path("codex-model-capabilities.json"), cache); err != nil {
		log.Printf("Capability cache save: %v", err)
	}
	if m.account != "" {
		catalog := buildCatalog(m.bundled, m.visibleLocked())
		if len(arr(catalog["models"])) == 0 {
			sentinel := fallbackModel("kobashi-no-available-models", "No models available through GitHub Copilot", 1)
			sentinel["visibility"] = "hide"
			sentinel["supported_in_api"] = false
			catalog["models"] = []any{sentinel}
		}
		if err := writeJSON(m.app.path("codex-model-catalog.json"), catalog); err != nil {
			log.Printf("Model catalog save: %v", err)
		}
	}
}
func (m *modelRegistry) visibleLocked() []object {
	out := []object{}
	for id, entry := range m.latest {
		r := m.records[id]
		if r == nil || r.State != "verified" {
			continue
		}
		model := r.VerifiedModel
		if model == nil {
			model = entry.Model
		}
		model = clone(model)
		if rule, ok := r.Constraints["reasoning.effort"]; ok {
			support := obj(nested(model, "capabilities", "supports"))
			values := []any{}
			for _, s := range rule {
				values = append(values, s)
			}
			support["reasoning_effort"] = values
		}
		model["kobashi_verified"] = object{"native": r.VerifiedNative, "constraints": r.Constraints, "checkedAt": r.CheckedAt, "multiAgentV2": r.MultiAgentV2Verified}
		out = append(out, model)
	}
	return selectModels(out)
}
func (m *modelRegistry) visible() []object {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.visibleLocked()
}
func (m *modelRegistry) status() object {
	m.mu.Lock()
	defer m.mu.Unlock()
	unavailable := 0
	for _, r := range m.records {
		if r.State == "unavailable" {
			unavailable++
		}
	}
	return object{"verified": len(m.visibleLocked()), "discovered": len(m.latest), "checking": m.active, "queued": m.queued, "unavailable": unavailable}
}
func (m *modelRegistry) pause() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generation++
	m.sessionStarted = false
	m.awaitingClient = false
	m.queued = 0
	if m.roundCancel != nil {
		m.roundCancel()
	}
}
func (m *modelRegistry) token(id string) string {
	e, ok := m.latest[id]
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%s", m.generation, e.Signature)
}
func (m *modelRegistry) requestRules(id string) (constraints, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rules := constraints{}
	if e, ok := m.latest[id]; ok {
		if v := efforts(e.Model); len(v) > 0 {
			rules["reasoning.effort"] = v
		}
	}
	if r := m.records[id]; r != nil {
		for k, v := range r.Constraints {
			rules[k] = v
		}
	}
	return rules, m.token(id)
}
func (m *modelRegistry) observe(id, token string, status int, errorBody object, rules constraints) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if token == "" || m.token(id) != token {
		return
	}
	r := m.records[id]
	if r == nil {
		return
	}
	if len(rules) > 0 {
		for k, v := range rules {
			r.Constraints[k] = v
		}
		r.Revision++
	}
	if modelUnavailable(status, errorBody) {
		r.State = "unavailable"
		r.Reason = "model_unavailable"
		r.Revision++
	}
	if encryptedAgentError(errorBody) {
		r.MultiAgentV2Verified = false
		r.Revision++
	}
	m.persistLocked()
}
func (m *modelRegistry) ensureSession(ctx context.Context) error {
	m.mu.Lock()
	if m.sessionStarted {
		done := m.discoveryDone
		m.mu.Unlock()
		if done == nil {
			return nil
		}
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.mu.Unlock()
	return m.beginRound(ctx, true)
}
func (m *modelRegistry) beginRound(waitCtx context.Context, awaiting bool) error {
	m.mu.Lock()
	if err := m.app.ctx.Err(); err != nil {
		m.mu.Unlock()
		return err
	}
	if awaiting && m.sessionStarted {
		done := m.discoveryDone
		m.mu.Unlock()
		if done == nil {
			return nil
		}
		select {
		case <-done:
			return nil
		case <-waitCtx.Done():
			return waitCtx.Err()
		}
	}
	if m.roundCancel != nil {
		m.roundCancel()
	}
	m.generation++
	generation := m.generation
	ctx, cancel := context.WithCancel(m.app.ctx)
	m.roundCancel = cancel
	m.sessionStarted = true
	m.awaitingClient = awaiting
	m.queued = 0
	done := make(chan struct{})
	m.discoveryDone = done
	m.mu.Unlock()
	models, err := m.app.discover(ctx, true)
	catalogLoader := m.app.options.NativeCatalog
	if catalogLoader == nil {
		catalogLoader = loadNativeCatalog
	}
	native, nativeErr := catalogLoader(ctx, m.app.options.Home)
	if nativeErr != nil {
		log.Printf("Native Codex catalog unavailable: %v", nativeErr)
	}
	m.mu.Lock()
	close(done)
	if generation != m.generation || m.account == "" || ctx.Err() != nil {
		m.mu.Unlock()
		return ctx.Err()
	}
	if err != nil {
		m.mu.Unlock()
		log.Printf("Model discovery: %v", err)
		return err
	}
	m.bundled = native
	latest := map[string]modelEntry{}
	entries := []modelEntry{}
	for _, model := range selectModels(models) {
		id := str(model["id"])
		var template object
		for _, n := range native {
			if n["slug"] == id {
				template = n
				break
			}
		}
		caps := object{}
		for _, k := range []string{"id", "version", "vendor", "policy", "supported_endpoints", "capabilities"} {
			if v, ok := model[k]; ok {
				caps[k] = v
			}
		}
		entry := modelEntry{model, template, digest(object{"protocol": 1, "model": caps, "native": template})}
		latest[id] = entry
		previous := m.records[id]
		if previous == nil {
			previous = &modelRecord{ID: id, State: "unknown", Constraints: constraints{}}
			m.records[id] = previous
		}
		if previous.State == "verified" && previous.VerifiedModel == nil {
			previous.VerifiedModel = m.latest[id].Model
			if previous.VerifiedModel == nil {
				previous.VerifiedModel = model
			}
			previous.VerifiedNative = m.latest[id].Native
		}
		if previous.Signature != entry.Signature {
			previous.MultiAgentV2Verified = false
		}
		previous.Signature = entry.Signature
		entries = append(entries, entry)
	}
	m.latest = latest
	for id := range m.records {
		if _, ok := latest[id]; !ok {
			delete(m.records, id)
		}
	}
	m.queued = len(entries)
	m.persistLocked()
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		var workers sync.WaitGroup
		for _, entry := range entries {
			select {
			case m.semaphore <- struct{}{}:
			case <-ctx.Done():
				workers.Wait()
				return
			}
			m.mu.Lock()
			if generation != m.generation || ctx.Err() != nil {
				m.mu.Unlock()
				<-m.semaphore
				workers.Wait()
				return
			}
			r := m.records[str(entry.Model["id"])]
			revision := r.Revision
			m.active++
			m.queued--
			m.mu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() { <-m.semaphore }()
				result := m.app.probe(ctx, entry)
				m.mu.Lock()
				defer m.mu.Unlock()
				m.active--
				if generation != m.generation || ctx.Err() != nil {
					return
				}
				r := m.records[str(entry.Model["id"])]
				newEvidence := r.Revision != revision
				if newEvidence && r.State == "unavailable" {
					m.persistLocked()
					return
				}
				if newEvidence {
					for k, v := range r.Constraints {
						result.Constraints[k] = v
					}
					result.MultiAgentV2Verified = result.MultiAgentV2Verified && r.MultiAgentV2Verified
				}
				switch result.State {
				case "verified":
					r.State = "verified"
					r.Constraints = result.Constraints
					r.CheckedAt = time.Now().UnixMilli()
					r.CheckedEffort = result.CheckedEffort
					r.VerifiedModel = entry.Model
					r.VerifiedNative = entry.Native
					r.MultiAgentV2Verified = result.MultiAgentV2Verified
					r.Reason = nil
				case "unavailable":
					if !newEvidence {
						r.State = "unavailable"
						r.Constraints = result.Constraints
						r.CheckedAt = time.Now().UnixMilli()
						r.Reason = result.Reason
					}
				default:
					r.Reason = result.Reason
				}
				m.persistLocked()
			}()
		}
		workers.Wait()
	}()
	return nil
}
func (a *App) discover(ctx context.Context, force bool) ([]object, error) {
	a.discoveryMu.Lock()
	defer a.discoveryMu.Unlock()
	a.mu.RLock()
	previous, at, gen := a.rawModels, a.rawAt, a.accountGeneration
	a.mu.RUnlock()
	if !force && previous != nil && time.Since(at) < time.Minute {
		return previous, nil
	}
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	response, err := a.copilot(bounded, "GET", "/models", nil)
	var models []object
	if err == nil {
		data, e := readResponse(response, 4<<20)
		err = e
		if err == nil && response.StatusCode != 200 {
			err = fmt.Errorf("Copilot model list returned %d", response.StatusCode)
		}
		if err == nil {
			var raw struct {
				Data []object `json:"data"`
			}
			err = json.Unmarshal(data, &raw)
			if err == nil && raw.Data == nil {
				err = errors.New("Copilot model list has no data array")
			}
			models = raw.Data
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if gen != a.accountGeneration {
		return nil, errors.New("account changed during model discovery")
	}
	if err != nil {
		if previous != nil {
			log.Printf("Model refresh failed, retaining account snapshot: %v", err)
			return previous, nil
		}
		return nil, err
	}
	a.rawModels = models
	a.rawAt = time.Now()
	return models, nil
}
func (a *App) copilot(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	retried := false
	return a.copilotWithRetry(ctx, method, path, body, &retried)
}
func (a *App) copilotWithRetry(ctx context.Context, method, path string, body []byte, retried *bool) (*http.Response, error) {
	for {
		token, err := a.ensureToken(ctx)
		if err != nil {
			return nil, err
		}
		h := headers(token)
		if len(body) > 0 {
			var flags struct{ Stream bool }
			if json.Unmarshal(body, &flags) == nil && flags.Stream {
				h.Set("Accept", "text/event-stream")
			}
		}
		response, err := a.request(ctx, method, "https://api.githubcopilot.com"+path, body, h)
		if err != nil {
			return nil, err
		}
		if response.StatusCode != 401 && response.StatusCode != 400 {
			return response, nil
		}
		data, err := readResponse(response, 16<<20)
		if err != nil {
			return nil, err
		}
		if authFailure(response.StatusCode, data) {
			a.invalidateToken(token)
			if !*retried {
				*retried = true
				continue
			}
		}
		response.Body = io.NopCloser(bytes.NewReader(data))
		return response, nil
	}
}

const probeTool = "kobashi_capability_check"

func probeRequest(entry modelEntry) object {
	available := efforts(entry.Model)
	effort := ""
	if nativeHasUltra(entry.Native) {
		underlying := str(entry.Native["multi_agent_reasoning_effort"])
		if underlying == "" {
			underlying = "max"
		}
		if contains(available, underlying) {
			effort = underlying
		}
	}
	if effort == "" {
		for _, s := range []string{"low", "minimal", "none", "medium", "high", "xhigh", "max"} {
			if contains(available, s) {
				effort = s
				break
			}
		}
	}
	reasoning := object{"context": "all_turns"}
	if effort != "" {
		reasoning["effort"] = effort
	}
	out := object{"model": entry.Model["id"], "input": []any{object{"role": "user", "content": "Call " + probeTool + " with value OK. Do nothing else."}},
		"tools":       []any{object{"type": "function", "name": probeTool, "description": "Return the capability check result.", "parameters": object{"type": "object", "properties": object{"value": object{"type": "string", "enum": []any{"OK"}}}, "required": []any{"value"}, "additionalProperties": false}, "strict": true}},
		"tool_choice": object{"type": "function", "name": probeTool}, "parallel_tool_calls": true, "reasoning": reasoning,
		"include": []any{"reasoning.encrypted_content"}, "store": false, "stream": true, "max_output_tokens": 1024}
	if entry.Native["support_verbosity"] != false {
		out["text"] = object{"verbosity": "low"}
	}
	return out
}
func (a *App) probe(ctx context.Context, entry modelEntry) modelRecord {
	body := probeRequest(entry)
	result := modelRecord{State: "transient", Constraints: constraints{}, Reason: "network_or_timeout"}
	authRetried := false
	for attempt := 0; attempt < 4; attempt++ {
		bounded, cancel := context.WithTimeout(ctx, 45*time.Second)
		response, err := a.copilotWithRetry(bounded, "POST", "/v1/responses", jsonBytes(body), &authRetried)
		var data []byte
		if err == nil {
			data, err = readResponse(response, 512<<10)
		}
		cancel()
		if err != nil {
			log.Printf("Capability check %s: %v", str(entry.Model["id"]), err)
			return result
		}
		status := response.StatusCode
		completed, tool := false, false
		var errorBody object
		if status == 200 && strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
			inspect := func(item object) {
				if item["type"] == "function_call" && item["name"] == probeTool {
					var input object
					if json.Unmarshal([]byte(str(item["arguments"])), &input) == nil && input["value"] == "OK" {
						tool = true
					}
				}
			}
			err = readSSE(bytes.NewReader(data), func(e sseEvent) error {
				v, name := e.data()
				if v == nil {
					return nil
				}
				typ := str(v["type"])
				if typ == "" {
					typ = name
				}
				if typ == "response.output_item.done" {
					inspect(obj(v["item"]))
				}
				if typ == "response.completed" {
					completed = nested(v, "response", "status") == "completed"
					for _, item := range arr(nested(v, "response", "output")) {
						inspect(obj(item))
					}
				}
				if parseError(v) != nil {
					errorBody = v
				}
				if typ == "error" && errorBody == nil {
					errorBody = object{"error": v}
				}
				return nil
			})
		} else {
			_ = json.Unmarshal(data, &errorBody)
			if status == 200 {
				result.State = "unavailable"
				result.Reason = "streaming_not_observed"
				return result
			}
		}
		if status == 200 && completed && tool && errorBody == nil && err == nil {
			result.State = "verified"
			result.Reason = nil
			result.CheckedEffort = nested(body, "reasoning", "effort")
			if nativeHasUltra(entry.Native) || entry.Native["multi_agent_version"] == "v2" {
				result.MultiAgentV2Verified = a.probeAgentMessages(ctx, body, &authRetried)
			}
			return result
		}
		if (status == 400 || (status == 200 && errorBody != nil)) && attempt < 3 {
			next, rules, changed := repairRequest(body, errorBody)
			if changed {
				for k, v := range rules {
					result.Constraints[k] = v
				}
				body = next
				continue
			}
		}
		code := str(parseError(errorBody)["code"])
		transient := slices.Contains([]int{401, 408, 429}, status) || status >= 500 || contains([]string{"server_error", "rate_limit_exceeded", "overloaded", "insufficient_quota", "timeout"}, code) ||
			(status == 200 && !completed && errorBody == nil)
		result.Reason = code
		if code == "" {
			result.Reason = "probe_rejected"
		}
		if !transient {
			result.State = "unavailable"
		}
		return result
	}
	return result
}
func (a *App) probeAgentMessages(ctx context.Context, baseline object, authRetried *bool) bool {
	request := clone(baseline)
	message := "Kobashi agent check " + rand.Text()
	request["tool_choice"] = "auto"
	request["tools"] = []any{object{"type": "namespace", "name": "collaboration", "description": "Agent communication.",
		"tools": []any{object{"type": "function", "name": "send_message", "description": "Send an agent message.", "strict": false,
			"parameters": object{"type": "object", "properties": object{"target": object{"type": "string"},
				"message": object{"type": "string", "encrypted": true}},
				"required": []any{"target", "message"}, "additionalProperties": false}}}}}
	request["input"] = []any{object{"role": "user", "content": "Call collaboration.send_message exactly once with target /root and message " +
		string(jsonBytes(message)) + ". Do not answer or use other tools."}}
	send := func(body object) object {
		bounded, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		response, err := a.copilotWithRetry(bounded, "POST", "/v1/responses", jsonBytes(body), authRetried)
		if err != nil {
			log.Printf("Agent message check %s: %v", str(baseline["model"]), err)
			return nil
		}
		defer response.Body.Close()
		if response.StatusCode != 200 || !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
			log.Printf("Agent message check %s: HTTP %d without a successful stream", str(baseline["model"]), response.StatusCode)
			return nil
		}
		var completed object
		failed := false
		err = readSSE(io.LimitReader(response.Body, 512<<10), func(e sseEvent) error {
			v, name := e.data()
			typ := str(v["type"])
			if typ == "" {
				typ = name
			}
			if typ == "response.completed" {
				completed = obj(v["response"])
			}
			if typ == "response.failed" || typ == "response.incomplete" || typ == "error" {
				failed = true
			}
			if detail := parseError(v); detail != nil {
				failed = true
				log.Printf("Agent message check %s: %s", str(baseline["model"]), str(detail["code"]))
			}
			return nil
		})
		if err != nil {
			log.Printf("Agent message check %s: %v", str(baseline["model"]), err)
		}
		if err != nil || failed || completed["status"] != "completed" {
			return nil
		}
		return completed
	}
	first := send(request)
	var content []any
	for _, value := range arr(first["output"]) {
		call := obj(value)
		if call["type"] != "function_call" || call["namespace"] != "collaboration" || call["name"] != "send_message" {
			continue
		}
		var arguments object
		if json.Unmarshal([]byte(str(call["arguments"])), &arguments) != nil || arguments["target"] != "/root" {
			continue
		}
		payload := str(arguments["message"])
		if payload == "" {
			continue
		}
		if encrypted, ok := call["encrypted_function_args"].([]any); ok && len(encrypted) == 0 {
			content = []any{object{"type": "input_text", "text": payload}}
		} else {
			content = []any{object{"type": "encrypted_content", "encrypted_content": payload}}
		}
		break
	}
	if content == nil {
		log.Printf("Agent message check %s: no replayable message was returned", str(baseline["model"]))
		return false
	}
	delete(request, "tools")
	request["input"] = []any{object{"type": "agent_message", "author": "/root/worker", "recipient": "/root", "content": content},
		object{"role": "user", "content": "Repeat the exact agent message payload as plain text. Do not add anything or use tools."}}
	second := send(request)
	var text strings.Builder
	for _, value := range arr(second["output"]) {
		item := obj(value)
		if item["type"] != "message" || item["role"] != "assistant" {
			continue
		}
		for _, value := range arr(item["content"]) {
			if part := obj(value); part["type"] == "output_text" {
				text.WriteString(str(part["text"]))
			}
		}
	}
	verified := second != nil && strings.TrimSpace(text.String()) == message
	if !verified {
		log.Printf("Agent message check %s: full message replay was not verified; keeping V1 delegation without Ultra", str(baseline["model"]))
	}
	return verified
}
func loadNativeCatalog(ctx context.Context, home string) ([]object, error) {
	scratch, err := os.MkdirTemp("", "kobashi-codex-catalog-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(scratch)
	commands := append(codexCommands(home), "codex")
	commands = append(commands, filepath.Join(home, ".local", "bin", "codex"), filepath.Join(home, ".npm-global", "bin", "codex"))
	var last error
	for _, command := range commands {
		if strings.ContainsAny(command, `\/`) {
			if _, err := os.Stat(command); err != nil {
				continue
			}
		}
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		cmd := exec.CommandContext(bounded, command, "debug", "models", "--bundled")
		cmd.Env = replaceEnv(os.Environ(), "CODEX_HOME", scratch)
		hideCommand(cmd)
		out, e := cmd.Output()
		cancel()
		if e != nil {
			last = e
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		var catalog struct {
			Models []object `json:"models"`
		}
		if json.Unmarshal(out, &catalog) == nil && catalog.Models != nil {
			return catalog.Models, nil
		}
		last = errors.New("native Codex catalog is invalid")
	}
	if last == nil {
		last = errors.New("Codex executable not found")
	}
	return nil, last
}
func replaceEnv(env []string, key, value string) []string {
	out := []string{}
	for _, s := range env {
		if !strings.HasPrefix(strings.ToUpper(s), strings.ToUpper(key)+"=") {
			out = append(out, s)
		}
	}
	return append(out, key+"="+value)
}
func nativeHasUltra(n object) bool {
	for _, level := range arr(n["supported_reasoning_levels"]) {
		if obj(level)["effort"] == "ultra" {
			return true
		}
	}
	return false
}
func fallbackModel(id, name string, priority int) object {
	return object{"slug": id, "display_name": name, "description": name + " (available through GitHub Copilot).", "default_reasoning_level": nil, "supported_reasoning_levels": []any{},
		"shell_type": "unified_exec", "visibility": "list", "supported_in_api": true, "priority": priority, "additional_speed_tiers": []any{}, "service_tiers": []any{},
		"availability_nux": nil, "upgrade": nil, "include_skills_usage_instructions": true, "include_plugin_usage_instructions": true, "include_apps_usage_instructions": true,
		"default_reasoning_summary": "auto", "support_verbosity": true, "apply_patch_tool_type": "freeform", "web_search_tool_type": "text_and_image",
		"truncation_policy": object{"mode": "tokens", "limit": 10000}, "supports_image_detail_original": true, "context_window": 272000, "max_context_window": 272000,
		"effective_context_window_percent": 95, "experimental_supported_tools": []any{}, "input_modalities": []any{"text", "image"}, "supports_search_tool": true, "use_responses_lite": true,
		"base_instructions": "You are Codex, an agentic coding assistant. Follow developer and user instructions, use the available tools when helpful, and work carefully in the user's workspace."}
}
func usableNative(n object) bool {
	_, api := n["supported_in_api"].(bool)
	_, verbosity := n["support_verbosity"].(bool)
	_, instructions := n["base_instructions"].(string)
	_, instructionTemplate := nested(n, "model_messages", "instructions_template").(string)
	_, priority := n["priority"].(float64)
	if _, integer := n["priority"].(int); integer {
		priority = true
	}
	return str(n["slug"]) != "" && str(n["display_name"]) != "" && arr(n["supported_reasoning_levels"]) != nil &&
		str(n["shell_type"]) != "" && str(n["visibility"]) != "" && api && priority &&
		verbosity && obj(n["truncation_policy"]) != nil && arr(n["experimental_supported_tools"]) != nil &&
		(instructions || instructionTemplate)
}
func buildCatalog(bundled, models []object) object {
	out := []any{}
	for i, model := range selectModels(models) {
		id := str(model["id"])
		name := str(model["name"])
		if name == "" {
			name = id
		}
		verified := obj(model["kobashi_verified"])
		template := obj(verified["native"])
		exact := template != nil
		if _, has := verified["native"]; !has {
			for _, n := range bundled {
				if n["slug"] == id && usableNative(n) {
					template = n
					exact = true
					break
				}
			}
		}
		if template == nil {
			candidates := []object{}
			for _, n := range bundled {
				if n["slug"] != id && usableNative(n) {
					candidates = append(candidates, n)
				}
			}
			small := func(s string) bool { return strings.Contains(s, "mini") || strings.Contains(s, "luna") }
			sort.SliceStable(candidates, func(a, b int) bool {
				left, right := str(candidates[a]["slug"]), str(candidates[b]["slug"])
				if (small(left) == small(id)) != (small(right) == small(id)) {
					return small(left) == small(id)
				}
				distance := func(s string) int {
					x, y := modelVersion(s), modelVersion(id)
					return abs(x[1]-y[1])*1000 + abs(x[2]-y[2])*10 + abs(x[3]-y[3])
				}
				if distance(left) != distance(right) {
					return distance(left) < distance(right)
				}
				return modelLess(left, right)
			})
			if len(candidates) > 0 {
				template = candidates[0]
			}
		}
		record := fallbackModel(id, name, i+1)
		if template != nil {
			record = clone(template)
		}
		record["slug"] = id
		record["visibility"] = "list"
		record["supported_in_api"] = true
		record["priority"] = i + 1
		record["availability_nux"] = nil
		record["upgrade"] = nil
		if !exact {
			record["display_name"] = name
			record["description"] = name + " (available through GitHub Copilot)."
		}
		available := efforts(model)
		multiAgentV2 := verified["multiAgentV2"] == true
		if !multiAgentV2 && (nativeHasUltra(template) || template["multi_agent_version"] == "v2") {
			record["multi_agent_version"] = "v1"
		}
		underlying := str(template["multi_agent_reasoning_effort"])
		if underlying == "" {
			underlying = "max"
		}
		if exact && multiAgentV2 && nativeHasUltra(template) && contains(available, underlying) {
			available = append(available, "ultra")
		}
		levels := []any{}
		for _, effort := range available {
			description := map[string]string{"none": "No reasoning", "minimal": "Fastest responses with minimal reasoning", "low": "Fast responses with lighter reasoning", "medium": "Balances speed and reasoning depth for everyday tasks", "high": "Greater reasoning depth for complex problems", "xhigh": "Extra high reasoning depth for complex problems", "max": "Maximum reasoning depth for the hardest problems", "ultra": "Maximum reasoning with automatic task delegation"}[effort]
			for _, level := range arr(template["supported_reasoning_levels"]) {
				if obj(level)["effort"] == effort && str(obj(level)["description"]) != "" {
					description = str(obj(level)["description"])
					break
				}
			}
			levels = append(levels, object{"effort": effort, "description": description})
		}
		record["supported_reasoning_levels"] = levels
		record["default_reasoning_level"] = nil
		if preferred := str(template["default_reasoning_level"]); contains(available, preferred) {
			record["default_reasoning_level"] = preferred
		} else {
			for _, e := range []string{"medium", "low", "high", "minimal", "none", "xhigh", "max", "ultra"} {
				if contains(available, e) {
					record["default_reasoning_level"] = e
					break
				}
			}
		}
		contextWindow := number(template["context_window"])
		if contextWindow <= 0 {
			contextWindow = 272000
		}
		compact := number(template["auto_compact_token_limit"])
		maxContext, maxPrompt := number(nested(model, "capabilities", "limits", "max_context_window_tokens")), number(nested(model, "capabilities", "limits", "max_prompt_tokens"))
		if maxContext >= 1000000 {
			contextWindow = 1000000
			compact = 900000
			if maxPrompt > 0 && maxPrompt < compact {
				compact = maxPrompt
			}
		} else if maxPrompt > 0 || maxContext > 0 {
			contextWindow = maxPrompt
			if contextWindow <= 0 {
				contextWindow = maxContext
			}
			compact = 0
		}
		record["context_window"] = int(contextWindow)
		record["max_context_window"] = int(contextWindow)
		if compact > 0 {
			record["auto_compact_token_limit"] = int(compact)
		} else {
			delete(record, "auto_compact_token_limit")
		}
		rules, ok := verified["constraints"].(constraints)
		if !ok && obj(verified["constraints"]) != nil {
			rules = constraints{}
			for key, value := range obj(verified["constraints"]) {
				if value == nil {
					rules[key] = nil
				} else {
					rules[key] = stringsOf(value)
				}
			}
			ok = true
		}
		if ok {
			if v, has := rules["text.verbosity"]; has && v == nil {
				record["support_verbosity"] = false
			}
			if v, has := rules["reasoning.summary"]; has {
				if v == nil {
					record["default_reasoning_summary"] = "none"
				} else if !contains(v, str(record["default_reasoning_summary"])) && len(v) > 0 {
					record["default_reasoning_summary"] = v[0]
					if contains(v, "auto") {
						record["default_reasoning_summary"] = "auto"
					}
				}
			}
		}
		out = append(out, record)
	}
	return object{"models": out}
}
func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
