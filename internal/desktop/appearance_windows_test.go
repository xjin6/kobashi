//go:build windows

package desktop

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func captureClient(t *testing.T, hwnd uintptr, width, height int) *image.NRGBA {
	t.Helper()
	dc := proc("GetDC", hwnd)
	defer proc("ReleaseDC", hwnd, dc)
	mem, _, _ := gdi.NewProc("CreateCompatibleDC").Call(dc)
	defer gdi.NewProc("DeleteDC").Call(mem)
	header := struct {
		Size                   uint32
		Width, Height          int32
		Planes, Bits           uint16
		Compression, ImageSize uint32
		X, Y                   int32
		Used, Important        uint32
	}{Size: 40, Width: int32(width), Height: -int32(height), Planes: 1, Bits: 32}
	var pixels uintptr
	bitmap, _, _ := gdi.NewProc("CreateDIBSection").Call(dc, uintptr(unsafe.Pointer(&header)), 0, uintptr(unsafe.Pointer(&pixels)), 0, 0)
	if bitmap == 0 || pixels == 0 {
		t.Fatal("could not create native capture bitmap")
	}
	defer gdi.NewProc("DeleteObject").Call(bitmap)
	old, _, _ := gdi.NewProc("SelectObject").Call(mem, bitmap)
	defer gdi.NewProc("SelectObject").Call(mem, old)
	proc("SendMessageW", hwnd, 0x317, mem, 0x14)
	gdi.NewProc("GdiFlush").Call()
	im := image.NewNRGBA(image.Rect(0, 0, width, height))
	kernel.NewProc("RtlMoveMemory").Call(uintptr(unsafe.Pointer(&im.Pix[0])), pixels, uintptr(len(im.Pix)))
	for i := 0; i < len(im.Pix); i += 4 {
		im.Pix[i], im.Pix[i+2], im.Pix[i+3] = im.Pix[i+2], im.Pix[i], 255
	}
	return im
}

