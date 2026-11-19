package dev.rokbot.nativeapp;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class Storage {
    private static final String PREFS_NAME = "dev.rokbot.nativeapp.prefs";
    private static final String KEY_ALIAS = "rokbot-native-device-credential";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String AES_GCM_NO_PADDING = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_SEEN_IDS = 256;

    private static volatile String sLastError = null;
    private static String sCachedTokenCiphertext = null;
    private static String sCachedTokenPlaintext = null;

    public static synchronized void init(Context context) {
        try {
            ensureKey();
        } catch (Throwable t) {
            sLastError = "keystore-init";
        }
    }

    public static String getLastError() {
        return sLastError;
    }

    public static void clearLastError() {
        sLastError = null;
    }

    private static SharedPreferences prefs(Context context) {
        Context app = context != null ? context.getApplicationContext() : null;
        Context resolved = app != null ? app : context;
        return resolved.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static SecretKey ensureKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    private static String seal(String plaintext) throws Exception {
        if (plaintext == null) return null;
        SecretKey key = ensureKey();
        Cipher cipher = Cipher.getInstance(AES_GCM_NO_PADDING);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(iv, Base64.NO_WRAP) + "." + Base64.encodeToString(sealed, Base64.NO_WRAP);
    }

    private static String open(String encoded) throws Exception {
        if (encoded == null || encoded.isEmpty()) return null;
        int dot = encoded.indexOf('.');
        if (dot <= 0) throw new IllegalStateException("Malformed sealed credential");
        byte[] iv = Base64.decode(encoded.substring(0, dot), Base64.NO_WRAP);
        byte[] sealed = Base64.decode(encoded.substring(dot + 1), Base64.NO_WRAP);
        SecretKey key = ensureKey();
        Cipher cipher = Cipher.getInstance(AES_GCM_NO_PADDING);
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
        return new String(cipher.doFinal(sealed), StandardCharsets.UTF_8);
    }

    private static synchronized void putSealed(Context context, String key, String value) {
        SharedPreferences.Editor ed = prefs(context).edit();
        if (value == null || value.isEmpty()) {
            ed.remove(key).commit();
            return;
        }
        try {
            ed.putString(key, seal(value)).commit();
        } catch (Throwable t) {
            sLastError = "credential-write";
            throw new IllegalStateException("Failed to seal credential in Android Keystore", t);
        }
    }

    private static synchronized String getSealed(Context context, String key) {
        String raw = prefs(context).getString(key, null);
        if (raw == null || raw.isEmpty()) return null;
        try {
            return open(raw);
        } catch (Throwable t) {
            sLastError = "credential";
            return null;
        }
    }

    public static boolean isPaired(Context context) {
        String token = getToken(context);
        String gateway = getGatewayUrl(context);
        return token != null && !token.isEmpty() && gateway != null && !gateway.isEmpty();
    }

    public static synchronized String getToken(Context context) {
        String raw = prefs(context).getString("token", null);
        if (raw == null || raw.isEmpty()) {
            sCachedTokenCiphertext = null;
            sCachedTokenPlaintext = null;
            return null;
        }
        if (raw.equals(sCachedTokenCiphertext) && sCachedTokenPlaintext != null) {
            return sCachedTokenPlaintext;
        }
        try {
            String plain = open(raw);
            sCachedTokenCiphertext = raw;
            sCachedTokenPlaintext = plain;
            return plain;
        } catch (Throwable t) {
            sLastError = "credential";
            return null;
        }
    }

    public static String getGatewayUrl(Context context) {
        return prefs(context).getString("gatewayUrl", null);
    }

    public static String getReportedGatewayUrl(Context context) {
        return prefs(context).getString("reportedGatewayUrl", null);
    }

    public static synchronized void setReportedGatewayUrl(Context context, String url) {
        SharedPreferences.Editor ed = prefs(context).edit();
        if (url != null && !url.trim().isEmpty()) {
            ed.putString("reportedGatewayUrl", url.trim());
        } else {
            ed.remove("reportedGatewayUrl");
        }
        ed.commit();
    }

    public static String getDeviceId(Context context) {
        return prefs(context).getString("deviceId", null);
    }

    public static synchronized void saveCredentials(Context context, String token, String gatewayUrl, String deviceId) {
        SharedPreferences.Editor ed = prefs(context).edit();
        try {
            ed.putString("token", seal(token));
        } catch (Throwable t) {
            sLastError = "credential-write";
            throw new IllegalStateException("Android Keystore encryption failed", t);
        }
        ed.putString("gatewayUrl", gatewayUrl);
        ed.putString("deviceId", deviceId);
        ed.putBoolean("tailcatEnabled", false);
        ed.remove("tailcatLink");
        ed.remove("reportedGatewayUrl");
        ed.remove("notificationCursor");
        ed.remove("seenNotificationIds");
        ed.remove("profileCache");
        ed.commit();
        sLastError = null;
    }

    public static synchronized void saveCredentials(Context context, String token, String gatewayUrl, String deviceId, String reportedGatewayUrl) {
        saveCredentials(context, token, gatewayUrl, deviceId);
        setReportedGatewayUrl(context, reportedGatewayUrl);
    }

    public static synchronized void saveTailcatCredentials(Context context, String token, String tailcatLink, String deviceId, String identityJson) {
        SharedPreferences.Editor ed = prefs(context).edit();
        try {
            ed.putString("token", seal(token));
            if (identityJson != null && !identityJson.isEmpty()) {
                ed.putString("tailcatIdentity", seal(identityJson));
            }
        } catch (Throwable t) {
            sLastError = "credential-write";
            throw new IllegalStateException("Android Keystore encryption failed", t);
        }
        ed.putString("gatewayUrl", tailcatLink);
        ed.putString("tailcatLink", tailcatLink);
        ed.putBoolean("tailcatEnabled", true);
        ed.putString("deviceId", deviceId);
        ed.remove("reportedGatewayUrl");
        ed.remove("notificationCursor");
        ed.remove("seenNotificationIds");
        ed.remove("profileCache");
        ed.commit();
        sLastError = null;
    }

    public static synchronized void saveTailcatCredentials(Context context, String token, String tailcatLink, String deviceId, String identityJson, String reportedGatewayUrl) {
        saveTailcatCredentials(context, token, tailcatLink, deviceId, identityJson);
        setReportedGatewayUrl(context, reportedGatewayUrl);
    }

    public static boolean isTailcatEnabled(Context context) {
        return prefs(context).getBoolean("tailcatEnabled", false);
    }

    public static String getTailcatLink(Context context) {
        return prefs(context).getString("tailcatLink", "");
    }

    public static String getTailcatIdentity(Context context) {
        String id = getSealed(context, "tailcatIdentity");
        return id != null ? id : "";
    }

    public static void saveTailcatIdentity(Context context, String identityJson) {
        putSealed(context, "tailcatIdentity", identityJson);
    }

    public static String getHostUrl(Context context) {
        String gw = getGatewayUrl(context);
        return gw != null ? gw : "";
    }

    public static String getStringPref(Context context, String key, String defaultValue) {
        return prefs(context).getString(key, defaultValue);
    }

    public static void setStringPref(Context context, String key, String value) {
        SharedPreferences.Editor ed = prefs(context).edit();
        if (value == null) ed.remove(key);
        else ed.putString(key, value);
        ed.commit();
    }

    public static String getThemePreference(Context context) {
        return prefs(context).getString("theme_mode", "auto");
    }

    public static void setThemePreference(Context context, String mode) {
        prefs(context).edit().putString("theme_mode", mode != null ? mode : "auto").commit();
    }

    public static synchronized void updateGatewayUrl(Context context, String gatewayUrl) {
        prefs(context).edit().putString("gatewayUrl", gatewayUrl).commit();
    }

    public static synchronized void updateDirectConnection(Context context, String gatewayUrl) {
        prefs(context).edit()
            .putString("gatewayUrl", gatewayUrl)
            .putBoolean("tailcatEnabled", false)
            .remove("tailcatLink")
            .commit();
        sLastError = null;
    }

    public static synchronized void updateTailcatConnection(Context context, String tailcatLink, String identityJson) {
        SharedPreferences.Editor ed = prefs(context).edit();
        if (identityJson != null && !identityJson.isEmpty()) {
            try {
                ed.putString("tailcatIdentity", seal(identityJson));
            } catch (Throwable t) {
                sLastError = "credential-write";
                throw new IllegalStateException("Android Keystore encryption failed", t);
            }
        }
        ed.putString("gatewayUrl", tailcatLink)
            .putString("tailcatLink", tailcatLink)
            .putBoolean("tailcatEnabled", true)
            .commit();
        sLastError = null;
    }

    public static synchronized void clearCredentials(Context context) {
        prefs(context).edit()
            .remove("token")
            .remove("gatewayUrl")
            .remove("reportedGatewayUrl")
            .remove("deviceId")
            .remove("tailcatEnabled")
            .remove("tailcatLink")
            .remove("tailcatIdentity")
            .remove("notificationCursor")
            .remove("seenNotificationIds")
            .remove("profileCache")
            .remove("pushProvider")
            .remove("unifiedPushDistributor")
            .remove("unifiedPushEndpoint")
            .remove("ntfyUrl")
            .remove("ntfyToken")
            .remove("webhookUrl")
            .remove("webhookSecret")
            .remove("fcmToken")
            .remove("registrationError")
            .commit();
        sCachedTokenCiphertext = null;
        sCachedTokenPlaintext = null;
        sLastError = null;
    }

    // ---- Notification cursor & 256-entry deduplication ring ----

    public static String getNotificationCursor(Context context) {
        return prefs(context).getString("notificationCursor", null);
    }

    public static synchronized void seedNotifications(Context context, String deviceId, JSONArray items) {
        if (deviceId == null || !deviceId.equals(getDeviceId(context)) || items == null) return;
        LinkedHashSet<String> seen = loadSeenIds(context);
        String lastId = prefs(context).getString("notificationCursor", "");
        for (int i = 0; i < items.length(); i++) {
            JSONObject obj = items.optJSONObject(i);
            if (obj == null) continue;
            String id = obj.optString("id", obj.optString("notificationId", ""));
            if (!id.isEmpty()) {
                seen.remove(id);
                seen.add(id);
                lastId = id;
            }
        }
        trimSeen(seen);
        saveSeen(context, seen, lastId);
    }

    public static synchronized boolean acceptNotification(Context context, String deviceId, String id, boolean updateCursor) {
        if (id == null || id.isEmpty() || deviceId == null || !deviceId.equals(getDeviceId(context))) {
            return false;
        }
        LinkedHashSet<String> seen = loadSeenIds(context);
        if (!seen.add(id)) {
            if (updateCursor) {
                prefs(context).edit().putString("notificationCursor", id).commit();
            }
            return false;
        }
        trimSeen(seen);
        saveSeen(context, seen, updateCursor ? id : prefs(context).getString("notificationCursor", null));
        return true;
    }

    private static LinkedHashSet<String> loadSeenIds(Context context) {
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        String raw = prefs(context).getString("seenNotificationIds", null);
        if (raw != null) {
            try {
                JSONArray arr = new JSONArray(raw);
                for (int i = 0; i < arr.length(); i++) {
                    String val = arr.optString(i, "");
                    if (!val.isEmpty()) seen.add(val);
                }
            } catch (Throwable ignored) {}
        }
        trimSeen(seen);
        return seen;
    }

    private static void trimSeen(Set<String> seen) {
        var it = seen.iterator();
        while (seen.size() > MAX_SEEN_IDS && it.hasNext()) {
            it.next();
            it.remove();
        }
    }

    private static void saveSeen(Context context, LinkedHashSet<String> seen, String cursor) {
        JSONArray arr = new JSONArray();
        for (String id : seen) arr.put(id);
        SharedPreferences.Editor ed = prefs(context).edit().putString("seenNotificationIds", arr.toString());
        if (cursor != null && !cursor.isEmpty()) ed.putString("notificationCursor", cursor);
        ed.commit();
    }

    // ---- Push configuration & state ----

    public static boolean isBackgroundNotificationsEnabled(Context context) {
        return prefs(context).getBoolean("backgroundNotifications", true);
    }

    public static void setBackgroundNotificationsEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean("backgroundNotifications", enabled).commit();
    }

    public static String getPushProvider(Context context) {
        return prefs(context).getString("pushProvider", "none");
    }

    public static void setPushProvider(Context context, String provider) {
        prefs(context).edit().putString("pushProvider", provider != null ? provider : "none").commit();
    }

    public static String getNtfyUrl(Context context) { return prefs(context).getString("ntfyUrl", ""); }
    public static void setNtfyUrl(Context context, String v) { prefs(context).edit().putString("ntfyUrl", v != null ? v : "").commit(); }

    public static String getNtfyToken(Context context) { return getSealed(context, "ntfyToken"); }
    public static void setNtfyToken(Context context, String v) { putSealed(context, "ntfyToken", v); }

    public static String getWebhookUrl(Context context) { return prefs(context).getString("webhookUrl", ""); }
    public static void setWebhookUrl(Context context, String v) { prefs(context).edit().putString("webhookUrl", v != null ? v : "").commit(); }

    public static String getWebhookSecret(Context context) { return getSealed(context, "webhookSecret"); }
    public static void setWebhookSecret(Context context, String v) { putSealed(context, "webhookSecret", v); }

    public static String getFcmToken(Context context) { return getSealed(context, "fcmToken"); }
    public static void setFcmToken(Context context, String v) { putSealed(context, "fcmToken", v); }

    public static String getUnifiedPushDistributor(Context context) { return prefs(context).getString("unifiedPushDistributor", ""); }
    public static void setUnifiedPushDistributor(Context context, String v) { prefs(context).edit().putString("unifiedPushDistributor", v != null ? v : "").commit(); }

    public static String getUnifiedPushEndpoint(Context context) { return prefs(context).getString("unifiedPushEndpoint", ""); }
    public static void setUnifiedPushEndpoint(Context context, String v) { prefs(context).edit().putString("unifiedPushEndpoint", v != null ? v : "").commit(); }

    public static synchronized String getOrCreateUnifiedPushInstance(Context context) {
        String existing = prefs(context).getString("unifiedPushInstance", null);
        if (existing != null && !existing.isEmpty()) return existing;
        String fresh = UUID.randomUUID().toString();
        prefs(context).edit().putString("unifiedPushInstance", fresh).commit();
        return fresh;
    }

    public static synchronized void resetUnifiedPushInstance(Context context) {
        prefs(context).edit().remove("unifiedPushInstance").commit();
    }

    public static synchronized String getOrCreateClientDeviceId(Context context) {
        String existing = prefs(context).getString("clientDeviceIdFallback", null);
        if (existing != null && !existing.isEmpty()) return existing;
        String fresh = "android-" + UUID.randomUUID().toString().replace("-", "");
        prefs(context).edit().putString("clientDeviceIdFallback", fresh).commit();
        return fresh;
    }

    public static String getRegistrationError(Context context) { return prefs(context).getString("registrationError", null); }
    public static void setRegistrationError(Context context, String err) {
        SharedPreferences.Editor ed = prefs(context).edit();
        if (err == null || err.isEmpty()) ed.remove("registrationError");
        else ed.putString("registrationError", err);
        ed.commit();
    }

    public static boolean wasNotificationPermissionAsked(Context context) {
        return prefs(context).getBoolean("askedNotificationPermission", false);
    }

    public static void setNotificationPermissionAsked(Context context) {
        prefs(context).edit().putBoolean("askedNotificationPermission", true).commit();
    }

    // ---- Profile cache & preconfig ----

    public static JSONObject getProfileCache(Context context) {
        String raw = prefs(context).getString("profileCache", null);
        if (raw == null) return null;
        try { return new JSONObject(raw); } catch (Throwable ignored) { return null; }
    }

    public static void setProfileCache(Context context, JSONObject profile) {
        prefs(context).edit().putString("profileCache", profile != null ? profile.toString() : null).commit();
    }

    public static String getUpdateFeedUrl(Context context) {
        return prefs(context).getString("updateFeedUrl", "");
    }

    public static void setUpdateFeedUrl(Context context, String url) {
        SharedPreferences.Editor ed = prefs(context).edit();
        if (url == null || url.trim().isEmpty()) ed.remove("updateFeedUrl");
        else ed.putString("updateFeedUrl", url.trim());
        ed.commit();
    }

    public static String getPreconfiguredHost(Context context) {
        JSONObject cfg = readPreconfigAsset(context);
        return cfg != null ? cfg.optString("host", "") : "";
    }

    public static String getPreconfiguredPairingCode(Context context) {
        JSONObject cfg = readPreconfigAsset(context);
        return cfg != null ? cfg.optString("pairingCode", "") : "";
    }

    private static JSONObject readPreconfigAsset(Context context) {
        try (InputStream is = context.getAssets().open("rokbot-preconfig.json")) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
            return new JSONObject(new String(baos.toByteArray(), StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            return null;
        }
    }
}
