package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func fixtureValue(v any) any {
	if buffer := obj(v); buffer["type"] == "Buffer" {
		data := []byte{}
		for _, n := range arr(buffer["data"]) {
			data = append(data, byte(number(n)))
		}
		var value any
		if json.Unmarshal(data, &value) == nil {
			return value
		}
		return string(data)
	}
	if s, ok := v.(string); ok {
		var value any
		if json.Unmarshal([]byte(s), &value) == nil {
			return value
		}
	}
	return v
}
func objectList(v any, key string) []object {
	v = fixtureValue(v)
	if m := obj(v); m != nil {
		v = m[key]
	}
	out := []object{}
	for _, x := range arr(v) {
		if m := obj(x); m != nil {
			out = append(out, m)
		}
	}
	return out
}
func canonicalSSE(t *testing.T, data string) []any {
	t.Helper()
	out := []any{}
	if err := readSSE(strings.NewReader(data), func(e sseEvent) error {
		value, _ := e.data()
		if value != nil {
			lines := []string{}
			for _, line := range e.lines {
				if !strings.HasPrefix(line, "data:") {
					lines = append(lines, line)
				}
			}
			out = append(out, object{"lines": lines, "data": value, "separator": e.separator})
		} else {
			out = append(out, object{"lines": e.lines, "separator": e.separator})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestExistingBehaviorParity(t *testing.T) {
	data, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Operation string
		Args      []any
		Expected  any
	}
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) < 100 {
		t.Fatal("missing parity coverage")
	}
	for i, f := range fixtures {
		t.Run(fmt.Sprintf("%03d/%s", i, f.Operation), func(t *testing.T) {
			arg := func(n int) any {
				if n < len(f.Args) {
					return f.Args[n]
				}
				return nil
			}
			var result any
			expected := f.Expected
			switch f.Operation {
			case "injectCodexConfig":
				result = injectConfig(str(arg(0)), int(number(arg(1))), str(obj(arg(2))["modelCatalogPath"]))
			case "restoreCodexConfigContents":
				result = restoreConfig(str(arg(0)), str(arg(1)), str(obj(arg(2))["modelCatalogPath"]))
			case "isKobashiManagedConfig":
				result = managedConfig(str(arg(0)))
				if result == true && arg(1) != nil {
					port := fmt.Sprintf(":%d", int(number(arg(1))))
					result = strings.Contains(str(arg(0)), port+"/") || strings.Contains(str(arg(0)), port+`"`)
				}
			case "isKobashiManagedAuth":
				source := jsonBytes(arg(0))
				if s, ok := arg(0).(string); ok {
					source = []byte(s)
				}
				result = managedAuth(source)
			case "selectCopilotOpenAIModels":
				result = selectModels(objectList(arg(0), "data"))
			case "getCopilotReasoningEfforts":
				result = efforts(obj(arg(0)))
			case "buildKobashiModelCatalog":
				models := objectList(arg(1), "data")
				// Catalog fixtures describe already verified capabilities.
				for _, model := range models {
					model["kobashi_verified"] = object{"multiAgentV2": true}
				}
				result = buildCatalog(objectList(arg(0), "models"), models)
			case "normalizeCodexRequest":
				if obj(arg(0)) == nil {
					result = arg(0)
					expected = obj(expected)["body"]
					break
				}
				options := obj(arg(1))
				rules := constraints{}
				body := obj(arg(0))
				for _, m := range objectList(options["copilotModels"], "data") {
					if m["id"] == body["model"] {
						if values := efforts(m); len(values) > 0 {
							rules["reasoning.effort"] = values
						}
					}
				}
				for key, value := range obj(options["constraints"]) {
					if value == nil {
						rules[key] = nil
					} else {
						rules[key] = stringsOf(value)
					}
				}
				result, _ = applyConstraints(body, rules)
				expected = obj(expected)["body"]
			case "retryCodexRequest":
				next, rules, changed := repairRequest(obj(arg(0)), obj(fixtureValue(arg(1))))
				if !changed {
					rules = constraints{}
				}
				result = object{"body": next, "constraints": rules}
				expected = object{"body": obj(expected)["body"], "constraints": obj(expected)["constraints"]}
			case "isModelUnavailable":
				result = modelUnavailable(int(number(arg(0))), obj(fixtureValue(arg(1))))
			case "responsesSSE":
				var b bytes.Buffer
				if err := normalizeSSE(strings.NewReader(str(arg(0))), &b, func(object) {}); err != nil {
					t.Fatal(err)
				}
				result = canonicalSSE(t, b.String())
				expected = canonicalSSE(t, str(expected))
			default:
				t.Fatalf("unknown operation %s", f.Operation)
			}
			if !bytes.Equal(jsonBytes(result), jsonBytes(expected)) {
				t.Errorf("got %s\nwant %s", jsonBytes(result), jsonBytes(expected))
			}
		})
	}
}
