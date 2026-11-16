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
 * sees the PKCE code verifier (the page keeps it).
 *
 *   browser({ url })  opens `url` (the project's authorize address) in a Custom Tab. The tab ends when the page it shows redirects
 *                     to littlearchive://auth-callback, which the intent filter in AndroidManifest.xml sends to MainActivity.
 *                     { status: "returned", url } | { status: "cancelled" }
 *
 * Android gives no signal when someone closes a Custom Tab, so a resume with the call still waiting and no callback means the tab
 * was closed. A callback arrives (onNewIntent) before the resume that follows it.
 *
 * Who can send the callback. The intent filter is exported and browsable, as it must be for the browser to reach it, so any app
 * on the phone can send littlearchive://auth-callback?... too. This class cannot tell such an intent from the browser's own
 * redirect:
 *   - While a call is waiting, whichever arrives first is handed to the page as the answer, and the attempt ends with it. It
 *     cannot sign anyone in: the page trades the code together with its own verifier, and the project refuses a code that was
 *     not made for that attempt's challenge (an error in the address is shown as a failed sign-in). So the most another app can
 *     do is make one attempt fail, and the person tries again.
 *   - With no call waiting, the address is dropped here and never handed to the page. If that happens before the page has asked
 *     interrupted() (the app was started, or started again, by the callback: Android ended the old process while the tab was
 *     open, or another app sent the intent), the fact is remembered, and the page says "Sign-in was interrupted. Try again."
 *     (interruptedSignIn in social.js). The code is not used: the verifier went with the old process. Capacitor hands the
 *     intent an activity was created with to onNewIntent as well, so both ways the callback can reach a fresh process end here.
 *
 *   interrupted()     { interrupted: true } once, if a callback was dropped before the page first asked; false after that.
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
    /** A callback arrived with nothing waiting, before the page asked interrupted(). Guarded by `this`. */
    private boolean droppedEarly;
    /** The page has asked interrupted() in this process: a callback dropped from now on is not remembered. Guarded by `this`. */
    private boolean asked;

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
            if (call == null && !asked) droppedEarly = true;
        }
        // Nothing is waiting: dropped (see the class comment).
        if (call == null) return;
        // Something is waiting. This may be the browser's redirect or any other app's intent; the page and the project decide
        // what the address is worth, not this class.
        JSObject result = new JSObject();
        result.put("status", "returned");
        result.put("url", data.toString());
        call.resolve(result);
    }

    @PluginMethod
    public void interrupted(PluginCall call) {
        boolean was;
        synchronized (this) {
            was = droppedEarly;
            droppedEarly = false;
            asked = true;
        }
        JSObject result = new JSObject();
        result.put("interrupted", was);
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
