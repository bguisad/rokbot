package dev.rokbot.nativeapp;

import android.content.Context;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Saved Host connections (Tailcat links and direct server URLs) the user can switch between
 * without pairing again.
 *
 * Each entry keeps its own device credential: the device token and, for Tailcat, the tunnel
 * identity (private key). Both are sealed with the same Android Keystore AES-GCM key that seals
 * the active token in {@link Storage}; only the sealed form is written to SharedPreferences.
 * Entries are keyed by type + address, so pairing the same Host again replaces its entry.
 *
 * Switching validates the target credential against the target Host first (GET /connect/status
 * with the stored token, through a pending tunnel for Tailcat), then installs it exactly like a
 * fresh pairing does, regenerates the paired RN bundle (force) and reloads React Native. A token
 * the Host no longer accepts (401/403) is reported as {@link SwitchException#KIND_INVALID} and the
 * current connection is left untouched.
 */
final class ConnectionHistory {
    static final String TYPE_TAILCAT = "tailcat";
    static final String TYPE_SERVER = "server";
    static final String PREF_KEY = "connectionHistory.v1";
    static final int MAX_ENTRIES = 20;

    private ConnectionHistory() {}

    static final class Entry {
        String id;
        String type;
        String address;
        String deviceId;
        String name;
        String customName;
        String reportedGatewayUrl;
        long lastUsedAt;
        String tokenHash;
        String sealedToken;
        String sealedIdentity;

        boolean isTailcat() {
            return TYPE_TAILCAT.equals(type);
        }

        String key() {
            return keyOf(type, address);
        }

        /** Renamed label, else the Host's hostName, else the address. */
        String displayName() {
            if (customName != null && !customName.trim().isEmpty()) return customName.trim();
            if (name != null && !name.trim().isEmpty()) return HostProfile.rebrandHostName(name.trim());
            return shortAddress(type, address);
        }

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id);
                o.put("type", type);
                o.put("address", address);
                if (deviceId != null) o.put("deviceId", deviceId);
                if (name != null) o.put("name", name);
                if (customName != null) o.put("customName", customName);
                if (reportedGatewayUrl != null) o.put("reportedGatewayUrl", reportedGatewayUrl);
                o.put("lastUsedAt", lastUsedAt);
                if (tokenHash != null) o.put("tokenHash", tokenHash);
                if (sealedToken != null) o.put("sealedToken", sealedToken);
                if (sealedIdentity != null) o.put("sealedIdentity", sealedIdentity);
            } catch (Exception ignored) {}
            return o;
        }

        static Entry fromJson(JSONObject o) {
            if (o == null) return null;
            Entry e = new Entry();
            e.id = o.optString("id", "");
            e.type = o.optString("type", "");
            e.address = o.optString("address", "");
            e.deviceId = optNullable(o, "deviceId");
            e.name = optNullable(o, "name");
            e.customName = optNullable(o, "customName");
            e.reportedGatewayUrl = optNullable(o, "reportedGatewayUrl");
            e.lastUsedAt = o.optLong("lastUsedAt", 0L);
            e.tokenHash = optNullable(o, "tokenHash");
            e.sealedToken = optNullable(o, "sealedToken");
            e.sealedIdentity = optNullable(o, "sealedIdentity");
            if (e.id.isEmpty() || e.address.isEmpty()
                    || !(TYPE_TAILCAT.equals(e.type) || TYPE_SERVER.equals(e.type))) {
                return null;
            }
            return e;
        }
    }

    static final class SwitchException extends Exception {
        static final int KIND_INVALID = 1;      // the Host rejected the stored token
        static final int KIND_UNREACHABLE = 2;  // network / tunnel failure
        static final int KIND_LOCKED = 3;       // the sealed credential can no longer be opened
        static final int KIND_MISSING = 4;
        final int kind;

        SwitchException(int kind, String message) {
            super(message);
            this.kind = kind;
        }
    }

    // ---- pure helpers (JVM-tested) ----

    private static String optNullable(JSONObject o, String key) {
        if (!o.has(key) || o.isNull(key)) return null;
        String v = o.optString(key, "");
        return v.isEmpty() ? null : v;
    }

    static String keyOf(String type, String address) {
        String t = type == null ? "" : type;
        String a = address == null ? "" : address.trim();
        if (TYPE_SERVER.equals(t)) {
            while (a.endsWith("/")) a = a.substring(0, a.length() - 1);
            a = a.toLowerCase(Locale.ROOT);
        }
        return t + "|" + a;
    }

    /** "tailcat://connect/tcAbCd…WxYz" or the server URL without a trailing slash. */
    static String shortAddress(String type, String address) {
        if (address == null) return "";
        String a = address.trim();
        if (TYPE_TAILCAT.equals(type)) {
            String prefix = "tailcat://connect/";
            if (a.startsWith(prefix)) {
                String rest = a.substring(prefix.length());
                int q = rest.indexOf('?');
                String node = q >= 0 ? rest.substring(0, q) : rest;
                String port = q >= 0 ? rest.substring(q) : "";
                if (node.length() > 14) node = node.substring(0, 8) + "…" + node.substring(node.length() - 4);
                return "tailcat://" + node + ("?port=8000".equals(port) ? "" : port.replace("?port=", ":"));
            }
            return a;
        }
        while (a.endsWith("/")) a = a.substring(0, a.length() - 1);
        return a;
    }

    static String tokenHash(String token) {
        if (token == null) return null;
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(("rokbot-history|" + token).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format(Locale.ROOT, "%02x", d[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    static List<Entry> parse(String raw) {
        List<Entry> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                Entry e = Entry.fromJson(arr.optJSONObject(i));
                if (e != null) out.add(e);
            }
        } catch (Exception ignored) {}
        return out;
    }

    static String serialize(List<Entry> entries) {
        JSONArray arr = new JSONArray();
        for (Entry e : entries) arr.put(e.toJson());
        return arr.toString();
    }

    /** Most recently used first; keeps at most MAX_ENTRIES (never drops the pinned key). */
    static List<Entry> ordered(List<Entry> entries, String keepKey) {
        List<Entry> list = new ArrayList<>(entries);
        Collections.sort(list, (a, b) -> Long.compare(b.lastUsedAt, a.lastUsedAt));
        while (list.size() > MAX_ENTRIES) {
            int drop = list.size() - 1;
            if (keepKey != null && keepKey.equals(list.get(drop).key())) drop--;
            list.remove(drop);
        }
        return list;
    }

    static Entry findByKey(List<Entry> entries, String key) {
        for (Entry e : entries) if (e.key().equals(key)) return e;
        return null;
    }

    static Entry findById(List<Entry> entries, String id) {
        if (id == null) return null;
        for (Entry e : entries) if (id.equals(e.id)) return e;
        return null;
    }

    static boolean isUnauthorized(Throwable t) {
        if (t instanceof HostApiClient.ApiException) {
            int code = ((HostApiClient.ApiException) t).statusCode;
            return code == 401 || code == 403;
        }
        return false;
    }

    // ---- persistence ----

    static synchronized List<Entry> load(Context context) {
        return ordered(parse(Storage.getRawPref(context, PREF_KEY)), currentKey(context));
    }

    private static synchronized void save(Context context, List<Entry> entries) {
        Storage.setRawPref(context, PREF_KEY, serialize(ordered(entries, currentKey(context))));
    }

    /** Type + address of the active pairing, or null when unpaired. */
    static String currentKey(Context context) {
        if (context == null || !Storage.isPaired(context)) return null;
        return Storage.isTailcatEnabled(context)
                ? keyOf(TYPE_TAILCAT, Storage.getTailcatLink(context))
                : keyOf(TYPE_SERVER, Storage.getGatewayUrl(context));
    }

    static boolean isCurrent(Context context, Entry e) {
        String key = currentKey(context);
        return key != null && e != null && key.equals(e.key());
    }

    /**
     * Upserts the active pairing (sealed token and Tailcat identity, display name, last used).
     * Cheap when nothing changed: the token is compared by a salted hash, not decrypted.
     * {@code replaceKey}: entry the active pairing used to be stored under (Edit Connection).
     */
    static synchronized Entry recordCurrent(Context context, String replaceKey) {
        if (context == null || !Storage.isPaired(context)) return null;
        String token = Storage.getToken(context);
        if (token == null || token.isEmpty()) return null;
        boolean tailcat = Storage.isTailcatEnabled(context);
        String address = tailcat ? Storage.getTailcatLink(context) : Storage.getGatewayUrl(context);
        if (address == null || address.isEmpty()) return null;
        String type = tailcat ? TYPE_TAILCAT : TYPE_SERVER;
        String key = keyOf(type, address);

        List<Entry> entries = parse(Storage.getRawPref(context, PREF_KEY));
        Entry e = findByKey(entries, key);
        if (e == null && replaceKey != null && !replaceKey.equals(key)) {
            e = findByKey(entries, replaceKey);
        }
        if (e == null) {
            e = new Entry();
            e.id = UUID.randomUUID().toString();
            entries.add(e);
        }
        e.type = type;
        e.address = address;
        e.deviceId = Storage.getDeviceId(context);
        e.reportedGatewayUrl = Storage.getReportedGatewayUrl(context);
        String host = HostProfile.hostName(context);
        if (host != null && !host.isEmpty()) e.name = host;
        e.lastUsedAt = System.currentTimeMillis();
        String hash = tokenHash(token);
        try {
            if (e.sealedToken == null || hash == null || !hash.equals(e.tokenHash)) {
                e.sealedToken = Storage.sealForHistory(token);
                e.tokenHash = hash;
            }
            if (tailcat) {
                String identity = Storage.getTailcatIdentity(context);
                if (identity != null && !identity.isEmpty()) {
                    String opened = e.sealedIdentity != null ? Storage.openFromHistory(e.sealedIdentity) : null;
                    if (!identity.equals(opened)) e.sealedIdentity = Storage.sealForHistory(identity);
                }
            } else {
                e.sealedIdentity = null;
            }
        } catch (Throwable t) {
            // Keystore unavailable: keep the entry without a credential (switching will ask to re-pair).
            android.util.Log.w("RokBotHistory", "could not seal connection credential", t);
        }
        save(context, entries);
        return e;
    }

    static Entry recordCurrent(Context context) {
        return recordCurrent(context, null);
    }

    /** Called on every launch: devices paired before rokbot.3 get their pairing into the history. */
    static void ensureCurrentRecorded(Context context) {
        if (context == null || !Storage.isPaired(context)) return;
        try {
            String key = currentKey(context);
            Entry e = key != null ? findByKey(parse(Storage.getRawPref(context, PREF_KEY)), key) : null;
            String hash = tokenHash(Storage.getToken(context));
            if (e == null || e.sealedToken == null || hash == null || !hash.equals(e.tokenHash)) {
                recordCurrent(context);
            }
        } catch (Throwable t) {
            android.util.Log.w("RokBotHistory", "history migration failed", t);
        }
    }

    /** HostProfile refreshed: remember the Host's name for the active entry. */
    static synchronized void noteHostName(Context context, String hostName) {
        if (context == null || hostName == null || hostName.trim().isEmpty()) return;
        String key = currentKey(context);
        if (key == null) return;
        List<Entry> entries = parse(Storage.getRawPref(context, PREF_KEY));
        Entry e = findByKey(entries, key);
        if (e == null || hostName.trim().equals(e.name)) return;
        e.name = hostName.trim();
        save(context, entries);
    }

    static synchronized void rename(Context context, String id, String newName) {
        List<Entry> entries = parse(Storage.getRawPref(context, PREF_KEY));
        Entry e = findById(entries, id);
        if (e == null) return;
        String n = newName != null ? newName.trim() : "";
        e.customName = n.isEmpty() ? null : (n.length() > 60 ? n.substring(0, 60) : n);
        save(context, entries);
    }

    /** Removes a saved connection. The active one cannot be removed (use Disconnect & Unpair). */
    static synchronized boolean delete(Context context, String id) {
        List<Entry> entries = parse(Storage.getRawPref(context, PREF_KEY));
        Entry e = findById(entries, id);
        if (e == null || isCurrent(context, e)) return false;
        entries.remove(e);
        save(context, entries);
        return true;
    }

    /** Unpair: the active entry's credential was revoked locally, so forget it too. */
    static synchronized void forgetCurrent(Context context) {
        String key = currentKey(context);
        if (key == null) return;
        List<Entry> entries = parse(Storage.getRawPref(context, PREF_KEY));
        Entry e = findByKey(entries, key);
        if (e != null) {
            entries.remove(e);
            Storage.setRawPref(context, PREF_KEY, serialize(entries));
        }
    }

    // ---- switching (call off the main thread) ----

    static Entry switchTo(Context context, String id) throws SwitchException {
        Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        Entry target = findById(load(app), id);
        if (target == null) {
            throw new SwitchException(SwitchException.KIND_MISSING, Localize.t(app, "该连接已不存在。", "This connection no longer exists."));
        }
        if (isCurrent(app, target)) return target;
        String token = target.sealedToken != null ? Storage.openFromHistory(target.sealedToken) : null;
        if (token == null || token.isEmpty()) {
            throw new SwitchException(SwitchException.KIND_LOCKED, Localize.t(app,
                    "无法读取这个连接保存的凭证，请重新配对。",
                    "The saved credential for this connection can't be read. Please pair again."));
        }
        // Keep the latest state of the connection we are leaving.
        recordCurrent(app);

        if (target.isTailcat()) {
            String identity = target.sealedIdentity != null ? Storage.openFromHistory(target.sealedIdentity) : null;
            TailcatManager.TunnelSession pending;
            try {
                pending = TailcatManager.get().startPending(app, target.address, identity);
            } catch (RuntimeException e) {
                throw new SwitchException(SwitchException.KIND_UNREACHABLE, e.getMessage() != null ? e.getMessage()
                        : Localize.t(app, "无法建立 Tailcat 隧道。", "Could not start the Tailcat tunnel."));
            }
            try {
                verify(app, pending.localUrl, token);
            } catch (SwitchException se) {
                TailcatManager.get().dropPending(pending);
                throw se;
            }
            Storage.saveTailcatCredentials(app, token, pending.link, target.deviceId, pending.identityJson, target.reportedGatewayUrl);
            TailcatManager.get().commitPending(pending);
        } else {
            verify(app, target.address, token);
            Storage.saveCredentials(app, token, target.address, target.deviceId, target.reportedGatewayUrl);
            TailcatManager.get().clear();
        }

        // Same follow-up as a successful pairing (PairingActivity.attemptPairing).
        HostProfile.clear();
        try {
            RokBotBootstrap.ensurePairedBundleFile(app, true);
        } catch (Throwable ignored) {}
        NotificationService.sync(app, true);
        PushManager.getInstance(app).syncDeviceAsync(RokBotBootstrap.isForeground(), true);
        HostProfile.refresh(app, true);
        AppUpdater.onPairingChanged(app);
        Entry now = recordCurrent(app);
        return now != null ? now : target;
    }

    private static void verify(Context app, String server, String token) throws SwitchException {
        try {
            HostApiClient.checkStatus(server, token);
        } catch (Throwable t) {
            if (isUnauthorized(t)) {
                throw new SwitchException(SwitchException.KIND_INVALID, Localize.t(app,
                        "这个连接的设备凭证已失效（Host 可能已移除此设备），请重新配对。",
                        "This connection's device credential is no longer valid (the Host may have removed this device). Please pair again."));
            }
            String msg = t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
            throw new SwitchException(SwitchException.KIND_UNREACHABLE, Localize.t(app,
                    "无法连接到该 Host：" + msg, "Could not reach this Host: " + msg));
        }
    }

    static String hostOf(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getHost();
        } catch (Throwable t) {
            return null;
        }
    }
}
