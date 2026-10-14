//go:build windows

package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"net/http"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/xjin6/kobashi/assets"
	"github.com/xjin6/kobashi/internal/bridge"
)

var user = syscall.NewLazyDLL("user32.dll")
var gdi = syscall.NewLazyDLL("gdi32.dll")
var shell = syscall.NewLazyDLL("shell32.dll")
var kernel = syscall.NewLazyDLL("kernel32.dll")
var active *Window

const eventMessage = 0x8001
const trayMessage = 0x8002
const (
	idConnect = 101 + iota
	idTokenView
	idToken
	idLogin
	idDone
	idCopy
	idBrowser
	idCodex
	idClaude
	idDisconnect
	idSettings
	idStartup
	idTray
	idQuit
	idTheme
	idProject
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type message struct {
	HWnd           uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          point
	Private        uint32
}
type windowClass struct {
	Size, Style                        uint32
	Procedure                          uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, Name                         *uint16
	SmallIcon                          uintptr
}
type notifyIcon struct {
	Size               uint32
	HWnd               uintptr
	ID, Flags, Message uint32
	Icon               uintptr
	Tip                [128]uint16
	State, StateMask   uint32
	Info               [256]uint16
	Version            uint32
	Title              [64]uint16
	InfoFlags          uint32
	GUID               [16]byte
	Balloon            uintptr
}
type control struct {
	handle     uintptr
	id         int
	view       string
	x, y, w, h int
	title      string
	class      string
	previous   uintptr
	hover      bool
}
type event struct {
	path     string
	value    map[string]any
	settings map[string]any
	err      error
}
type Window struct {
	app                                                                                        *bridge.App
	Handle                                                                                     uintptr
	controls                                                                                   []control
	view                                                                                       string
	notice, code, device, verification                                                         string
	deviceExpiry, nextPoll                                                                     time.Time
	interval                                                                                   time.Duration
	status, settings                                                                           map[string]any
	events                                                                                     chan event
	client                                                                                     *http.Client
	polling                                                                                    atomic.Bool
	busy                                                                                       bool
	focus                                                                                      uintptr
	tray                                                                                       bool
	dpi                                                                                        int
	font, heading, small, tiny, bold, codeFont, inputFont, symbolFont, icon, brush, inputBrush uintptr
	dark                                                                                       bool
	highContrast                                                                               bool
	foreground, background                                                                     uintptr
	palette                                                                                    palette
	artwork                                                                                    map[string]image.Image
	taskbar                                                                                    uint32
}

//go:uintptrescapes
func proc(name string, args ...uintptr) uintptr {
	value, _, _ := user.NewProc(name).Call(args...)
	return value
}
func wide(value string) *uint16 { p, _ := syscall.UTF16PtrFromString(value); return p }

func ShowError(message string) {
	proc("MessageBoxW", 0, uintptr(unsafe.Pointer(wide(message))), uintptr(unsafe.Pointer(wide("Kobashi"))), 0x10)
}
func FocusExisting() bool {
	h := proc("FindWindowW", uintptr(unsafe.Pointer(wide("KobashiNativeWindow"))), 0)
	if h == 0 {
		return false
	}
	proc("ShowWindow", h, 9)
	proc("SetForegroundWindow", h)
	return true
}
func OpenURL(address string) error {
	if !strings.HasPrefix(address, "https://") {
		return errors.New("only HTTPS links are allowed")
	}
	value, _, _ := shell.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(wide("open"))), uintptr(unsafe.Pointer(wide(address))), 0, 0, 1)
	if value <= 32 {
		return fmt.Errorf("could not open the browser (%d)", value)
	}
	return nil
}
func (w *Window) control(id int) uintptr {
	for _, c := range w.controls {
		if c.id == id {
			return c.handle
		}
	}
	return 0
}
func (w *Window) setText(id int, text string) {
	h := w.control(id)
	buffer := make([]uint16, proc("GetWindowTextLengthW", h)+1)
	proc("GetWindowTextW", h, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if syscall.UTF16ToString(buffer) == text {
		return
	}
	proc("SetWindowTextW", h, uintptr(unsafe.Pointer(wide(text))))
	proc("NotifyWinEvent", 0x800c, h, ^uintptr(3), 0)
	if id == 12 && text != "" && !strings.HasPrefix(text, "v") {
		proc("NotifyWinEvent", 2, h, ^uintptr(3), 0)
	}
}
func (w *Window) add(class, title, view string, id, x, y, width, height int, style uintptr) error {
	h, _, err := user.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(wide(class))), uintptr(unsafe.Pointer(wide(title))), 0x50000000|style, uintptr(x*w.dpi/96), uintptr(y*w.dpi/96), uintptr(width*w.dpi/96), uintptr(height*w.dpi/96), w.Handle, uintptr(id), 0, 0)
	if h == 0 {
		return fmt.Errorf("create %s control: %w", class, err)
	}
	w.controls = append(w.controls, control{handle: h, id: id, view: view, x: x, y: y, w: width, h: height, title: title, class: class})
	proc("SendMessageW", h, 0x30, w.font, 1)
	if class == "BUTTON" || class == "STATIC" || class == "EDIT" {
		previous := proc("SetWindowLongPtrW", h, ^uintptr(3), controlCallback)
		if previous == 0 {
			return fmt.Errorf("could not style %s control", title)
		}
		w.controls[len(w.controls)-1].previous = previous
	}
	return nil
}
func (w *Window) build() error {
	items := []struct {
		class, title, view      string
		id, x, y, width, height int
		style                   uintptr
	}{
		{"STATIC", "Kobashi", "all", 1, 28, 24, 170, 28, 0},
		{"BUTTON", "Se&ttings", "all", idSettings, 296, 24, 32, 32, 0x10000},
		{"BUTTON", "Toggle light/dark &mode", "all", idTheme, 336, 24, 32, 32, 0x10000},
		{"BUTTON", "Not &Connected", "sign-in", idConnect, 95, 244, 210, 42, 0x10000 | 1},
		{"STATIC", "Have an access token?", "idle", 3, 99, 303, 119, 24, 0},
		{"BUTTON", "Paste it instead", "idle", idTokenView, 218, 299, 91, 24, 0x10000},
		{"STATIC", "Access token", "token", 4, 60, 253, 280, 12, 0},
		{"EDIT", "", "token", idToken, 73, 274, 254, 22, 0x10000 | 0x80 | 0x20},
		{"BUTTON", "Not Connected", "token", idLogin, 60, 314, 280, 40, 0x10000 | 1},
		{"STATIC", "Enter this code at GitHub", "device", 5, 53, 203, 294, 20, 1},
		{"BUTTON", "Open GitHub", "device", idBrowser, 70, 230, 260, 24, 0x10000},
		{"STATIC", "", "device", 6, 53, 262, 294, 42, 1},
		{"BUTTON", "&Copy", "device", idCopy, 166, 309, 68, 24, 0x10000},
		{"STATIC", "", "connected", 7, 50, 160, 175, 27, 0},
		{"BUTTON", "Connecte&d", "connected", idDisconnect, 255, 160, 94, 28, 0x10000},
		{"STATIC", "", "connected", 8, 50, 201, 299, 16, 0},
		{"BUTTON", "C&laude Bridge", "connected", idClaude, 32, 247, 336, 80, 0x10000 | 3},
		{"BUTTON", "&Codex Bridge", "connected", idCodex, 32, 339, 336, 80, 0x10000 | 3},
		{"STATIC", "Settings", "settings", 9, 32, 70, 260, 32, 0},
		{"BUTTON", "&Start at login", "settings", idStartup, 32, 118, 336, 88, 0x10000 | 3},
		{"STATIC", "Start Kobashi when you sign in to your computer.", "settings", 10, 48, 156, 268, 34, 0x100},
		{"BUTTON", "&Close to system tray", "settings", idTray, 32, 218, 336, 88, 0x10000 | 3},
		{"STATIC", "Keep bridges running when the window is closed.", "settings", 11, 48, 256, 268, 34, 0x100},
		{"STATIC", "", "all", 12, 32, 373, 336, 42, 0},
		{"BUTTON", "&Done", "settings", idDone, 32, 372, 336, 38, 0x10000},
		{"BUTTON", "&Quit Kobashi", "settings", idQuit, 144, 418, 112, 24, 0x10000},
		{"BUTTON", "Version", "all", idProject, 252, 446, 116, 24, 0x10000},
	}
	for _, item := range items {
		if err := w.add(item.class, item.title, item.view, item.id, item.x, item.y, item.width, item.height, item.style); err != nil {
			return err
		}
	}
	w.fonts()
	proc("SendMessageW", w.control(idToken), 0xc5, 8192, 0)
	proc("SendMessageW", w.control(idToken), 0x1501, 1, uintptr(unsafe.Pointer(wide("Paste your access token"))))
	return nil
}
func (w *Window) fonts() {
	old := []uintptr{w.font, w.heading, w.small, w.tiny, w.bold, w.codeFont, w.inputFont, w.symbolFont}
	makeFont := func(size, weight int, name string) uintptr {
		f, _, _ := gdi.NewProc("CreateFontW").Call(uintptr(int64(-size*w.dpi/96)), 0, 0, 0, uintptr(weight), 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(wide(name))))
		return f
	}
	w.font = makeFont(14, 400, "Segoe UI")
	w.heading = makeFont(20, 700, "Segoe UI")
	w.small = makeFont(12, 400, "Segoe UI")
	w.tiny = makeFont(11, 400, "Segoe UI")
	w.bold = makeFont(14, 600, "Segoe UI")
	w.codeFont = makeFont(32, 700, "Consolas")
	w.inputFont = makeFont(13, 400, "Consolas")
	w.symbolFont = makeFont(16, 400, "Segoe MDL2 Assets")
	for _, c := range w.controls {
		f := w.font
		if c.id == 1 || c.id == 9 {
			f = w.heading
		} else if c.id == 6 {
			f = w.codeFont
		} else if c.id == idToken {
			f = w.inputFont
		} else if c.id == 3 || c.id == 5 || c.id == 10 || c.id == 11 || c.id == 12 {
			f = w.small
		}
		proc("SendMessageW", c.handle, 0x30, f, 1)
	}
	for _, f := range old {
		if f != 0 {
			gdi.NewProc("DeleteObject").Call(f)
		}
	}
}
func appIcon() uintptr {
	data := assets.Icon
	if len(data) < 22 {
		return proc("LoadIconW", 0, 32512)
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	index := 0
	for i := 0; i < count && 6+i*16+16 <= len(data); i++ {
		if data[6+i*16] == 32 {
			index = i
			break
		}
	}
	entry := 6 + index*16
	size, offset := int(binary.LittleEndian.Uint32(data[entry+8:])), int(binary.LittleEndian.Uint32(data[entry+12:]))
	if offset < 0 || size <= 0 || offset+size > len(data) {
		return proc("LoadIconW", 0, 32512)
	}
	return proc("CreateIconFromResourceEx", uintptr(unsafe.Pointer(&data[offset])), uintptr(size), 1, 0x30000, 32, 32, 0)
}
func (w *Window) addTray() error {
	n := notifyIcon{HWnd: w.Handle, ID: 1, Flags: 7, Message: trayMessage, Icon: w.icon}
	n.Size = uint32(unsafe.Sizeof(n))
	copy(n.Tip[:], syscall.StringToUTF16("Kobashi"))
	ok, _, err := shell.NewProc("Shell_NotifyIconW").Call(0, uintptr(unsafe.Pointer(&n)))
	w.tray = ok != 0
	if !w.tray {
		return fmt.Errorf("system tray registration failed: %w", err)
	}
	return nil
}
func (w *Window) removeTray() {
	if !w.tray {
		return
	}
	n := notifyIcon{HWnd: w.Handle, ID: 1}
	n.Size = uint32(unsafe.Sizeof(n))
	shell.NewProc("Shell_NotifyIconW").Call(2, uintptr(unsafe.Pointer(&n)))
	w.tray = false
}
func (w *Window) Show() { proc("ShowWindow", w.Handle, 9); proc("SetForegroundWindow", w.Handle) }
func (w *Window) request(path string, value map[string]any) (map[string]any, error) {
	method := "GET"
	var data []byte
	if value != nil {
		method = "POST"
		data, _ = json.Marshal(value)
	}
	ctx, cancel := context.WithCancel(context.Background())
	if method == "GET" {
		cancel()
		ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	}
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, w.app.ControlURL()+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+w.app.ControlToken())
	req.Header.Set("Content-Type", "application/json")
	response, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var out map[string]any
	if err = json.NewDecoder(response.Body).Decode(&out); err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("%v", out["error"])
	}
	return out, nil
}
func (w *Window) post(path string, value map[string]any) {
	w.focus = proc("GetFocus")
	w.busy = true
	w.notice = "Working..."
	w.render()
	go func() {
		out, err := w.request(path, value)
		w.events <- event{path: path, value: out, err: err}
		proc("PostMessageW", w.Handle, eventMessage, 0, 0)
	}()
}
func (w *Window) refresh() {
	if !w.polling.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer w.polling.Store(false)
		status, err := w.request("/api/status", nil)
		settings, settingErr := w.request("/api/settings", nil)
		if err == nil {
			err = settingErr
		}
		w.events <- event{path: "refresh", value: status, settings: settings, err: err}
		proc("PostMessageW", w.Handle, eventMessage, 0, 0)
	}()
}
func (w *Window) render() {
	w.layout()
	for _, c := range w.controls {
		show := c.view == "all" || c.view == w.view || (c.view == "sign-in" && (w.view == "idle" || w.view == "token"))
		if c.id == 8 {
			_, _, show = w.usage()
			show = show && w.view == "connected"
		}
		visible := uintptr(0)
		if show {
			visible = 5
		}
		proc("ShowWindow", c.handle, visible)
		if c.id >= idConnect && c.id != idQuit && c.id != idDone {
			enabled := uintptr(1)
			if w.busy {
				enabled = 0
			}
			if c.id == idLogin && w.tokenValue() == "" {
				enabled = 0
			}
			proc("EnableWindow", c.handle, enabled)
		}
	}
	check := func(id int, value any) {
		n := uintptr(0)
		if value == true {
			n = 1
		}
		proc("SendMessageW", w.control(id), 0xf1, n, 0)
	}
	check(idCodex, w.status["codexEnabled"])
	check(idClaude, w.status["claudeEnabled"])
	check(idStartup, w.settings["startAtLogin"])
	check(idTray, w.settings["closeToTray"])
	w.setText(6, w.code)
	w.setText(7, "@"+text(w.status["username"]))
	if used, total, ok := w.usage(); ok {
		w.setText(8, "AI credits this cycle     "+credits(used)+" / "+credits(total))
	}
	if w.verification != "" {
		w.setText(idBrowser, w.verification)
	}
	notice := w.notice
	if notice == "" {
		notice = text(w.status["error"])
	}
	if notice == "" && w.view == "settings" {
		notice = text(w.settings["error"])
	}
	if notice == "" && w.view == "settings" {
		notice = "Changes are saved automatically."
	} else if notice == "" && w.view == "device" {
		notice = "Waiting for authorization..."
	}
	w.setText(12, notice)
	w.setText(idProject, "v"+text(w.status["version"]))
	w.applyTheme()
	proc("RedrawWindow", w.Handle, 0, 0, 0x85)
}
func text(v any) string           { s, _ := v.(string); return s }
func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func (w *Window) accept(e event) {
	if e.path == "refresh" {
		if e.value != nil {
			w.status = e.value
			if w.view != "settings" && w.status["connected"] == true {
				w.view = "connected"
			}
			if w.view == "connected" && w.status["connected"] != true {
				w.view = "idle"
			}
		}
		if e.settings != nil {
			w.settings = e.settings
		}
		if e.err != nil {
			w.notice = e.err.Error()
		}
		w.render()
		return
	}
	w.busy = false
	w.notice = ""
	if e.err != nil {
		w.notice = e.err.Error()
		w.render()
		w.restoreFocus()
		w.refresh()
		return
	}
	switch e.path {
	case "/api/start":
		if code := text(e.value["user_code"]); code != "" {
			w.code = code
			w.device = text(e.value["device_code"])
			w.verification = text(e.value["verification_uri"])
			w.view = "device"
			seconds, _ := e.value["interval"].(float64)
			if seconds < 1 {
				seconds = 5
			}
			w.interval = time.Duration(seconds) * time.Second
			w.nextPoll = time.Now().Add(w.interval)
			expiry, _ := e.value["expires_in"].(float64)
			if expiry <= 0 {
				expiry = 900
			}
			w.deviceExpiry = time.Now().Add(time.Duration(expiry) * time.Second)
			if err := OpenURL(w.verification); err != nil {
				w.notice = err.Error()
			}
			w.focus = w.control(idCopy)
		} else {
			w.notice = "GitHub did not return a device code."
		}
	case "/api/token-login", "/api/poll":
		if e.value["ok"] == true {
			w.device = ""
			w.view = "connected"
			w.setText(idToken, "")
			w.refresh()
			w.focus = w.control(idClaude)
		} else if e.value["pending"] == true {
			reason := text(e.value["error"])
			if reason == "slow_down" {
				w.interval += 5 * time.Second
			} else if reason != "authorization_pending" && reason != "" {
				w.device = ""
				w.notice = "GitHub authorization: " + reason
			}
			w.nextPoll = time.Now().Add(w.interval)
		} else {
			w.notice = map[string]string{"invalid_token": "The GitHub token is invalid.", "no_copilot": "This account has no GitHub Copilot access.", "network": "Could not connect to GitHub."}[text(e.value["reason"])]
			if w.notice == "" {
				w.notice = "Sign-in failed."
			}
		}
	case "/api/settings":
		w.settings = e.value
		w.notice = "Settings saved."
	case "/api/disconnect":
		w.view = "idle"
		w.focus = w.control(idConnect)
		if text(e.value["next"]) == "token" {
			w.view = "token"
			w.focus = w.control(idToken)
		}
		w.status["connected"] = false
		w.refresh()
	case "/api/appearance":
		w.status["appearance"] = e.value["appearance"]
	default:
		w.refresh()
	}
	w.render()
	w.restoreFocus()
}
func (w *Window) restoreFocus() {
	focus := w.focus
	w.focus = 0
	if focus != 0 && proc("IsWindowVisible", focus) != 0 && proc("IsWindowEnabled", focus) != 0 {
		proc("SetFocus", focus)
	}
}
func (w *Window) command(id int) {
	switch id {
	case 10:
		proc("SendMessageW", w.control(idStartup), 0xf5, 0, 0)
	case 11:
		proc("SendMessageW", w.control(idTray), 0xf5, 0, 0)
	case idConnect:
		w.post("/api/start", map[string]any{})
	case idTokenView:
		w.view = "token"
		w.notice = ""
		w.render()
		proc("SetFocus", w.control(idToken))
	case idLogin:
		if token := w.tokenValue(); token != "" && !w.busy {
			w.post("/api/token-login", map[string]any{"token": token})
		}
	case idDone:
		w.device = ""
		w.view = "idle"
		if w.status["connected"] == true {
			w.view = "connected"
		}
		w.notice = ""
		w.render()
		proc("SetFocus", w.control(idSettings))
	case idCopy:
		if err := copyClipboard(w.Handle, w.code); err != nil {
			w.notice = err.Error()
		} else {
			w.notice = "Code copied."
		}
		w.render()
	case idBrowser:
		if err := OpenURL(w.verification); err != nil {
			w.notice = err.Error()
			w.render()
		}
	case idCodex:
		w.post("/api/toggle-codex", map[string]any{})
	case idClaude:
		w.post("/api/toggle-claude", map[string]any{})
	case idDisconnect:
		w.post("/api/disconnect", map[string]any{})
	case idSettings:
		w.view = "settings"
		w.notice = ""
		w.render()
		proc("SetFocus", w.control(idStartup))
	case idStartup, idTray:
		key := "startAtLogin"
		if id == idTray {
			key = "closeToTray"
		}
		checked := proc("SendMessageW", w.control(id), 0xf0, 0, 0) == 1
		w.post("/api/settings", map[string]any{key: checked})
	case idTheme:
		mode := "dark"
		if text(w.status["appearance"]) == "dark" || (text(w.status["appearance"]) == "system" && systemDark()) {
			mode = "light"
		}
		w.post("/api/appearance", map[string]any{"appearance": mode})
	case idProject:
		if err := OpenURL("https://github.com/xjin6/kobashi"); err != nil {
			w.notice = err.Error()
			w.render()
		}
	case idQuit:
		w.quit()
	}
}
func copyClipboard(hwnd uintptr, text string) error {
	if proc("OpenClipboard", hwnd) == 0 {
		return errors.New("clipboard is busy")
	}
	defer proc("CloseClipboard")
	data, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	h, _, err := kernel.NewProc("GlobalAlloc").Call(2, uintptr(len(data)*2))
	if h == 0 {
		return err
	}
	p, _, err := kernel.NewProc("GlobalLock").Call(h)
	if p == 0 {
		kernel.NewProc("GlobalFree").Call(h)
		return err
	}
	kernel.NewProc("RtlMoveMemory").Call(p, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	kernel.NewProc("GlobalUnlock").Call(h)
	if proc("EmptyClipboard") == 0 || proc("SetClipboardData", 13, h) == 0 {
		kernel.NewProc("GlobalFree").Call(h)
		return errors.New("could not write clipboard")
	}
	return nil
}
func (w *Window) quit() {
	if w.view == "quitting" {
		return
	}
	w.view = "quitting"
	w.notice = "Restoring client configurations..."
	w.render()
	go func() {
		err := w.app.Stop()
		w.events <- event{path: "stopped", err: err}
		proc("PostMessageW", w.Handle, eventMessage, 0, 0)
	}()
}
func (w *Window) fixedSize(x, y int) {
	style := proc("GetWindowLongW", w.Handle, ^uintptr(15))
	extended := proc("GetWindowLongW", w.Handle, ^uintptr(19))
	frameDPI := proc("GetDpiForWindow", w.Handle)
	if frameDPI == 0 {
		frameDPI = uintptr(w.dpi)
	}
	r := rect{Right: int32(400 * w.dpi / 96), Bottom: int32(480 * w.dpi / 96)}
	adjust := user.NewProc("AdjustWindowRectExForDpi")
	if adjust.Find() == nil {
		adjust.Call(uintptr(unsafe.Pointer(&r)), style, 0, extended, frameDPI)
	} else {
		proc("AdjustWindowRectEx", uintptr(unsafe.Pointer(&r)), style, 0, extended)
	}
	proc("SetWindowPos", w.Handle, 0, uintptr(x), uintptr(y), uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), 0x4|0x10)
	for _, c := range w.controls {
		proc("MoveWindow", c.handle, uintptr(c.x*w.dpi/96), uintptr(c.y*w.dpi/96), uintptr(c.w*w.dpi/96), uintptr(c.h*w.dpi/96), 1)
	}
}
func (w *Window) trayMenu() {
	menu := proc("CreatePopupMenu")
	defer proc("DestroyMenu", menu)
	proc("AppendMenuW", menu, 0, 1, uintptr(unsafe.Pointer(wide("Show Kobashi"))))
	proc("AppendMenuW", menu, 0, 2, uintptr(unsafe.Pointer(wide("Quit Kobashi"))))
	var p point
	proc("GetCursorPos", uintptr(unsafe.Pointer(&p)))
	proc("SetForegroundWindow", w.Handle)
	selected := proc("TrackPopupMenu", menu, 0x100|2, uintptr(p.X), uintptr(p.Y), 0, w.Handle, 0)
	if selected == 1 {
		w.Show()
	} else if selected == 2 {
		w.quit()
	}
	proc("PostMessageW", w.Handle, 0, 0, 0)
}
func (w *Window) applyTheme() {
	dark := text(w.status["appearance"]) == "dark"
	if text(w.status["appearance"]) == "" || w.status["appearance"] == "system" {
		dark = systemDark()
	}
	type highContrast struct {
		Size, Flags uint32
		Scheme      *uint16
	}
	hc := highContrast{}
	hc.Size = uint32(unsafe.Sizeof(hc))
	proc("SystemParametersInfoW", 0x42, uintptr(hc.Size), uintptr(unsafe.Pointer(&hc)), 0)
	high := hc.Flags&1 != 0
	if high {
		dark = false
	}
	p := themePalette(dark, high)
	if w.brush != 0 && p == w.palette {
		return
	}
	w.dark, w.highContrast, w.palette = dark, high, p
	w.foreground, w.background = colorRef(p.text), colorRef(p.background)
	if w.brush != 0 {
		gdi.NewProc("DeleteObject").Call(w.brush)
		gdi.NewProc("DeleteObject").Call(w.inputBrush)
	}
	w.brush, _, _ = gdi.NewProc("CreateSolidBrush").Call(w.background)
	w.inputBrush, _, _ = gdi.NewProc("CreateSolidBrush").Call(colorRef(p.input))
	var enabled int32
	if dark {
		enabled = 1
	}
	syscall.NewLazyDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute").Call(w.Handle, 20, uintptr(unsafe.Pointer(&enabled)), 4)
	for _, c := range w.controls {
		theme := "Explorer"
		if dark {
			theme = "DarkMode_Explorer"
		}
		syscall.NewLazyDLL("uxtheme.dll").NewProc("SetWindowTheme").Call(c.handle, uintptr(unsafe.Pointer(wide(theme))), 0)
	}
	proc("InvalidateRect", w.Handle, 0, 1)
}
func systemDark() bool {
	adv := syscall.NewLazyDLL("advapi32.dll")
	var key uintptr
	code, _, _ := adv.NewProc("RegOpenKeyExW").Call(0x80000001, uintptr(unsafe.Pointer(wide(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`))), 0, 0x20019, uintptr(unsafe.Pointer(&key)))
	if code != 0 {
		return false
	}
	defer adv.NewProc("RegCloseKey").Call(key)
	var value uint32 = 1
	size := uint32(4)
	code, _, _ = adv.NewProc("RegQueryValueExW").Call(key, uintptr(unsafe.Pointer(wide("AppsUseLightTheme"))), 0, 0, uintptr(unsafe.Pointer(&value)), uintptr(unsafe.Pointer(&size)))
	return code == 0 && value == 0
}
func windowProc(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
	w := active
	if w == nil || (w.Handle != 0 && hwnd != w.Handle) {
		return proc("DefWindowProcW", hwnd, uintptr(msg), wp, lp)
	}
	if msg == w.taskbar && w.taskbar != 0 {
		if err := w.addTray(); err != nil {
			w.notice = err.Error()
			w.Show()
			w.render()
		}
		return 0
	}
	switch msg {
	case 0x11:
		return 1
	case 0x16:
		if wp != 0 {
			_ = w.app.Stop()
			proc("DestroyWindow", hwnd)
		}
		return 0
	case 0x111:
		if wp>>16 == 0 {
			w.command(int(wp & 0xffff))
		} else if int(wp&0xffff) == idToken && wp>>16 == 0x300 && w.view == "token" {
			w.notice = ""
			w.render()
		}
		return 0
	case 0x10:
		if w.app.Settings().CloseToTray && w.tray {
			proc("ShowWindow", hwnd, 0)
		} else {
			w.quit()
		}
		return 0
	case 0x113:
		if w.view != "quitting" {
			w.refresh()
			if w.device != "" && !w.busy && time.Now().After(w.nextPoll) {
				if time.Now().After(w.deviceExpiry) {
					w.device = ""
					w.notice = "GitHub authorization expired. Connect again."
					w.render()
				} else {
					w.post("/api/poll", map[string]any{"device_code": w.device})
				}
			}
		}
		return 0
	case eventMessage:
		for {
			select {
			case e := <-w.events:
				if e.path == "stopped" {
					if e.err != nil {
						ShowError(e.err.Error())
					}
					proc("DestroyWindow", hwnd)
					return 0
				}
				w.accept(e)
			default:
				return 0
			}
		}
	case trayMessage:
		if lp == 0x202 || lp == 0x203 {
			w.Show()
		} else if lp == 0x205 || lp == 0x7b {
			w.trayMenu()
		}
		return 0
	case 0x2e0:
		w.dpi = int(wp & 0xffff)
		w.fonts()
		var r rect
		kernel.NewProc("RtlMoveMemory").Call(uintptr(unsafe.Pointer(&r)), lp, unsafe.Sizeof(r))
		w.fixedSize(int(r.Left), int(r.Top))
		return 0
	case 0xf:
		w.paintWindow(0)
		return 0
	case 0x318:
		w.paintWindow(wp)
		return 0
	case 0x317:
		w.paintWindow(wp)
		if lp&0x10 != 0 {
			for _, c := range w.controls {
				if proc("GetWindowLongW", c.handle, ^uintptr(15))&0x10000000 == 0 {
					continue
				}
				saved, _, _ := gdi.NewProc("SaveDC").Call(wp)
				gdi.NewProc("IntersectClipRect").Call(wp, uintptr(c.x*w.dpi/96), uintptr(c.y*w.dpi/96), uintptr((c.x+c.w)*w.dpi/96), uintptr((c.y+c.h)*w.dpi/96))
				gdi.NewProc("SetViewportOrgEx").Call(wp, uintptr(c.x*w.dpi/96), uintptr(c.y*w.dpi/96), 0)
				proc("SendMessageW", c.handle, 0x318, wp, 0)
				gdi.NewProc("RestoreDC").Call(wp, saved)
			}
		}
		return 0
	case 0x14:
		return 1
	case 0x133, 0x135, 0x138:
		if w.brush != 0 {
			gdi.NewProc("SetTextColor").Call(wp, w.foreground)
			background := w.background
			if lp == w.control(idToken) {
				background = colorRef(w.palette.input)
			}
			gdi.NewProc("SetBkColor").Call(wp, background)
			if lp == w.control(idToken) {
				return w.inputBrush
			}
			return w.brush
		}
	case 0x1a:
		w.applyTheme()
	case 2:
		proc("KillTimer", hwnd, 1)
		w.removeTray()
		for _, f := range []uintptr{w.font, w.heading, w.small, w.tiny, w.bold, w.codeFont, w.inputFont, w.symbolFont} {
			if f != 0 {
				gdi.NewProc("DeleteObject").Call(f)
			}
		}
		if w.brush != 0 {
			gdi.NewProc("DeleteObject").Call(w.brush)
			gdi.NewProc("DeleteObject").Call(w.inputBrush)
		}
		proc("PostQuitMessage", 0)
		return 0
	}
	return proc("DefWindowProcW", hwnd, uintptr(msg), wp, lp)
}
func Run(app *bridge.App, hidden bool) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	awareness := user.NewProc("SetProcessDpiAwarenessContext")
	if awareness.Find() == nil {
		awareness.Call(^uintptr(3))
	} else {
		proc("SetProcessDPIAware")
	}
	w := &Window{app: app, view: "idle", dpi: 96, events: make(chan event, 32), status: map[string]any{}, settings: map[string]any{"startAtLogin": true, "closeToTray": true}, client: &http.Client{Transport: &http.Transport{Proxy: nil}}}
	if err := w.loadArtwork(); err != nil {
		return err
	}
	active = w
	defer func() { active = nil }()
	if get := user.NewProc("GetDpiForSystem"); get.Find() == nil {
		d, _, _ := get.Call()
		if d > 0 {
			w.dpi = int(d)
		}
	}
	w.fonts()
	w.icon = appIcon()
	class := windowClass{Procedure: syscall.NewCallback(windowProc), Icon: w.icon, SmallIcon: w.icon, Cursor: proc("LoadCursorW", 0, 32512), Background: 6, Name: wide("KobashiNativeWindow")}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := user.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return err
	}
	defer user.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(wide("KobashiNativeWindow"))), 0)
	h, _, err := user.NewProc("CreateWindowExW").Call(0x10000, uintptr(unsafe.Pointer(wide("KobashiNativeWindow"))), uintptr(unsafe.Pointer(wide("Kobashi"))), 0x02ca0000, 100, 100, 400, 480, 0, 0, 0, 0)
	if h == 0 {
		return err
	}
	w.Handle = h
	w.fixedSize(100, 100)
	if err = w.build(); err != nil {
		proc("DestroyWindow", h)
		return err
	}
	w.taskbar = uint32(proc("RegisterWindowMessageW", uintptr(unsafe.Pointer(wide("TaskbarCreated")))))
	if err = w.addTray(); err != nil {
		w.notice = err.Error()
		hidden = false
	}
	w.render()
	if !hidden {
		w.Show()
		proc("SetFocus", w.control(idConnect))
	}
	proc("SetTimer", h, 1, 2000, 0)
	w.refresh()
	var msg message
	for {
		result, _, err := user.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(result) == -1 {
			return err
		}
		if result == 0 {
			break
		}
		if msg.Message == 0x100 && msg.WParam == 0x1b && (w.view == "settings" || w.view == "token" || w.view == "device") {
			w.command(idDone)
			continue
		}
		if msg.Message == 0x100 && msg.WParam == 0xd {
			focus := proc("GetFocus")
			if w.view == "token" && focus == w.control(idToken) {
				w.command(idLogin)
				continue
			}
			activated := false
			for _, c := range w.controls {
				if c.handle == focus && c.class == "BUTTON" && proc("IsWindowEnabled", focus) != 0 {
					proc("SendMessageW", focus, 0xf5, 0, 0)
					activated = true
					break
				}
			}
			if activated {
				continue
			}
		}
		if proc("IsDialogMessageW", h, uintptr(unsafe.Pointer(&msg))) == 0 {
			proc("TranslateMessage", uintptr(unsafe.Pointer(&msg)))
			proc("DispatchMessageW", uintptr(unsafe.Pointer(&msg)))
		}
	}
	if w.icon != 0 {
		proc("DestroyIcon", w.icon)
	}
	return nil
}
