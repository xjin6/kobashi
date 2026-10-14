package bridge

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

type textRange struct{ start, end int }
type tomlTable struct {
	textRange
	path string
}
type tomlAssignment struct {
	textRange
	key   string
	table *tomlTable
}
type tomlScan struct {
	tables      []*tomlTable
	assignments []*tomlAssignment
}
type tomlState struct {
	quote         string
	square, curly int
}

var assignmentPattern = regexp.MustCompile(`^\s*([A-Za-z0-9_-]+)\s*=`)
var providerPattern = regexp.MustCompile(`(?i)^\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*$`)
var localProviderPattern = regexp.MustCompile(`(?i)^https?://127\.0\.0\.1:\d+(?:/|$)`)

func (s *tomlState) neutral() bool { return s.quote == "" && s.square == 0 && s.curly == 0 }
func (s *tomlState) scan(line string) {
	for i := 0; i < len(line); {
		c := line[i]
		if s.quote != "" {
			if s.quote[0] == '"' && c == '\\' {
				i += 2
			} else if strings.HasPrefix(line[i:], s.quote) {
				q := s.quote[0]
				i += len(s.quote)
				if len(s.quote) == 3 {
					for i < len(line) && line[i] == q {
						i++
					}
				}
				s.quote = ""
			} else {
				i++
			}
			continue
		}
		if c == '#' {
			break
		}
		if strings.HasPrefix(line[i:], `"""`) || strings.HasPrefix(line[i:], `'''`) {
			s.quote = line[i : i+3]
			i += 3
			continue
		}
		switch c {
		case '"', '\'':
			s.quote = string(c)
		case '[':
			s.square++
		case ']':
			if s.square > 0 {
				s.square--
			}
		case '{':
			s.curly++
		case '}':
			if s.curly > 0 {
				s.curly--
			}
		}
		i++
	}
	if len(s.quote) == 1 {
		s.quote = ""
	}
}
func tableHeader(line string) (string, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "[") {
		return "", false
	}
	open, close := 1, "]"
	if strings.HasPrefix(line, "[[") {
		open, close = 2, "]]"
	}
	var quote byte
	for i := open; i < len(line); i++ {
		if quote != 0 {
			if quote == '"' && line[i] == '\\' {
				i++
				continue
			}
			if line[i] == quote {
				quote = 0
			}
			continue
		}
		if line[i] == '"' || line[i] == '\'' {
			quote = line[i]
			continue
		}
		if strings.HasPrefix(line[i:], close) {
			rest := strings.TrimSpace(line[i+len(close):])
			if rest == "" || strings.HasPrefix(rest, "#") {
				return line[open:i], true
			}
			return "", false
		}
	}
	return "", false
}
func scanToml(source string) tomlScan {
	out := tomlScan{}
	state := tomlState{}
	var current *tomlTable
	var active *tomlAssignment
	for start := 0; start < len(source); {
		end := len(source)
		if n := strings.IndexByte(source[start:], '\n'); n >= 0 {
			end = start + n + 1
		}
		line := strings.TrimRight(source[start:end], "\r\n")
		if state.neutral() {
			if path, ok := tableHeader(line); ok {
				if current != nil {
					current.end = start
				}
				current = &tomlTable{textRange{start, len(source)}, path}
				out.tables = append(out.tables, current)
				active = nil
				start = end
				continue
			}
			if m := assignmentPattern.FindStringSubmatch(line); m != nil {
				active = &tomlAssignment{textRange{start, end}, strings.ToLower(m[1]), current}
				out.assignments = append(out.assignments, active)
			}
		}
		state.scan(line)
		if active != nil {
			active.end = end
			if state.neutral() {
				active = nil
			}
		}
		start = end
	}
	return out
}
func assignmentValue(source string, a *tomlAssignment) string {
	value := strings.TrimSpace(strings.SplitN(source[a.start:a.end], "=", 2)[1])
	if len(value) == 0 || (value[0] != '"' && value[0] != '\'') {
		return ""
	}
	for i := 1; i < len(value); i++ {
		if value[0] == '"' && value[i] == '\\' {
			i++
			continue
		}
		if value[i] != value[0] {
			continue
		}
		rest := strings.TrimSpace(value[i+1:])
		if rest != "" && !strings.HasPrefix(rest, "#") {
			return ""
		}
		if value[0] == '\'' {
			return value[1:i]
		}
		var s string
		if json.Unmarshal([]byte(value[:i+1]), &s) == nil {
			return s
		}
		return ""
	}
	return ""
}
func providerName(t *tomlTable) string {
	m := providerPattern.FindStringSubmatch(t.path)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1] + m[2] + m[3])
}
func kobashiProvider(s string) bool { return s == "kobashi" || s == "copilot-bridge" }
func managedTable(source string, scan tomlScan, t *tomlTable) bool {
	if !kobashiProvider(providerName(t)) {
		return false
	}
	for _, a := range scan.assignments {
		if a.table == t && a.key == "base_url" {
			return localProviderPattern.MatchString(assignmentValue(source, a))
		}
	}
	return false
}
func managedConfig(source string) bool {
	source = strings.TrimPrefix(source, "\ufeff")
	scan := scanToml(source)
	for _, a := range scan.assignments {
		if a.table != nil || a.key != "model_provider" {
			continue
		}
		name := strings.ToLower(assignmentValue(source, a))
		for _, t := range scan.tables {
			if name == providerName(t) && managedTable(source, scan, t) {
				return true
			}
		}
	}
	return false
}
func removeRanges(source string, ranges []textRange) string {
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	var out strings.Builder
	cursor := 0
	for _, r := range ranges {
		if r.start > cursor {
			out.WriteString(source[cursor:r.start])
		}
		if r.end > cursor {
			cursor = r.end
		}
	}
	out.WriteString(source[cursor:])
	return out.String()
}
func sourceParts(s string) (bom, body, newline string) {
	body, newline = s, "\n"
	if strings.HasPrefix(s, "\ufeff") {
		bom, body = "\ufeff", s[len("\ufeff"):]
	}
	if strings.Contains(body, "\r\n") {
		newline = "\r\n"
	}
	return
}
func hasRoot(scan tomlScan, key string) bool {
	for _, a := range scan.assignments {
		if a.table == nil && a.key == key {
			return true
		}
	}
	return false
}
func markedDefault(key, value string) string { return key + " = " + value + " # Kobashi default" }
func injectConfig(source string, port int, catalog string) string {
	bom, body, nl := sourceParts(source)
	scan := scanToml(body)
	ranges := []textRange{}
	for _, a := range scan.assignments {
		if a.table != nil {
			continue
		}
		text := strings.TrimSpace(body[a.start:a.end])
		if a.key == "model_provider" || (a.key == "base_url" && strings.Contains(assignmentValue(body, a), "127.0.0.1")) ||
			text == markedDefault("model_context_window", "1000000") || text == markedDefault("model_auto_compact_token_limit", "900000") {
			ranges = append(ranges, a.textRange)
		}
	}
	for _, t := range scan.tables {
		if kobashiProvider(providerName(t)) {
			ranges = append(ranges, t.textRange)
		}
	}
	cleaned := removeRanges(body, ranges)
	cleanScan := scanToml(cleaned)
	offset := len(cleaned)
	if len(cleanScan.tables) > 0 {
		offset = cleanScan.tables[0].start
	}
	top := `model_provider = "kobashi"` + nl
	if catalog != "" && !hasRoot(cleanScan, "model_catalog_json") {
		top += markedDefault("model_catalog_json", string(jsonBytes(catalog))) + nl
	}
	prefix := top + cleaned[:offset]
	if !strings.HasSuffix(prefix, nl+nl) {
		if !strings.HasSuffix(prefix, nl) {
			prefix += nl
		}
		prefix += nl
	}
	// Codex gates account visibility on this flag; the explicit bearer still isolates inference auth.
	block := fmt.Sprintf("[model_providers.kobashi]%sname = \"Kobashi\"%sbase_url = \"http://127.0.0.1:%d/v1\"%sexperimental_bearer_token = \"PROXY_MANAGED\"%srequires_openai_auth = true%swire_api = \"responses\"", nl, nl, port, nl, nl, nl)
	if offset < len(cleaned) {
		return bom + prefix + block + nl + nl + cleaned[offset:]
	}
	return bom + prefix + block + nl
}
func restoreConfig(live, backup, catalog string) string {
	bom, body, nl := sourceParts(live)
	if managedConfig(backup) {
		backup = ""
	}
	_, saved, _ := sourceParts(backup)
	scan, savedScan := scanToml(body), scanToml(saved)
	names := map[string]bool{}
	ranges := []textRange{}
	for _, t := range scan.tables {
		if managedTable(body, scan, t) {
			names[providerName(t)] = true
			ranges = append(ranges, t.textRange)
		}
	}
	defaults := map[string]string{"model_context_window": "1000000", "model_auto_compact_token_limit": "900000"}
	if catalog != "" {
		defaults["model_catalog_json"] = string(jsonBytes(catalog))
	}
	for _, a := range scan.assignments {
		if a.table != nil {
			continue
		}
		if a.key == "model_provider" && names[strings.ToLower(assignmentValue(body, a))] {
			ranges = append(ranges, a.textRange)
		}
		if v, ok := defaults[a.key]; ok && !hasRoot(savedScan, a.key) && strings.TrimSpace(body[a.start:a.end]) == markedDefault(a.key, v) {
			ranges = append(ranges, a.textRange)
		}
	}
	restored := removeRanges(body, ranges)
	resultScan := scanToml(restored)
	if !hasRoot(resultScan, "model_provider") {
		for _, a := range savedScan.assignments {
			if a.table == nil && a.key == "model_provider" {
				restored = strings.TrimRight(saved[a.start:a.end], "\r\n") + nl + restored
				break
			}
		}
	}
	resultScan = scanToml(restored)
	existing := map[string]bool{}
	for _, t := range resultScan.tables {
		existing[providerName(t)] = true
	}
	blocks := []string{}
	for _, t := range savedScan.tables {
		if kobashiProvider(providerName(t)) && !existing[providerName(t)] {
			blocks = append(blocks, strings.TrimRight(saved[t.start:t.end], "\r\n"))
		}
	}
	if len(blocks) > 0 {
		offset := len(restored)
		if len(resultScan.tables) > 0 {
			offset = resultScan.tables[0].start
		}
		prefix := restored[:offset]
		if prefix != "" && !strings.HasSuffix(prefix, nl+nl) {
			prefix = strings.TrimRight(prefix, "\r\n") + nl + nl
		}
		suffix := restored[offset:]
		restored = prefix + strings.Join(blocks, nl+nl) + nl
		if suffix != "" {
			restored += nl + suffix
		}
	}
	return bom + restored
}