func TestNativeAppearanceMatchesExistingInterface(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	awareness := user.NewProc("SetProcessDpiAwarenessContext")
	if awareness.Find() == nil {
		awareness.Call(^uintptr(3))
	} else {
		proc("SetProcessDPIAware")
	}
	if active != nil {
		t.Fatal("another native window owns this process")
	}
	w := &Window{dpi: 96, view: "idle", settings: map[string]any{"startAtLogin": true, "closeToTray": true},
		status: map[string]any{"version": "2.1.6", "username": "example", "codexEnabled": false, "claudeEnabled": true,
			"usage": map[string]any{"creditsUsed": float64(12), "entitlement": float64(100)}}}
	if err := w.loadArtwork(); err != nil {
		t.Fatal(err)
	}
	active = w
	defer func() { active = nil }()
	w.fonts()
	class := windowClass{Procedure: syscall.NewCallback(windowProc), Name: wide("KobashiAppearanceTest")}
	class.Size = uint32(unsafe.Sizeof(class))
	if proc("RegisterClassExW", uintptr(unsafe.Pointer(&class))) == 0 {
		t.Fatal("could not register isolated UI test class")
	}
	defer proc("UnregisterClassW", uintptr(unsafe.Pointer(class.Name)), 0)
	w.Handle = proc("CreateWindowExW", 0, uintptr(unsafe.Pointer(class.Name)), uintptr(unsafe.Pointer(wide("Isolated UI test"))),
		0x82000000, 0, 0, 400, 480, 0, 0, 0, 0)
	if w.Handle == 0 {
		t.Fatal("could not create isolated native UI")
	}
	defer func() {
		proc("DestroyWindow", w.Handle)
		var m message
		for proc("PeekMessageW", uintptr(unsafe.Pointer(&m)), 0, 0x12, 0x12, 1) != 0 {
		}
	}()
	if err := w.build(); err != nil {
		t.Fatal(err)
	}
	if w.control(2) != 0 {
		t.Fatal("the route description is still present")
	}
	dc := proc("GetDC", w.Handle)
	for font, want := range map[uintptr]string{w.font: "Segoe UI", w.bold: "Segoe UI", w.heading: "Segoe UI", w.symbolFont: "Segoe MDL2 Assets"} {
		old, _, _ := gdi.NewProc("SelectObject").Call(dc, font)
		face := make([]uint16, 64)
		gdi.NewProc("GetTextFaceW").Call(dc, uintptr(len(face)), uintptr(unsafe.Pointer(&face[0])))
		gdi.NewProc("SelectObject").Call(dc, old)
		if syscall.UTF16ToString(face) != want {
			t.Fatalf("incorrect native typography: %q", syscall.UTF16ToString(face))
		}
	}
	old, _, _ := gdi.NewProc("SelectObject").Call(dc, w.symbolFont)
	symbol, glyph := uint16(0xe713), uint16(0)
	if count, _, _ := gdi.NewProc("GetGlyphIndicesW").Call(dc, uintptr(unsafe.Pointer(&symbol)), 1,
		uintptr(unsafe.Pointer(&glyph)), 1); count != 1 || glyph == 0xffff {
		t.Fatal("the system font does not provide the standard Settings gear")
	}
	gdi.NewProc("SelectObject").Call(dc, old)
	proc("ReleaseDC", w.Handle, dc)
	proc("SendMessageW", w.Handle, 0x127, 1|2<<16, 0)
	w.code = "ABCD-1234"
	w.verification = "https://github.com/login/device"
	assertStatus := func(id int, want string, rgb uint32) {
		t.Helper()
		h := w.control(id)
		if proc("GetWindowLongW", h, ^uintptr(15))&0x10000 == 0 {
			t.Fatal("connection status lost keyboard focusability", id)
		}
		buffer := make([]uint16, 64)
		proc("GetWindowTextW", h, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if strings.ReplaceAll(syscall.UTF16ToString(buffer), "&", "") != want {
			t.Fatal("incorrect connection status label", id, syscall.UTF16ToString(buffer))
		}
		var c control
		for _, candidate := range w.controls {
			if candidate.id == id {
				c = candidate
				break
			}
		}
		width, height := c.w*w.dpi/96, c.h*w.dpi/96
		screenshot := captureClient(t, h, width, height)
		pixel := func(rgb uint32) color.NRGBA {
			return color.NRGBA{R: byte(rgb >> 16), G: byte(rgb >> 8), B: byte(rgb), A: 255}
		}
		colored := 0
		for y := 3; y < height-3; y++ {
			for x := 3; x < width-3; x++ {
				if screenshot.NRGBAAt(x, y) == pixel(rgb) {
					colored++
				}
			}
		}
		if colored < 4 {
			t.Fatal("connection status is not rendered in its state color", id, w.dpi, rgb)
		}
		border := pixel(w.palette.border)
		for side, at := range []func(int) color.NRGBA{
			func(n int) color.NRGBA { return screenshot.NRGBAAt(width/2, n) },
			func(n int) color.NRGBA { return screenshot.NRGBAAt(width/2, height-1-n) },
			func(n int) color.NRGBA { return screenshot.NRGBAAt(n, height/2) },
			func(n int) color.NRGBA { return screenshot.NRGBAAt(width-1-n, height/2) },
		} {
			stroke := 0
			for stroke < height/3 && at(stroke) == border {
				stroke++
			}
			if stroke != max(1, (w.dpi+48)/96) {
				t.Errorf("status border is clipped or uneven: id=%d dpi=%d side=%d thickness=%d", id, w.dpi, side, stroke)
			}
		}
	}
	for _, theme := range []string{"dark", "light"} {
		w.status["appearance"] = theme
		for _, view := range []string{"idle", "token", "device", "connected", "settings"} {
			w.view = view
			w.notice = ""
			w.render()
			if view == "idle" || view == "token" {
				assertStatus(idConnect, "Not Connected", w.palette.disconnected)
			}
			if view == "token" {
				assertStatus(idLogin, "Not Connected", w.palette.disconnected)
			}
			if view == "connected" {
				assertStatus(idDisconnect, "Connected", w.palette.connected)
			}
			if view == "idle" || view == "connected" {
				w.busy = true
				w.render()
				if view == "idle" {
					assertStatus(idConnect, "Not Connected", w.palette.disconnected)
				} else {
					assertStatus(idDisconnect, "Connected", w.palette.connected)
				}
				w.busy = false
				w.render()
			}
			screenshot := captureClient(t, w.Handle, 400, 480)
			want := themePalette(theme == "dark", w.highContrast)
			background := screenshot.NRGBAAt(5, 5)
			if background != (color.NRGBA{R: byte(want.background >> 16), G: byte(want.background >> 8), B: byte(want.background), A: 255}) {
				t.Fatalf("%s/%s has an incorrect plain background: %v", theme, view, background)
			}
			if dir := os.Getenv("KOBASHI_UI_CAPTURE_DIR"); dir != "" {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(dir, theme+"-"+view+".png")
				f, err := os.Create(path)
				if err != nil {
					t.Fatal(err)
				}
				err = png.Encode(f, screenshot)
				closeErr := f.Close()
				if err != nil || closeErr != nil {
					t.Fatal(err, closeErr)
				}
			}
		}
	}
	for id, want := range map[int]rect{
		idSettings: {296, 24, 328, 56}, idTheme: {336, 24, 368, 56},
		idClaude: {32, 247, 368, 327}, idCodex: {32, 339, 368, 419},
		idDisconnect: {255, 160, 349, 188},
		idStartup:    {32, 118, 368, 206}, idTray: {32, 218, 368, 306},
		idDone: {32, 372, 368, 410}, idQuit: {144, 418, 256, 442},
	} {
		var got rect
		proc("GetWindowRect", w.control(id), uintptr(unsafe.Pointer(&got)))
		proc("MapWindowPoints", 0, w.Handle, uintptr(unsafe.Pointer(&got)), 2)
		if got != want {
			t.Fatal("control does not match old UI geometry", id, got, want)
		}
	}
	for _, id := range []int{idClaude, idCodex, idStartup, idTray} {
		if proc("GetWindowLongW", w.control(id), ^uintptr(15))&0xf != 3 {
			t.Fatal("custom appearance discarded native checkbox semantics", id)
		}
	}
	w.view = "idle"
	for _, theme := range []string{"dark", "light"} {
		w.status["appearance"] = theme
		for _, dpi := range []int{96, 120, 144, 168, 192, 216, 240, 288, 384} {
			w.view = "idle"
			w.dpi = dpi
			w.fonts()
			w.fixedSize(0, 0)
			w.render()
			assertStatus(idConnect, "Not Connected", w.palette.disconnected)
			var client rect
			proc("GetClientRect", w.Handle, uintptr(unsafe.Pointer(&client)))
			if int(client.Right) != 400*dpi/96 || int(client.Bottom) != 480*dpi/96 {
				t.Fatalf("%s/%d DPI changed the fixed logical content size: %v", theme, dpi, client)
			}
			var hint, link control
			dc := proc("GetDC", w.Handle)
			if dc == 0 {
				t.Fatal("could not measure native text")
			}
			old, _, _ := gdi.NewProc("SelectObject").Call(dc, w.small)
			for _, c := range w.controls {
				if c.id != 3 && c.id != idTokenView {
					continue
				}
				if c.id == 3 {
					hint = c
				} else {
					link = c
				}
				var extent point
				if result, _, _ := gdi.NewProc("GetTextExtentPoint32W").Call(dc, uintptr(unsafe.Pointer(wide(c.title))),
					uintptr(len(syscall.StringToUTF16(c.title))-1), uintptr(unsafe.Pointer(&extent))); result == 0 {
					t.Fatal("could not measure native text", c.title)
				}
				if int(extent.X) > c.w*dpi/96 || int(extent.Y) > c.h*dpi/96 {
					t.Errorf("%s/%d DPI clips %q: text %dx%d, control %dx%d", theme, dpi, c.title,
						extent.X, extent.Y, c.w*dpi/96, c.h*dpi/96)
				}
				if c.x < 32 || c.x+c.w > 368 {
					t.Errorf("%s/%d DPI places sign-in text outside the content padding", theme, dpi)
				}
			}
			gdi.NewProc("SelectObject").Call(dc, old)
			proc("ReleaseDC", w.Handle, dc)
			if hint.x+hint.w+6 > link.x || hint.y != link.y || hint.h != link.h {
				t.Errorf("%s/%d DPI overlaps or misaligns the token hint and link", theme, dpi)
			}
			if proc("GetWindowLongW", link.handle, ^uintptr(15))&0x10000 == 0 {
				t.Fatal("token link lost keyboard focusability")
			}
			if dir := os.Getenv("KOBASHI_UI_CAPTURE_DIR"); dir != "" {
				path := filepath.Join(dir, fmt.Sprintf("%s-idle-%d-dpi.png", theme, dpi))
				f, err := os.Create(path)
				if err != nil {
					t.Fatal(err)
				}
				err = png.Encode(f, captureClient(t, w.Handle, 400*dpi/96, 480*dpi/96))
				closeErr := f.Close()
				if err != nil || closeErr != nil {
					t.Fatal(err, closeErr)
				}
			}
			w.view = "connected"
			w.render()
			assertStatus(idDisconnect, "Connected", w.palette.connected)
			w.view = "settings"
			w.render()
			dc = proc("GetDC", w.Handle)
			old, _, _ = gdi.NewProc("SelectObject").Call(dc, w.small)
			for _, c := range w.controls {
				if c.id != 10 && c.id != 11 {
					continue
				}
				bounds := rect{Right: int32(c.w * dpi / 96), Bottom: int32(c.h * dpi / 96)}
				if proc("DrawTextW", dc, uintptr(unsafe.Pointer(wide(c.title))), ^uintptr(0),
					uintptr(unsafe.Pointer(&bounds)), 0xc10) == 0 {
					t.Fatal("could not measure settings description", c.title)
				}
				if int(bounds.Right) > c.w*dpi/96 || int(bounds.Bottom) > c.h*dpi/96 {
					t.Errorf("%s/%d DPI clips the settings description %q", theme, dpi, c.title)
				}
			}
			gdi.NewProc("SelectObject").Call(dc, old)
			proc("ReleaseDC", w.Handle, dc)
			if proc("GetWindowLongW", w.control(idDone), ^uintptr(15))&0x10000 == 0 {
				t.Fatal("Done lost keyboard focusability")
			}
			if proc("GetWindowLongW", w.control(idQuit), ^uintptr(15))&0x10000 == 0 ||
				proc("GetNextDlgTabItem", w.Handle, w.control(idDone), 0) != w.control(idQuit) {
				t.Fatal("Quit must remain keyboard reachable after Done")
			}
			var doneBounds, quitBounds rect
			proc("GetWindowRect", w.control(idDone), uintptr(unsafe.Pointer(&doneBounds)))
			proc("GetWindowRect", w.control(idQuit), uintptr(unsafe.Pointer(&quitBounds)))
			proc("MapWindowPoints", 0, w.Handle, uintptr(unsafe.Pointer(&doneBounds)), 2)
			proc("MapWindowPoints", 0, w.Handle, uintptr(unsafe.Pointer(&quitBounds)), 2)
			if int(quitBounds.Top-doneBounds.Bottom) < 8*dpi/96-1 ||
				int(quitBounds.Bottom) > 446*dpi/96 ||
				int(quitBounds.Bottom-quitBounds.Top) < 24*dpi/96 {
				t.Errorf("%s/%d DPI overlaps or clips the Quit link", theme, dpi)
			}
			if dir := os.Getenv("KOBASHI_UI_CAPTURE_DIR"); dir != "" {
				path := filepath.Join(dir, fmt.Sprintf("%s-settings-%d-dpi.png", theme, dpi))
				f, err := os.Create(path)
				if err != nil {
					t.Fatal(err)
				}
				err = png.Encode(f, captureClient(t, w.Handle, 400*dpi/96, 480*dpi/96))
				closeErr := f.Close()
				if err != nil || closeErr != nil {
					t.Fatal(err, closeErr)
				}
			}
		}
	}
	for _, connected := range []bool{false, true} {
		w.status["connected"] = connected
		w.view = "settings"
		w.notice = "Changes are saved automatically."
		w.command(idDone)
		want := "idle"
		if connected {
			want = "connected"
		}
		if w.view != want || w.notice != "" {
			t.Fatal("Done did not return to the main view", w.view, w.notice)
		}
	}
	w.view = "connected"
	w.status["username"] = "xjin6"
	w.render()
	for id, want := range map[int]string{idProject: "v2.1.6", 7: "@xjin6"} {
		buffer := make([]uint16, 128)
		proc("GetWindowTextW", w.control(id), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if syscall.UTF16ToString(buffer) != want {
			t.Fatal("author removal changed the native accessible label or signed-in identity", id)
		}
	}
	w.view = "settings"
	w.render()
	if proc("GetNextDlgTabItem", w.Handle, w.control(idQuit), 0) != w.control(idProject) ||
		proc("GetNextDlgTabItem", w.Handle, w.control(idProject), 1) != w.control(idQuit) {
		t.Fatal("version link lost forward or reverse keyboard navigation")
	}
}

func BenchmarkNativeArtwork(b *testing.B) {
	for _, name := range []string{"github", "codex"} {
		b.Run(name, func(b *testing.B) {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			w := &Window{dpi: 192, palette: themePalette(true, false)}
			if err := w.loadArtwork(); err != nil {
				b.Fatal(err)
			}
			dc := proc("GetDC", 0)
			defer proc("ReleaseDC", 0, dc)
			mem, _, _ := gdi.NewProc("CreateCompatibleDC").Call(dc)
			defer gdi.NewProc("DeleteDC").Call(mem)
			bitmap, _, _ := gdi.NewProc("CreateCompatibleBitmap").Call(dc, 48, 48)
			if dc == 0 || mem == 0 || bitmap == 0 {
				b.Fatal("could not create the isolated artwork buffer")
			}
			old, _, _ := gdi.NewProc("SelectObject").Call(mem, bitmap)
			defer func() {
				gdi.NewProc("SelectObject").Call(mem, old)
				gdi.NewProc("DeleteObject").Call(bitmap)
			}()
			p := painter{w, mem}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				p.artwork(name, 0, 0, 24, w.palette.tile, w.palette.accent, name == "github")
			}
		})
	}
}

func TestNativeUsageHidesUnavailableValuesAndFormatsCredits(t *testing.T) {
	for _, usage := range []map[string]any{nil, {}, {"creditsUsed": float64(0), "entitlement": float64(0)},
		{"creditsUsed": float64(1), "entitlement": float64(100), "unlimited": true},
		{"creditsUsed": math.NaN(), "entitlement": float64(100)}} {
		w := Window{status: map[string]any{"usage": usage}}
		if _, _, ok := w.usage(); ok {
			t.Fatal("unavailable usage was shown", usage)
		}
	}

	if credits(1234567.5) != "1,234,567.5" {
		t.Fatal("credits formatting does not match the existing UI")
	}
}

func TestNativeConnectionStatusContrast(t *testing.T) {
	luminance := func(rgb uint32) float64 {
		channels := [3]float64{}
		for i, shift := range []uint{16, 8, 0} {
			value := float64((rgb>>shift)&255) / 255
			if value <= 0.04045 {
				channels[i] = value / 12.92
			} else {
				channels[i] = math.Pow((value+0.055)/1.055, 2.4)
			}
		}
		return channels[0]*0.2126 + channels[1]*0.7152 + channels[2]*0.0722
	}
	for _, dark := range []bool{false, true} {
		colors := themePalette(dark, false)
		for _, pair := range [][2]uint32{
			{colors.disconnected, colors.button}, {colors.disconnected, colors.hover},
			{colors.connected, colors.panel}, {colors.connected, colors.hover},
		} {
			a, b := luminance(pair[0]), luminance(pair[1])
			if ratio := (max(a, b) + 0.05) / (min(a, b) + 0.05); ratio < 4.5 {
				t.Errorf("connection status text contrast is %.2f: dark=%v colors=%x", ratio, dark, pair)
			}
		}
	}
}
