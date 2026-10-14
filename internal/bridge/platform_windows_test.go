package bridge

import (
	"crypto/rand"
	"syscall"
	"testing"
	"unsafe"
)

func TestRegistryDeleteUsesWriteAccess(t *testing.T) {
	path := `Software\KobashiNativeTest-` + rand.Text()
	t.Cleanup(func() {
		_ = registryWrite(path, "Value", nil)
		code, _, _ := advapi.NewProc("RegDeleteKeyW").Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(wide(path))))
		if code != 0 && code != 2 {
			t.Error(syscall.Errno(code))
		}
	})
	value := "native"
	if err := registryWrite(path, "Value", &value); err != nil {
		t.Fatal(err)
	}
	if got, err := registryString(path, "Value"); err != nil || got == nil || *got != value {
		t.Fatal(got, err)
	}
	if err := registryWrite(path, "Value", nil); err != nil {
		t.Fatal(err)
	}
	if got, err := registryString(path, "Value"); err != nil || got != nil {
		t.Fatal(got, err)
	}
	if err := registryWrite(path, "Value", nil); err != nil {
		t.Fatal("missing value deletion must be harmless", err)
	}
	if err := registryWrite(path+`\Missing`, "Value", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := registryHandle(path+`\Missing`, false); err != syscall.ERROR_FILE_NOT_FOUND {
		t.Fatal("deletion created a registry key", err)
	}
}
