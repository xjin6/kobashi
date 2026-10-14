//go:build windows

package desktop

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"github.com/xjin6/kobashi/assets"
)

type palette struct {
	background, text, muted, panel, border, button, hover, input uint32
	accent, secondary, danger, toggle, on, knob, tile, badge     uint32
	connected, disconnected                                      uint32
}

func colorRef(rgb uint32) uintptr {
	return uintptr(rgb&0xff)<<16 | uintptr(rgb&0xff00) | uintptr(rgb>>16)
}

func themePalette(dark, high bool) palette {
	if high {
		system := func(index uintptr) uint32 {
			ref := uint32(proc("GetSysColor", index))
			return ref&0xff<<16 | ref&0xff00 | ref>>16
		}
		bg, fg, face, accent := system(5), system(8), system(15), system(13)
		return palette{bg, fg, fg, bg, fg, face, face, bg, accent, accent, fg, bg, accent, system(14), face, bg, fg, fg}
	}
	if dark {
		return palette{0x0a0c10, 0xe6edf3, 0x8b949e, 0x1e2229, 0x272c33, 0x1c2127, 0x2a3038, 0x0c1016,
			0x58a6ff, 0xa371f7, 0xf85149, 0x21262d, 0x1f6feb, 0xffffff, 0x2f343b, 0x24303e, 0x3fb950, 0x9ca3af}
	}
	return palette{0xf0f4f0, 0x1a2e1a, 0x5a6e5a, 0xf0f9f2, 0xd9e8de, 0xffffff, 0xf0fdf4, 0xf0fbf3,
		0x15803d, 0x0891b2, 0xdc2626, 0xd1d5db, 0x238636, 0xffffff, 0xffffff, 0xdef3e2, 0x15803d, 0x6b7280}
}

func (w *Window) loadArtwork() error {
	w.artwork = map[string]image.Image{}
	for name, data := range map[string][]byte{"github": assets.GitHub, "claude": assets.Claude, "codex": assets.Codex} {
		im, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("load %s artwork: %w", name, err)
		}
		w.artwork[name] = im
	}
	return nil
}

