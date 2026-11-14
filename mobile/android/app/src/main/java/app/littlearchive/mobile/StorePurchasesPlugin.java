package app.littlearchive.mobile;

import android.app.Activity;
import com.android.billingclient.api.AccountIdentifiers;
import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClient.BillingResponseCode;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;

/**
 * The one-time unlock, sold through Google Play Billing. Nothing else: no subscriptions, no consumables, no ads, no purchase service.
 *
 * This class only talks to Google Play and hands over what it says; mobile/src/purchases.js decides what to do with it. The
 * server (POST /api/purchases/google) is the only thing that unlocks an account, by asking Google about the purchase token.
 * The server also acknowledges the purchase when it can; this plugin acknowledges (`finish`) only when the app asks, which it does
 * only if the server said it could not. A purchase nobody acknowledges is refunded by Google after three days.
 *
 * A record, the same shape on both platforms (see purchases.js):
 *   provider, product_id, purchase_token, account_tag (the obfuscated account id: the hash of the account's UUID, lowercase hex),
 *   state ("purchased" or "pending"), finished (acknowledged)
 */
@CapacitorPlugin(name = "StorePurchases")
public class StorePurchasesPlugin extends Plugin implements PurchasesUpdatedListener {

    /** The product id in Play Console (a one-time product). Changing it means changing it in the server's configuration too. */
    static final String PRODUCT_ID = "unlock_full";

    private BillingClient client;
    /** The call waiting for the purchase sheet's answer. Guarded by `this`. */
    private PluginCall buying;
    private final List<Waiter> waiting = new ArrayList<>();
    private boolean connecting;

    private static final class Waiter {
        final PluginCall call;
        final Runnable run;

