//go:build windows

package desktop

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/xjin6/kobashi/internal/bridge"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
func ownWindow() uintptr {
	h := uintptr(0)
	for {
		h = proc("FindWindowExW", 0, h, uintptr(unsafe.Pointer(wide("KobashiNativeWindow"))), 0)
		if h == 0 {
			return 0
		}
		var pid uint32
		proc("GetWindowThreadProcessId", h, uintptr(unsafe.Pointer(&pid)))
		if pid == uint32(os.Getpid()) {
			return h
		}
	}
}
func waitFor(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("native UI did not reach expected state")
}
func TestNativeWindowControlsSizeSettingsAndTrayLifecycle(t *testing.T) {
	if proc("FindWindowW", uintptr(unsafe.Pointer(wide("Shell_TrayWnd"))), 0) == 0 {
		t.Skip("native tray checks require a Windows graphical login session")
	}
	home := t.TempDir()
	a, err := bridge.New(bridge.Options{Home: home, CodexHome: filepath.Join(home, ".codex"), Desktop: true,
		Ports: bridge.Ports{Codex: freePort(t), Control: freePort(t), Claude: freePort(t)}, Startup: func(bool) error { return nil },
		ReadEnvironment:  func(string) (*string, error) { t.Fatal("unexpected user environment access"); return nil, nil },
		WriteEnvironment: func(string, *string) error { t.Fatal("unexpected user environment mutation"); return nil }})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- Run(a, true) }()
	t.Cleanup(func() {
		if h := ownWindow(); h != 0 {
			proc("PostMessageW", h, 0x111, idQuit, 0)
		}
		_ = a.Stop()
	})
	waitFor(t, func() bool { return ownWindow() != 0 })
	h := ownWindow()
	waitFor(t, func() bool { return proc("GetDlgItem", h, idTray) != 0 })
	var r rect
	proc("GetClientRect", h, uintptr(unsafe.Pointer(&r)))
	dpi := proc("GetDpiForWindow", h)
	if dpi == 0 {
		dpi = 96
	}
	if int(r.Right) != 400*int(dpi)/96 || int(r.Bottom) != 480*int(dpi)/96 {
		t.Fatal("incorrect fixed content dimensions", r, dpi)
	}
	suggested := rect{Left: 100, Top: 100}
	proc("SendMessageW", h, 0x2e0, 144<<16|144, uintptr(unsafe.Pointer(&suggested)))
	proc("GetClientRect", h, uintptr(unsafe.Pointer(&r)))
	if r.Right != 600 || r.Bottom != 720 {
		t.Fatal("DPI changes did not preserve logical dimensions", r)
	}
	proc("SendMessageW", h, 0x2e0, dpi<<16|dpi, uintptr(unsafe.Pointer(&suggested)))
	style := proc("GetWindowLongW", h, ^uintptr(15))
	if style&(0x40000|0x10000) != 0 {
		t.Fatal("resize or maximize enabled")
	}
	for id, class := range map[int]string{idToken: "Edit", idStartup: "Button", idTray: "Button", idSettings: "Button"} {
		child := proc("GetDlgItem", h, uintptr(id))
		buf := make([]uint16, 64)
		proc("GetClassNameW", child, uintptr(unsafe.Pointer(&buf[0])), 64)
		if !strings.EqualFold(syscall.UTF16ToString(buf), class) {
			t.Fatal("non-native control", id)
		}
	}
	if proc("GetWindowLongW", proc("GetDlgItem", h, idToken), ^uintptr(15))&0x20 == 0 {
		t.Fatal("token field is not protected")
	}
	proc("SendMessageW", h, 0x111, idTokenView, 0)
	if proc("GetWindowLongW", proc("GetDlgItem", h, idConnect), ^uintptr(15))&0x10000000 == 0 || proc("GetWindowLongW", proc("GetDlgItem", h, idToken), ^uintptr(15))&0x10000000 == 0 {
		t.Fatal("token entry did not expand within the sign-in screen")
	}
	if proc("IsWindowEnabled", proc("GetDlgItem", h, idLogin)) != 0 {
		t.Fatal("empty tokens can be submitted")
	}
	proc("SetWindowTextW", proc("GetDlgItem", h, idToken), uintptr(unsafe.Pointer(wide("test input"))))
	if proc("IsWindowEnabled", proc("GetDlgItem", h, idLogin)) == 0 {
		t.Fatal("token typing did not enable Connect")
	}
	proc("SendMessageW", h, 0x111, idSettings, 0)
	for _, id := range []int{idStartup, idTray} {
		if proc("SendMessageW", proc("GetDlgItem", h, uintptr(id)), 0xf0, 0, 0) != 1 {
			t.Fatal("settings are not enabled by default", id)
		}
	}
	proc("SendMessageW", proc("GetDlgItem", h, idStartup), 0xf5, 0, 0)
	waitFor(t, func() bool { return !a.Settings().StartAtLogin })
	if data, err := os.ReadFile(filepath.Join(home, ".kobashi", "settings.json")); err != nil || !strings.Contains(string(data), `"startAtLogin": false`) {
		t.Fatal("setting was not persisted", err)
	}
	proc("SendMessageW", h, 0x111, idDone, 0)
	if proc("GetWindowLongW", proc("GetDlgItem", h, idDone), ^uintptr(15))&0x10000000 != 0 ||
		proc("GetWindowLongW", proc("GetDlgItem", h, idConnect), ^uintptr(15))&0x10000000 == 0 {
		t.Fatal("Done did not close Settings without quitting")
	}
	if a.Settings().StartAtLogin {
		t.Fatal("Done discarded the saved setting")
	}
	proc("SendMessageW", h, 0x111, idSettings, 0)
	proc("PostMessageW", h, 0x100, 0x1b, 0)
	waitFor(t, func() bool {
		return proc("GetWindowLongW", proc("GetDlgItem", h, idDone), ^uintptr(15))&0x10000000 == 0
	})
	proc("SendMessageW", h, 0x111, idSettings, 0)
	proc("ShowWindow", h, 4)
	proc("SendMessageW", h, 0x10, 0, 0)
	if proc("IsWindowVisible", h) != 0 {
		t.Fatal("close did not hide to tray")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", a.ControlURL()+"/api/status", nil)
	req.Header.Set("Authorization", "Bearer "+a.ControlToken())
	client := http.Client{Transport: &http.Transport{Proxy: nil}}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal("bridge stopped after close", err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	proc("ShowWindow", h, 4)
	if proc("IsWindowVisible", h) == 0 {
		t.Fatal("window cannot be restored")
	}
	waitFor(t, func() bool { return proc("IsWindowEnabled", proc("GetDlgItem", h, idTray)) != 0 })
	proc("SendMessageW", proc("GetDlgItem", h, idTray), 0xf5, 0, 0)
	waitFor(t, func() bool { return !a.Settings().CloseToTray })
	proc("SendMessageW", h, 0x10, 0, 0)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("native quit did not finish")
	}
	if ownWindow() != 0 {
		t.Fatal("native window survived quit")
	}
	select {
	case <-a.Closed():
	default:
		t.Fatal("bridge was not stopped by native close")
	}
}
