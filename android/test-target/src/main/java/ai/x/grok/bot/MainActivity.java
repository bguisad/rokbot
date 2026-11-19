package ai.x.grok.bot;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
    private TextView mInfo;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#0D1117"));
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(64, 140, 64, 80);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("GrokBot Target App (1.16.0)");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        mInfo = new TextView(this);
        mInfo.setTextColor(Color.parseColor("#8B949E"));
        mInfo.setTextSize(13);
        mInfo.setGravity(Gravity.CENTER);
        mInfo.setPadding(0, 20, 0, 32);
        root.addView(mInfo);
        updateIntentText(getIntent());

        // Official RN surface labels hooked by GrokBotBootstrap (6 GBBootstrap surfaces)
        for (String label : new String[] {
                "Connect Host",
                "Profile",
                "Notifications",
                "Library",
                "Bot Computer",
                "Usage",
        }) {
            TextView row = new TextView(this);
            row.setText(label);
            row.setTextColor(Color.WHITE);
            row.setTextSize(15);
            row.setGravity(Gravity.CENTER);
            row.setPadding(40, 26, 40, 26);
            row.setBackgroundColor(Color.parseColor("#161B22"));
            row.setClickable(true);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = 16;
            row.setLayoutParams(lp);
            root.addView(row);
        }

        setContentView(scroll);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        updateIntentText(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateIntentText(getIntent());
    }

    private void updateIntentText(Intent intent) {
        if (mInfo == null) return;
        String uriStr = (intent != null && intent.getDataString() != null) ? intent.getDataString() : "";
        mInfo.setText(
            "Package: " + getPackageName() + "\n" +
            "expo.modules.updates.ENABLED = false\n" +
            "Intent URI: " + uriStr
        );
    }
}
