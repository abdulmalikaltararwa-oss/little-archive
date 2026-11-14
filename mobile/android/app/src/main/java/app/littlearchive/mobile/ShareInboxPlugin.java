package app.littlearchive.mobile;

import android.content.Intent;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives text shared from other apps (ACTION_SEND, text/plain) and keeps the most recent share until the web interface
 * asks for it with take().
 *
 * What arrives is untrusted text from another app. It is only handed on as strings, capped in length. The interface
 * reduces it to plain text that fills the save form (parseSharedContent in web/utils.js); nothing is saved until the person
 * taps Save.
 */
@CapacitorPlugin(name = "ShareInbox")
public class ShareInboxPlugin extends Plugin {

    private static final int LIMIT = 20000;
    private JSObject pending;

    @Override
    public void load() {
        // The app was opened from the share sheet.
        capture(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        // The app was already running and was brought forward by the share sheet.
        if (capture(intent)) {
            notifyListeners("shareReceived", new JSObject(), true);
        }
    }

    private boolean capture(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return false;
        JSObject share = new JSObject();
        try {
            share.put("text", clip(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)));
            // Apps that share a page put its title in the subject.
            String subject = clip(intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT));
            share.put("title", subject.isEmpty() ? clip(intent.getCharSequenceExtra(Intent.EXTRA_TITLE)) : subject);
            share.put("url", "");
        } catch (RuntimeException unreadable) {
            // An extra of the wrong kind from a misbehaving app is the same as nothing shared.
            return false;
        }
        // Handled once: a recreated activity must not deliver the same share again.
        intent.setAction(null);
        intent.removeExtra(Intent.EXTRA_TEXT);
        synchronized (this) {
            pending = share;
        }
        return true;
    }

    private static String clip(CharSequence value) {
        if (value == null) return "";
        String text = value.toString();
        return text.length() > LIMIT ? text.substring(0, LIMIT) : text;
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (this) {
            if (pending != null) {
                items.put(pending);
                pending = null;
            }
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }
}
