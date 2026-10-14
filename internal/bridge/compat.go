package bridge

import (
	"regexp"
	"slices"
	"strings"
)

var protocolValues = map[string][]string{
	"reasoning.context": {"auto", "current_turn", "all_turns"},
	"reasoning.effort":  {"none", "minimal", "low", "medium", "high", "xhigh", "max"},
	"reasoning.summary": {"none", "auto", "concise", "detailed"},
	"text.verbosity":    {"low", "medium", "high"},
	// An unsupported service tier can be omitted, but never substituted.
	"service_tier": nil,
}

type constraints map[string][]string

var unknownParameter = regexp.MustCompile("(?i)^(?:Unknown|Unrecognized|Unsupported) parameter:\\s*['\"`]?([a-z][a-z0-9_.]*)['\"`]?\\.?$")
var unsupportedParameter = regexp.MustCompile("(?i)^(?:(?:The )?parameter\\s+)?['\"`]?([a-z][a-z0-9_.]*)['\"`]? is not supported\\.?$")
var rejectedValue = regexp.MustCompile("(?i)^Unsupported value:\\s*['\"‘’“”`]([^'\"‘’“”`]+)['\"‘’“”`]")
var supportedValues = regexp.MustCompile(`(?i)Supported values are:\s*(.+)$`)
var quotedValue = regexp.MustCompile("['\"‘’“”`]([^'\"‘’“”`\\r\\n]+)['\"‘’“”`]")

func effortRank(s string) int {
	if i := slices.Index(protocolValues["reasoning.effort"], s); i >= 0 {
		return i
	}
	if s == "ultra" {
		return 6
	}
	return 4
}
func chooseValue(field, wanted string, allowed []string) string {
	if contains(allowed, wanted) {
		return wanted
	}
	if field == "reasoning.context" || field == "reasoning.summary" {
		order := []string{"current_turn", "auto", "all_turns"}
		if field == "reasoning.summary" {
			order = []string{"auto", "concise", "detailed", "none"}
		}
		for _, s := range order {
			if contains(allowed, s) {
				return s
			}
		}
	}
	rank := effortRank(wanted)
	ordered := slices.Clone(allowed)
	slices.SortFunc(ordered, func(a, b string) int { return effortRank(a) - effortRank(b) })
	selected := ""
	for _, s := range ordered {
		if effortRank(s) <= rank {
			selected = s
		}
	}
	if rank > 0 && (selected == "" || selected == "none") {
		for _, s := range ordered {
			if effortRank(s) > 0 {
				return s
			}
		}
	}
	if selected != "" {
		return selected
	}
	return allowed[0]
}
func applyConstraints(body object, rules constraints) (object, bool) {
	var out object
	for field, values := range protocolValues {
		keys := strings.Split(field, ".")
		original, ok := nested(body, keys...).(string)
		if !ok {
			continue
		}
		rule, exists := rules[field]
		if !exists {
			continue
		}
		allowed := []string{}
		for _, s := range values {
			if contains(rule, s) {
				allowed = append(allowed, s)
			}
		}
		if rule != nil && len(allowed) == 0 {
			continue
		}
		next := ""
		if rule != nil {
			next = chooseValue(field, strings.ToLower(original), allowed)
		}
		if rule != nil && next == original {
			continue
		}
		if out == nil {
			out = clone(body)
		}
		group, key := out, keys[0]
		if len(keys) > 1 {
			group, key = obj(out[keys[0]]), keys[1]
		}
		if rule == nil {
			delete(group, key)
		} else {
			group[key] = next
		}
		if len(keys) > 1 && len(group) == 0 {
			delete(out, keys[0])
		}
	}
	if out == nil {
		return body, false
	}
	return out, true
}
func parseError(v object) object {
	if e := obj(v["error"]); e != nil {
		return e
	}
	if e := obj(nested(v, "response", "error")); e != nil {
		return e
	}
	if v["type"] == "error" && str(v["message"]) != "" {
		return v
	}
	return nil
}
func encryptedAgentError(v object) bool {
	e := parseError(v)
	return e["code"] == "invalid_request_body" &&
		strings.TrimSpace(str(e["message"])) == "Encrypted function output content could not be decrypted or decoded."
}
func repairRequest(body, errorBody object) (object, constraints, bool) {
	e := parseError(errorBody)
	message := strings.TrimSpace(str(e["message"]))
	param := str(e["param"])
	for _, pattern := range []*regexp.Regexp{unknownParameter, unsupportedParameter} {
		if m := pattern.FindStringSubmatch(message); m != nil && (param == "" || param == m[1]) {
			_, known := protocolValues[m[1]]
			if known && nested(body, strings.Split(m[1], ".")...) != nil {
				rules := constraints{m[1]: nil}
				out, changed := applyConstraints(body, rules)
				return out, rules, changed
			}
		}
	}
	m := rejectedValue.FindStringSubmatch(message)
	if m == nil {
		return body, nil, false
	}
	supported := stringsOf(e["supported_values"])
	if len(supported) == 0 {
		if match := supportedValues.FindStringSubmatch(message); match != nil {
			for _, value := range quotedValue.FindAllStringSubmatch(match[1], -1) {
				supported = append(supported, value[1])
			}
		}
	}
	if len(supported) == 0 || contains(supported, m[1]) {
		return body, nil, false
	}
	candidates := []string{}
	for field, values := range protocolValues {
		keys := strings.Split(field, ".")
		if str(nested(body, keys...)) != m[1] || (param != "" && param != field) {
			continue
		}
		valid := true
		for _, s := range supported {
			if !contains(values, s) {
				valid = false
			}
		}
		if valid {
			candidates = append(candidates, field)
		}
	}
	if len(candidates) != 1 {
		return body, nil, false
	}
	rules := constraints{candidates[0]: supported}
	out, changed := applyConstraints(body, rules)
	return out, rules, changed
}
func authFailure(status int, body []byte) bool {
	if status == 401 {
		return true
	}
	if status != 400 {
		return false
	}
	s := strings.ToLower(string(body))
	for _, value := range []string{"not a valid api key", "authorization header is badly formatted", "invalid api key", "bad credentials", "token expired", "unauthorized"} {
		if strings.Contains(s, value) {
			return true
		}
	}
	return false
}
func modelUnavailable(status int, body object) bool {
	return slices.Contains([]int{400, 403, 404, 410}, status) && contains([]string{"model_not_found", "model_not_supported", "model_not_available", "model_access_denied", "model_retired"}, str(parseError(body)["code"]))
}
