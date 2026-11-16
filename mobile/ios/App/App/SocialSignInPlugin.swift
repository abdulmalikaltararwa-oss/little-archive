import AuthenticationServices
import Capacitor
import UIKit

/// "Continue with Apple" and "Continue with Google": the two system sheets, and nothing else.
///
/// This class only shows a sheet and hands back what came out of it; mobile/src/social.js decides everything else. It never sees
/// the code verifier or the raw nonce (the page keeps those), and it holds a call only while that call's sheet is open. On iOS
/// an address that arrives any other way has nowhere to go (see the last paragraph; Android is different, and
/// SocialSignInPlugin.java says how). Every answer is `{ status, ... }`:
///
///   apple({ nonce })  nonce is the SHA-256 of the page's raw nonce, as lower case hex, which Apple signs into the identity token.
///                     { status: "signed_in", identityToken, authorizationCode? } | { status: "cancelled" }
///                     authorizationCode is Apple's one-time code (good once, for five minutes). The page hands it to the Little
///                     Archive server, which trades it with Apple so that deleting the account can revoke this sign-in. It is
///                     left out when Apple gave none, and is not kept or logged here.
///   browser({ url })  opens `url` (the project's authorize address) in the system authentication session, which closes itself when
///                     the page it shows redirects to littlearchive://auth-callback.
///                     { status: "returned", url } | { status: "cancelled" }
///
/// A callback comes back through the session's own completion handler and nowhere else (not through `appUrlOpen`, which the share
/// inbox listens to), so a `littlearchive://` address opened by another app cannot be mistaken for it.
@objc(SocialSignInPlugin)
public class SocialSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SocialSignInPlugin"
    public let jsName = "SocialSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "apple", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browser", returnType: CAPPluginReturnPromise)
    ]

    /// Must match the redirect URL on the project's allow-list (littlearchive://auth-callback) and CFBundleURLSchemes in Info.plist.
    static let callbackScheme = "littlearchive"

    /// The sheet that is open, if any. Main thread only.
    private var appleSheet: AppleSheet?
    private var browserSheet: BrowserSheet?

    /// Said when there is no window to show a sheet over (the app is not on screen yet, or is leaving it). Not the same thing as
    /// another sign-in being open, and the page shows this sentence as it is.
    static let noWindow = "The sign-in could not be shown just now. Bring Little Archive to the front and try again."

    /// The window a sheet is shown over.
    private func anchor() -> ASPresentationAnchor? {
        bridge?.viewController?.view.window
    }

    // MARK: Sign in with Apple

    @objc func apple(_ call: CAPPluginCall) {
        guard let hashedNonce = call.getString("nonce"), hashedNonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            call.reject("Sign in with Apple could not start. Try again.", "BAD_REQUEST")
            return
        }
        DispatchQueue.main.async {
            guard self.appleSheet == nil, self.browserSheet == nil else {
                call.reject("Another sign-in is already open.", "BUSY")
                return
            }
            guard let anchor = self.anchor() else {
                call.reject(SocialSignInPlugin.noWindow, "NO_WINDOW")
                return
            }
            let sheet = AppleSheet(anchor: anchor, nonce: hashedNonce) { [weak self] outcome in
                self?.appleSheet = nil
                switch outcome {
                case .token(let token, let code):
                    var answer: [String: Any] = ["status": "signed_in", "identityToken": token]
                    if let code = code, !code.isEmpty { answer["authorizationCode"] = code }
                    call.resolve(answer)
                case .cancelled: call.resolve(["status": "cancelled"])
                case .failed(let message): call.reject(message, "APPLE_FAILED")
                }
            }
            self.appleSheet = sheet
            sheet.start()
        }
    }

    // MARK: Google, through the system browser

    @objc func browser(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host?.isEmpty == false else {
            call.reject("The browser could not be opened. Try again.", "BAD_REQUEST")
            return
        }
        DispatchQueue.main.async {
            guard self.appleSheet == nil, self.browserSheet == nil else {
                call.reject("Another sign-in is already open.", "BUSY")
                return
            }
            guard let anchor = self.anchor() else {
                call.reject(SocialSignInPlugin.noWindow, "NO_WINDOW")
                return
            }
            let sheet = BrowserSheet(anchor: anchor, url: url, scheme: SocialSignInPlugin.callbackScheme) { [weak self] outcome in
                self?.browserSheet = nil
                switch outcome {
                case .returned(let address): call.resolve(["status": "returned", "url": address])
                case .cancelled: call.resolve(["status": "cancelled"])
                case .failed(let message): call.reject(message, "BROWSER_FAILED")
                }
            }
            self.browserSheet = sheet
            if !sheet.start() {
                self.browserSheet = nil
                call.reject("The browser could not be opened. Try again.", "BROWSER_FAILED")
            }
        }
    }
}

// MARK: - the two sheets

private final class AppleSheet: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    /// `token` carries the identity token and, when Apple gave one, the authorization code.
    enum Outcome { case token(String, String?), cancelled, failed(String) }

    private let anchor: ASPresentationAnchor
    private let controller: ASAuthorizationController
    private var finish: ((Outcome) -> Void)?

    init(anchor: ASPresentationAnchor, nonce: String, finish: @escaping (Outcome) -> Void) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        // The email goes into the identity token (the project makes the account from it). The name is not asked for: the app
        // has no use for it.
        request.requestedScopes = [.email]
        request.nonce = nonce
        self.anchor = anchor
        self.controller = ASAuthorizationController(authorizationRequests: [request])
        self.finish = finish
        super.init()
        controller.delegate = self
        controller.presentationContextProvider = self
    }

    func start() { controller.performRequests() }

    private func end(_ outcome: Outcome) {
        // A sheet answers once.
        guard let done = finish else { return }
        finish = nil
        done(outcome)
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { anchor }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken, let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            end(.failed("Apple did not send back a sign-in. Try again."))
            return
        }
        end(.token(token, credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let failure = error as? ASAuthorizationError, failure.code == .canceled {
            end(.cancelled)
        } else {
            end(.failed("Sign in with Apple did not work. Make sure this device is signed in to an Apple Account, then try again."))
        }
    }
}

private final class BrowserSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum Outcome { case returned(String), cancelled, failed(String) }

    private let anchor: ASPresentationAnchor
    private var session: ASWebAuthenticationSession?

    init(anchor: ASPresentationAnchor, url: URL, scheme: String, finish: @escaping (Outcome) -> Void) {
        self.anchor = anchor
        super.init()
        var answered = false
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
            // The completion handler runs once; the guard keeps it that way whatever the system does.
            guard !answered else { return }
            answered = true
            if let failure = error as? ASWebAuthenticationSessionError, failure.code == .canceledLogin {
                finish(.cancelled)
            } else if let callback = callback {
                finish(.returned(callback.absoluteString))
            } else {
                finish(.failed("The browser sign-in did not finish. Try again."))
            }
        }
        session.presentationContextProvider = self
        self.session = session
    }

    func start() -> Bool { session?.start() ?? false }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
}
