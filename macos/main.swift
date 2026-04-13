import Cocoa
import WebKit

let UI_PORT = 18922

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        startServer()
        createWindow()
        pollAndLoad()
    }

    func startServer() {
        let resourcesURL = Bundle.main.resourceURL!
        let binaryDir = resourcesURL.appendingPathComponent("bin")
        var info = utsname(); uname(&info)
        let machine = withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        let binaryName = machine == "arm64" ? "codex-copilot-bridge-arm64" : "codex-copilot-bridge-x64"
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
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 580),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false
        )
        window.title = "Codex Copilot Bridge"
        window.center()
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = false

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(webView)

        // Loading placeholder
        let label = NSTextField(labelWithString: "Starting Codex Copilot Bridge…")
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 0, y: 270, width: 440, height: 24)
        label.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        label.tag = 999
        window.contentView!.addSubview(label)

        window.makeKeyAndOrderFront(nil)
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
            alert.messageText = "Codex Copilot Bridge"
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
