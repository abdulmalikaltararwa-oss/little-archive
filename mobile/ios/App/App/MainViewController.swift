import UIKit
import Capacitor

/// The web view's controller. It adds the one plugin that is part of this app rather than a package: the inbox where
/// the share extension leaves what was shared.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareInboxPlugin())
    }
}
