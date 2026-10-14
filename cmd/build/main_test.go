package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildRejectsCheckoutAndCloudScratch(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(source, "scratch"), filepath.Join(root, "OneDrive - Test", "scratch"), filepath.Join(root, "Library", "CloudStorage", "provider", "scratch")} {
		if _, err := localPath(path, source); err == nil {
			t.Fatal("unsafe scratch accepted", path)
		}
	}
	if _, err := localPath(filepath.Join(root, "local", "scratch"), source); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OneDriveCommercial", filepath.Join(root, "custom-cloud"))
	if _, err := localPath(filepath.Join(root, "custom-cloud", "scratch"), source); err == nil {
		t.Fatal("cloud override accepted")
	}
}
func TestPublishOnlyFinishedArtifactsWithChecksums(t *testing.T) {
	source := t.TempDir()
	scratch := t.TempDir()
	dist := filepath.Join(source, "dist")
	if err := os.MkdirAll(dist, 0700); err != nil {
		t.Fatal(err)
	}
	writeReleaseFixture(t, dist, map[string]string{
		"Kobashi.exe":                     "old exe",
		"Kobashi.app/Contents/Info.plist": "old plist",
	})
	built := filepath.Join(scratch, "Kobashi.exe")
	if err := os.WriteFile(built, []byte("native"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := publish(dist, built, "Kobashi.exe"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dist, "Kobashi.app", "Contents", "Info.plist"))
	if err != nil || string(data) != "old plist" {
		t.Fatal("other platform overwritten", err)
	}
	sums, err := os.ReadFile(filepath.Join(dist, "SHA256SUMS.txt"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(sums)), "\n")
	if len(lines) != 2 {
		t.Fatal("missing release checksums", string(sums))
	}
	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) != 2 {
			t.Fatal(line)
		}
		digest, err := checksum(filepath.Join(dist, parts[1]))
		if err != nil || digest != parts[0] {
			t.Fatal("invalid checksum", line, err)
		}
	}
	files, _ := os.ReadDir(dist)
	if len(files) != 3 {
		t.Fatal("intermediates were published", files)
	}
}

func writeReleaseFixture(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPublishCreatesAppBundle(t *testing.T) {
	scratch := t.TempDir()
	writeReleaseFixture(t, scratch, map[string]string{
		"Kobashi.app/Contents/Info.plist": "plist",
	})
	dist := filepath.Join(t.TempDir(), "release with spaces")
	if err := publish(dist, filepath.Join(scratch, "Kobashi.app"), "Kobashi.app"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dist, "Kobashi.app", "Contents", "Info.plist"))
	if err != nil || string(data) != "plist" {
		t.Fatal("bundle not published", err)
	}
	files, err := os.ReadDir(dist)
	if err != nil || len(files) != 2 {
		t.Fatal("unexpected release files", files, err)
	}
}

func TestPublishAppReplacesBundleAndPreservesWindowsRelease(t *testing.T) {
	dist := t.TempDir()
	scratch := t.TempDir()
	writeReleaseFixture(t, dist, map[string]string{
		"Kobashi.exe":                       "windows",
		"Kobashi.app/Contents/Info.plist":   "old plist",
		"Kobashi.app/Contents/obsolete.txt": "obsolete",
	})
	bundle := map[string]string{
		"Kobashi.app/Contents/Info.plist":                  "plist",
		"Kobashi.app/Contents/MacOS/kobashi":               "cocoa",
		"Kobashi.app/Contents/Resources/AppIcon.icns":      "icon",
		"Kobashi.app/Contents/Resources/bin/kobashi-arm64": "arm64",
		"Kobashi.app/Contents/Resources/bin/kobashi-x64":   "x64",
	}
	writeReleaseFixture(t, scratch, bundle)
	built := filepath.Join(scratch, "Kobashi.app")
	if err := publish(dist, built, "Kobashi.app"); err != nil {
		t.Fatal(err)
	}
	for name, content := range bundle {
		path := filepath.FromSlash(name)
		data, err := os.ReadFile(filepath.Join(dist, path))
		if err != nil || string(data) != content {
			t.Fatal("bundle content mismatch", name, err)
		}
		sourceInfo, err := os.Stat(filepath.Join(scratch, path))
		if err != nil {
			t.Fatal(err)
		}
		publishedInfo, err := os.Stat(filepath.Join(dist, path))
		if err != nil || publishedInfo.Mode().Perm() != sourceInfo.Mode().Perm() {
			t.Fatal("bundle permissions changed", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dist, "Kobashi.app", "Contents", "obsolete.txt")); !os.IsNotExist(err) {
		t.Fatal("obsolete bundle file retained", err)
	}
	data, err := os.ReadFile(filepath.Join(dist, "Kobashi.exe"))
	if err != nil || string(data) != "windows" {
		t.Fatal("Windows release overwritten", err)
	}
	sums, err := os.ReadFile(filepath.Join(dist, "SHA256SUMS.txt"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(sums)), "\n")
	if len(lines) != len(bundle)+1 {
		t.Fatal("missing release checksums", string(sums))
	}
	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) != 2 || strings.Contains(parts[1], `\`) {
			t.Fatal("invalid checksum entry", line)
		}
		digest, err := checksum(filepath.Join(dist, filepath.FromSlash(parts[1])))
		if err != nil || digest != parts[0] {
			t.Fatal("invalid checksum", line, err)
		}
	}
	files, err := os.ReadDir(dist)
	if err != nil || len(files) != 3 {
		t.Fatal("intermediates were published", files, err)
	}
}

func TestReplaceAppRestoresPreviousBundleOnFailure(t *testing.T) {
	dist := t.TempDir()
	writeReleaseFixture(t, dist, map[string]string{
		"Kobashi.app/Contents/Info.plist": "previous",
	})
	target := filepath.Join(dist, "Kobashi.app")
	if err := replaceApp(filepath.Join(dist, "missing.app"), target); err == nil {
		t.Fatal("missing bundle accepted")
	}
	data, err := os.ReadFile(filepath.Join(target, "Contents", "Info.plist"))
	if err != nil || string(data) != "previous" {
		t.Fatal("previous bundle not restored", err)
	}
	files, err := os.ReadDir(dist)
	if err != nil || len(files) != 1 {
		t.Fatal("backup directory retained after rollback", files, err)
	}
}
