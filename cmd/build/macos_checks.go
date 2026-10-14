package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func checkMac(smoke bool) error {
	if !smoke {
		if err := checkMacHarness("macos-toggles.swift"); err != nil {
			return err
		}
	}
	test := "macos-lifecycle.swift"
	if smoke {
		test = "macos-smoke.swift"
	}
	return checkMacHarness(test)
}

func checkMacHarness(test string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("Cocoa lifecycle checks require a macOS graphical login session")
	}
	root, err := os.Getwd()
	if err != nil {
		return err
	}
	temp, err := localPath(os.TempDir(), root)
	if err != nil {
		return err
	}
	workspace, err := os.MkdirTemp(temp, "kobashi-cocoa-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workspace)
	source, err := os.ReadFile(filepath.Join(root, "macos", "main.swift"))
	if err != nil {
		return err
	}
	source = []byte(strings.ReplaceAll(string(source), "\r\n", "\n"))
	entry := "\nlet app = NSApplication.shared\n"
	if strings.Count(string(source), entry) != 1 {
		return errors.New("Cocoa application entry point not found")
	}
	harness, err := os.ReadFile(filepath.Join(root, "test", test))
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(workspace, "main.swift"), append([]byte(strings.SplitN(string(source), entry, 2)[0]+"\n"), harness...), 0600); err != nil {
		return err
	}
	app := filepath.Join(workspace, "Kobashi Lifecycle Test.app", "Contents")
	if err = os.MkdirAll(filepath.Join(app, "MacOS"), 0700); err != nil {
		return err
	}
	for _, name := range []string{"github.png", "claude.png", "codex.png"} {
		if err = copyFile(filepath.Join(root, "assets", name), filepath.Join(app, "Resources", name)); err != nil {
			return err
		}
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>lifecycle-check</string><key>CFBundleName</key><string>Kobashi Lifecycle Test</string><key>CFBundleIdentifier</key><string>com.xjin6.kobashi.lifecycle-test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
	if err = os.WriteFile(filepath.Join(app, "Info.plist"), []byte(plist), 0600); err != nil {
		return err
	}
	executable := filepath.Join(app, "MacOS", "lifecycle-check")
	if err = run(workspace, os.Environ(), "xcrun", "--toolchain", "XcodeDefault", "swiftc", "-framework", "Cocoa", filepath.Join(workspace, "main.swift"), "-o", executable); err != nil {
		return err
	}
	return run(workspace, os.Environ(), executable)
}
