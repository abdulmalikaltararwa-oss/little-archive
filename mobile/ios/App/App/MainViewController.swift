import UIKit
import Capacitor

/// The web view's controller. It adds the two plugins that are part of this app rather than packages: the inbox where
/// the share extension leaves what was shared, and the App Store's purchase sheet for the one-time unlock.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareInboxPlugin())
        bridge?.registerPluginInstance(StorePurchasesPlugin())
    }
}
