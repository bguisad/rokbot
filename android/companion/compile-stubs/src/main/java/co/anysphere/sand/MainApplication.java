package co.anysphere.sand;

import android.app.Application;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactNativeHost;

public class MainApplication extends Application implements ReactApplication {
    private ReactNativeHost mReactNativeHost;

    @Override
    public ReactNativeHost getReactNativeHost() {
        return mReactNativeHost;
    }
}
