import Capacitor
import StoreKit
import UIKit

/// The one-time unlock, sold through StoreKit 2. Nothing else: no subscriptions, no consumables, no ads, no purchase service.
///
/// This class only talks to the App Store and hands over what it says; mobile/src/purchases.js decides what to do with it. The
/// server (POST /api/purchases/apple) is the only thing that unlocks an account, by checking the signed transaction against
/// Apple's certificates. A transaction is finished (`finish`) only when the app asks, which it does after the server answered:
/// until then StoreKit offers it again at every start, which is how a purchase made while the phone was offline is never lost.
///
/// A record, the same shape on both platforms (see purchases.js):
///   provider, product_id, id (the transaction id), signed_transaction (the JWS), account_tag (the appAccountToken, lowercase),
///   state ("purchased" or "revoked"), finished
@objc(StorePurchasesPlugin)
public class StorePurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePurchasesPlugin"
    public let jsName = "StorePurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "product", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "buy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise)
    ]

    /// The product id in App Store Connect (a non-consumable). Changing it means changing it in the server's configuration too.
    static let productId = "unlock_full"

    /// Transactions seen since the app started, so `finish` can find the one it is asked about without searching.
    private actor Seen {
        private var transactions: [UInt64: Transaction] = [:]
        func remember(_ transaction: Transaction) { transactions[transaction.id] = transaction }
        func transaction(_ id: UInt64) -> Transaction? { transactions[id] }
        func forget(_ id: UInt64) { transactions[id] = nil }
    }
    private let seen = Seen()
    private var updates: Task<Void, Never>?

    override public func load() {
        // StoreKit must be listened to from the moment the app starts: a purchase approved later (Ask to Buy), one made on another
        // device, or a refund arrives here, and nothing else will hear it. The page is told, and looks at what the store holds.
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                guard let self = self, case .verified(let transaction) = result, transaction.productID == StorePurchasesPlugin.productId else { continue }
                await self.seen.remember(transaction)
                self.notifyListeners("purchaseUpdated", data: ["id": String(transaction.id)])
            }
        }
    }

    deinit { updates?.cancel() }

    // MARK: the unlock, as the store describes it

    /// The unlock's localized price, from the store. `available` is false when the store does not have it (not set up yet, or not a non-consumable).
    @objc func product(_ call: CAPPluginCall) {
        Task {
            do {
                guard let product = try await unlock() else { call.resolve(["available": false]); return }
                call.resolve(["available": true, "id": product.id, "price": product.displayPrice])
            } catch {
                call.reject("The App Store could not be reached. Try again in a moment.", "UNAVAILABLE")
            }
        }
    }

    // MARK: buying

    /// Opens the App Store's purchase sheet, binding the purchase to the account (`accountTag`, a UUID) so the server can tell whose it is.
    /// Resolves { status: "purchased", purchase } | { status: "pending" } | { status: "cancelled" }.
    @objc func buy(_ call: CAPPluginCall) {
        guard let tag = call.getString("accountTag"), let account = UUID(uuidString: tag) else {
            call.reject("This account could not be identified. Sign in again and try once more.", "BAD_ACCOUNT")
            return
        }
        Task {
            do {
                guard let product = try await unlock() else {
                    call.reject("The unlock is not available from the App Store right now. Try again later.", "UNAVAILABLE")
                    return
                }
                let result = try await purchase(product, account: account)
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification else {
                        // A transaction StoreKit could not verify is not used, and not finished.
                        call.reject("The App Store could not confirm this purchase, so it was not used. If you were charged, restore the purchase.", "UNVERIFIED")
                        return
                    }
                    await seen.remember(transaction)
                    call.resolve(["status": "purchased", "purchase": record(verification, transaction, finished: false)])
                case .pending:
                    call.resolve(["status": "pending"])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.reject("The App Store gave an answer this version does not understand.", "FAILED")
                }
            } catch {
                call.reject("The purchase did not go through. You were not charged for anything the App Store did not confirm.", "FAILED")
            }
        }
    }

    // MARK: what the store account holds

    /// Every verified transaction for the unlock that is not delivered, and every one that currently counts, so the page can offer Restore and finish what
    /// was left. `sync: true` asks the App Store to look again first (it can ask the person to sign in), which only a Restore button should do.
    @objc func list(_ call: CAPPluginCall) {
        let sync = call.getBool("sync") ?? false
        Task {
            do {
                if sync {
                    do { try await AppStore.sync() }
                    catch StoreKitError.userCancelled { call.reject("Restoring was cancelled.", "CANCELLED"); return }
                }
                var records: [[String: Any]] = []
                var unfinished = Set<UInt64>()
                for await result in Transaction.unfinished {
                    guard case .verified(let transaction) = result, transaction.productID == StorePurchasesPlugin.productId else { continue }
                    await seen.remember(transaction)
                    unfinished.insert(transaction.id)
                    records.append(record(result, transaction, finished: false))
                }
                for await result in Transaction.currentEntitlements {
                    guard case .verified(let transaction) = result, transaction.productID == StorePurchasesPlugin.productId, !unfinished.contains(transaction.id) else { continue }
                    await seen.remember(transaction)
                    records.append(record(result, transaction, finished: true))
                }
                call.resolve(["purchases": records])
            } catch {
                call.reject("The App Store could not be reached. Try again in a moment.", "UNAVAILABLE")
            }
        }
    }

    // MARK: delivering

    /// Tells the App Store the purchase was delivered. Called only after the server has answered; a transaction that is not finished
    /// is offered again at the next start.
    @objc func finish(_ call: CAPPluginCall) {
        guard let text = call.getString("id"), let id = UInt64(text) else {
            call.reject("Which transaction?", "BAD_ID")
            return
        }
        Task {
            var found = await seen.transaction(id)
            if found == nil {
                for await result in Transaction.unfinished {
                    if case .verified(let transaction) = result, transaction.id == id { found = transaction; break }
                }
            }
            guard let transaction = found else { call.resolve(["finished": false]); return }
            await transaction.finish()
            await seen.forget(id)
            call.resolve(["finished": true])
        }
    }

    // MARK: helpers

    /// The unlock, or nil if the store does not have it as a non-consumable (a product set up as anything else is never sold).
    private func unlock() async throws -> Product? {
        let products = try await Product.products(for: [StorePurchasesPlugin.productId])
        guard let product = products.first, product.type == .nonConsumable else { return nil }
        return product
    }

    private func purchase(_ product: Product, account: UUID) async throws -> Product.PurchaseResult {
        let options: Set<Product.PurchaseOption> = [.appAccountToken(account)]
        if #available(iOS 17.0, *) {
            // Name the window the sheet belongs to, rather than leaving StoreKit to guess it.
            let scene = await MainActor.run { UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive } }
            if let scene = scene { return try await product.purchase(confirmIn: scene, options: options) }
        }
        return try await product.purchase(options: options)
    }

    private func record(_ verification: VerificationResult<Transaction>, _ transaction: Transaction, finished: Bool) -> [String: Any] {
        [
            "provider": "apple",
            "product_id": transaction.productID,
            "id": String(transaction.id),
            "signed_transaction": verification.jwsRepresentation,
            "account_tag": transaction.appAccountToken?.uuidString.lowercased() ?? "",
            "state": transaction.revocationDate == nil ? "purchased" : "revoked",
            "finished": finished
        ]
    }
}
