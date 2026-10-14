package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

func main() {
	target := flag.String("target", runtime.GOOS, "windows or darwin")
	destination := flag.String("output", "", "Directory for finished artifacts; default: dist")
	testMac := flag.Bool("test-mac", false, "Run isolated Cocoa lifecycle checks on macOS")
	smoke := flag.Bool("smoke", false, "Run the interactive isolated Cocoa smoke check")
	flag.Parse()
	var err error
	if *testMac {
		err = checkMac(*smoke)
	} else {
		err = build(*target, *destination)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func within(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func resolvedLocation(path string) (string, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	suffix := []string{}
	for {
		resolved, err := filepath.EvalSymlinks(path)
		if err == nil {
			return filepath.Join(append([]string{resolved}, suffix...)...), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", err
		}
		suffix = append([]string{filepath.Base(path)}, suffix...)
		path = parent
	}
}
func localPath(path, source string) (string, error) {
	resolved, err := resolvedLocation(path)
	if err != nil {
		return "", err
	}
	source, err = resolvedLocation(source)
	if err != nil {
		return "", err
	}
	if within(resolved, source) {
		return "", fmt.Errorf("build scratch must be outside the checkout: %s", path)
	}
	normalized := strings.ToLower(strings.ReplaceAll(resolved, `\`, "/"))
	for _, part := range strings.Split(normalized, "/") {
		if strings.HasPrefix(part, "onedrive") {
			return "", fmt.Errorf("build scratch must be outside OneDrive: %s", path)
		}
	}
	if strings.Contains(normalized, "/library/cloudstorage/") {
		return "", fmt.Errorf("cloud-backed scratch is not allowed: %s", path)
	}
	for _, key := range []string{"OneDrive", "OneDriveConsumer", "OneDriveCommercial"} {
		if value := os.Getenv(key); value != "" {
			root, e := resolvedLocation(value)
			if e != nil {
				return "", e
			}
			if within(resolved, root) {
				return "", fmt.Errorf("cloud-backed scratch is not allowed: %s", path)
			}
		}
	}
	return resolved, nil
}
func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	closeErr := output.Close()
	return errors.Join(err, closeErr)
}
func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(target, rel), 0700)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("build source contains a symlink: %s", path)
		}
		return copyFile(path, filepath.Join(target, rel))
	})
}
func envWith(env []string, key, value string) []string {
	out := []string{}
	for _, s := range env {
		if !strings.HasPrefix(strings.ToUpper(s), strings.ToUpper(key)+"=") {
			out = append(out, s)
		}
	}
	return append(out, key+"="+value)
}
func run(workspace string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = workspace
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}
func build(target, destination string) error {
	if !slices.Contains([]string{"windows", "darwin"}, target) {
		return errors.New("target must be windows or darwin")
	}
	if target == "darwin" && runtime.GOOS != "darwin" {
		return errors.New("a macOS host with Xcode Command Line Tools is required to build the Cocoa app")
	}
	source, err := os.Getwd()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(source, "package.json"))
	if err != nil {
		return err
	}
	var pkg struct{ Version string }
	if err = json.Unmarshal(data, &pkg); err != nil || pkg.Version == "" {
		return errors.New("package.json must contain the app version")
	}
	scratchRoot := os.Getenv("KOBASHI_BUILD_TMPDIR")
	if scratchRoot == "" {
		scratchRoot = os.TempDir()
	}
	scratchRoot, err = localPath(scratchRoot, source)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(scratchRoot, 0700); err != nil {
		return err
	}
	workspace, err := os.MkdirTemp(scratchRoot, "kobashi-native-build-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workspace)
	fmt.Println("Native build workspace:", workspace)
	for _, name := range []string{"go.mod", "package.json"} {
		if err = copyFile(filepath.Join(source, name), filepath.Join(workspace, name)); err != nil {
			return err
		}
	}
	for _, name := range []string{"cmd", "internal", "macos"} {
		if err = copyTree(filepath.Join(source, name), filepath.Join(workspace, name)); err != nil {
			return err
		}
	}
	for _, name := range []string{"native.go", "kobashi-icon.ico", "kobashi-icon.png", "github.png", "claude.png", "codex.png"} {
		if err = copyFile(filepath.Join(source, "assets", name), filepath.Join(workspace, "assets", name)); err != nil {
			return err
		}
	}
	env := envWith(os.Environ(), "CGO_ENABLED", "0")
	env = envWith(env, "GOTOOLCHAIN", "local")
	env = envWith(env, "GOCACHE", filepath.Join(workspace, "go-cache"))
	env = envWith(env, "GOMODCACHE", filepath.Join(workspace, "go-mod-cache"))
	scratch := filepath.Join(workspace, "tmp")
	if err = os.MkdirAll(scratch, 0700); err != nil {
		return err
	}
	env = envWith(env, "TMPDIR", scratch)
	env = envWith(env, "TMP", scratch)
	env = envWith(env, "TEMP", scratch)
	env = envWith(env, "CLANG_MODULE_CACHE_PATH", filepath.Join(workspace, "clang-module-cache"))
	output := filepath.Join(workspace, "output")
	if err = os.MkdirAll(output, 0700); err != nil {
		return err
	}
	name := "Kobashi.exe"
	if target == "windows" {
		icon, readErr := os.ReadFile(filepath.Join(workspace, "assets", "kobashi-icon.ico"))
		if readErr != nil {
			return readErr
		}
		if err = writeWindowsResources(filepath.Join(workspace, "cmd", "kobashi", "resources_windows_amd64.syso"), icon, pkg.Version); err != nil {
			return err
		}
		winEnv := envWith(env, "GOOS", "windows")
		winEnv = envWith(winEnv, "GOARCH", "amd64")
		if err = run(workspace, winEnv, "go", "build", "-trimpath", "-ldflags", "-s -w -H=windowsgui -X main.Version="+pkg.Version, "-o", filepath.Join(output, name), "./cmd/kobashi"); err != nil {
			return err
		}
	} else {
		name = "Kobashi.app"
		if err = buildMac(workspace, output, env, pkg.Version); err != nil {
			return err
		}
	}
	if destination == "" {
		destination = filepath.Join(source, "dist")
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	if err = publish(destination, filepath.Join(output, name), name); err != nil {
		return err
	}
	fmt.Println("Built:", filepath.Join(destination, name))
	return nil
}
func buildMac(workspace, output string, env []string, version string) error {
	app := filepath.Join(output, "Kobashi.app", "Contents")
	binaries := filepath.Join(app, "Resources", "bin")
	if err := os.MkdirAll(binaries, 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(app, "MacOS"), 0700); err != nil {
		return err
	}
	for _, name := range []string{"github.png", "claude.png", "codex.png"} {
		if err := copyFile(filepath.Join(workspace, "assets", name), filepath.Join(app, "Resources", name)); err != nil {
			return err
		}
	}
	swiftBinaries := []string{}
	for _, architecture := range []string{"arm64", "amd64"} {
		childEnv := envWith(env, "GOOS", "darwin")
		childEnv = envWith(childEnv, "GOARCH", architecture)
		binary := "kobashi-arm64"
		swiftArch := "arm64"
		if architecture == "amd64" {
			binary = "kobashi-x64"
			swiftArch = "x86_64"
		}
		if err := run(workspace, childEnv, "go", "build", "-trimpath", "-ldflags", "-s -w -X main.Version="+version, "-o", filepath.Join(binaries, binary), "./cmd/kobashi"); err != nil {
			return err
		}
		swift := filepath.Join(output, "cocoa-"+architecture)
		if err := run(workspace, env, "xcrun", "--toolchain", "XcodeDefault", "swiftc", "-O", "-module-cache-path", filepath.Join(workspace, "swift-module-cache"), "-framework", "Cocoa", "-target", swiftArch+"-apple-macos13", "macos/main.swift", "-o", swift); err != nil {
			return err
		}
		swiftBinaries = append(swiftBinaries, swift)
	}
	if err := run(workspace, env, "lipo", "-create", swiftBinaries[0], swiftBinaries[1], "-output", filepath.Join(app, "MacOS", "kobashi")); err != nil {
		return err
	}
	if err := run(workspace, env, "xcrun", "--toolchain", "XcodeDefault", "swift", "-module-cache-path", filepath.Join(workspace, "swift-module-cache"), "macos/icon.swift", filepath.Join(workspace, "assets", "kobashi-icon.png"), filepath.Join(output, "AppIcon.iconset")); err != nil {
		return err
	}
	if err := run(workspace, env, "iconutil", "-c", "icns", filepath.Join(output, "AppIcon.iconset"), "-o", filepath.Join(app, "Resources", "AppIcon.icns")); err != nil {
		return err
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>Kobashi</string><key>CFBundleDisplayName</key><string>Kobashi</string>
<key>CFBundleIdentifier</key><string>com.xjin6.kobashi</string><key>CFBundleVersion</key><string>` + version + `</string>
<key>CFBundleShortVersionString</key><string>` + version + `</string><key>CFBundleExecutable</key><string>kobashi</string>
<key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`
	return os.WriteFile(filepath.Join(app, "Info.plist"), []byte(plist), 0600)
}
func checksum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func releaseChecksums(path, name string) ([]string, error) {
	lines := []string{}
	err := filepath.WalkDir(path, func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("release contains a non-regular file: %s", file)
		}
		rel, err := filepath.Rel(path, file)
		if err != nil {
			return err
		}
		release := name
		if rel != "." {
			release = filepath.ToSlash(filepath.Join(name, rel))
		}
		sum, err := checksum(file)
		if err != nil {
			return err
		}
		lines = append(lines, sum+"  "+release)
		return nil
	})
	return lines, err
}
func replaceApp(source, target string) error {
	if _, err := os.Lstat(target); errors.Is(err, os.ErrNotExist) {
		return replaceRelease(source, target)
	} else if err != nil {
		return err
	}
	backup, err := os.MkdirTemp(filepath.Dir(target), "."+filepath.Base(target)+"-*.old")
	if err != nil {
		return err
	}
	previous := filepath.Join(backup, filepath.Base(target))
	if err = replaceRelease(target, previous); err != nil {
		return errors.Join(err, os.Remove(backup))
	}
	if err = replaceRelease(source, target); err != nil {
		if rollbackErr := replaceRelease(previous, target); rollbackErr != nil {
			return fmt.Errorf("replace app: %w; restore failed: %w; previous app kept at %s", err, rollbackErr, previous)
		}
		return errors.Join(err, os.Remove(backup))
	}
	return os.RemoveAll(backup)
}
func publish(dir, built, name string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Stat(built)
	if err != nil {
		return err
	}
	temp, err := os.MkdirTemp(dir, "."+name+"-*.tmp")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	staged := filepath.Join(temp, name)
	if info.IsDir() {
		err = copyTree(built, staged)
	} else {
		err = copyFile(built, staged)
	}
	if err != nil {
		return err
	}
	expected, err := releaseChecksums(built, name)
	if err != nil {
		return err
	}
	copied, err := releaseChecksums(staged, name)
	if err != nil {
		return err
	}
	if !slices.Equal(copied, expected) {
		return errors.New("release copy checksum mismatch")
	}
	lines := []string{}
	for _, release := range []string{"Kobashi.exe", "Kobashi.app"} {
		if release == name {
			lines = append(lines, expected...)
			continue
		}
		existing, err := releaseChecksums(filepath.Join(dir, release), release)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		lines = append(lines, existing...)
	}
	sums, err := os.CreateTemp(dir, ".SHA256SUMS-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(sums.Name())
	_, err = sums.WriteString(strings.Join(lines, "\n") + "\n")
	closeErr := sums.Close()
	if err = errors.Join(err, closeErr); err != nil {
		return err
	}
	if info.IsDir() {
		err = replaceApp(staged, filepath.Join(dir, name))
	} else {
		err = replaceRelease(staged, filepath.Join(dir, name))
	}
	if err != nil {
		return fmt.Errorf("publish %s: %w; use -output to save elsewhere without stopping a running app", filepath.Join(dir, name), err)
	}
	return replaceRelease(sums.Name(), filepath.Join(dir, "SHA256SUMS.txt"))
}
