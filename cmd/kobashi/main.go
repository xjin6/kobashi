package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/xjin6/kobashi/internal/bridge"
	"github.com/xjin6/kobashi/internal/desktop"
)

var Version = "dev"

func main() {
	headless := flag.Bool("no-open", false, "Run the native bridge without a window")
	startup := flag.Bool("startup", false, "Launch using the login-startup window preference")
	home := flag.String("home", "", "Use an isolated home directory")
	offset := flag.Int("port-offset", 0, "Offset all three loopback ports for isolated testing")
	noStartup := flag.Bool("no-startup-registration", false, "Do not change OS login-startup registration")
	flag.Parse()
	isolated := *home != ""
	if *offset < 0 || *offset > 40000 {
		fmt.Fprintln(os.Stderr, "invalid port offset")
		os.Exit(1)
	}
	if runtime.GOOS == "windows" && !*headless && *offset == 0 && *home == "" && desktop.FocusExisting() {
		return
	}
	if *home == "" {
		var err error
		*home, err = os.UserHomeDir()
		if err != nil {
			desktop.ShowError(err.Error())
			os.Exit(1)
		}
	}
	absoluteHome, err := filepath.Abs(*home)
	if err != nil {
		desktop.ShowError(err.Error())
		os.Exit(1)
	}
	*home = absoluteHome
	dir := filepath.Join(*home, ".kobashi")
	if err := os.MkdirAll(dir, 0700); err != nil {
		desktop.ShowError(err.Error())
		os.Exit(1)
	}
	logFile, err := os.OpenFile(filepath.Join(dir, "kobashi.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		desktop.ShowError(err.Error())
		os.Exit(1)
	}
	defer logFile.Close()
	log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	if Version == "dev" {
		if data, err := os.ReadFile("package.json"); err == nil {
			var pkg struct{ Version string }
			if json.Unmarshal(data, &pkg) == nil {
				Version = pkg.Version
			}
		}
	}
	executable, err := os.Executable()
	if err != nil {
		desktop.ShowError(err.Error())
		os.Exit(1)
	}
	options := bridge.Options{Home: *home, Executable: executable, AppPath: os.Getenv("KOBASHI_APP_PATH"), Version: Version, ControlToken: os.Getenv("KOBASHI_CONTROL_TOKEN"),
		Ports: bridge.Ports{Codex: 18921 + *offset, Control: 18922 + *offset, Claude: 18923 + *offset}, Desktop: !*headless || os.Getenv("KOBASHI_APP_PATH") != ""}
	if *noStartup {
		options.Startup = func(bool) error { return nil }
	}
	if isolated {
		options.CodexHome = filepath.Join(*home, ".codex")
	}
	app, err := bridge.New(options)
	if err == nil {
		err = app.Start()
	}
	if err != nil {
		log.Print(err)
		desktop.ShowError(err.Error())
		os.Exit(1)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case <-signals:
			_ = app.Stop()
		case <-app.Closed():
		}
	}()
	if options.AppPath != "" {
		// The Cocoa parent owns this pipe. EOF also cleans up after a parent crash.
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
			}
			if err := scanner.Err(); err != nil {
				log.Print(err)
			}
			_ = app.Stop()
		}()
	}
	if *headless {
		<-app.Closed()
	} else {
		if err = desktop.Run(app, *startup && app.Settings().CloseToTray); err != nil {
			desktop.ShowError(err.Error())
			log.Print(err)
		}
	}
	signal.Stop(signals)
	if stopErr := app.Stop(); err == nil {
		err = stopErr
	}
	if err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
