func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
    print("PASS: \(message)")
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let subject = AppDelegate()
let service = Process()
service.executableURL = URL(fileURLWithPath: "/bin/sleep")
service.arguments = ["60"]
try service.run()
subject.serverProcess = service
defer {
    if service.isRunning { service.terminate() }
    service.waitUntilExit()
}
subject.createWindow()
subject.window.performClose(nil)
check(!subject.window.isVisible, "The red close action closes the window")
check(!subject.applicationShouldTerminateAfterLastWindowClosed(application),
      "Closing the last window does not terminate the application")

let originalWindow = subject.window
let originalWebView = subject.webView
let lifecycle: NSApplicationDelegate = subject
_ = lifecycle.applicationShouldHandleReopen?(application, hasVisibleWindows: false)
check(subject.window.isVisible, "Dock reopening restores a closed window")
check(subject.window === originalWindow && subject.webView === originalWebView,
      "Dock reopening preserves the same window and web view")

for _ in 0..<3 {
    subject.window.performClose(nil)
    _ = lifecycle.applicationShouldHandleReopen?(application, hasVisibleWindows: false)
}
check(subject.window === originalWindow && subject.webView === originalWebView,
      "Repeated close and reopen does not create new UI instances")
check(subject.serverProcess === service && service.isRunning,
      "The same child process survives closing and reopening")
subject.window.miniaturize(nil)
_ = lifecycle.applicationShouldHandleReopen?(application, hasVisibleWindows: true)
check(!subject.window.isMiniaturized && subject.window.isVisible,
      "Dock reopening restores a minimized window")
application.hide(nil)
_ = lifecycle.applicationShouldHandleReopen?(application, hasVisibleWindows: false)
check(subject.window.isVisible, "Dock reopening orders a hidden app's window front")
check(application.activationPolicy() == .regular, "The application remains Dock-eligible")
subject.setUpMainMenu()
let quitItem = application.mainMenu?.items.first?.submenu?.items.first { $0.keyEquivalent == "q" }
check(quitItem?.action == #selector(NSApplication.terminate(_:)),
      "Cmd-Q still targets application termination")
subject.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
service.waitUntilExit()
check(!service.isRunning && service.terminationReason == .uncaughtSignal,
      "Explicit application termination signals its child process")
