// Replace only external service startup and loading. Window lifecycle, menus,
// Dock reopening and termination remain the production AppDelegate behavior.
class SmokeDelegate: AppDelegate {
    var timer: Timer?
    var ticks = 0

    override func startServer() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["86400"]
        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("Failed to start isolated test child: \(error.localizedDescription)")
        }
    }

    override func pollAndLoad(attempt: Int = 0) {
        window.title = "Kobashi Lifecycle Test (no bridge)"
        window.contentView?.viewWithTag(999)?.removeFromSuperview()
        let status = NSTextField(wrappingLabelWithString: "")
        status.frame = NSRect(x: 24, y: 160, width: 352, height: 220)
        window.contentView?.addSubview(status)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.ticks += 1
            status.stringValue = """
            ISOLATED LIFECYCLE TEST

            No real bridge, credentials or client settings.
            Tick: \(self.ticks)
            Test child PID: \(self.serverProcess?.processIdentifier ?? 0)
            Child running: \(self.serverProcess?.isRunning == true)

            Close with red X, then click this test app in the Dock.
            The counter should advance and PID stay the same.
            Quit this TEST app with Cmd-Q or Dock > Quit.
            """
        }
    }

    override func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        super.applicationWillTerminate(notification)
        serverProcess?.waitUntilExit()
        print("Test app quit; isolated child running: \(serverProcess?.isRunning == true)")
    }
}

let application = NSApplication.shared
let smokeDelegate = SmokeDelegate()
application.delegate = smokeDelegate
application.run()
