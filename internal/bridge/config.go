package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func managedAuth(source []byte) bool {
	var v object
	return json.Unmarshal(source, &v) == nil && len(v) == 1 && v["OPENAI_API_KEY"] == "PROXY_MANAGED"
}
func (a *App) migrateCodexAuth() error {
	path := filepath.Join(a.options.CodexHome, "auth.json")
	live, err := readOptional(path)
	if err != nil || !managedAuth(live) {
		return err
	}
	backup, err := readOptional(path + ".bak")
	if err != nil {
		return err
	}
	if backup != nil {
		var saved object
		if json.Unmarshal(backup, &saved) != nil || saved == nil {
			return errors.New("invalid Codex login backup; recover the original login or sign in to Codex again")
		}
		apiKey := str(saved["OPENAI_API_KEY"])
		tokens := obj(saved["tokens"])
		if (apiKey != "" && apiKey != "PROXY_MANAGED") || (str(tokens["access_token"]) != "" && str(tokens["id_token"]) != "") {
			if err = writeAtomic(path, backup); err != nil {
				return err
			}
			return removeOptional(path + ".bak")
		}
	}
	if err = removeOptional(path); err != nil {
		return err
	}
	a.report(errors.New("Codex ChatGPT login could not be recovered; sign in to Codex again to use the plugin store"))
	return nil
}
func (a *App) migrateCodexEnvironment() error {
	records, err := a.environment()
	if err != nil {
		return err
	}
	_, recordedBase := records["OPENAI_BASE_URL"]
	legacyKey, err := a.readEnvironment("OPENAI_API_KEY")
	if err != nil {
		return err
	}
	if err = a.restoreEnvironment([]string{"OPENAI_API_KEY", "OPENAI_BASE_URL"}); err != nil {
		return err
	}
	live, err := a.readEnvironment("OPENAI_API_KEY")
	if err != nil {
		return err
	}
	if live != nil && *live == "PROXY_MANAGED" {
		if err = a.writeEnvironment("OPENAI_API_KEY", nil); err != nil {
			return err
		}
	}
	if !recordedBase && legacyKey != nil && *legacyKey == "PROXY_MANAGED" {
		base, err := a.readEnvironment("OPENAI_BASE_URL")
		if err != nil {
			return err
		}
		if base != nil && *base == fmt.Sprintf("http://127.0.0.1:%d/v1", a.options.Ports.Codex) {
			return a.writeEnvironment("OPENAI_BASE_URL", nil)
		}
	}
	return nil
}
func (a *App) injectCodex() error {
	state := a.snapshot()
	if !state.Codex || state.Token == "" {
		return nil
	}
	if err := a.migrateCodexAuth(); err != nil {
		return err
	}
	if err := a.migrateCodexEnvironment(); err != nil {
		return err
	}
	a.models.setAccount(state.Token)
	if len(a.models.visible()) == 0 {
		if err := a.models.ensureSession(a.ctx); err != nil {
			return err
		}
		a.models.wg.Wait()
	}
	if a.ctx.Err() != nil {
		return a.ctx.Err()
	}
	if a.snapshot().Token != state.Token || !a.snapshot().Codex {
		return errors.New("account changed during Codex preparation")
	}
	a.models.mu.Lock()
	a.models.persistLocked()
	a.models.mu.Unlock()
	if err := os.MkdirAll(a.options.CodexHome, 0700); err != nil {
		return err
	}
	configPath := filepath.Join(a.options.CodexHome, "config.toml")
	source, err := readOptional(configPath)
	if err != nil {
		return err
	}
	if source != nil && !managedConfig(string(source)) {
		if err = writeAtomic(configPath+".bak", source); err != nil {
			return err
		}
	} else if source == nil {
		backup, e := readOptional(configPath + ".bak")
		if e != nil {
			return e
		}
		source = backup
		if managedConfig(string(source)) {
			source = []byte(restoreConfig(string(source), "", a.path("codex-model-catalog.json")))
		}
	}
	if err = writeAtomic(configPath, []byte(injectConfig(string(source), a.options.Ports.Codex, a.path("codex-model-catalog.json")))); err != nil {
		return err
	}
	if err = a.injectEnvironment(map[string]string{"NO_PROXY": "127.0.0.1,localhost"}); err != nil {
		return err
	}
	a.startWatcher()
	return nil
}
func (a *App) restoreCodex() error {
	a.models.pause()
	configPath := filepath.Join(a.options.CodexHome, "config.toml")
	if err := a.migrateCodexAuth(); err != nil {
		return err
	}
	if err := a.migrateCodexEnvironment(); err != nil {
		return err
	}
	live, err := readOptional(configPath)
	if err != nil {
		return err
	}
	backup, err := readOptional(configPath + ".bak")
	if err != nil {
		return err
	}
	if live != nil {
		// Always preserve the file, including an empty user baseline.
		err = writeAtomic(configPath, []byte(restoreConfig(string(live), string(backup), a.path("codex-model-catalog.json"))))
	} else if backup != nil {
		recovered := string(backup)
		if managedConfig(recovered) {
			recovered = restoreConfig(recovered, "", a.path("codex-model-catalog.json"))
		}
		err = writeAtomic(configPath, []byte(recovered))
	}
	if err != nil {
		return err
	}
	return errors.Join(removeOptional(configPath+".bak"), a.restoreEnvironment([]string{"NO_PROXY"}))
}

