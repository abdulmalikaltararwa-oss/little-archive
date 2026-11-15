package app.littlearchive.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * "Continue with Google": the system browser (a Custom Tab), and nothing else. Sign in with Apple is iOS only, so there is no
 * apple() here and the page never calls one on Android.
 *
 * This class only opens the browser and hands back where it ended up; mobile/src/social.js decides everything else. It never
 * sees the PKCE code verifier (the page keeps it), and it answers a call only while that call is waiting.
 *
 *   browser({ url })  opens `url` (the project's authorize address) in a Custom Tab. The tab ends when the page it shows redirects
 *                     to littlearchive://auth-callback, which the intent filter in AndroidManifest.xml sends to MainActivity.
 *                     { status: "returned", url } | { status: "cancelled" }
 *
 * Android gives no signal when someone closes a Custom Tab, so a resume with the call still waiting and no callback means the tab
 * was closed. A callback arrives (onNewIntent) before the resume that follows it. A callback that arrives when nothing is waiting
 * (another app sent the intent, or the app was restarted since the tab opened and the page's verifier is gone) is dropped.
 */
@CapacitorPlugin(name = "SocialSignIn")
public class SocialSignInPlugin extends Plugin {

    /** The address Supabase redirects to; the project's allow-list and the intent filter in the manifest name the same one. */
    private static final String SCHEME = "littlearchive";
    private static final String HOST = "auth-callback";

    /** The call whose tab is open. Guarded by `this`. */
    private PluginCall waiting;
    /** Set once the tab has been started, so that a resume before that is not taken for the tab closing. Guarded by `this`. */
    private boolean opened;

    @PluginMethod
    public void browser(PluginCall call) {
        final Uri target = parse(call.getString("url"));
        if (target == null) {
            call.reject("The browser could not be opened. Try again.", "BAD_REQUEST");
            return;
        }
        synchronized (this) {
            if (waiting != null) {
                call.reject("Another sign-in is already open.", "BUSY");
                return;
            }
            waiting = call;
            opened = false;
        }
        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            try {
                new CustomTabsIntent.Builder().build().launchUrl(activity, target);
                synchronized (this) {
                    if (waiting == call) opened = true;
                }
            } catch (ActivityNotFoundException | SecurityException noBrowser) {
                if (take(call)) call.reject("No web browser is available to sign in with.", "BROWSER_FAILED");
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        if (!SCHEME.equals(data.getScheme()) || !HOST.equals(data.getHost())) return;
        // Handled once: the address must not be read again from this intent.
        intent.setData(null);
        PluginCall call;
        synchronized (this) {
            call = waiting;
            waiting = null;
            opened = false;
        }
        if (call == null) return;
        JSObject result = new JSObject();
        result.put("status", "returned");
        result.put("url", data.toString());
        call.resolve(result);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        PluginCall call;
        synchronized (this) {
            if (waiting == null || !opened) return;
            call = waiting;
            waiting = null;
            opened = false;
        }
        JSObject result = new JSObject();
        result.put("status", "cancelled");
        call.resolve(result);
    }

    private synchronized boolean take(PluginCall call) {
        if (waiting != call) return false;
        waiting = null;
        opened = false;
        return true;
    }

    /** Only an http or https address with a host is opened: this is not a way to start anything else. */
    private static Uri parse(String text) {
        if (text == null || text.length() > 4096) return null;
        Uri uri = Uri.parse(text);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        return uri.getHost() == null || uri.getHost().isEmpty() ? null : uri;
    }
}
