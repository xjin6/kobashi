package bridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type sseEvent struct {
	lines     []string
	separator string
}

func (e sseEvent) data() (object, string) {
	data := []string{}
	name := ""
	for _, line := range e.lines {
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "data":
			data = append(data, value)
		case "event":
			name = value
		}
	}
	var v object
	if json.Unmarshal([]byte(strings.Join(data, "\n")), &v) != nil {
		return nil, name
	}
	return v, name
}
func (e sseEvent) withData(v object) sseEvent {
	lines := []string{}
	added := false
	for _, line := range e.lines {
		field, _, _ := strings.Cut(line, ":")
		if field == "data" {
			if !added {
				lines = append(lines, "data: "+string(jsonBytes(v)))
				added = true
			}
		} else {
			lines = append(lines, line)
		}
	}
	e.lines = lines
	return e
}
func readSSE(r io.Reader, consume func(sseEvent) error) error {
	reader := bufio.NewReader(r)
	lines := []string{}
	size := 0
	for {
		line, err := reader.ReadString('\n')
		size += len(line)
		if size > 16<<20 {
			return errors.New("SSE event exceeds 16 MiB")
		}
		nl := "\n"
		if strings.HasSuffix(line, "\r\n") {
			nl = "\r\n"
		}
		text := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if text == "" && len(line) > 0 {
			if e := consume(sseEvent{lines, nl}); e != nil {
				return e
			}
			lines = nil
			size = 0
		} else if len(line) > 0 {
			lines = append(lines, text)
		}
		if err != nil {
			if len(lines) > 0 {
				if e := consume(sseEvent{lines, ""}); e != nil {
					return e
				}
			}
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

type sseIDs struct {
	response string
	items    map[int][2]string
}

func (n *sseIDs) normalize(event object) bool {
	if n.items == nil {
		n.items = map[int][2]string{}
	}
	changed := false
	fix := func(owner object, key string, state *string) {
		if value := str(owner[key]); value != "" {
			if *state == "" {
				*state = value
			} else if value != *state {
				owner[key] = *state
				changed = true
			}
		}
	}
	item := func(v object, index int) {
		state := n.items[index]
		fix(v, "id", &state[0])
		fix(v, "call_id", &state[1])
		n.items[index] = state
	}
	if response := obj(event["response"]); response != nil {
		fix(response, "id", &n.response)
		for i, v := range arr(response["output"]) {
			item(obj(v), i)
		}
	}
	fix(event, "response_id", &n.response)
	if value, ok := event["output_index"].(float64); ok && value == float64(int(value)) {
		i := int(value)
		item(obj(event["item"]), i)
		state := n.items[i]
		fix(event, "item_id", &state[0])
		fix(event, "call_id", &state[1])
		n.items[i] = state
	}
	return changed
}
func normalizeSSE(r io.Reader, w io.Writer, onEvent func(object)) error {
	ids := sseIDs{}
	write := func(e sseEvent) error {
		event, name := e.data()
		if event != nil {
			if event["type"] == nil && name != "" {
				observed := clone(event)
				observed["type"] = name
				onEvent(observed)
			} else {
				onEvent(event)
			}
			if ids.normalize(event) {
				e = e.withData(event)
			}
		}
		nl := e.separator
		if nl == "" {
			nl = "\n"
		}
		text := strings.Join(e.lines, nl)
		if e.separator != "" {
			text += nl + nl
		}
		_, err := io.WriteString(w, text)
		if err == nil {
			if f, ok := w.(interface{ Flush() }); ok {
				f.Flush()
			}
		}
		return err
	}
	var pending *sseEvent
	err := readSSE(r, func(e sseEvent) error {
		event, name := e.data()
		kind := str(event["type"])
		if kind == "" {
			kind = name
		}
		if pending != nil {
			failure := *pending
			pending = nil
			if kind == "error" && event != nil {
				observed := clone(event)
				observed["type"] = kind
				if detail := parseError(observed); detail != nil {
					value, _ := failure.data()
					obj(value["response"])["error"] = clone(detail)
					failure = failure.withData(value)
				}
			}
			if err := write(failure); err != nil {
				return err
			}
		}
		// Copilot can send the failure details in the next error frame.
		if kind == "response.failed" && obj(event["response"]) != nil && parseError(event) == nil {
			pending = &e
			return nil
		}
		return write(e)
	})
	if pending != nil {
		err = errors.Join(err, write(*pending))
	}
	return err
}
