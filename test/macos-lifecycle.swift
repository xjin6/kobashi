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
service.executableURL = URL(fileURLWithPath: "/bin/cat")
let serviceInput = Pipe()
service.standardInput = serviceInput
service.standardOutput = FileHandle.nullDevice
try service.run()
subject.serverProcess = service
subject.serverInput = serviceInput
defer {
    serviceInput.fileHandleForWriting.closeFile()
    service.waitUntilExit()
}
subject.setUpStatusItem()
check(subject.createWindow(), "The native window loads its existing brand artwork")
check(subject.window.contentView?.bounds.size == NSSize(width: 400, height: 480),
      "The compact window has a fixed 400 by 480 content area")
check(!subject.window.styleMask.contains(.resizable), "The window cannot be resized")
check(subject.statusItem?.menu?.items.first?.title == "Show Kobashi",
      "The menu bar provides a way to restore the window")
subject.window.performClose(nil)
check(!subject.window.isVisible, "The red close action hides the window")
check(application.activationPolicy() == .accessory, "Closing to tray removes the Dock entry")
check(!subject.applicationShouldTerminateAfterLastWindowClosed(application),
      "Closing the last window does not terminate the application")

let originalWindow = subject.window
let originalContent = subject.window.contentView
let lifecycle: NSApplicationDelegate = subject
_ = lifecycle.applicationShouldHandleReopen?(application, hasVisibleWindows: false)
check(subject.window.isVisible, "Dock reopening restores a closed window")
check(subject.window === originalWindow && subject.window.contentView === originalContent,
      "Dock reopening preserves the same native window and controls")

for _ in 0..<3 {
    subject.window.performClose(nil)
    _ = lifecycle.applicationShouldHandleReopen?(application, hasVisibleWindows: false)
}
check(subject.window === originalWindow && subject.window.contentView === originalContent,
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
subject.closeToTray = false
check(subject.windowShouldClose(subject.window),
      "Disabling close to tray allows the native close action")
check(subject.applicationShouldTerminateAfterLastWindowClosed(application),
      "Disabling close to tray terminates after the last window closes")
subject.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
service.waitUntilExit()
check(!service.isRunning && service.terminationStatus == 0,
      "Explicit application termination closes its own child input gracefully")
check(subject.controls["token"] is NSSecureTextField,
      "Token entry uses a native protected text field")
check(subject.controls["startup"] is NSButton &&
      (subject.controls["startup"] as? NSButton)?.action == #selector(AppDelegate.saveStartup),
      "Startup uses a native checkbox")
check((subject.controls["startup"] as? NSButton)?.accessibilityRole() == .checkBox,
      "Custom styling preserves native checkbox accessibility")
check(subject.controls["settings"]?.frame == NSRect(x: 296, y: 24, width: 32, height: 32),
      "Settings remains in the original header position")
check(subject.controls["subtitle"] == nil, "The route description is absent")
check(NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil) != nil,
      "The standard Settings gear is available")
for (key, title, action) in [
    ("connect", "Not Connected", #selector(AppDelegate.connect)),
    ("login", "Not Connected", #selector(AppDelegate.login)),
    ("disconnect", "Connected", #selector(AppDelegate.disconnect))
] {
    check((subject.controls[key] as? NSButton)?.title == title &&
          (subject.controls[key] as? NSButton)?.action == action &&
          (subject.controls[key] as? NSButton)?.accessibilityLabel() == title &&
          (subject.controls[key] as? NSButton)?.accessibilityRole() == .button,
          "The \(key) status retains its native accessible name and action")
}
check(subject.controls["claude"]?.frame == NSRect(x: 32, y: 247, width: 336, height: 80) &&
      subject.controls["codex"]?.frame == NSRect(x: 32, y: 339, width: 336, height: 80),
      "The two bridge cards preserve the original layout and order")
check(subject.controls["startup"]?.frame == NSRect(x: 32, y: 118, width: 336, height: 88) &&
      subject.controls["tray"]?.frame == NSRect(x: 32, y: 218, width: 336, height: 88),
      "Settings uses consistently padded cards")
check(subject.controls["done"]?.frame == NSRect(x: 32, y: 372, width: 336, height: 38) &&
      subject.controls["quit"]?.frame == NSRect(x: 144, y: 418, width: 112, height: 24),
      "Quit is a centered text action beneath the full-width Done button")
check((subject.controls["done"] as? NSButton)?.title == "Done" &&
      (subject.controls["done"] as? NSButton)?.action == #selector(AppDelegate.done),
      "Done retains native button semantics")
for connected in [false, true] {
    subject.status["connected"] = connected
    subject.currentView = "settings"
    subject.done()
    check(subject.currentView == (connected ? "connected" : "idle"),
          "Done returns to the appropriate main screen")
}
if let hint = subject.controls["tokenTeaser"] as? NSTextField,
   let link = subject.controls["tokenView"] as? NSButton {
    let font = NSFont.systemFont(ofSize: 12)
    check(hint.frame.width >= (hint.stringValue as NSString).size(withAttributes: [.font: font]).width + 4 &&
          link.frame.width >= (link.title as NSString).size(withAttributes: [.font: font]).width + 4,
          "The token hint and link fit their native font metrics")
    check(hint.frame.minX >= 32 && hint.frame.maxX + 6 <= link.frame.minX && link.frame.maxX <= 368,
          "The single-line token prompt stays separated within the content padding")
} else {
    check(false, "The token prompt retains native label and button controls")
}
subject.tokenView()
check(subject.controls["connect"]?.isHidden == false && subject.controls["token"]?.isHidden == false,
      "Token entry expands within the original sign-in screen")
check((subject.controls["login"] as? NSButton)?.isEnabled == false,
      "Connect remains disabled for an empty token")
subject.currentView = "connected"
subject.status = ["username": "example", "claudeEnabled": true, "codexEnabled": false]
subject.render()
check(subject.controls["usageLabel"]?.isHidden == true && subject.controls["usageValue"]?.isHidden == true,
      "Unavailable usage is hidden rather than displaying zero credits")
for appearance in ["light", "dark"] {
    subject.status["appearance"] = appearance
    subject.render()
    check(subject.window.contentView?.bounds.size == NSSize(width: 400, height: 480),
          "The \(appearance) appearance keeps the original fixed dimensions")
}
subject.status["username"] = "xjin6"
subject.status["version"] = "2.1.6"
subject.render()
check((subject.controls["project"] as? NSButton)?.title == "v2.1.6" &&
      (subject.controls["project"] as? NSButton)?.accessibilityRole() == .button,
      "The version link retains a native accessible name without author attribution")
check((subject.controls["account"] as? NSTextField)?.stringValue == "@xjin6",
      "Removing author attribution preserves the signed-in username")