func (w *Window) tokenValue() string {
	buffer := make([]uint16, 8193)
	proc("GetWindowTextW", w.control(idToken), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	return strings.TrimSpace(syscall.UTF16ToString(buffer))
}

func (w *Window) usage() (float64, float64, bool) {
	u := object(w.status["usage"])
	used, usedOK := u["creditsUsed"].(float64)
	total, totalOK := u["entitlement"].(float64)
	ok := usedOK && totalOK && u["unlimited"] != true && used >= 0 && total > 0 &&
		!math.IsNaN(used) && !math.IsNaN(total) && !math.IsInf(used, 0) && !math.IsInf(total, 0)
	return used, total, ok
}

func credits(value float64) string {
	parts := strings.SplitN(strconv.FormatFloat(value, 'f', -1, 64), ".", 2)
	for i := len(parts[0]) - 3; i > 0; i -= 3 {
		parts[0] = parts[0][:i] + "," + parts[0][i:]
	}
	return strings.Join(parts, ".")
}

func (w *Window) layout() {
	var hint, link *control
	for i := range w.controls {
		switch w.controls[i].id {
		case 3:
			hint = &w.controls[i]
		case idTokenView:
			link = &w.controls[i]
		}
	}
	if hint != nil && link != nil {
		dc := proc("GetDC", w.Handle)
		if dc == 0 {
			w.notice = "Windows could not measure the sign-in text."
		} else {
			old, _, _ := gdi.NewProc("SelectObject").Call(dc, w.small)
			for _, c := range []*control{hint, link} {
				var extent point
				if result, _, _ := gdi.NewProc("GetTextExtentPoint32W").Call(dc, uintptr(unsafe.Pointer(wide(c.title))),
					uintptr(len(syscall.StringToUTF16(c.title))-1), uintptr(unsafe.Pointer(&extent))); result == 0 {
					w.notice = "Windows could not measure the sign-in text."
				} else {
					c.w = (int(extent.X)*96+w.dpi-1)/w.dpi + 8
				}
			}
			gdi.NewProc("SelectObject").Call(dc, old)
			proc("ReleaseDC", w.Handle, dc)
			hint.x = (400 - hint.w - 6 - link.w) / 2
			link.x = hint.x + hint.w + 6
			hint.y = link.y
		}
	}
	for i := range w.controls {
		c := &w.controls[i]
		if c.id == idConnect {
			c.y = 244
			if w.view == "token" {
				c.y = 210
			}
		} else if c.id == 12 {
			c.y, c.h = 334, 70
			switch w.view {
			case "connected":
				c.y, c.h = 112, 30
			case "settings":
				c.y, c.h = 320, 36
			case "token":
				c.y, c.h = 364, 62
			case "device":
				c.y, c.h = 378, 48
			case "quitting":
				c.y = 200
			}
		}
		proc("MoveWindow", c.handle, uintptr(c.x*w.dpi/96), uintptr(c.y*w.dpi/96), uintptr(c.w*w.dpi/96), uintptr(c.h*w.dpi/96), 0)
	}
}

type paintStruct struct {
	DC              uintptr
	Erase           uint32
	Rect            rect
	Restore, Update uint32
	Reserved        [32]byte
}

type painter struct {
	w  *Window
	dc uintptr
}

func (p painter) s(n int) uintptr { return uintptr(int64(n * p.w.dpi / 96)) }

func (p painter) fill(x, y, width, height int, rgb uint32) {
	brush, _, _ := gdi.NewProc("CreateSolidBrush").Call(colorRef(rgb))
	defer gdi.NewProc("DeleteObject").Call(brush)
	r := rect{int32(p.s(x)), int32(p.s(y)), int32(p.s(x + width)), int32(p.s(y + height))}
	proc("FillRect", p.dc, uintptr(unsafe.Pointer(&r)), brush)
}

func (p painter) round(x, y, width, height, radius int, fill, border uint32) {
	outer, _, _ := gdi.NewProc("CreateSolidBrush").Call(colorRef(border))
	inner, _, _ := gdi.NewProc("CreateSolidBrush").Call(colorRef(fill))
	pen, _, _ := gdi.NewProc("GetStockObject").Call(8)
	oldBrush, _, _ := gdi.NewProc("SelectObject").Call(p.dc, outer)
	oldPen, _, _ := gdi.NewProc("SelectObject").Call(p.dc, pen)
	// Penless GDI RoundRect omits the final pixel row and column.
	left, top, right, bottom := p.s(x), p.s(y), p.s(x+width)+1, p.s(y+height)+1
	stroke := uintptr(max(1, (p.w.dpi+48)/96))
	diameter := p.s(radius * 2)
	gdi.NewProc("RoundRect").Call(p.dc, left, top, right, bottom, diameter, diameter)
	if right > left+2*stroke && bottom > top+2*stroke {
		gdi.NewProc("SelectObject").Call(p.dc, inner)
		insetDiameter := uintptr(max(0, int(diameter)-2*int(stroke)))
		gdi.NewProc("RoundRect").Call(p.dc, left+stroke, top+stroke, right-stroke, bottom-stroke, insetDiameter, insetDiameter)
	}
	gdi.NewProc("SelectObject").Call(p.dc, oldBrush)
	gdi.NewProc("SelectObject").Call(p.dc, oldPen)
	gdi.NewProc("DeleteObject").Call(outer)
	gdi.NewProc("DeleteObject").Call(inner)
}

func (p painter) line(x1, y1, x2, y2, width int, rgb uint32) {
	pen, _, _ := gdi.NewProc("CreatePen").Call(0, p.s(width), colorRef(rgb))
	old, _, _ := gdi.NewProc("SelectObject").Call(p.dc, pen)
	gdi.NewProc("MoveToEx").Call(p.dc, p.s(x1), p.s(y1), 0)
	gdi.NewProc("LineTo").Call(p.dc, p.s(x2), p.s(y2))
	gdi.NewProc("SelectObject").Call(p.dc, old)
	gdi.NewProc("DeleteObject").Call(pen)
}

func (p painter) text(value string, x, y, width, height int, font uintptr, rgb uint32, flags uintptr) {
	gdi.NewProc("SelectObject").Call(p.dc, font)
	gdi.NewProc("SetTextColor").Call(p.dc, colorRef(rgb))
	gdi.NewProc("SetBkMode").Call(p.dc, 1)
	r := rect{int32(p.s(x)), int32(p.s(y)), int32(p.s(x + width)), int32(p.s(y + height))}
	if proc("SendMessageW", p.w.Handle, 0x129, 0, 0)&2 != 0 {
		flags |= 0x100000
	}
	proc("DrawTextW", p.dc, uintptr(unsafe.Pointer(wide(value))), ^uintptr(0), uintptr(unsafe.Pointer(&r)), flags)
}

func (p painter) gradient(x, y, width, height int) {
	type vertex struct {
		X, Y                    int32
		Red, Green, Blue, Alpha uint16
	}
	v := func(x, y int, rgb uint32) vertex {
		return vertex{int32(p.s(x)), int32(p.s(y)), uint16(rgb>>16) << 8, uint16(rgb>>8) << 8, uint16(rgb) << 8, 0xff00}
	}
	vertices := [2]vertex{v(x, y, p.w.palette.accent), v(x+width, y+height, p.w.palette.secondary)}
	mesh := [2]uint32{0, 1}
	syscall.NewLazyDLL("msimg32.dll").NewProc("GradientFill").Call(p.dc, uintptr(unsafe.Pointer(&vertices[0])), 2, uintptr(unsafe.Pointer(&mesh[0])), 1, 0)
}

func (p painter) gradientText(value string, x, y, width, height int, font uintptr) {
	mem, _, _ := gdi.NewProc("CreateCompatibleDC").Call(p.dc)
	defer gdi.NewProc("DeleteDC").Call(mem)
	header := struct {
		Size                   uint32
		Width, Height          int32
		Planes, Bits           uint16
		Compression, ImageSize uint32
		X, Y                   int32
		Used, Important        uint32
	}{Size: 40, Width: int32(p.s(width)), Height: -int32(p.s(height)), Planes: 1, Bits: 32}
	var pixels uintptr
	bitmap, _, _ := gdi.NewProc("CreateDIBSection").Call(p.dc, uintptr(unsafe.Pointer(&header)), 0, uintptr(unsafe.Pointer(&pixels)), 0, 0)
	if bitmap == 0 || pixels == 0 {
		p.w.notice = "Windows could not render the gradient text."
		p.text(value, x, y, width, height, font, p.w.palette.text, 0x824)
		return
	}
	old, _, _ := gdi.NewProc("SelectObject").Call(mem, bitmap)
	defer func() {
		gdi.NewProc("SelectObject").Call(mem, old)
		gdi.NewProc("DeleteObject").Call(bitmap)
	}()
	mask := painter{p.w, mem}
	mask.fill(0, 0, width, height, 0)
	gdi.NewProc("SelectObject").Call(mem, font)
	extra, _, _ := gdi.NewProc("GetTextCharacterExtra").Call(p.dc)
	gdi.NewProc("SetTextCharacterExtra").Call(mem, extra)
	gdi.NewProc("SetTextColor").Call(mem, 0xffffff)
	gdi.NewProc("SetBkMode").Call(mem, 1)
	gdi.NewProc("TextOutW").Call(mem, 0, 0, uintptr(unsafe.Pointer(wide(value))), uintptr(len(syscall.StringToUTF16(value))-1))
	gdi.NewProc("GdiFlush").Call()
	data := make([]byte, int(header.Width)*int(-header.Height)*4)
	kernel.NewProc("RtlMoveMemory").Call(uintptr(unsafe.Pointer(&data[0])), pixels, uintptr(len(data)))
	bg := p.w.palette.background
	if font == p.w.codeFont {
		bg = p.w.palette.input
	}
	for row := 0; row < int(-header.Height); row++ {
		for column := 0; column < int(header.Width); column++ {
			index := (row*int(header.Width) + column) * 4
			alpha := (uint32(data[index]) + uint32(data[index+1]) + uint32(data[index+2])) / 3
			t := float64(column) / float64(header.Width)
			for channel := 0; channel < 3; channel++ {
				shift := uint(channel * 8)
				start, end := (p.w.palette.accent>>shift)&255, (p.w.palette.secondary>>shift)&255
				rgb := uint32(float64(start)*(1-t) + float64(end)*t)
				data[index+channel] = byte((rgb*alpha + ((bg>>shift)&255)*(255-alpha)) / 255)
			}
		}
	}
	gdi.NewProc("StretchDIBits").Call(p.dc, p.s(x), p.s(y), p.s(width), p.s(height), 0, 0, uintptr(header.Width), uintptr(-header.Height),
		uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&header)), 0, 0xcc0020)
}

