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
        let center = NotificationCenter.default
        // Every change of the keyboard's place arrives as a frame change: showing, hiding, turning the phone, the bar of a
        // hardware keyboard.
        center.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        // The web view listens for the keyboard too, and on hearing of it gives its scroll view room at the bottom for the part
        // the keyboard covers. It works that out when the notification arrives, while it is still full height, and does not work
        // it out again when its frame changes (WebKit, WKWebViewIOS.mm: the adjustment is made in _keyboardChangedWithInfo only,
        // not in _frameOrBoundsMayHaveChanged). On iOS 26 the room is gone once the frame has changed; whether an older system
        // keeps it, and so moves the page twice, could not be run. The web view ends at the keyboard and has nothing to make room
        // for, so it is not told: the same four notifications Capacitor's keyboard plugin takes from it for its own resize
        // (@capacitor/keyboard 8.0.6, Keyboard.m, load). If a later WebKit listens some other way this removes nothing and the web
        // view behaves as it did.
        if let webView = main.webView {
            for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification, UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardDidChangeFrameNotification] {
                center.removeObserver(webView, name: name, object: nil)
            }
        }
    }

    /// How much of a view the keyboard takes from its bottom edge: `keyboard` and `bounds` are in the view's own coordinates.
    /// Only a keyboard docked to the bottom across the whole view takes room; a floating or split one (iPad) lies over the page,
    /// and one that is off the screen or belongs to another part of it takes none.
    static func keyboardCover(keyboard: CGRect, in bounds: CGRect) -> CGFloat {
        let docked = keyboard.maxY >= bounds.maxY - 1 && keyboard.minX <= bounds.minX + 1 && keyboard.maxX >= bounds.maxX - 1
        return docked ? min(max(0, bounds.maxY - keyboard.minY), bounds.height) : 0
    }

    /// Anything shorter than this is the bar a hardware keyboard leaves on screen (68pt on an iPhone), not a keyboard: the web
    /// view still ends above it, but the page is not told a keyboard is up, so the dock stays.
    static let tallestBar: CGFloat = 120

    /// Where the keyboard last said it would be, in the screen's coordinates.
    private var keyboardEnd: CGRect?
    private var toldKeyboardUp: Bool?

    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let info = note.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        keyboardEnd = end
        toldKeyboardUp = nil // Say it again: the theme may have changed since.
        fitToKeyboard(animation: info)
    }

    /// The view can change size with no word from the keyboard (Split View, Stage Manager, a turn of the phone that arrives
    /// first), so the room the keyboard takes is worked out again from where it last was.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        fitToKeyboard(animation: nil)
    }

    private func fitToKeyboard(animation info: [AnyHashable: Any]?) {
        guard let end = keyboardEnd, let window = view.window else { return }
        let covered = Self.keyboardCover(keyboard: view.convert(end, from: window.screen.coordinateSpace), in: view.bounds)
        let keyboardUp = covered > Self.tallestBar
        if keyboardUp != toldKeyboardUp { toldKeyboardUp = keyboardUp; tellPage(keyboardUp: keyboardUp) }
        guard bottom.constant != -covered else { return }
        bottom.constant = -covered
        guard let info = info else { return }
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? UInt(UIView.AnimationCurve.easeInOut.rawValue)
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) { self.view.layoutIfNeeded() }
    }

    /// Marks the page while a keyboard takes room from it (`data-keyboard` on the root element; the interface hides its dock,
    /// ui/src/features/shell/shell.tsx), and reads the page's theme back. The page can be set to light or dark whatever the phone
    /// is set to (Settings in the interface), so the colour behind the keyboard follows the page's theme, not the system's.
    private func tellPage(keyboardUp: Bool) {
        let script = "document.documentElement.toggleAttribute('data-keyboard', \(keyboardUp)); document.documentElement.dataset.theme"
        main.webView?.evaluateJavaScript(script) { [weak self] theme, _ in
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
