package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
)

func put16(b []byte, offset int, value uint16) { binary.LittleEndian.PutUint16(b[offset:], value) }
func put32(b []byte, offset int, value uint32) { binary.LittleEndian.PutUint32(b[offset:], value) }
func align(n int) int                          { return (n + 3) &^ 3 }

type resource struct {
	kind, id uint16
	data     []byte
}

func versionBlock(key string, value []byte, valueLength uint16, text bool, children ...[]byte) []byte {
	var b bytes.Buffer
	b.Write(make([]byte, 6))
	for _, u := range utf16.Encode([]rune(key + "\x00")) {
		_ = binary.Write(&b, binary.LittleEndian, u)
	}
	for b.Len()%4 != 0 {
		b.WriteByte(0)
	}
	b.Write(value)
	for _, child := range children {
		for b.Len()%4 != 0 {
			b.WriteByte(0)
		}
		b.Write(child)
	}
	out := b.Bytes()
	put16(out, 0, uint16(len(out)))
	put16(out, 2, valueLength)
	if text {
		put16(out, 4, 1)
	}
	return out
}
func versionResource(version string) []byte {
	numbers := [4]uint32{}
	for i, s := range strings.Split(version, ".") {
		if i >= 4 {
			break
		}
		n, _ := strconv.ParseUint(s, 10, 16)
		numbers[i] = uint32(n)
	}
	fixed := make([]byte, 52)
	values := []uint32{0xfeef04bd, 0x10000, numbers[0]<<16 | numbers[1], numbers[2]<<16 | numbers[3], numbers[0]<<16 | numbers[1], numbers[2]<<16 | numbers[3], 0x3f, 0, 0x40004, 1, 0, 0, 0}
	for i, n := range values {
		put32(fixed, i*4, n)
	}
	children := [][]byte{}
	for _, pair := range [][2]string{{"FileDescription", "Kobashi"}, {"ProductName", "Kobashi"}, {"FileVersion", version}, {"ProductVersion", version}, {"OriginalFilename", "Kobashi.exe"}} {
		units := utf16.Encode([]rune(pair[1] + "\x00"))
		value := make([]byte, len(units)*2)
		for i, u := range units {
			put16(value, i*2, u)
		}
		children = append(children, versionBlock(pair[0], value, uint16(len(units)), true))
	}
	stringsBlock := versionBlock("StringFileInfo", nil, 0, true, versionBlock("040904B0", nil, 0, true, children...))
	translation := []byte{9, 4, 0xb0, 4}
	varBlock := versionBlock("VarFileInfo", nil, 0, true, versionBlock("Translation", translation, 4, false))
	return versionBlock("VS_VERSION_INFO", fixed, 52, false, stringsBlock, varBlock)
}
func writeWindowsResources(path string, ico []byte, version string) error {
	if len(ico) < 6 {
		return errors.New("missing Windows icon")
	}
	count := int(binary.LittleEndian.Uint16(ico[4:]))
	if count < 1 || len(ico) < 6+16*count {
		return errors.New("invalid Windows icon")
	}
	resources := []resource{}
	group := make([]byte, 6+14*count)
	copy(group, ico[:6])
	for i := 0; i < count; i++ {
		entry := ico[6+16*i : 6+16*(i+1)]
		length, offset := int(binary.LittleEndian.Uint32(entry[8:])), int(binary.LittleEndian.Uint32(entry[12:]))
		if offset < 0 || length <= 0 || offset+length > len(ico) {
			return errors.New("invalid icon image")
		}
		resources = append(resources, resource{3, uint16(i + 1), ico[offset : offset+length]})
		copy(group[6+14*i:], entry[:12])
		put16(group, 6+14*i+12, uint16(i+1))
	}
	manifest := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<assemblyIdentity type="win32" name="com.xjin6.kobashi" version="` + version + `.0"/>
<dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="amd64" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>`)
	resources = append(resources, resource{14, 1, group}, resource{16, 1, versionResource(version)}, resource{24, 1, manifest})
	// Resource directories contain section-relative offsets; COFF relocations
	// let the Go linker supply the final image RVA for each data entry.
	kinds := []uint16{3, 14, 16, 24}
	rootSize := 16 + len(kinds)*8
	typeOffsets := map[uint16]int{}
	cursor := rootSize
	for _, kind := range kinds {
		n := 1
		if kind == 3 {
			n = count
		}
		typeOffsets[kind] = cursor
		cursor += 16 + n*8
	}
	idOffsets := make([]int, len(resources))
	for i := range resources {
		idOffsets[i] = cursor
		cursor += 24
	}
	dataOffsets := make([]int, len(resources))
	for i := range resources {
		dataOffsets[i] = cursor
		cursor += 16
	}
	rawOffsets := make([]int, len(resources))
	for i, r := range resources {
		cursor = align(cursor)
		rawOffsets[i] = cursor
		cursor += len(r.data)
	}
	section := make([]byte, align(cursor))
	put16(section, 14, uint16(len(kinds)))
	for i, kind := range kinds {
		put32(section, 16+i*8, uint32(kind))
		put32(section, 20+i*8, uint32(typeOffsets[kind])|0x80000000)
	}
	kindCounts := map[uint16]int{}
	for i, r := range resources {
		root := typeOffsets[r.kind]
		n := 1
		if r.kind == 3 {
			n = count
		}
		put16(section, root+14, uint16(n))
		index := kindCounts[r.kind]
		kindCounts[r.kind]++
		put32(section, root+16+8*index, uint32(r.id))
		put32(section, root+20+8*index, uint32(idOffsets[i])|0x80000000)
		put16(section, idOffsets[i]+14, 1)
		put32(section, idOffsets[i]+16, 0x409)
		put32(section, idOffsets[i]+20, uint32(dataOffsets[i]))
		put32(section, dataOffsets[i], uint32(rawOffsets[i]))
		put32(section, dataOffsets[i]+4, uint32(len(r.data)))
		copy(section[rawOffsets[i]:], r.data)
	}
	header := make([]byte, 60)
	put16(header, 0, 0x8664)
	put16(header, 2, 1)
	relocations := make([]byte, 10*len(resources))
	for i := range resources {
		put32(relocations, i*10, uint32(dataOffsets[i]))
		put16(relocations, i*10+8, 3)
	}
	symbolsOffset := 60 + len(section) + len(relocations)
	put32(header, 8, uint32(symbolsOffset))
	put32(header, 12, 1)
	copy(header[20:], ".rsrc")
	put32(header, 36, uint32(len(section)))
	put32(header, 40, 60)
	put32(header, 44, uint32(60+len(section)))
	put16(header, 52, uint16(len(resources)))
	put32(header, 56, 0x40000040)
	symbol := make([]byte, 18)
	copy(symbol, ".rsrc")
	put16(symbol, 12, 1)
	symbol[16] = 3
	output := append(header, section...)
	output = append(output, relocations...)
	output = append(output, symbol...)
	output = append(output, 4, 0, 0, 0)
	return os.WriteFile(path, output, 0600)
}
