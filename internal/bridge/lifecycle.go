package bridge

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type processInfo struct {
	PID, Parent                        int
	Started, Executable, Name, Command string
}
type clientProcess struct {
	Key         string
	ProcessKeys []string
}

var argumentPattern = regexp.MustCompile(`"[^"]*"|'[^']*'|\S+`)
var macDesktopPattern = regexp.MustCompile(`(?i)/(?:ChatGPT|Codex)\.app/Contents/MacOS/[^/]+$`)

func processClient(p processInfo) bool {
	name := strings.ToLower(filepath.Base(strings.ReplaceAll(p.Executable, `\`, "/")))
	if p.Executable == "" {
		name = strings.ToLower(p.Name)
	}
	if p.Started == "" || !contains([]string{"codex", "codex.exe", "chatgpt", "chatgpt.exe"}, name) {
		return false
	}
	if p.Command == "" {
		return macDesktopPattern.MatchString(p.Executable)
	}
	args := argumentPattern.FindAllString(p.Command, -1)
	if len(args) > 0 {
		args = args[1:]
	}
	for i := range args {
		args[i] = strings.Trim(args[i], `"'`)
		if strings.HasPrefix(args[i], "--type") || contains([]string{"--version", "--help", "-V", "-h"}, args[i]) {
			return false
		}
	}
	if macDesktopPattern.MatchString(p.Executable) {
		return true
	}
	values := []string{"-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "-i", "--image", "--enable", "--disable"}
	command := ""
	for i := 0; i < len(args); i++ {
		if contains(values, args[i]) {
			i++
			continue
		}
		if strings.HasPrefix(args[i], "-") {
			continue
		}
		command = args[i]
		break
	}
	if command == "app-server" {
		return !contains(args, "generate-ts") && !contains(args, "generate-json-schema")
	}
	return !contains([]string{"debug", "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "features", "completion", "completions", "apply", "cloud", "responses-api-proxy"}, command)
}
func selectClients(processes []processInfo) []clientProcess {
	byPID := map[int]processInfo{}
	candidates := map[int]processInfo{}
	for _, p := range processes {
		byPID[p.PID] = p
		if processClient(p) {
			candidates[p.PID] = p
		}
	}
	groups := map[int][]string{}
	for _, p := range candidates {
		root, parent := p.PID, p.Parent
		seen := map[int]bool{root: true}
		for parent != 0 && !seen[parent] {
			if _, ok := candidates[parent]; ok {
				root = parent
			}
			seen[parent] = true
			parent = byPID[parent].Parent
		}
		groups[root] = append(groups[root], fmt.Sprintf("%d:%s", p.PID, p.Started))
	}
	out := []clientProcess{}
	for pid, keys := range groups {
		out = append(out, clientProcess{fmt.Sprintf("%d:%s", pid, candidates[pid].Started), keys})
	}
	return out
}
func (a *App) startWatcher() {
	a.watchOnce.Do(func() {
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			timer := time.NewTicker(5 * time.Second)
			defer timer.Stop()
			var previous map[string]bool
			poll := func() {
				if a.snapshot().Token == "" || !a.snapshot().Codex {
					previous = nil
					return
				}
				bounded, cancel := context.WithTimeout(a.ctx, 8*time.Second)
				processes, err := readProcesses(bounded)
				cancel()
				if err != nil {
					log.Printf("Client inspection: %v", err)
					return
				}
				clients := selectClients(processes)
				started := false
				for _, client := range clients {
					if !previous[client.Key] {
						started = true
					}
				}
				initial := previous == nil
				stopped := len(previous) > 0 && len(clients) == 0
				previous = map[string]bool{}
				for _, client := range clients {
					for _, key := range client.ProcessKeys {
						previous[key] = true
					}
				}
				if started {
					a.models.mu.Lock()
					adopt := a.models.sessionStarted && (initial || a.models.awaitingClient)
					a.models.awaitingClient = false
					a.models.mu.Unlock()
					if !adopt {
						if err := a.models.beginRound(a.ctx, false); err != nil {
							log.Printf("Startup model discovery: %v", err)
						}
					}
				} else if stopped {
					a.models.pause()
				}
			}
			poll()
			for {
				select {
				case <-a.ctx.Done():
					return
				case <-timer.C:
					poll()
					a.refreshUsage()
				}
			}
		}()
	})
}
func (a *App) refreshUsage() {
	a.mu.Lock()
	account, gen := a.state.Token, a.accountGeneration
	if account == "" || time.Since(a.usageAt) < time.Minute {
		a.mu.Unlock()
		return
	}
	a.usageAt = time.Now()
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	status, value, err := a.github(ctx, "/copilot_internal/user", account)
	if err != nil {
		log.Printf("Usage refresh: %v", err)
		return
	}
	if status != 200 {
		log.Printf("Usage refresh returned %d", status)
		return
	}
	snapshot := obj(nested(value, "quota_snapshots", "premium_interactions"))
	if snapshot == nil {
		return
	}
	entitlement := number(snapshot["entitlement"])
	usage := object{"creditsUsed": number(snapshot["credits_used"]), "entitlement": entitlement, "unlimited": snapshot["unlimited"] == true || entitlement <= 0, "resetDate": value["quota_reset_date_utc"]}
	if usage["resetDate"] == nil {
		usage["resetDate"] = value["quota_reset_date"]
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.accountGeneration == gen {
		a.usage = usage
	}
}
