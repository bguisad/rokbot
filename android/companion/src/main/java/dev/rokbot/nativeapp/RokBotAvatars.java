package dev.rokbot.nativeapp;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import android.view.View;
import android.widget.LinearLayout;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Bot avatars drawn natively (outside React Native) in the user's RokBot avatar style: the share
 * sheet's Bot list and notification large icons. Bot shape / color come from the Host roster
 * (/api/listAgents: avatarShape, avatarColor, avatarDataUrl), remembered per Bot id so a notification
 * never waits for the network on the main thread.
 */
final class RokBotAvatars {
    private static final String PREF_ROSTER = "avatarRoster";
    private static final long ROSTER_TTL_MS = 30L * 60L * 1000L;
    private static final Map<String, String> sImages = new HashMap<>();
    private static long sRosterFetchedAt = 0L;

    private RokBotAvatars() {}

    static final class Look {
        final String shape;
        final String color;
        final String imageDataUrl;
        final String name;

        Look(String shape, String color, String imageDataUrl, String name) {
            this.shape = shape;
            this.color = color;
            this.imageDataUrl = imageDataUrl;
            this.name = name;
        }
    }

    static Look lookOf(JSONObject bot) {
        if (bot == null) return new Look(null, null, null, "");
        String image = UiChrome.jsonStr(bot, "avatarDataUrl");
        return new Look(UiChrome.jsonStr(bot, "avatarShape"), UiChrome.jsonStr(bot, "avatarColor"),
                image.startsWith("data:image") ? image : null, UiChrome.jsonStr(bot, "name"));
    }

    /** Remembers shape / color of every Bot in a roster (custom images only in memory). */
    static void remember(Context context, JSONArray agents) {
        if (context == null || agents == null) return;
        try {
            JSONObject stored = new JSONObject(Storage.getStringPref(context, PREF_ROSTER, "{}"));
            for (int i = 0; i < agents.length(); i++) {
                JSONObject a = agents.optJSONObject(i);
                if (a == null) continue;
                String id = UiChrome.jsonStr(a, "id");
                if (id.isEmpty()) continue;
                JSONObject entry = new JSONObject();
                entry.put("shape", UiChrome.jsonStr(a, "avatarShape"));
                entry.put("color", UiChrome.jsonStr(a, "avatarColor"));
                entry.put("name", UiChrome.jsonStr(a, "name"));
                String image = UiChrome.jsonStr(a, "avatarDataUrl");
                entry.put("image", image.startsWith("data:image"));
                synchronized (sImages) {
                    if (image.startsWith("data:image")) sImages.put(id, image);
                    else sImages.remove(id);
                }
                stored.put(id, entry);
            }
            Storage.setStringPref(context, PREF_ROSTER, stored.toString());
        } catch (Throwable ignored) {}
    }

    /** The Bot's look from the remembered roster; refreshes it (off the main thread) when stale or unknown. */
    static Look lookForAgent(Context context, String agentId) {
        Look look = cachedLook(context, agentId);
        boolean stale = System.currentTimeMillis() - sRosterFetchedAt > ROSTER_TTL_MS;
        if ((look == null || stale) && Looper.myLooper() != Looper.getMainLooper() && Storage.isPaired(context)) {
            try {
                JSONArray agents = HostApiClient.listAgents(context);
                sRosterFetchedAt = System.currentTimeMillis();
                remember(context, agents);
                look = cachedLook(context, agentId);
            } catch (Throwable ignored) {}
        }
        return look;
    }

    private static Look cachedLook(Context context, String agentId) {
        if (context == null || agentId == null || agentId.isEmpty()) return null;
        try {
            JSONObject stored = new JSONObject(Storage.getStringPref(context, PREF_ROSTER, "{}"));
            JSONObject e = stored.optJSONObject(agentId);
            if (e == null) return null;
            String image;
            synchronized (sImages) { image = sImages.get(agentId); }
            return new Look(e.optString("shape", ""), e.optString("color", ""), image, e.optString("name", ""));
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static boolean isDark(Context context) {
        return (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    /** One still frame of the Bot in the chosen style (custom pictures stay pictures). */
    static Bitmap render(Context context, Look look, int sizePx) {
        if (look != null && look.imageDataUrl != null) {
            return UiChrome.decodeCircleAvatar(look.name, look.imageDataUrl, sizePx);
        }
        Bitmap out = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        String style = RokBotAvatarManager.getStyle(context);
        Bitmap mask = RokBotAvatarShapes.mask(look != null ? look.shape : null);
        int color = RokBotAvatarShapes.color(look != null ? look.color : null);
        float pad = sizePx * 0.04f;
        c.translate(pad, pad);
        RokBotAvatarRenderer.draw(c, style, mask, "blob", sizePx - 2 * pad, 0.0, 0f, false, color, isDark(context));
        return out;
    }

    /** Animated avatar view for native Bot lists. */
    static View makeView(Context context, Look look, int sizeDp, UiChrome.Palette p) {
        int px = UiChrome.dp(context, sizeDp);
        if (look != null && look.imageDataUrl != null) {
            return UiChrome.makeAvatarView(context, look.name, look.imageDataUrl, sizeDp, p);
        }
        RokBotAvatarView v = new RokBotAvatarView(context);
        v.setStyleId(RokBotAvatarManager.getStyle(context));
        v.setShapeMask(RokBotAvatarShapes.mask(look != null ? look.shape : null));
        v.setBaseColor(RokBotAvatarShapes.color(look != null ? look.color : null));
        v.setLayoutParams(new LinearLayout.LayoutParams(px, px));
        v.setContentDescription("bot_avatar");
        return v;
    }
}
