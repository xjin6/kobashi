package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

const defaultClaude = "claude-sonnet-4.6"

func imagePart(source object) object {
	if source["type"] == "base64" && str(source["data"]) != "" {
		media := str(source["media_type"])
		if media == "" {
			media = "image/png"
		}
		return object{"type": "image_url", "image_url": object{"url": "data:" + media + ";base64," + str(source["data"])}}
	}
	if source["type"] == "url" && str(source["url"]) != "" {
		return object{"type": "image_url", "image_url": object{"url": source["url"]}}
	}
	return nil
}
func anthropicToOpenAI(req object) object {
	messages := []any{}
	if system := req["system"]; system != nil {
		text := str(system)
		if _, ok := system.(string); !ok {
			parts := []string{}
			for _, block := range arr(system) {
				parts = append(parts, str(obj(block)["text"]))
			}
			text = strings.Join(parts, "\n")
		}
		messages = append(messages, object{"role": "system", "content": text})
	}
	for _, value := range arr(req["messages"]) {
		m := obj(value)
		if text, ok := m["content"].(string); ok {
			messages = append(messages, object{"role": m["role"], "content": text})
			continue
		}
		parts, calls, results, images := []any{}, []any{}, []any{}, []any{}
		for _, value := range arr(m["content"]) {
			b := obj(value)
			switch b["type"] {
			case "text":
				parts = append(parts, object{"type": "text", "text": str(b["text"])})
			case "thinking":
				if str(b["thinking"]) != "" {
					parts = append(parts, object{"type": "text", "text": "[reasoning]\n" + str(b["thinking"])})
				}
			case "redacted_thinking":
				parts = append(parts, object{"type": "text", "text": "[reasoning redacted]"})
			case "image":
				if p := imagePart(obj(b["source"])); p != nil {
					parts = append(parts, p)
				}
			case "document":
				src := obj(b["source"])
				title := ""
				if str(b["title"]) != "" {
					title = " " + str(b["title"])
				}
				text := "[document" + title + " omitted — this backend cannot accept binary PDFs; ask the user to paste the relevant text]"
				if src["type"] == "text" && str(src["data"]) != "" {
					text = "[document" + title + "]\n" + str(src["data"])
				}
				if src["type"] == "content" && arr(src["content"]) != nil {
					texts := []string{}
					for _, x := range arr(src["content"]) {
						if obj(x)["type"] == "text" {
							texts = append(texts, str(obj(x)["text"]))
						}
					}
					text = "[document" + title + "]\n" + strings.Join(texts, "\n")
				}
				parts = append(parts, object{"type": "text", "text": text})
			case "tool_use":
				input := b["input"]
				if input == nil {
					input = object{}
				}
				calls = append(calls, object{"id": b["id"], "type": "function", "function": object{"name": b["name"], "arguments": string(jsonBytes(input))}})
			case "tool_result":
				blocks := arr(b["content"])
				if text, ok := b["content"].(string); ok {
					blocks = []any{object{"type": "text", "text": text}}
				}
				texts := []string{}
				for _, x := range blocks {
					block := obj(x)
					if block["type"] == "image" {
						if p := imagePart(obj(block["source"])); p != nil {
							images = append(images, p)
						}
					} else {
						texts = append(texts, str(block["text"]))
					}
				}
				text := strings.Join(texts, "\n")
				if text == "" && len(images) > 0 {
					text = "[image returned by tool — see attached image below]"
				}
				if b["is_error"] == true {
					text = "[tool error] " + text
				}
				results = append(results, object{"role": "tool", "tool_call_id": b["tool_use_id"], "content": text})
			}
		}
		if len(results) > 0 {
			messages = append(messages, results...)
			if len(images) > 0 {
				messages = append(messages, object{"role": "user", "content": images})
			}
			continue
		}
		msg := object{"role": m["role"]}
		hasImage := false
		texts := []string{}
		for _, p := range parts {
			if obj(p)["type"] == "image_url" {
				hasImage = true
			}
			texts = append(texts, str(obj(p)["text"]))
		}
		if hasImage {
			msg["content"] = parts
		} else if text := strings.Join(texts, "\n"); text != "" {
			msg["content"] = text
		}
		if len(calls) > 0 {
			msg["tool_calls"] = calls
			if msg["content"] == nil {
				msg["content"] = nil
			}
		}
		messages = append(messages, msg)
	}
	model := str(req["model"])
	if model == "" {
		model = defaultClaude
	}
	out := object{"model": model, "messages": messages, "stream": req["stream"] == true}
	if req["stream"] == true {
		out["stream_options"] = object{"include_usage": true}
	}
	for _, key := range []string{"max_tokens", "temperature", "top_p"} {
		if v, ok := req[key]; ok {
			out[key] = v
		}
	}
	if v, ok := req["stop_sequences"]; ok {
		out["stop"] = v
	}
	if user := nested(req, "metadata", "user_id"); user != nil {
		out["user"] = user
	}
	if effort := strings.ToLower(str(nested(req, "output_config", "effort"))); effort != "" {
		if !contains([]string{"low", "medium", "high", "xhigh", "max"}, effort) {
			if effort == "ultracode" || effort == "extra_high" {
				effort = "xhigh"
			} else {
				effort = "high"
			}
		}
		out["reasoning_effort"] = effort
	} else if nested(req, "thinking", "type") == "enabled" && nested(req, "thinking", "budget_tokens") != nil {
		budget := number(nested(req, "thinking", "budget_tokens"))
		effort := "max"
		if budget <= 4096 {
			effort = "low"
		} else if budget <= 9000 {
			effort = "medium"
		} else if budget <= 16000 {
			effort = "high"
		}
		out["reasoning_effort"] = effort
	}
	if tools := arr(req["tools"]); tools != nil {
		mapped := []any{}
		for _, t := range tools {
			tool := obj(t)
			mapped = append(mapped, object{"type": "function", "function": object{"name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"]}})
		}
		out["tools"] = mapped
	}
	if tc := obj(req["tool_choice"]); tc != nil {
		switch tc["type"] {
		case "auto":
			out["tool_choice"] = "auto"
		case "any":
			out["tool_choice"] = "required"
		case "none":
			out["tool_choice"] = "none"
		case "tool":
			if str(tc["name"]) != "" {
				out["tool_choice"] = object{"type": "function", "function": object{"name": tc["name"]}}
			}
		}
		if tc["disable_parallel_tool_use"] == true {
			out["parallel_tool_calls"] = false
		}
	}
	return out
}
func stopReason(reason string) string {
	switch reason {
	case "length":
		return "max_tokens"
	case "tool_calls":
		return "tool_use"
	default:
		return "end_turn"
	}
}
func anthropicResponse(oai object, model string) object {
	choice := object{}
	if choices := arr(oai["choices"]); len(choices) > 0 {
		choice = obj(choices[0])
	}
	msg := obj(choice["message"])
	content := []any{}
	if str(msg["reasoning_text"]) != "" {
		block := object{"type": "thinking", "thinking": msg["reasoning_text"]}
		if str(msg["reasoning_opaque"]) != "" {
			block["signature"] = msg["reasoning_opaque"]
		}
		content = append(content, block)
	}
	if str(msg["content"]) != "" {
		content = append(content, object{"type": "text", "text": msg["content"]})
	}
	for _, v := range arr(msg["tool_calls"]) {
		tc := obj(v)
		var input object
		_ = json.Unmarshal([]byte(str(nested(tc, "function", "arguments"))), &input)
		if input == nil {
			input = object{}
		}
		content = append(content, object{"type": "tool_use", "id": tc["id"], "name": nested(tc, "function", "name"), "input": input})
	}
	id := str(oai["id"])
	if id == "" {
		id = fmt.Sprintf("msg_%d", time.Now().UnixNano())
	}
	return object{"id": id, "type": "message", "role": "assistant", "model": model, "content": content, "stop_reason": stopReason(str(choice["finish_reason"])), "stop_sequence": nil,
		"usage": object{"input_tokens": number(nested(oai, "usage", "prompt_tokens")), "output_tokens": number(nested(oai, "usage", "completion_tokens")), "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
}
func estimateTokens(body object) int {
	chars := 0
	length := func(v any) int { return len(utf16.Encode([]rune(str(v)))) }
	if text, ok := body["system"].(string); ok {
		chars += length(text)
	} else {
		for _, b := range arr(body["system"]) {
			chars += length(obj(b)["text"])
		}
	}
	for _, t := range arr(body["tools"]) {
		tool := obj(t)
		chars += length(tool["name"]) + length(tool["description"])
		if tool["input_schema"] != nil {
			chars += length(string(jsonBytes(tool["input_schema"])))
		}
	}
	for _, v := range arr(body["messages"]) {
		m := obj(v)
		if text, ok := m["content"].(string); ok {
			chars += length(text)
			continue
		}
		for _, v := range arr(m["content"]) {
			b := obj(v)
			switch b["type"] {
			case "text":
				chars += length(b["text"])
			case "image":
				chars += 4000
			case "tool_use":
				input := b["input"]
				if input == nil {
					input = object{}
				}
				chars += length(string(jsonBytes(input))) + length(b["name"])
			case "tool_result":
				if text, ok := b["content"].(string); ok {
					chars += length(text)
				} else {
					v := b["content"]
					if v == nil {
						v = ""
					}
					chars += length(string(jsonBytes(v)))
				}
			}
		}
	}
	return max(1, (chars*2+4)/5)
}

var claudeDotted = regexp.MustCompile(`^(claude-[a-z]+-\d+)-(\d+)(.*)$`)
var decimalVersion = regexp.MustCompile(`(\d+)\.(\d+)`)

func claudeFacing(id string) string {
	oneM := strings.HasSuffix(strings.ToLower(id), "-1m")
	if oneM {
		id = id[:len(id)-3]
	}
	id = decimalVersion.ReplaceAllString(id, "$1-$2")
	if oneM {
		id += "[1m]"
	}
	return id
}
func claudeModels(raw []object) []object {
	out := []object{}
	seen := map[string]bool{}
	for _, m := range raw {
		id := str(m["id"])
		if !strings.Contains(strings.ToLower(id), "claude") {
			continue
		}
		facing := claudeFacing(id)
		if seen[facing] {
			continue
		}
		seen[facing] = true
		name := str(m["name"])
		if name == "" {
			name = id
		}
		out = append(out, object{"id": facing, "display_name": name, "copilot": id})
	}
	return out
}
func mapClaude(requested string, raw []object) string {
	for _, m := range claudeModels(raw) {
		if m["id"] == requested || m["copilot"] == requested {
			return str(m["copilot"])
		}
	}
	oneM := strings.HasSuffix(strings.ToLower(requested), "[1m]")
	stripped := requested
	if oneM {
		stripped = stripped[:len(stripped)-4]
	}
	dotted := claudeDotted.ReplaceAllString(stripped, "$1.$2$3")
	if oneM {
		for _, m := range raw {
			if m["id"] == dotted+"-1m" {
				return str(m["id"])
			}
		}
	}
	for _, m := range raw {
		if m["id"] == dotted {
			return dotted
		}
	}
	family := ""
	for _, f := range []string{"sonnet", "opus", "haiku"} {
		if strings.Contains(requested, "claude-"+f) {
			family = f
			break
		}
	}
	candidates := []string{}
	if family != "" {
		for _, m := range raw {
			if strings.Contains(str(m["id"]), "claude-"+family) {
				candidates = append(candidates, str(m["id"]))
			}
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool { return modelLess(candidates[i], candidates[j]) })
	if len(candidates) > 0 {
		return candidates[0]
	}
	return defaultClaude
}

type toolBlock struct {
	index    int
	id, name string
}

func translateStream(r io.Reader, w http.ResponseWriter, model string, estimate int) error {
	started := false
	finished := false
	next := 0
	thinking, text := -1, -1
	signature := ""
	tools := map[int]toolBlock{}
	input, output := float64(estimate), float64(0)
	reason := "end_turn"
	send := func(name string, data object) error {
		_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, jsonBytes(data))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return err
	}
	start := func() error {
		if started {
			return nil
		}
		started = true
		return send("message_start", object{"type": "message_start", "message": object{"id": fmt.Sprintf("msg_%d", time.Now().UnixNano()), "type": "message", "role": "assistant", "model": model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": object{"input_tokens": estimate, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}})
	}
	closeThinking := func() error {
		if thinking < 0 {
			return nil
		}
		if signature != "" {
			if err := send("content_block_delta", object{"type": "content_block_delta", "index": thinking, "delta": object{"type": "signature_delta", "signature": signature}}); err != nil {
				return err
			}
			signature = ""
		}
		err := send("content_block_stop", object{"type": "content_block_stop", "index": thinking})
		thinking = -1
		return err
	}
	err := readSSE(r, func(e sseEvent) error {
		for _, line := range e.lines {
			if strings.HasPrefix(line, "data:") && strings.TrimSpace(strings.TrimPrefix(line, "data:")) == "[DONE]" {
				finished = true
			}
		}
		v, _ := e.data()
		if v == nil {
			return nil
		}
		if upstreamError := parseError(v); upstreamError != nil {
			return fmt.Errorf("upstream stream error: %s", str(upstreamError["message"]))
		}
		if err := start(); err != nil {
			return err
		}
		choice := object{}
		if choices := arr(v["choices"]); len(choices) > 0 {
			choice = obj(choices[0])
		}
		delta := obj(choice["delta"])
		if usage := obj(v["usage"]); usage != nil {
			if n := number(usage["prompt_tokens"]); n > 0 {
				input = n
			}
			if n := number(usage["completion_tokens"]); n > 0 {
				output = n
			}
		}
		if s := str(delta["reasoning_text"]); s != "" {
			if thinking < 0 {
				thinking = next
				next++
				if err := send("content_block_start", object{"type": "content_block_start", "index": thinking, "content_block": object{"type": "thinking", "thinking": "", "signature": ""}}); err != nil {
					return err
				}
			}
			if err := send("content_block_delta", object{"type": "content_block_delta", "index": thinking, "delta": object{"type": "thinking_delta", "thinking": s}}); err != nil {
				return err
			}
		}
		if s := str(delta["reasoning_opaque"]); s != "" {
			signature = s
		}
		if s := str(delta["content"]); s != "" {
			if err := closeThinking(); err != nil {
				return err
			}
			if text < 0 {
				text = next
				next++
				if err := send("content_block_start", object{"type": "content_block_start", "index": text, "content_block": object{"type": "text", "text": ""}}); err != nil {
					return err
				}
			}
			if err := send("content_block_delta", object{"type": "content_block_delta", "index": text, "delta": object{"type": "text_delta", "text": s}}); err != nil {
				return err
			}
		}
		if arr(delta["tool_calls"]) != nil {
			if err := closeThinking(); err != nil {
				return err
			}
			for _, v := range arr(delta["tool_calls"]) {
				tc := obj(v)
				key := int(number(tc["index"]))
				block, ok := tools[key]
				if !ok {
					block = toolBlock{index: next, id: str(tc["id"]), name: str(nested(tc, "function", "name"))}
					next++
					if block.id == "" {
						block.id = fmt.Sprintf("tool_%d", block.index)
					}
					tools[key] = block
					if err := send("content_block_start", object{"type": "content_block_start", "index": block.index, "content_block": object{"type": "tool_use", "id": block.id, "name": block.name, "input": object{}}}); err != nil {
						return err
					}
				}
				if args := str(nested(tc, "function", "arguments")); args != "" {
					if err := send("content_block_delta", object{"type": "content_block_delta", "index": block.index, "delta": object{"type": "input_json_delta", "partial_json": args}}); err != nil {
						return err
					}
				}
			}
		}
		if finish := str(choice["finish_reason"]); finish != "" {
			reason = stopReason(finish)
			finished = true
		}
		return nil
	})
	if err == nil && !finished {
		err = errors.New("upstream stream ended before completion")
	}
	if err != nil {
		_ = send("error", object{"type": "error", "error": object{"type": "api_error", "message": err.Error()}})
		return err
	}
	if err = start(); err != nil {
		return err
	}
	if err = closeThinking(); err != nil {
		return err
	}
	indexes := []int{}
	if text >= 0 {
		indexes = append(indexes, text)
	}
	for _, b := range tools {
		indexes = append(indexes, b.index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		if err = send("content_block_stop", object{"type": "content_block_stop", "index": index}); err != nil {
			return err
		}
	}
	if err = send("message_delta", object{"type": "message_delta", "delta": object{"stop_reason": reason, "stop_sequence": nil}, "usage": object{"input_tokens": input, "output_tokens": output, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}); err != nil {
		return err
	}
	return send("message_stop", object{"type": "message_stop"})
}
