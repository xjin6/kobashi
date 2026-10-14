package bridge

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func replaceFile(source, target string) error { return os.Rename(source, target) }
func hideCommand(cmd *exec.Cmd)               {}
func xmlString(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func configureStartup(options Options, enabled bool) error {
	path := filepath.Join(options.Home, "Library", "LaunchAgents", "com.xjin6.kobashi.plist")
	if !enabled {
		return removeOptional(path)
	}
	if options.AppPath == "" {
		return errors.New("start at login requires the installed Kobashi.app")
	}
	contents := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.xjin6.kobashi</string>
<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>` + xmlString(options.AppPath) + `</string><string>--args</string><string>--startup</string></array>
<key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>
`
	return writeAtomic(path, []byte(contents))
}
func osCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}
func systemProxy() (*url.URL, error) {
	out, err := osCommand("/usr/sbin/scutil", "--proxy")
	if err != nil {
		return nil, err
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	for _, kind := range []string{"HTTPS", "HTTP", "SOCKS"} {
		if fields[kind+"Enable"] == "1" && fields[kind+"Proxy"] != "" && fields[kind+"Port"] != "" {
			scheme := "http"
			if kind == "SOCKS" {
				scheme = "socks5"
			}
			return url.Parse(scheme + "://" + fields[kind+"Proxy"] + ":" + fields[kind+"Port"])
		}
	}
	return nil, nil
}
func readUserEnvironment(key string) (*string, error) {
	out, err := osCommand("/bin/launchctl", "getenv", key)
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 && len(out) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value := strings.TrimRight(string(out), "\r\n")
	if value == "" {
		return nil, nil
	}
	return &value, nil
}
func writeUserEnvironment(key string, value *string) error {
	args := []string{"unsetenv", key}
	if value != nil {
		args = []string{"setenv", key, *value}
	}
	_, err := osCommand("/bin/launchctl", args...)
	return err
}
func codexCommands(home string) []string {
	out := []string{}
	for _, root := range []string{"/Applications/ChatGPT.app", "/Applications/Codex.app", filepath.Join(home, "Applications", "ChatGPT.app"), filepath.Join(home, "Applications", "Codex.app")} {
		out = append(out, filepath.Join(root, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"), filepath.Join(root, "Contents", "Resources", "codex"))
	}
	return append(out, "/opt/homebrew/bin/codex", "/usr/local/bin/codex")
}

var processLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$`)

func readProcesses(ctx context.Context) ([]processInfo, error) {
	cmd := exec.CommandContext(ctx, "/bin/ps", "-axo", "pid=,ppid=,lstart=,comm=")
	cmd.Env = replaceEnv(os.Environ(), "LC_ALL", "C")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	rows := []processInfo{}
	ids := []string{}
	for _, line := range strings.Split(string(output), "\n") {
		m := processLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		parent, _ := strconv.Atoi(m[2])
		rows = append(rows, processInfo{PID: pid, Parent: parent, Started: m[3], Executable: m[4]})
		if contains([]string{"codex", "chatgpt"}, strings.ToLower(filepath.Base(m[4]))) && !macDesktopPattern.MatchString(m[4]) {
			ids = append(ids, m[1])
		}
	}
	if len(ids) > 0 {
		out, err := exec.CommandContext(ctx, "/bin/ps", "-p", strings.Join(ids, ","), "-o", "pid=,args=").Output()
		var exit *exec.ExitError
		if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 1) {
			return nil, err
		}
		for _, line := range strings.Split(string(out), "\n") {
			var pid int
			trimmed := strings.TrimSpace(line)
			first, rest, ok := strings.Cut(trimmed, " ")
			if !ok {
				continue
			}
			if _, err := fmt.Sscanf(first, "%d", &pid); err != nil {
				continue
			}
			for i := range rows {
				if rows[i].PID == pid {
					rows[i].Command = strings.TrimSpace(rest)
					break
				}
			}
		}
	}
	return rows, nil
}
