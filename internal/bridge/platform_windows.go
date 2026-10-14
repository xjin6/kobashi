package bridge

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var advapi = syscall.NewLazyDLL("advapi32.dll")
var regOpen = advapi.NewProc("RegOpenKeyExW")
var regCreate = advapi.NewProc("RegCreateKeyExW")
var regQuery = advapi.NewProc("RegQueryValueExW")
var regSet = advapi.NewProc("RegSetValueExW")
var regDelete = advapi.NewProc("RegDeleteValueW")
var regClose = advapi.NewProc("RegCloseKey")
var kernel = syscall.NewLazyDLL("kernel32.dll")
var ntQueryProcess = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQueryInformationProcess")

func wide(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func registryHandle(path string, write bool) (uintptr, error) {
	var handle uintptr
	var status uintptr
	if write {
		status, _, _ = regCreate.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(wide(path))), 0, 0, 0, 0x20006, 0, uintptr(unsafe.Pointer(&handle)), 0)
	} else {
		status, _, _ = regOpen.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(wide(path))), 0, 0x20019, uintptr(unsafe.Pointer(&handle)))
	}
	if status != 0 {
		return 0, syscall.Errno(status)
	}
	return handle, nil
}
func registryRead(path, key string) ([]byte, uint32, error) {
	handle, err := registryHandle(path, false)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	defer regClose.Call(handle)
	var size, kind uint32
	code, _, _ := regQuery.Call(handle, uintptr(unsafe.Pointer(wide(key))), 0, uintptr(unsafe.Pointer(&kind)), 0, uintptr(unsafe.Pointer(&size)))
	if code == 2 {
		return nil, 0, nil
	}
	if code != 0 {
		return nil, 0, syscall.Errno(code)
	}
	if size == 0 {
		return []byte{}, kind, nil
	}
	buffer := make([]byte, size)
	code, _, _ = regQuery.Call(handle, uintptr(unsafe.Pointer(wide(key))), 0, uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size)))
	if code != 0 {
		return nil, 0, syscall.Errno(code)
	}
	return buffer[:size], kind, nil
}
func registryString(path, key string) (*string, error) {
	data, kind, err := registryRead(path, key)
	if err != nil || data == nil {
		return nil, err
	}
	if kind != 1 && kind != 2 {
		return nil, fmt.Errorf("registry value %s is not a string", key)
	}
	if len(data)%2 != 0 {
		return nil, fmt.Errorf("invalid registry string %s", key)
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	value := syscall.UTF16ToString(units)
	return &value, nil
}
func registryWrite(path, key string, value *string) error {
	var handle uintptr
	var err error
	if value != nil {
		handle, err = registryHandle(path, true)
	} else {
		code, _, _ := regOpen.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(wide(path))), 0, 2, uintptr(unsafe.Pointer(&handle)))
		if code != 0 {
			err = syscall.Errno(code)
		}
	}
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) && value == nil {
		return nil
	}
	if err != nil {
		return err
	}
	defer regClose.Call(handle)
	var code uintptr
	if value == nil {
		code, _, _ = regDelete.Call(handle, uintptr(unsafe.Pointer(wide(key))))
		if code == 2 {
			return nil
		}
	} else {
		data, err := syscall.UTF16FromString(*value)
		if err != nil {
			return err
		}
		code, _, _ = regSet.Call(handle, uintptr(unsafe.Pointer(wide(key))), 0, 1, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	}
	if code != 0 {
		return syscall.Errno(code)
	}
	return nil
}
func replaceFile(source, target string) error {
	ok, _, err := kernel.NewProc("MoveFileExW").Call(uintptr(unsafe.Pointer(wide(source))), uintptr(unsafe.Pointer(wide(target))), 0x1|0x8)
	if ok == 0 {
		return err
	}
	return nil
}
func configureStartup(options Options, enabled bool) error {
	var value *string
	if enabled {
		executable := options.Executable
		if executable == "" {
			var err error
			executable, err = os.Executable()
			if err != nil {
				return err
			}
		}
		executable, err := filepath.Abs(executable)
		if err != nil {
			return err
		}
		command := `"` + executable + `" --startup`
		value = &command
	}
	return registryWrite(`Software\Microsoft\Windows\CurrentVersion\Run`, "Kobashi", value)
}
func systemProxy() (*url.URL, error) {
	path := `Software\Microsoft\Windows\CurrentVersion\Internet Settings`
	data, _, err := registryRead(path, "ProxyEnable")
	if err != nil {
		return nil, err
	}
	if len(data) < 4 || binary.LittleEndian.Uint32(data) != 1 {
		return nil, nil
	}
	value, err := registryString(path, "ProxyServer")
	if err != nil || value == nil || *value == "" {
		return nil, err
	}
	server := *value
	scheme := "http"
	if strings.Contains(server, "=") {
		parts := map[string]string{}
		for _, part := range strings.Split(server, ";") {
			key, value, ok := strings.Cut(part, "=")
			if ok {
				parts[strings.TrimSpace(key)] = strings.TrimSpace(value)
			}
		}
		server = parts["https"]
		if server == "" {
			server = parts["http"]
		}
		if server == "" {
			server = parts["socks"]
			scheme = "socks5"
		}
	}
	if server == "" {
		return nil, nil
	}
	return url.Parse(scheme + "://" + server)
}
func hideCommand(cmd *exec.Cmd)                       { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func readUserEnvironment(key string) (*string, error) { return registryString("Environment", key) }
func writeUserEnvironment(key string, value *string) error {
	if err := registryWrite("Environment", key, value); err != nil {
		return err
	}
	var result uintptr
	syscall.NewLazyDLL("user32.dll").NewProc("SendMessageTimeoutW").Call(0xffff, 0x1a, 0, uintptr(unsafe.Pointer(wide("Environment"))), 2, 1000, uintptr(unsafe.Pointer(&result)))
	return nil
}
func codexCommands(home string) []string {
	root := filepath.Join(os.Getenv("LOCALAPPDATA"), "OpenAI", "Codex", "bin")
	if os.Getenv("LOCALAPPDATA") == "" {
		root = filepath.Join(home, "AppData", "Local", "OpenAI", "Codex", "bin")
	}
	commands := []string{filepath.Join(root, "codex.exe")}
	dirs, err := os.ReadDir(root)
	if err == nil {
		for _, d := range dirs {
			if d.IsDir() {
				commands = append(commands, filepath.Join(root, d.Name(), "codex.exe"))
			}
		}
	}
	sort.SliceStable(commands, func(i, j int) bool {
		a, e := os.Stat(commands[i])
		if e != nil {
			return false
		}
		b, e := os.Stat(commands[j])
		return e != nil || a.ModTime().After(b.ModTime())
	})
	return commands
}

type processEntry struct {
	Size, Usage, PID        uint32
	Heap                    uintptr
	Module, Threads, Parent uint32
	Priority                int32
	Flags                   uint32
	Name                    [260]uint16
}

func readProcesses(ctx context.Context) ([]processInfo, error) {
	snapshot, _, err := kernel.NewProc("CreateToolhelp32Snapshot").Call(2, 0)
	if snapshot == ^uintptr(0) {
		return nil, err
	}
	defer kernel.NewProc("CloseHandle").Call(snapshot)
	entry := processEntry{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	first := kernel.NewProc("Process32FirstW")
	next := kernel.NewProc("Process32NextW")
	ok, _, err := first.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	if ok == 0 {
		return nil, err
	}
	out := []processInfo{}
	for {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		p := processInfo{PID: int(entry.PID), Parent: int(entry.Parent), Name: syscall.UTF16ToString(entry.Name[:])}
		if contains([]string{"codex.exe", "chatgpt.exe"}, strings.ToLower(p.Name)) {
			handle, _, openErr := kernel.NewProc("OpenProcess").Call(0x1000, 0, uintptr(entry.PID))
			if handle == 0 && !errors.Is(openErr, syscall.Errno(87)) {
				return nil, openErr
			}
			if handle != 0 {
				var created, exited, kern, user syscall.Filetime
				ok, _, e := kernel.NewProc("GetProcessTimes").Call(handle, uintptr(unsafe.Pointer(&created)), uintptr(unsafe.Pointer(&exited)), uintptr(unsafe.Pointer(&kern)), uintptr(unsafe.Pointer(&user)))
				if ok != 0 {
					p.Started = strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10)
				} else {
					kernel.NewProc("CloseHandle").Call(handle)
					return nil, e
				}
				buffer := make([]uint16, 32768)
				size := uint32(len(buffer))
				if ok, _, _ := kernel.NewProc("QueryFullProcessImageNameW").Call(handle, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size))); ok != 0 {
					p.Executable = syscall.UTF16ToString(buffer[:size])
				}
				var length uint32
				ntQueryProcess.Call(handle, 60, 0, 0, uintptr(unsafe.Pointer(&length)))
				if length > 0 && length < 1<<20 {
					data := make([]byte, length)
					status, _, _ := ntQueryProcess.Call(handle, 60, uintptr(unsafe.Pointer(&data[0])), uintptr(length), uintptr(unsafe.Pointer(&length)))
					if status == 0 {
						type unicodeString struct {
							Length, Maximum uint16
							Buffer          uintptr
						}
						u := (*unicodeString)(unsafe.Pointer(&data[0]))
						base := uintptr(unsafe.Pointer(&data[0]))
						if u.Buffer >= base && u.Buffer+uintptr(u.Length) <= base+uintptr(len(data)) && u.Length%2 == 0 {
							offset := u.Buffer - base
							units := unsafe.Slice((*uint16)(unsafe.Pointer(&data[offset])), int(u.Length)/2)
							p.Command = syscall.UTF16ToString(units)
						}
					}
				}
				kernel.NewProc("CloseHandle").Call(handle)
				if p.Command == "" {
					return nil, errors.New("cannot inspect Codex command line")
				}
			}
		}
		out = append(out, p)
		if ok, _, err = next.Call(snapshot, uintptr(unsafe.Pointer(&entry))); ok == 0 {
			if errors.Is(err, syscall.Errno(18)) {
				break
			}
			return nil, err
		}
	}
	return out, nil
}