        Waiter(PluginCall call, Runnable run) {
            this.call = call;
            this.run = run;
        }
    }

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
            .setListener(this)
            // A payment that is not complete yet (cash, a slow bank) is a pending purchase: the unlock waits for it.
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build();
    }

    // The unlock, as the store describes it -------------------------------------------------------------------

    /** The unlock's localized price, from Google Play. `available` is false when Play does not have it. */
    @PluginMethod
    public void product(PluginCall call) {
        whenReady(call, () -> unlock(call, details -> {
            JSObject out = new JSObject();
            String price = details == null ? null : priceOf(details);
            out.put("available", price != null);
            if (price != null) {
                out.put("id", PRODUCT_ID);
                out.put("price", price);
            }
            call.resolve(out);
        }));
    }

    // Buying --------------------------------------------------------------------------------------------------

    /**
     * Opens Google Play's purchase sheet, binding the purchase to the account (`accountTag`, 64 lowercase hex characters) so the
     * server can tell whose it is. Resolves { status: "purchased", purchase } | { status: "pending" } | { status: "cancelled" }.
     */
    @PluginMethod
    public void buy(PluginCall call) {
        String tag = call.getString("accountTag");
        if (tag == null || !tag.matches("[0-9a-f]{64}")) {
            call.reject("This account could not be identified. Sign in again and try once more.", "BAD_ACCOUNT");
            return;
        }
        synchronized (this) {
            if (buying != null) {
                call.reject("A purchase is already open.", "BUSY");
                return;
            }
            buying = call;
        }
        whenReady(call, () -> unlock(call, details -> {
            if (details == null) {
                reject(call, "The unlock is not available from Google Play right now. Try again later.", "UNAVAILABLE");
                return;
            }
            BillingFlowParams.ProductDetailsParams.Builder product = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details);
            List<ProductDetails.OneTimePurchaseOfferDetails> offers = details.getOneTimePurchaseOfferDetailsList();
            if (offers != null && !offers.isEmpty() && offers.get(0).getOfferToken() != null) product.setOfferToken(offers.get(0).getOfferToken());
            BillingFlowParams flow = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(product.build()))
                .setObfuscatedAccountId(tag)
                .build();
            Activity activity = getActivity();
            if (activity == null) {
                reject(call, "Little Archive is not on screen, so Google Play cannot open its purchase sheet.", "FAILED");
                return;
            }
            // The sheet is opened from the main thread; its answer arrives in onPurchasesUpdated.
            activity.runOnUiThread(() -> {
                BillingResult launched = client.launchBillingFlow(activity, flow);
                if (launched.getResponseCode() != BillingResponseCode.OK) answer(launched, null);
            });
        }));
    }

    /** Google Play's answer to the sheet, or an update that happened outside it (a pending payment that cleared, a purchase from the Play Store). */
    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        answer(result, purchases);
    }

    private void answer(BillingResult result, List<Purchase> purchases) {
        PluginCall call;
        synchronized (this) {
            call = buying;
            buying = null;
        }
        int code = result.getResponseCode();
        Purchase mine = code == BillingResponseCode.OK ? find(purchases) : null;
        if (call == null) {
            // Nobody is waiting on the sheet: tell the page, which looks at what Google Play holds.
            if (mine != null) notifyListeners("purchaseUpdated", new JSObject());
            return;
        }
        if (mine != null) {
            JSObject out = new JSObject();
            if (mine.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                out.put("status", "purchased");
                out.put("purchase", record(mine));
            } else {
                out.put("status", "pending");
            }
            call.resolve(out);
        } else if (code == BillingResponseCode.USER_CANCELED) {
            call.resolve(new JSObject().put("status", "cancelled"));
        } else if (code == BillingResponseCode.ITEM_ALREADY_OWNED) {
            // Bought before: that is a restore. Hand over the purchase Google Play holds.
            final PluginCall owned = call;
            whenReady(owned, () -> queryOwned(owned, purchasesHeld -> {
                Purchase held = find(purchasesHeld);
                if (held == null || held.getPurchaseState() != Purchase.PurchaseState.PURCHASED) {
                    reject(owned, "Google Play says this is already bought, but could not show the purchase. Try Restore.", "FAILED");
                    return;
                }
                owned.resolve(new JSObject().put("status", "purchased").put("purchase", record(held)));
            }));
        } else {
            call.reject("The purchase did not go through. You were not charged for anything Google Play did not confirm.", "FAILED");
        }
    }

    // What the store account holds ----------------------------------------------------------------------------

    /** Every purchase of the unlock Google Play holds, paid or still pending. `sync` has no meaning here: Google Play keeps this current. */
    @PluginMethod
    public void list(PluginCall call) {
        whenReady(call, () -> queryOwned(call, purchases -> {
            JSArray out = new JSArray();
            if (purchases != null) {
                for (Purchase purchase : purchases) {
                    if (!purchase.getProducts().contains(PRODUCT_ID)) continue;
                    int state = purchase.getPurchaseState();
                    if (state == Purchase.PurchaseState.PURCHASED || state == Purchase.PurchaseState.PENDING) out.put(record(purchase));
                }
            }
            call.resolve(new JSObject().put("purchases", out));
        }));
    }

    // Delivering ----------------------------------------------------------------------------------------------

    /** Acknowledges the purchase. Called only when the server said it could not do so itself; Google refunds an unacknowledged purchase after three days. */
    @PluginMethod
    public void finish(PluginCall call) {
        String token = call.getString("purchaseToken");
        if (token == null || token.isEmpty()) {
            call.reject("Which purchase?", "BAD_TOKEN");
            return;
        }
        whenReady(call, () -> client.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(),
            result -> call.resolve(new JSObject().put("finished", result.getResponseCode() == BillingResponseCode.OK))));
    }

    // Helpers -------------------------------------------------------------------------------------------------

    private void queryOwned(PluginCall call, Consumer<List<Purchase>> done) {
        client.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
            (result, purchases) -> {
                if (result.getResponseCode() != BillingResponseCode.OK) {
                    reject(call, "Google Play could not be reached. Try again in a moment.", "UNAVAILABLE");
                    return;
                }
                done.accept(purchases);
            });
    }

    /** The unlock's details, or null when Google Play does not have it as a one-time product. */
    private void unlock(PluginCall call, Consumer<ProductDetails> done) {
        QueryProductDetailsParams query = QueryProductDetailsParams.newBuilder()
            .setProductList(Collections.singletonList(
                QueryProductDetailsParams.Product.newBuilder().setProductId(PRODUCT_ID).setProductType(BillingClient.ProductType.INAPP).build()))
            .build();
        client.queryProductDetailsAsync(query, (result, found) -> {
            if (result.getResponseCode() != BillingResponseCode.OK) {
                reject(call, "Google Play could not be reached. Try again in a moment.", "UNAVAILABLE");
                return;
            }
            List<ProductDetails> list = found.getProductDetailsList();
            done.accept(list == null || list.isEmpty() ? null : list.get(0));
        });
    }

    private static String priceOf(ProductDetails details) {
        List<ProductDetails.OneTimePurchaseOfferDetails> offers = details.getOneTimePurchaseOfferDetailsList();
        if (offers != null && !offers.isEmpty()) return offers.get(0).getFormattedPrice();
        ProductDetails.OneTimePurchaseOfferDetails single = details.getOneTimePurchaseOfferDetails();
        return single == null ? null : single.getFormattedPrice();
    }

    private static Purchase find(List<Purchase> purchases) {
        if (purchases == null) return null;
        for (Purchase purchase : purchases) if (purchase.getProducts().contains(PRODUCT_ID)) return purchase;
        return null;
    }

    private static JSObject record(Purchase purchase) {
        AccountIdentifiers ids = purchase.getAccountIdentifiers();
        String tag = ids == null || ids.getObfuscatedAccountId() == null ? "" : ids.getObfuscatedAccountId().toLowerCase(Locale.ROOT);
        JSObject out = new JSObject();
        out.put("provider", "google");
        out.put("product_id", PRODUCT_ID);
        out.put("purchase_token", purchase.getPurchaseToken());
        out.put("account_tag", tag);
        out.put("state", purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased" : "pending");
        out.put("finished", purchase.isAcknowledged());
        return out;
    }

    /** Rejects a call, and if it was the one waiting on the sheet, stops waiting. */
    private void reject(PluginCall call, String message, String code) {
        synchronized (this) {
            if (buying == call) buying = null;
        }
        call.reject(message, code);
    }

    /** Runs `run` once the billing service is connected, or rejects the call if it cannot be. One connection attempt at a time. */
    private void whenReady(PluginCall call, Runnable run) {
        if (client.isReady()) {
            run.run();
            return;
        }
        boolean start;
        synchronized (waiting) {
            waiting.add(new Waiter(call, run));
            start = !connecting;
            connecting = true;
        }
        if (!start) return;
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                List<Waiter> go;
                synchronized (waiting) {
                    go = new ArrayList<>(waiting);
                    waiting.clear();
                    connecting = false;
                }
                for (Waiter waiter : go) {
                    if (result.getResponseCode() == BillingResponseCode.OK) waiter.run.run();
                    else reject(waiter.call, "Google Play is not available on this device right now.", "UNAVAILABLE");
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Automatic reconnection is on; a call that arrives meanwhile connects again in whenReady.
            }
        });
    }
}
