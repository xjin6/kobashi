func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
    print("PASS: \(message)")
}

class ToggleCheckDelegate: AppDelegate {
    var requests: [String] = []
    var enabled = ["codexEnabled": true, "claudeEnabled": true]
    var step = 0
    let clicks = [
        ("codex", NSPoint(x: 295, y: 40)),
        ("codex", NSPoint(x: 168, y: 40)),
        ("claude", NSPoint(x: 295, y: 40)),
        ("claude", NSPoint(x: 168, y: 40))
    ]

    override func applicationDidFinishLaunching(_ notification: Notification) {
        check(createWindow(), "The isolated toggle window loads")
        currentView = "connected"
        status = ["connected": true, "codexEnabled": true, "claudeEnabled": true]
        render()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.clickNext() }
    }

    override func request(_ path: String, body: [String: Any]? = nil,
                          completion: @escaping ([String: Any]?, String?) -> Void) {
        requests.append(path)
        let field = path == "/api/toggle-codex" ? "codexEnabled" : "claudeEnabled"
        enabled[field] = !(enabled[field] ?? false)
        DispatchQueue.main.async { completion(self.enabled, nil) }
    }

    override func refresh() {}

    func clickNext() {
        guard step < clicks.count else {
            print("PASS: Both bridge cards toggle off and back on through mouse events")
            exit(0)
        }
        let (key, point) = clicks[step]
        let button = controls[key] as! NSButton
        let location = button.convert(point, to: nil)
        check(window.contentView?.hitTest(location) === button,
              "The \(key) switch hit-tests to its bridge card")
        let count = requests.count
        let timestamp = ProcessInfo.processInfo.systemUptime
        let down = NSEvent.mouseEvent(with: .leftMouseDown, location: location, modifierFlags: [],
                                     timestamp: timestamp, windowNumber: window.windowNumber,
                                     context: nil, eventNumber: step * 2 + 1, clickCount: 1, pressure: 1)!
        let up = NSEvent.mouseEvent(with: .leftMouseUp, location: location, modifierFlags: [],
                                   timestamp: timestamp + 0.01, windowNumber: window.windowNumber,
                                   context: nil, eventNumber: step * 2 + 2, clickCount: 1, pressure: 0)!
        NSApp.postEvent(down, atStart: false)
        NSApp.postEvent(up, atStart: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            check(self.requests.count == count + 1 && self.requests.last == "/api/toggle-\(key)",
                  "Clicking the \(key) card at \(point) sends exactly one toggle request")
            check(button.state == (self.enabled["\(key)Enabled"] == true ? .on : .off),
                  "The \(key) card displays the confirmed bridge state")
            self.step += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + NSEvent.doubleClickInterval + 0.02) {
                self.clickNext()
            }
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let toggles = ToggleCheckDelegate()
application.delegate = toggles
DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    check(false, "The isolated mouse tests complete before the timeout")
}
application.run()
