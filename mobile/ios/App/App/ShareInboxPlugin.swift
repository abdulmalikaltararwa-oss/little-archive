import Capacitor

/// Hands the app what the share extension left in the shared App Group.
///
/// The extension writes one JSON object ({title, text, url}) under `pendingShare` and opens the app. The app asks for it
/// with `take()`, which returns it once and removes it. The text came from another app and is untrusted: the web
/// interface reduces it to plain text that only fills the save form, and nothing is saved until the person taps Save.
@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInboxPlugin"
    public let jsName = "ShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)
    ]

    // Changing the bundle identifier means changing this group in both entitlements files and in ShareViewController.
    static let group = "group.app.littlearchive.mobile"
    static let key = "pendingShare"
    static let limit = 20_000

    @objc func take(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: ShareInboxPlugin.group) else {
            call.resolve(["items": []])
            return
        }
        defer { defaults.removeObject(forKey: ShareInboxPlugin.key) }
        guard let json = defaults.string(forKey: ShareInboxPlugin.key),
              let data = json.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            call.resolve(["items": []])
            return
        }
        func text(_ name: String) -> String { String(((object[name] as? String) ?? "").prefix(ShareInboxPlugin.limit)) }
        call.resolve(["items": [["title": text("title"), "text": text("text"), "url": text("url")]]])
    }
}
