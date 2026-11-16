import UIKit
import Capacitor

/// The web view's controller. It adds the plugins that are part of this app rather than packages: the inbox where the share
/// extension leaves what was shared, the App Store's purchase sheet for the one-time unlock, and the sheets for "Continue with
/// Apple" and "Continue with Google".
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareInboxPlugin())
        bridge?.registerPluginInstance(StorePurchasesPlugin())
        bridge?.registerPluginInstance(SocialSignInPlugin())
    }
}
