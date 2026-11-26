func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
    print("PASS: \(message)")
}

final class LayoutResult: NSObject, WKScriptMessageHandler {
    var message: String?
    func userContentController(_ controller: WKUserContentController, didReceive reply: WKScriptMessage) {
        message = reply.body as? String
    }
}

func checkConnectedLayout(_ view: WKWebView) throws {
    let result = LayoutResult()
    let scripts = view.configuration.userContentController
    scripts.add(result, name: "layoutResult")
    // The production HTML runs its normal status refresh and Grok launch error
    // handling. All requests stay inside this document, with no live bridge.
    let fixture = """
    window.fetch = async path => ({ok: true, json: async () => path === '/api/status' ? {
      connected:true, username:'fixture', version:'2.3.0', releaseDate:'2026-11-26',
      codexEnabled:true, claudeEnabled:true, grokEnabled:true, grokDesktopLaunchSupported:true, claudeDesktopLaunchSupported:true,
      usage:{creditsUsed:750000, entitlement:10000000}
    } : {ok:false, error:'grok_other_profile_running'}});
    navigator.sendBeacon = () => true;
    """
    scripts.addUserScript(WKUserScript(source: fixture, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let assertions = """
    (async () => {
      function measure(withNotice) {
        const cv = document.getElementById('dx-canvas'), canvas = cv.getBoundingClientRect();
        const panels = ['claude','codex','grok'].map(id => document.getElementById(id+'-toggle').closest('.panel'));
        const notice = document.getElementById('grok-launch-feedback'), footer = document.querySelector('.footer');
        const elements = [...(withNotice ? [notice] : []), ...panels, cv, footer];
        let bottom = 0;
        for (const el of elements) {
          const r = el.getBoundingClientRect();
          if (getComputedStyle(el).visibility !== 'visible' || !r.width || !r.height ||
              r.left < -1 || r.right > innerWidth+1 || r.top < bottom-1 || r.bottom > innerHeight+1)
            throw Error((el.id || el.className)+' cropped/overlapped '+JSON.stringify(r.toJSON())+' viewport '+innerWidth+'x'+innerHeight);
          bottom = r.bottom;
        }
        const dpr = Math.min(2, devicePixelRatio);
        if (canvas.height < 64 || Math.abs(cv.width-canvas.width*dpr)>1 || Math.abs(cv.height-canvas.height*dpr)>1)
          throw Error('canvas '+canvas.width+'x'+canvas.height+' rendered at '+cv.width+'x'+cv.height+' DPR '+dpr);
        const above = canvas.top - panels[2].getBoundingClientRect().bottom;
        const below = footer.getBoundingClientRect().top + parseFloat(getComputedStyle(footer).paddingTop) - canvas.bottom;
        // The 10pt version text has ~4pt from its line box to its first
        // painted pixels. Keep the original lower gap and match the visible ink.
        if (Math.abs(above-(below+4))>1 || Math.abs(below-16)>1 || Math.abs(footer.getBoundingClientRect().bottom-innerHeight)>1)
          throw Error('footer gaps '+above+'/'+below+' and bottom '+footer.getBoundingClientRect().bottom+' in '+innerHeight);
        const lines = notice.textContent ? notice.getClientRects().length : 0;
        if (lines !== (withNotice ? 2 : 0)) throw Error('expected '+(withNotice ? 2 : 0)+' Grok notice lines, found '+lines);
        return 'canvas '+canvas.width+'x'+canvas.height+', gaps '+above+'/'+below+', footer bottom '+footer.getBoundingClientRect().bottom;
      }
      await refreshStatus();
      document.getElementById('view-connected').getAnimations().forEach(a => a.finish());
      const normal = measure(false);
      await openGrokDesktop();
      return 'ok '+innerWidth+'x'+innerHeight+'; normal '+normal+'; two lines '+measure(true);
    })().catch(e => String(e)).then(value => webkit.messageHandlers.layoutResult.postMessage(value));
    """
    scripts.addUserScript(WKUserScript(source: assertions, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    let html = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    view.loadHTMLString(html, baseURL: nil)
    let deadline = Date(timeIntervalSinceNow: 15)
    while result.message == nil && Date() < deadline {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    check(result.message?.hasPrefix("ok ") == true, "Connected bridge cards, 64pt DPR canvas and footer fit (\(result.message ?? "timed out"))")
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
subject.window.contentView?.viewWithTag(999)?.removeFromSuperview()
try checkConnectedLayout(subject.webView)
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
