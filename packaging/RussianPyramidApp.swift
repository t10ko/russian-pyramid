import AppKit
import WebKit

@MainActor
@main
final class RussianPyramidApp: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered,
        defer: false
    )
    private let webView = WKWebView()
    private let server = Process()
    private let output = Pipe()
    private var pendingOutput = Data()
    private var isQuitting = false

    static func main() {
        let app = NSApplication.shared
        let delegate = RussianPyramidApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpMenu()
        webView.navigationDelegate = self
        window.title = "Russian Pyramid"
        window.contentMinSize = NSSize(width: 640, height: 480)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("Practice Table")

        let content = NSView()
        let status = NSTextField(labelWithString: "Starting the practice table…")
        status.font = .systemFont(ofSize: 15, weight: .medium)
        status.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(status)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        startServer()
    }

    private func setUpMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Russian Pyramid")
        appMenu.addItem(withTitle: "Quit Russian Pyramid", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    private func startServer() {
        guard let executable = Bundle.main.url(forAuxiliaryExecutable: "russian-pyramid") else {
            showFailure("The bundled practice server is missing.")
            return
        }
        server.executableURL = executable
        server.arguments = ["--no-browser"]
        server.standardInput = FileHandle.nullDevice
        server.standardOutput = output
        server.standardError = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                DispatchQueue.main.async { [weak self] in self?.readServerOutput(data) }
            }
        }
        server.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.isQuitting else { return }
                self.showFailure("The practice server stopped (exit status \(status)).")
            }
        }
        do {
            try server.run()
        } catch {
            showFailure(error.localizedDescription)
        }
    }

    private func readServerOutput(_ data: Data) {
        pendingOutput.append(data)
        while let newline = pendingOutput.firstIndex(of: 0x0A) {
            let line = String(decoding: pendingOutput[..<newline], as: UTF8.self)
            pendingOutput.removeSubrange(...newline)
            let prefix = "  serving: "
            if line.hasPrefix(prefix),
               let address = line.dropFirst(prefix.count).split(separator: " ").first,
               let url = URL(string: String(address)),
               url.host == "127.0.0.1" {
                window.contentView = webView
                window.makeFirstResponder(webView)
                webView.load(URLRequest(url: url))
            } else {
                NSLog("%@", line)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure(error.localizedDescription)
    }

    private func showFailure(_ details: String) {
        guard !isQuitting else { return }
        isQuitting = true
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Couldn’t open the practice table"
        alert.informativeText = details
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        isQuitting = true
        output.fileHandleForReading.readabilityHandler = nil
        if server.isRunning {
            server.terminate()
        }
    }
}
