import UIKit
import UniformTypeIdentifiers

/// The "Little Archive" entry in the iOS share sheet.
///
/// It saves nothing. It collects the link and text that were shared, leaves them in the App Group that the app reads
/// (`pendingShare`), and asks iOS to open the app, which shows its ordinary save dialog with the link filled in. The
/// person looks at it and taps Save there. If iOS does not let the extension open the app, the share is still waiting
/// when the person next opens Little Archive.
final class ShareViewController: UIViewController {
    // Changing the bundle identifier means changing this group in both entitlements files and in ShareInboxPlugin.
    private let group = "group.app.littlearchive.mobile"
    private let key = "pendingShare"
    private let wake = "littlearchive://share"
    private let limit = 20_000

    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.969, green: 0.957, blue: 0.937, alpha: 1)
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        label.text = "Sending to Little Archive…"
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(red: 0.161, green: 0.184, blue: 0.165, alpha: 1)
        label.textAlignment = .center
        label.numberOfLines = 0
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.layoutMarginsGuide.trailingAnchor),
        ])
        Task { await handOver() }
    }

    private func handOver() async {
        var title = "", text = "", url = ""
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            if title.isEmpty, let heading = item.attributedTitle?.string { title = heading }
            for provider in item.attachments ?? [] {
                if url.isEmpty, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let value = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) {
                    if let link = value as? URL { url = link.absoluteString } else if let string = value as? String { url = string }
                } else if text.isEmpty, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let value = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text = value
                }
            }
        }
        // Only text is ever passed on, and only up to a size the app reads.
        let payload: [String: String] = ["title": String(title.prefix(limit)), "text": String(text.prefix(limit)), "url": String(url.prefix(limit))]
        guard payload.values.contains(where: { !$0.isEmpty }),
              let defaults = UserDefaults(suiteName: group),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            label.text = "There was nothing here that Little Archive can keep."
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        defaults.set(json, forKey: key)
        openApp()
        // If the app did not come to the front, say where the link is.
        label.text = "Sent. Open Little Archive to review and save it."
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// An extension cannot call UIApplication.shared. The app is reached through the responder chain, which is the
    /// long-standing way to open a containing app from a share extension. It is best effort: the share is already
    /// stored, so nothing is lost if it does nothing.
    private func openApp() {
        guard let url = URL(string: wake) else { return }
        typealias Open = @convention(c) (AnyObject, Selector, URL, [UIApplication.OpenExternalURLOptionsKey: Any], ((Bool) -> Void)?) -> Void
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                let open = unsafeBitCast(current.method(for: selector), to: Open.self)
                open(current, selector, url, [:], nil)
                return
            }
            responder = current.next
        }
    }
}