func (p painter) artwork(name string, x, y, size int, bg, tint uint32, mask bool) {
	im := p.w.artwork[name]
	bounds := im.Bounds()
	data := make([]byte, bounds.Dx()*bounds.Dy()*4)
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			c := color.NRGBAModel.Convert(im.At(bounds.Min.X+x, bounds.Min.Y+y)).(color.NRGBA)
			rgb := uint32(c.R)<<16 | uint32(c.G)<<8 | uint32(c.B)
			if mask {
				rgb = tint
			}
			offset := (y*bounds.Dx() + x) * 4
			for channel := 0; channel < 3; channel++ {
				shift := uint(channel * 8)
				foreground, background := (rgb>>shift)&0xff, (bg>>shift)&0xff
				data[offset+channel] = byte((foreground*uint32(c.A) + background*(255-uint32(c.A))) / 255)
			}
		}
	}
	header := struct {
		Size                   uint32
		Width, Height          int32
		Planes, Bits           uint16
		Compression, ImageSize uint32
		X, Y                   int32
		Used, Important        uint32
	}{Size: 40, Width: int32(bounds.Dx()), Height: -int32(bounds.Dy()), Planes: 1, Bits: 32}
	gdi.NewProc("SetStretchBltMode").Call(p.dc, 4)
	gdi.NewProc("SetBrushOrgEx").Call(p.dc, 0, 0, 0)
	gdi.NewProc("StretchDIBits").Call(p.dc, p.s(x), p.s(y), p.s(size), p.s(size), 0, 0, uintptr(bounds.Dx()), uintptr(bounds.Dy()),
		uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&header)), 0, 0xcc0020)
}

