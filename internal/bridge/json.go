package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type object = map[string]any

func obj(v any) object {
	m, _ := v.(map[string]any)
	return m
}
func arr(v any) []any {
	a, _ := v.([]any)
	return a
}
func str(v any) string {
	s, _ := v.(string)
	return s
}
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}
func nested(v any, keys ...string) any {
	for _, k := range keys {
		v = obj(v)[k]
	}
	return v
}
func contains(a []string, s string) bool {
	for _, v := range a {
		if s == v {
			return true
		}
	}
	return false
}
func stringsOf(v any) []string {
	out := []string{}
	for _, x := range arr(v) {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func clone(v object) object {
	b, _ := json.Marshal(v)
	var m object
	decoder := json.NewDecoder(strings.NewReader(string(b)))
	decoder.UseNumber()
	_ = decoder.Decode(&m)
	return m
}
func jsonBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
func readOptional(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}
func removeOptional(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceFile(name, path)
}
func writeJSON(path string, data any) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(b, '\n'))
}
func readObject(r io.Reader, limit int64) (object, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("JSON body exceeds %d bytes", limit)
	}
	var v object
	decoder := json.NewDecoder(strings.NewReader(string(b)))
	decoder.UseNumber()
	if err = decoder.Decode(&v); err != nil {
		return nil, err
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("unexpected data after JSON object")
	}
	if v == nil {
		return nil, errors.New("expected a JSON object")
	}
	return v, nil
}
