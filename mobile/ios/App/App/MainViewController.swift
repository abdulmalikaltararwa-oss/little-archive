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

/// The window's root: it holds the web view and ends it at the top of the keyboard.
///
/// Left alone, a web view that fills the screen keeps its size when the keyboard comes up and slides its page up behind the
/// status bar to show the focused field. The page cannot stop that: what moves is the web view's visible area, not the document,
/// so nothing the page fixes in place stays put. With the web view ending where the keyboard begins there is nothing to slide:
/// the page is simply shorter, scrolls like any page, and the strip it keeps under the status bar holds.
class RootViewController: UIViewController {
    let main = MainViewController()
    private var bottom: NSLayoutConstraint!

    /// The page's paper (ui/src/styles/tokens.css, --paper), for what shows through and around the keyboard.
    private static let lightPaper = UIColor(red: 0xf8 / 255, green: 0xf3 / 255, blue: 0xea / 255, alpha: 1)
    private static let darkPaper = UIColor(red: 0x1a / 255, green: 0x21 / 255, blue: 0x1d / 255, alpha: 1)
    private static let systemPaper = UIColor { $0.userInterfaceStyle == .dark ? darkPaper : lightPaper }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.systemPaper
        addChild(main)
        main.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(main.view)
        bottom = main.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            main.view.topAnchor.constraint(equalTo: view.topAnchor),
            main.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            main.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottom,
        ])
        main.didMove(toParent: self)
        // Every change of the keyboard's place arrives as a frame change: showing, hiding, turning the phone, the bar of a
        // hardware keyboard.
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let info = note.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, let window = view.window else { return }
        // The keyboard's frame is in the screen's coordinates. Only a keyboard docked to the bottom across the whole view takes
        // room from the page; a floating or split one (iPad) lies over it and the web view keeps its size.
        let keyboard = view.convert(end, from: window.screen.coordinateSpace)
        let docked = keyboard.maxY >= view.bounds.maxY - 1 && keyboard.minX <= 1 && keyboard.maxX >= view.bounds.maxX - 1
        let covered = docked ? max(0, view.bounds.maxY - keyboard.minY) : 0
        if covered > 0 { matchPaper() }
        guard bottom.constant != -covered else { return }
        bottom.constant = -covered
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? UInt(UIView.AnimationCurve.easeInOut.rawValue)
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) { self.view.layoutIfNeeded() }
    }

    /// The page can be set to light or dark whatever the phone is set to (Settings in the interface), so the colour behind the
    /// keyboard follows the page's theme, not the system's.
    private func matchPaper() {
        main.webView?.evaluateJavaScript("document.documentElement.dataset.theme") { [weak self] theme, _ in
            switch theme as? String {
            case "dark": self?.view.backgroundColor = Self.darkPaper
            case "light": self?.view.backgroundColor = Self.lightPaper
            default: self?.view.backgroundColor = Self.systemPaper
            }
        }
    }

    // The web view's controller keeps deciding what it decided as the root.
    override var childForStatusBarStyle: UIViewController? { main }
    override var childForStatusBarHidden: UIViewController? { main }
    override var childForHomeIndicatorAutoHidden: UIViewController? { main }
    override var childForScreenEdgesDeferringSystemGestures: UIViewController? { main }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { main.supportedInterfaceOrientations }
}