func (w *Window) paintWindow(dc uintptr) {
	var ps paintStruct
	if dc == 0 {
		dc = proc("BeginPaint", w.Handle, uintptr(unsafe.Pointer(&ps)))
		defer proc("EndPaint", w.Handle, uintptr(unsafe.Pointer(&ps)))
	}
	w.buffered(dc, 400, 480, func(p painter) {
		c := w.palette
		p.fill(0, 0, 400, 480, c.background)
		switch w.view {
		case "connected":
			p.round(32, 145, 336, 90, 12, c.panel, c.border)
			if used, total, ok := w.usage(); ok {
				p.round(50, 219, 299, 5, 3, c.toggle, c.toggle)
				width := int(math.Min(1, used/total) * 299)
				if used > 0 {
					width = max(3, width)
					saved, _, _ := gdi.NewProc("SaveDC").Call(p.dc)
					region, _, _ := gdi.NewProc("CreateRoundRectRgn").Call(p.s(50), p.s(219), p.s(50+width), p.s(224), p.s(6), p.s(6))
					gdi.NewProc("ExtSelectClipRgn").Call(p.dc, region, 1)
					p.gradient(50, 219, width, 5)
					gdi.NewProc("RestoreDC").Call(p.dc, saved)
					gdi.NewProc("DeleteObject").Call(region)
				}
			}
		case "device":
			p.round(32, 182, 336, 170, 12, c.input, c.border)
		case "token":
			border := c.border
			if proc("GetFocus") == w.control(idToken) {
				border = c.accent
			}
			p.round(60, 265, 280, 40, 10, c.input, border)
		case "settings":
			p.round(32, 118, 336, 88, 12, c.panel, c.border)
			p.round(32, 218, 336, 88, 12, c.panel, c.border)
		}
	})
}

