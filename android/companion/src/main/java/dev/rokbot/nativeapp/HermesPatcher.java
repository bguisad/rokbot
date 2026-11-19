package dev.rokbot.nativeapp;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public class HermesPatcher {
    private static volatile boolean sAppliedUnpairedBundle = false;

    public static boolean hasAppliedUnpairedBundle() {
        return sAppliedUnpairedBundle;
    }

    public static void markAppliedUnpairedBundle(boolean applied) {
        sAppliedUnpairedBundle = applied;
    }

    public static boolean hasUnpairedBundle(Context context) {
        if (context == null) return false;
        try (InputStream ignored = context.getAssets().open("recipes/unpaired.hbc")) {
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    public static File ensureUnpairedBundleFile(Context context) {
        if (context == null || !hasUnpairedBundle(context)) return null;
        try {
            File outDir = new File(context.getFilesDir(), "RokBotUnpaired");
            outDir.mkdirs();
            File outFile = new File(outDir, "unpaired.hbc");
            if (!outFile.exists() || outFile.length() == 0) {
                byte[] bytes;
                try (InputStream is = context.getAssets().open("recipes/unpaired.hbc")) {
                    bytes = readAllBytes(is);
                }
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                }
            }
            sAppliedUnpairedBundle = outFile.exists() && outFile.length() > 0;
            return outFile;
        } catch (Throwable t) {
            return null;
        }
    }

    public static boolean hasGatewayTemplate(Context context) {
        try (InputStream ignored = context.getAssets().open("recipes/gateway-template.json");
             InputStream ignored2 = context.getAssets().open("recipes/gateway-template.hbc")) {
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    public static File generatePairedBundle(Context context, String url, String token) throws Exception {
        byte[] jsonBytes;
        try (InputStream is = context.getAssets().open("recipes/gateway-template.json")) {
            jsonBytes = readAllBytes(is);
        }
        JSONObject meta = new JSONObject(new String(jsonBytes, StandardCharsets.UTF_8));

        byte[] bundle;
        try (InputStream is = context.getAssets().open("recipes/gateway-template.hbc")) {
            bundle = readAllBytes(is);
        }

        String expectedSha = meta.optString("templateSha256", "");
        if (!expectedSha.isEmpty() && !sha256Hex(bundle).equalsIgnoreCase(expectedSha)) {
            throw new IllegalStateException("gateway-template.hbc SHA-256 verification failed");
        }

        JSONObject opcodes = meta.getJSONObject("opcodes");
        JSONObject strings = meta.getJSONObject("strings");
        int emptyString = meta.getInt("emptyString");
        int urlKey = meta.getInt("urlKey");
        int tokenKey = meta.getInt("tokenKey");
        int bodyOffset = meta.getInt("bodyOffset");
        int bodyCapacity = meta.getInt("bodyCapacity");
        int bodyLengthOffset = meta.getInt("bodyLengthOffset");

        if (bodyOffset < 0 || bodyCapacity <= 0 || bodyOffset + bodyCapacity > bundle.length - 20) {
            throw new IllegalStateException("Invalid Hermes template body bounds");
        }

        ByteBuffer body = ByteBuffer.allocate(bodyCapacity).order(ByteOrder.LITTLE_ENDIAN);

        // Op: NewObject reg 0
        body.put((byte) opcodes.getInt("NewObject"));
        body.put((byte) 0);

        String[] values = new String[] { url, token };
        int[] keys = new int[] { urlKey, tokenKey };

        for (int cache = 0; cache < 2; cache++) {
            loadString(body, opcodes, 1, emptyString);
            String val = values[cache];
            for (int i = 0; i < val.length(); i++) {
                char c = val.charAt(i);
                if (c < 33 || c > 126) {
                    throw new IllegalArgumentException("URL and token must be printable ASCII");
                }
                String code = String.valueOf((int) c);
                if (strings.has(code)) {
                    loadString(body, opcodes, 2, strings.getInt(code));
                } else if (c >= '0' && c <= '9') {
                    body.put((byte) opcodes.getInt("LoadConstUInt8"));
                    body.put((byte) 2);
                    body.put((byte) (c - '0'));
                } else {
                    throw new IllegalArgumentException("Unsupported char in url/token: " + c);
                }
                body.put((byte) opcodes.getInt("Add"));
                body.put((byte) 1);
                body.put((byte) 1);
                body.put((byte) 2);
            }
            int keyIdx = keys[cache];
            if (keyIdx < 65536) {
                body.put((byte) opcodes.getInt("DefineOwnById"));
                body.put((byte) 0);
                body.put((byte) 1);
                body.put((byte) cache);
                body.putShort((short) keyIdx);
            } else {
                body.put((byte) opcodes.getInt("DefineOwnByIdLong"));
                body.put((byte) 0);
                body.put((byte) 1);
                body.put((byte) cache);
                body.putInt(keyIdx);
            }
        }

        body.put((byte) opcodes.getInt("Ret"));
        body.put((byte) 0);

        int bodyLen = body.position();
        byte[] bodyBytes = body.array();

        System.arraycopy(bodyBytes, 0, bundle, bodyOffset, bodyLen);
        for (int i = bodyOffset + bodyLen; i < bodyOffset + bodyCapacity; i++) {
            bundle[i] = 0;
        }

        ByteBuffer.wrap(bundle, bodyLengthOffset, 4).order(ByteOrder.LITTLE_ENDIAN).putInt(bodyLen);

        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        sha1.update(bundle, 0, bundle.length - 20);
        byte[] digest = sha1.digest();
        System.arraycopy(digest, 0, bundle, bundle.length - 20, 20);

        File outDir = new File(context.getFilesDir(), "RokBotPaired");
        outDir.mkdirs();
        File outFile = new File(outDir, "index.android.bundle");
        try (FileOutputStream fos = new FileOutputStream(outFile)) {
            fos.write(bundle);
        }

        return outFile;
    }

    private static void loadString(ByteBuffer buf, JSONObject opcodes, int reg, int idx) throws Exception {
        if (idx < 65536) {
            buf.put((byte) opcodes.getInt("LoadConstString"));
            buf.put((byte) reg);
            buf.putShort((short) idx);
        } else {
            buf.put((byte) opcodes.getInt("LoadConstStringLongIndex"));
            buf.put((byte) reg);
            buf.putInt(idx);
        }
    }

    private static String sha256Hex(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static byte[] readAllBytes(InputStream is) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) {
            baos.write(buf, 0, n);
        }
        return baos.toByteArray();
    }
}
