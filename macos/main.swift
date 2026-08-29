import Cocoa
import WebKit

let UI_PORT = 18922

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        setUpMainMenu()
        startServer()
        createWindow()
        pollAndLoad()
    }

    // macOS routes Cmd-C/V/X/A through the main menu's key equivalents, NOT through
    // the focused control. An app with no menu bar therefore has no working clipboard
    // shortcuts anywhere in it — including inside a WKWebView text field, which looks
    // to the user like the field itself is broken.
    //
    // This went unnoticed while the UI had no text input. The token field is the first,
    // and pasting is the ONLY way anyone will ever fill it: the token is 40 random
    // characters that nobody types by hand.
    //
    // Passing nil targets lets each action follow the responder chain to whatever is
    // focused, so the same menu serves the web view without any per-control wiring.
    func setUpMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Kobashi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Kobashi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Kobashi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    func startServer() {
        let resourcesURL = Bundle.main.resourceURL!
        let binaryDir = resourcesURL.appendingPathComponent("bin")
        var info = utsname(); uname(&info)
        let machine = withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        let binaryName = machine == "arm64" ? "kobashi-arm64" : "kobashi-x64"
        let binaryURL = binaryDir.appendingPathComponent(binaryName)

        let process = Process()
        process.executableURL = binaryURL
        process.arguments = ["--no-open"]
        process.terminationHandler = { _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("Failed to start bridge: \(error.localizedDescription)")
        }
    }

    func createWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 540),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false
        )
        window.title = "Kobashi"
        window.center()
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = false

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(webView)

        // Loading placeholder
        let label = NSTextField(labelWithString: "Starting Kobashi…")
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 0, y: 270, width: 440, height: 24)
        label.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        label.tag = 999
        window.contentView!.addSubview(label)

        window.makeKeyAndOrderFront(nil)
        // Without this the web view never becomes first responder, so clipboard
        // actions have nothing to travel the responder chain to.
        window.makeFirstResponder(webView)
        NSApp.activate(ignoringOtherApps: true)
    }

    func pollAndLoad(attempt: Int = 0) {
        let url = URL(string: "http://127.0.0.1:\(UI_PORT)/api/status")!
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                DispatchQueue.main.async {
                    self?.window.contentView?.viewWithTag(999)?.removeFromSuperview()
                    self?.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(UI_PORT)")!))
                }
            } else if attempt < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self?.pollAndLoad(attempt: attempt + 1)
                }
            }
        }.resume()
    }

    func showError(_ msg: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "Kobashi"
            alert.informativeText = msg
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