func (w *Window) buffered(dc uintptr, width, height int, draw func(painter)) {
	mem, _, _ := gdi.NewProc("CreateCompatibleDC").Call(dc)
	bitmap, _, _ := gdi.NewProc("CreateCompatibleBitmap").Call(dc, uintptr(width*w.dpi/96), uintptr(height*w.dpi/96))
	old, _, _ := gdi.NewProc("SelectObject").Call(mem, bitmap)
	draw(painter{w, mem})
	gdi.NewProc("BitBlt").Call(dc, 0, 0, uintptr(width*w.dpi/96), uintptr(height*w.dpi/96), mem, 0, 0, 0xcc0020)
	gdi.NewProc("SelectObject").Call(mem, old)
	gdi.NewProc("DeleteObject").Call(bitmap)
	gdi.NewProc("DeleteDC").Call(mem)
}

func (w *Window) paintControl(c control, dc uintptr) {
	w.buffered(dc, c.w, c.h, func(p painter) {
		colors := w.palette
		bg := colors.background
		if c.view == "device" && c.id != 12 || c.id == 7 || c.id == 8 || c.id == idDisconnect {
			bg = colors.input
			if c.view != "device" {
				bg = colors.panel
			}
		}
		if c.id == 10 || c.id == 11 {
			bg = colors.panel
		}
		p.fill(0, 0, c.w, c.h, bg)
		buffer := make([]uint16, proc("GetWindowTextLengthW", c.handle)+1)
		proc("GetWindowTextW", c.handle, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		title := syscall.UTF16ToString(buffer)
		fg := colors.text
		if proc("IsWindowEnabled", c.handle) == 0 {
			fg = colors.muted
		}
		switch c.id {
		case 1:
			p.line(8, 14, 20, 5, 3, colors.accent)
			p.line(8, 14, 20, 23, 3, colors.secondary)
			p.gradientText(title, 34, 1, 90, 27, w.heading)
		case 3, 4, 10, 11, 12:
			rgb := colors.muted
			if c.id == 12 && w.notice != "" && w.notice != "Working..." && w.notice != "Settings saved." && w.notice != "Code copied." && w.view != "quitting" {
				rgb = colors.danger
			}
			font := w.small
			flags := uintptr(0x810)
			if c.id == 3 {
				flags = 0x824
			}
			if c.id == 4 {
				font = w.tiny
			}
			p.text(title, 0, 0, c.w, c.h, font, rgb, flags)
		case 5:
			p.text(title, 0, 0, c.w, c.h, w.small, colors.muted, 0x825)
		case 6:
			var extent point
			gdi.NewProc("SelectObject").Call(p.dc, w.codeFont)
			gdi.NewProc("SetTextCharacterExtra").Call(p.dc, p.s(6))
			gdi.NewProc("GetTextExtentPoint32W").Call(p.dc, uintptr(unsafe.Pointer(wide(title))), uintptr(len(syscall.StringToUTF16(title))-1), uintptr(unsafe.Pointer(&extent)))
			x := max(0, (c.w-int(extent.X)*96/w.dpi)/2)
			p.gradientText(title, x, 0, c.w-x, c.h, w.codeFont)
		case 7:
			var extent point
			gdi.NewProc("SelectObject").Call(p.dc, w.small)
			gdi.NewProc("GetTextExtentPoint32W").Call(p.dc, uintptr(unsafe.Pointer(wide(title))), uintptr(len(syscall.StringToUTF16(title))-1), uintptr(unsafe.Pointer(&extent)))
			width := min(c.w, int(extent.X)*96/w.dpi+38)
			p.round(0, 0, width, c.h, 13, colors.badge, colors.border)
			p.artwork("github", 5, 5, 16, colors.badge, colors.accent, true)
			p.text(title, 27, 0, width-35, c.h, w.small, colors.accent, 0x8824)
		case 8:
			used, total, _ := w.usage()
			p.text("AI credits this cycle", 0, 0, 170, c.h, w.tiny, colors.muted, 0x824)
			p.text(credits(used)+" / "+credits(total), 170, 0, c.w-170, c.h, w.tiny, fg, 0x826)
		case 9:
			p.text(title, 0, 0, c.w, c.h, w.heading, fg, 0x824)
		case idClaude, idCodex:
			p.round(0, 0, c.w, c.h, 12, colors.panel, colors.border)
			p.round(18, 24, 32, 32, 8, colors.tile, colors.border)
			if c.id == idClaude {
				p.artwork("claude", 24, 30, 20, colors.tile, 0xd97757, true)
			} else {
				p.artwork("codex", 22, 28, 24, colors.tile, 0, false)
			}
			p.text(title, 62, 20, 180, 20, w.small, colors.muted, 0x24)
			on := proc("SendMessageW", c.handle, 0xf0, 0, 0) == 1
			word, dot := "Paused", colors.muted
			if on {
				word, dot = "Active", colors.accent
			}
			p.round(66, 48, 8, 8, 4, dot, dot)
			p.text(word, 82, 40, 120, 24, w.font, fg, 0x824)
			track, knob := colors.toggle, 2
			if on {
				track, knob = colors.on, 22
			}
			p.round(273, 28, 44, 24, 12, track, colors.border)
			p.round(273+knob, 31, 18, 18, 9, colors.knob, colors.knob)
		case idStartup, idTray:
			p.round(0, 0, c.w, c.h, 12, colors.panel, colors.border)
			p.text(title, 16, 12, 256, 24, w.bold, fg, 0x24)
			fill, border := colors.button, colors.muted
			checked := proc("SendMessageW", c.handle, 0xf0, 0, 0) == 1
			if checked {
				fill, border = colors.accent, colors.accent
			}
			p.round(294, 16, 20, 20, 4, fill, border)
			if checked {
				p.line(298, 26, 302, 30, 2, colors.knob)
				p.line(302, 30, 310, 21, 2, colors.knob)
			}
		case idTokenView, idBrowser, idProject, idQuit:
			rgb, flags := colors.accent, uintptr(0x825)
			if c.id == idProject {
				rgb, flags = colors.muted, 0x826
			} else if c.id == idQuit {
				rgb, flags = colors.danger, 0x25
			}
			p.text(title, 0, 0, c.w, c.h, w.small, rgb, flags)
		default:
			fill, border, font := colors.button, colors.border, w.bold
			if c.hover || proc("SendMessageW", c.handle, 0xf2, 0, 0)&4 != 0 {
				fill, border = colors.hover, colors.accent
			}
			if c.id == idConnect || c.id == idLogin || c.id == idDisconnect {
				fg = colors.disconnected
				if c.id == idDisconnect {
					fill, fg, font = bg, colors.connected, w.small
				}
				if c.hover || proc("SendMessageW", c.handle, 0xf2, 0, 0)&4 != 0 {
					border = fg
				}
			} else if c.id == idDone {
				fill, fg = colors.on, colors.knob
				if !c.hover && proc("SendMessageW", c.handle, 0xf2, 0, 0)&4 == 0 {
					border = colors.on
				}
			} else if c.id == idCopy {
				font = w.small
			}
			radius := min(10, c.h/3)
			if c.id == idSettings || c.id == idTheme || c.id == idDisconnect || c.id == idDone {
				radius = 8
			} else if c.id == idCopy {
				radius = 6
			}
			p.round(0, 0, c.w, c.h, radius, fill, border)
			if proc("IsWindowEnabled", c.handle) == 0 && c.id != idConnect && c.id != idLogin && c.id != idDisconnect {
				fg = colors.muted
			}
			if c.id == idSettings {
				p.text("\ue713", 0, 0, c.w, c.h, w.symbolFont, colors.muted, 0x825)
			} else if c.id == idTheme {
				p.round(9, 9, 14, 14, 7, colors.muted, colors.muted)
				if w.dark {
					p.round(13, 6, 14, 14, 7, fill, fill)
				} else {
					p.round(11, 11, 10, 10, 5, fill, fill)
					for angle := 0; angle < 8; angle++ {
						a := float64(angle) * math.Pi / 4
						p.line(16+int(10*math.Cos(a)), 16+int(10*math.Sin(a)), 16+int(12*math.Cos(a)), 16+int(12*math.Sin(a)), 1, colors.muted)
					}
				}
			} else if c.id == idConnect {
				p.artwork("github", 23, 12, 18, fill, fg, true)
				p.text(title, 48, 0, c.w-60, c.h, font, fg, 0x24)
			} else if c.id == idCopy {
				p.round(12, 8, 8, 8, 1, fill, colors.muted)
				p.round(15, 5, 8, 8, 1, fill, colors.muted)
				p.text(title, 27, 0, 35, c.h, font, fg, 0x24)
			} else {
				p.text(title, 2, 0, c.w-4, c.h, font, fg, 0x25)
			}
		}
		if c.class == "BUTTON" && proc("GetFocus") == c.handle && proc("SendMessageW", w.Handle, 0x129, 0, 0)&1 == 0 {
			r := rect{int32(p.s(2)), int32(p.s(2)), int32(p.s(c.w - 2)), int32(p.s(c.h - 2))}
			gdi.NewProc("SetTextColor").Call(p.dc, colorRef(colors.accent))
			gdi.NewProc("SetBkColor").Call(p.dc, colorRef(bg))
			proc("DrawFocusRect", p.dc, uintptr(unsafe.Pointer(&r)))
		}
	})
}

var controlCallback = syscall.NewCallback(controlProc)

func controlProc(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
	w := active
	if w != nil {
		for i := range w.controls {
			c := &w.controls[i]
			if c.handle != hwnd {
				continue
			}
			if c.class != "EDIT" {
				switch msg {
				case 0x20:
					if c.id == idQuit {
						proc("SetCursor", proc("LoadCursorW", 0, 32649))
						return 1
					}
				case 0xf:
					var ps paintStruct
					dc := proc("BeginPaint", hwnd, uintptr(unsafe.Pointer(&ps)))
					w.paintControl(*c, dc)
					proc("EndPaint", hwnd, uintptr(unsafe.Pointer(&ps)))
					return 0
				case 0x318:
					w.paintControl(*c, wp)
					return 0
				case 0x14:
					return 1
				case 0x200:
					if !c.hover {
						c.hover = true
						track := struct {
							Size, Flags uint32
							Window      uintptr
							Time        uint32
						}{Window: hwnd, Flags: 2}
						track.Size = uint32(unsafe.Sizeof(track))
						proc("TrackMouseEvent", uintptr(unsafe.Pointer(&track)))
						proc("InvalidateRect", hwnd, 0, 0)
					}
				case 0x2a3:
					c.hover = false
					proc("InvalidateRect", hwnd, 0, 0)
				}
			}
			previous := c.previous
			result := proc("CallWindowProcW", previous, hwnd, uintptr(msg), wp, lp)
			if c.class == "EDIT" && msg == 0x318 && proc("GetWindowTextLengthW", hwnd) == 0 {
				painter{w, wp}.text("Paste your access token", 0, 0, c.w, c.h, w.inputFont, w.palette.muted, 0x824)
			}
			if msg == 7 || msg == 8 || msg == 0xf1 || msg == 0xf3 || msg == 0x128 {
				proc("InvalidateRect", hwnd, 0, 0)
				if hwnd == w.control(idToken) {
					proc("InvalidateRect", w.Handle, 0, 0)
				}
			}
			return result
		}
	}
	return proc("DefWindowProcW", hwnd, uintptr(msg), wp, lp)
}
