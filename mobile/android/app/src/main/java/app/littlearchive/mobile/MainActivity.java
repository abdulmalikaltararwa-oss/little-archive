package app.littlearchive.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The share inbox, the store's purchase sheet and the browser for "Continue with Google" are part of this app, not
        // packages, so they are registered here, before the bridge starts.
        registerPlugin(ShareInboxPlugin.class);
        registerPlugin(StorePurchasesPlugin.class);
        registerPlugin(SocialSignInPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