var claudeOverrides = []string{"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS"}

func readSettingsObject(path string) (object, []byte, error) {
	b, err := readOptional(path)
	if err != nil {
		return nil, b, err
	}
	v := object{}
	if b != nil {
		if err = json.Unmarshal(b, &v); err != nil || v == nil {
			return nil, b, fmt.Errorf("invalid JSON configuration: %s", path)
		}
	}
	if env, ok := v["env"]; ok && obj(env) == nil {
		return nil, b, fmt.Errorf("configuration env must be an object: %s", path)
	}
	return v, b, nil
}
func (a *App) injectClaude() error {
	path := filepath.Join(a.options.Home, ".claude", "settings.json")
	live, source, err := readSettingsObject(path)
	if err != nil {
		return err
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", a.options.Ports.Claude)
	managed := nested(live, "env", "ANTHROPIC_BASE_URL") == base && nested(live, "env", "ANTHROPIC_AUTH_TOKEN") == "PROXY_MANAGED"
	if source != nil && !managed {
		if err = writeAtomic(path+".bak", source); err != nil {
			return err
		}
	}
	env := obj(live["env"])
	if env == nil {
		env = object{}
		live["env"] = env
	}
	env["ANTHROPIC_BASE_URL"] = base
	env["ANTHROPIC_AUTH_TOKEN"] = "PROXY_MANAGED"
	for _, key := range claudeOverrides {
		delete(env, key)
	}
	return writeJSON(path, live)
}
func (a *App) restoreClaude() error {
	path := filepath.Join(a.options.Home, ".claude", "settings.json")
	live, source, err := readSettingsObject(path)
	if err != nil {
		return err
	}
	saved, backup, err := readSettingsObject(path + ".bak")
	if err != nil {
		return err
	}
	if source == nil {
		if backup != nil {
			if err = writeAtomic(path, backup); err != nil {
				return err
			}
		}
		return removeOptional(path + ".bak")
	}
	env := obj(live["env"])
	previous := obj(saved["env"])
	for key, expected := range map[string]string{"ANTHROPIC_BASE_URL": fmt.Sprintf("http://127.0.0.1:%d", a.options.Ports.Claude), "ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED"} {
		if env[key] != expected {
			continue
		}
		if value, ok := previous[key]; ok {
			env[key] = value
		} else {
			delete(env, key)
		}
	}
	for _, key := range claudeOverrides {
		if _, exists := env[key]; !exists {
			if value, ok := previous[key]; ok {
				if env == nil {
					env = object{}
					live["env"] = env
				}
				env[key] = value
			}
		}
	}
	if len(env) == 0 {
		delete(live, "env")
	}
	if err = writeJSON(path, live); err != nil {
		return err
	}
	return removeOptional(path + ".bak")
}

type environmentRecord struct {
	Previous *string `json:"previous"`
	Injected string  `json:"injected"`
}

func (a *App) environment() (map[string]environmentRecord, error) {
	data, err := readOptional(a.path("environment.json"))
	if err != nil {
		return nil, err
	}
	out := map[string]environmentRecord{}
	if data != nil {
		err = json.Unmarshal(data, &out)
	}
	return out, err
}
func (a *App) injectEnvironment(values map[string]string) error {
	records, err := a.environment()
	if err != nil {
		return err
	}
	for key, value := range values {
		previous, err := a.readEnvironment(key)
		if err != nil {
			return err
		}
		if key == "NO_PROXY" && previous != nil && *previous != "" && *previous != value && *previous != records[key].Injected {
			value = *previous + ",127.0.0.1,localhost"
		}
		record, exists := records[key]
		if !exists || previous == nil || *previous != record.Injected {
			record = environmentRecord{Previous: previous}
		}
		record.Injected = value
		records[key] = record
		// Journal before mutation so cleanup remains possible after a failure.
		if err = writeJSON(a.path("environment.json"), records); err != nil {
			return err
		}
		if err = a.writeEnvironment(key, &value); err != nil {
			return err
		}
	}
	return nil
}
func (a *App) restoreEnvironment(keys []string) error {
	records, err := a.environment()
	if err != nil {
		return err
	}
	for _, key := range keys {
		record, exists := records[key]
		if !exists {
			continue
		}
		live, err := a.readEnvironment(key)
		if err != nil {
			return err
		}
		if live != nil && *live == record.Injected {
			if key == "OPENAI_API_KEY" && record.Previous != nil && *record.Previous == "PROXY_MANAGED" {
				record.Previous = nil
			}
			if err = a.writeEnvironment(key, record.Previous); err != nil {
				return err
			}
		}
		delete(records, key)
		if err = writeJSON(a.path("environment.json"), records); err != nil {
			return err
		}
	}
	if len(records) == 0 {
		return removeOptional(a.path("environment.json"))
	}
	return nil
}

func (a *App) readEnvironment(key string) (*string, error) {
	if a.options.ReadEnvironment != nil {
		return a.options.ReadEnvironment(key)
	}
	return readUserEnvironment(key)
}
func (a *App) writeEnvironment(key string, value *string) error {
	if a.options.WriteEnvironment != nil {
		return a.options.WriteEnvironment(key, value)
	}
	return writeUserEnvironment(key, value)
}
