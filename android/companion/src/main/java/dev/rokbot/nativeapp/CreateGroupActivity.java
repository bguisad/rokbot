package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Native Create Group Chat screen aligned with RokBot Desktop 1.3.0's NewChatBar group compose flow:
 * - Top bar with Back, localized title ("创建群聊" / "New Group Chat"), member count badge, and primary "Create" pill.
 * - "To:" / "收件人：" recipient bar with wrapping removable Member Chips and inline borderless search input.
 * - Elevated candidate picker card (14dp radius, 8dp row radius) showing eligible Bots (excluding groups and
 *   already-selected Bots) plus inline "Add '<name>' as a new Bot" creation.
 * - Auto-generated group name matching Desktop HRn (max 72 chars) and description "" via POST /api/createGroup.
 * - Optional pinned bottom first-message composer ("发消息给 …" / "Message …") that creates the group, sends the
 *   first message via POST /api/sendPrompt, and opens the newly created group chat.
 * - Desktop-aligned error alert banner with draft preservation, rollback of inline created Bots, and Retry action.
 */
public class CreateGroupActivity extends Activity {
    private static final String TITLE_ZH = "创建群聊";
    private static final String TITLE_EN = "New Group Chat";

    private static final int ICON_PLUS = 1;
    private static final int ICON_CLOSE = 2;
    private static final int ICON_ARROW_UP = 3;
    private static final int ICON_ALERT = 4;

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private volatile boolean mDestroyed = false;

    private UiChrome.Palette mPalette;
    private DesktopTokens mTokens;

    // Header controls
    private TextView mCountBadge;
    private TextView mCreateBtn;

    // Recipient "To:" bar
    private FlowChipLayout mChipFlow;
    private EditText mSearchInput;
    private ImageView mSearchActionBtn;

    // Error banner (mirrors Desktop izn)
    private LinearLayout mErrorBanner;
    private TextView mErrorBannerText;
    private TextView mErrorRetryBtn;

    // Candidate picker panel (mirrors Desktop sand-new-chat-menu)
    private LinearLayout mPickerCard;
    private LinearLayout mCandidatesContainer;
    private ProgressBar mProgress;

    // Bottom composer (mirrors Desktop NewChatComposer)
    private EditText mMessageInput;
    private ImageView mSendBtn;

    // State
    private final List<GroupCreateModel.BotCandidate> mEligibleBots = new ArrayList<>();
    private final List<GroupCreateModel.Recipient> mRecipients = new ArrayList<>();
    private String mQuery = "";
    private String mAccountDisplayName = "";
    private boolean mLoadingBots = false;
    private boolean mSubmitting = false;
    private boolean mLastSubmitHadPrompt = false;
    private boolean mHadLoadError = false;

    /** Desktop --sand-* visual tokens adapted for both light and dark modes. */
    private static final class DesktopTokens {
        final int chipBg;
        final int chipCloseHover;
        final int rowHover;
        final int iconBadgeBg;
        final int menuBorder;
        final int errorBg;
        final int errorBorder;
        final int composerBg;

        DesktopTokens(UiChrome.Palette p) {
            if (p.dark) {
                this.chipBg = 0x1AFFFFFF;          // translucent white pill on dark chrome
                this.chipCloseHover = 0x2EFFFFFF;
                this.rowHover = 0x14FFFFFF;        // --sand-bg-hover dark
                this.iconBadgeBg = 0x1AFFFFFF;
                this.menuBorder = 0x24FFFFFF;      // --sand-border-secondary-translucent dark
                this.errorBg = 0x22F87171;
                this.errorBorder = 0x55F87171;
                this.composerBg = p.bgCard;
            } else {
                this.chipBg = 0x0F1C1C1C;          // --sand-bg-secondary (#1c1c1c0f)
                this.chipCloseHover = 0x1A1C1C1C;  // --sand-bg-secondary-hover (#1c1c1c1a)
                this.rowHover = 0x0F1C1C1C;        // --sand-bg-hover (#1c1c1c0f)
                this.iconBadgeBg = 0x0F1C1C1C;     // --sand-bg-secondary (#1c1c1c0f)
                this.menuBorder = 0x1F1C1C1C;      // --sand-border-secondary-translucent (#1c1c1c1f)
                this.errorBg = 0x14DC2626;
                this.errorBorder = 0x40DC2626;
                this.composerBg = 0xFFFFFFFF;      // --sand-bg-elevated (#fff)
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        if (w != null) {
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                    | WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);
        }
        Storage.init(this);
        buildUi();
        loadRosterAndProfile();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        mMain.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        finish();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        mPalette = p;
        mTokens = new DesktopTokens(p);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(p.bgPaper);
        root.setContentDescription("create_group_screen");

        // 1. Top Header Bar
        root.addView(buildHeaderBar(p));

        // 2. Desktop-style "To:" Recipient Bar (sand-new-chat-bar)
        root.addView(buildRecipientBar(p));

        // Hairline divider beneath recipient bar
        root.addView(makeHairline(p.border));

        // 3. Inline Error Banner (hidden by default; mirrors Desktop izn)
        mErrorBanner = buildErrorBanner(p);
        mErrorBanner.setVisibility(View.GONE);
        root.addView(mErrorBanner);

        // 4. Scrollable Candidate Picker Menu (sand-new-chat-menu)
        ScrollView pickerScroll = new ScrollView(this);
        pickerScroll.setFillViewport(true);
        pickerScroll.setClipToPadding(false);
        pickerScroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout scrollBody = new LinearLayout(this);
        scrollBody.setOrientation(LinearLayout.VERTICAL);
        scrollBody.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 12),
                UiChrome.dp(this, 14), UiChrome.dp(this, 14));

        mPickerCard = new LinearLayout(this);
        mPickerCard.setOrientation(LinearLayout.VERTICAL);
        mPickerCard.setContentDescription("create_group_picker_menu");
        mPickerCard.setBackground(UiChrome.roundRect(
                p.bgCard,
                UiChrome.dp(this, 14),
                mTokens.menuBorder,
                Math.max(1, UiChrome.dp(this, 0.8f))));
        mPickerCard.setElevation(UiChrome.dp(this, p.dark ? 0 : 2));
        mPickerCard.setPadding(UiChrome.dp(this, 6), UiChrome.dp(this, 6),
                UiChrome.dp(this, 6), UiChrome.dp(this, 6));

        mProgress = new ProgressBar(this);
        mProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progLp = new LinearLayout.LayoutParams(
                UiChrome.dp(this, 26), UiChrome.dp(this, 26));
        progLp.gravity = Gravity.CENTER_HORIZONTAL;
        progLp.topMargin = UiChrome.dp(this, 16);
        progLp.bottomMargin = UiChrome.dp(this, 16);
        mProgress.setLayoutParams(progLp);
        mPickerCard.addView(mProgress);

        mCandidatesContainer = new LinearLayout(this);
        mCandidatesContainer.setOrientation(LinearLayout.VERTICAL);
        mPickerCard.addView(mCandidatesContainer);

        scrollBody.addView(mPickerCard, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        pickerScroll.addView(scrollBody);
        root.addView(pickerScroll);

        // 5. Pinned Bottom First-Message Composer (mirrors Desktop NewChatComposer)
        root.addView(buildBottomComposer(p));

        rebuildRecipientChips();
        renderCandidates();
        updateActionStates();

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
    }

    private LinearLayout buildHeaderBar(UiChrome.Palette p) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(p.bgPaper);
        bar.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 10),
                UiChrome.dp(this, 14), UiChrome.dp(this, 8));

        View backBtn = UiChrome.makeVectorIconButton(this, "back", "create_group_back_button", p, v -> finish());
        LinearLayout.LayoutParams blp = (LinearLayout.LayoutParams) backBtn.getLayoutParams();
        blp.rightMargin = UiChrome.dp(this, 12);
        backBtn.setLayoutParams(blp);
        bar.addView(backBtn);

        LinearLayout titleWrap = new LinearLayout(this);
        titleWrap.setOrientation(LinearLayout.HORIZONTAL);
        titleWrap.setGravity(Gravity.CENTER_VERTICAL);
        titleWrap.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView titleTv = new TextView(this);
        titleTv.setText(Localize.t(this, TITLE_ZH, TITLE_EN));
        titleTv.setTextColor(p.textPrimary);
        titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        titleTv.setTypeface(Typeface.DEFAULT_BOLD);
        titleTv.setSingleLine(true);
        titleTv.setEllipsize(TextUtils.TruncateAt.END);
        titleWrap.addView(titleTv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        mCountBadge = new TextView(this);
        mCountBadge.setContentDescription("group_selected_count");
        mCountBadge.setTextColor(p.textSecondary);
        mCountBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mCountBadge.setTypeface(Typeface.DEFAULT_BOLD);
        mCountBadge.setPadding(UiChrome.dp(this, 8), UiChrome.dp(this, 2.5f),
                UiChrome.dp(this, 8), UiChrome.dp(this, 2.5f));
        mCountBadge.setBackground(UiChrome.roundRect(mTokens.chipBg, UiChrome.dp(this, 11), 0, 0));
        LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cLp.leftMargin = UiChrome.dp(this, 8);
        mCountBadge.setLayoutParams(cLp);
        mCountBadge.setVisibility(View.GONE);
        titleWrap.addView(mCountBadge);

        bar.addView(titleWrap);

        mCreateBtn = makeHeaderCreateButton(p);
        LinearLayout.LayoutParams crLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        crLp.leftMargin = UiChrome.dp(this, 10);
        bar.addView(mCreateBtn, crLp);

        return bar;
    }

    private TextView makeHeaderCreateButton(UiChrome.Palette p) {
        TextView btn = new TextView(this);
        btn.setContentDescription("create_group_submit_button");
        btn.setText(Localize.t(this, "创建", "Create"));
        btn.setTextColor(p.accentText);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setGravity(Gravity.CENTER);
        btn.setSingleLine(true);
        btn.setMinimumHeight(UiChrome.dp(this, 36));
        btn.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 8),
                UiChrome.dp(this, 16), UiChrome.dp(this, 8));
        GradientDrawable fill = UiChrome.roundRect(p.accent, UiChrome.dp(this, 18), 0, 0);
        GradientDrawable mask = UiChrome.roundRect(0xFFFFFFFF, UiChrome.dp(this, 18), 0, 0);
        int ripple = (p.accentText & 0x00FFFFFF) | 0x26000000;
        btn.setBackground(new RippleDrawable(ColorStateList.valueOf(ripple), fill, mask));
        btn.setOnClickListener(v -> {
            String draft = mMessageInput != null && mMessageInput.getText() != null
                    ? mMessageInput.getText().toString().trim() : "";
            submitCreateGroup(!draft.isEmpty());
        });
        return btn;
    }

    private LinearLayout buildRecipientBar(UiChrome.Palette p) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.TOP);
        bar.setBackgroundColor(p.bgPaper);
        bar.setContentDescription("create_group_to_bar");
        bar.setMinimumHeight(UiChrome.dp(this, 50));
        bar.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 9),
                UiChrome.dp(this, 12), UiChrome.dp(this, 9));

        // Desktop "To:" / "收件人：" label (--sand-text-tertiary, body1)
        TextView toLabel = new TextView(this);
        toLabel.setContentDescription("create_group_to_label");
        toLabel.setText(Localize.t(this, "收件人：", "To:"));
        toLabel.setTextColor(p.textMuted);
        toLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        toLabel.setPadding(0, UiChrome.dp(this, 5), UiChrome.dp(this, 6), 0);
        bar.addView(toLabel, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // Wrapping chip flow + inline search input, bounded in height so keyboard never crowds list
        MaxHeightScrollView chipScroll = new MaxHeightScrollView(this, UiChrome.dp(this, 124));
        chipScroll.setVerticalScrollBarEnabled(false);
        chipScroll.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        mChipFlow = new FlowChipLayout(this, UiChrome.dp(this, 6), UiChrome.dp(this, 6));

        mSearchInput = new EditText(this);
        mSearchInput.setContentDescription("group_recipient_search_input");
        mSearchInput.setBackground(null);
        mSearchInput.setTextColor(p.textPrimary);
        mSearchInput.setHintTextColor(p.textMuted);
        mSearchInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        mSearchInput.setSingleLine(true);
        mSearchInput.setMinWidth(UiChrome.dp(this, 140));
        mSearchInput.setMinHeight(UiChrome.dp(this, 30));
        mSearchInput.setPadding(UiChrome.dp(this, 2), UiChrome.dp(this, 4),
                UiChrome.dp(this, 4), UiChrome.dp(this, 4));
        mSearchInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        mSearchInput.setImeOptions(EditorInfo.IME_ACTION_DONE);

        mSearchInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                mQuery = s != null ? s.toString() : "";
                updateSearchActionIcon();
                renderCandidates();
            }
        });

        // Desktop Backspace on empty search removes the last selected chip
        mSearchInput.setOnKeyListener((v, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_DEL
                    && event.getAction() == KeyEvent.ACTION_DOWN
                    && mQuery.isEmpty()
                    && !mRecipients.isEmpty()
                    && !mSubmitting) {
                removeRecipientAt(mRecipients.size() - 1);
                return true;
            }
            return false;
        });

        mSearchInput.setOnEditorActionListener((v, actionId, event) -> {
            boolean isEnter = actionId == EditorInfo.IME_ACTION_DONE
                    || actionId == EditorInfo.IME_ACTION_SEARCH
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN);
            if (!isEnter || mSubmitting) return false;
            handleSearchEnter();
            return true;
        });

        chipScroll.addView(mChipFlow, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(chipScroll);

        // Trailing action: clear query when text present, else reload Bots
        int actionSize = UiChrome.dp(this, 28);
        mSearchActionBtn = new ImageView(this);
        mSearchActionBtn.setScaleType(ImageView.ScaleType.CENTER);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(actionSize, actionSize);
        alp.leftMargin = UiChrome.dp(this, 6);
        alp.topMargin = UiChrome.dp(this, 2);
        mSearchActionBtn.setLayoutParams(alp);
        mSearchActionBtn.setOnClickListener(v -> {
            if (!mQuery.isEmpty()) {
                mSearchInput.setText("");
            } else if (!mLoadingBots && !mSubmitting) {
                loadRosterAndProfile();
            }
        });
        updateSearchActionIcon();
        bar.addView(mSearchActionBtn);

        return bar;
    }

    private void updateSearchActionIcon() {
        if (mSearchActionBtn == null || mPalette == null) return;
        boolean hasQuery = !mQuery.isEmpty();
        if (hasQuery) {
            mSearchActionBtn.setContentDescription("clear_recipient_search_button");
            mSearchActionBtn.setBackground(UiChrome.circle(mTokens.iconBadgeBg, 0, 0));
            mSearchActionBtn.setImageDrawable(new VectorGlyphDrawable(
                    ICON_CLOSE, mPalette.textSecondary, UiChrome.dp(this, 14), UiChrome.dp(this, 1.7f)));
            mSearchActionBtn.setVisibility(View.VISIBLE);
        } else {
            mSearchActionBtn.setContentDescription("refresh_group_bots_button");
            mSearchActionBtn.setBackground(UiChrome.circle(Color.TRANSPARENT, 0, 0));
            mSearchActionBtn.setImageDrawable(makeMiniRefreshDrawable(mPalette.textMuted));
            mSearchActionBtn.setVisibility(View.VISIBLE);
        }
    }

    private Drawable makeMiniRefreshDrawable(final int color) {
        final int sz = UiChrome.dp(this, 16);
        final float sw = Math.max(1.5f, UiChrome.dp(this, 1.6f));
        return new Drawable() {
            @Override
            public void draw(Canvas canvas) {
                android.graphics.Rect b = getBounds();
                float cx = b.exactCenterX();
                float cy = b.exactCenterY();
                float r = Math.min(b.width(), b.height()) * 0.36f;
                Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                paint.setColor(color);
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(sw);
                paint.setStrokeCap(Paint.Cap.ROUND);
                paint.setStrokeJoin(Paint.Join.ROUND);
                RectF arc = new RectF(cx - r, cy - r, cx + r, cy + r);
                canvas.drawArc(arc, -40f, 285f, false, paint);
                float ax = (float) (cx + r * Math.cos(Math.toRadians(-40)));
                float ay = (float) (cy + r * Math.sin(Math.toRadians(-40)));
                Path arrow = new Path();
                arrow.moveTo(ax - r * 0.48f, ay - r * 0.1f);
                arrow.lineTo(ax, ay + r * 0.08f);
                arrow.lineTo(ax + r * 0.12f, ay - r * 0.45f);
                canvas.drawPath(arrow, paint);
            }
            @Override public void setAlpha(int alpha) {}
            @Override public void setColorFilter(ColorFilter cf) {}
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
            @Override public int getIntrinsicWidth() { return sz; }
            @Override public int getIntrinsicHeight() { return sz; }
        };
    }

    private LinearLayout buildErrorBanner(UiChrome.Palette p) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setContentDescription("create_group_error_banner");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = UiChrome.dp(this, 14);
        lp.rightMargin = UiChrome.dp(this, 14);
        lp.topMargin = UiChrome.dp(this, 10);
        wrap.setLayoutParams(lp);
        wrap.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 12),
                UiChrome.dp(this, 14), UiChrome.dp(this, 12));
        wrap.setBackground(UiChrome.roundRect(
                mTokens.errorBg, UiChrome.dp(this, 12), mTokens.errorBorder, Math.max(1, UiChrome.dp(this, 0.8f))));

        LinearLayout msgRow = new LinearLayout(this);
        msgRow.setOrientation(LinearLayout.HORIZONTAL);
        msgRow.setGravity(Gravity.TOP);

        ImageView alertIcon = new ImageView(this);
        int iconSz = UiChrome.dp(this, 18);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(iconSz, iconSz);
        ilp.rightMargin = UiChrome.dp(this, 8);
        ilp.topMargin = UiChrome.dp(this, 1);
        alertIcon.setLayoutParams(ilp);
        alertIcon.setImageDrawable(new VectorGlyphDrawable(
                ICON_ALERT, p.danger, iconSz, UiChrome.dp(this, 1.7f)));
        msgRow.addView(alertIcon);

        mErrorBannerText = new TextView(this);
        mErrorBannerText.setTextColor(p.textPrimary);
        mErrorBannerText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        mErrorBannerText.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        msgRow.addView(mErrorBannerText);
        wrap.addView(msgRow);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        LinearLayout.LayoutParams actLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actLp.topMargin = UiChrome.dp(this, 10);
        actions.setLayoutParams(actLp);

        TextView backAction = makeBannerPill(
                Localize.t(this, "返回聊天", "Back to chats"), false, p, v -> finish());
        actions.addView(backAction);

        mErrorRetryBtn = makeBannerPill(
                Localize.t(this, "重试创建群组", "Retry group creation"), true, p, v -> {
                    if (mHadLoadError) {
                        loadRosterAndProfile();
                    } else {
                        submitCreateGroup(mLastSubmitHadPrompt);
                    }
                });
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.leftMargin = UiChrome.dp(this, 8);
        actions.addView(mErrorRetryBtn, rlp);

        wrap.addView(actions);
        return wrap;
    }

    private TextView makeBannerPill(String label, boolean primary, UiChrome.Palette p, View.OnClickListener onClick) {
        TextView btn = new TextView(this);
        btn.setText(label);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setTextColor(primary ? p.accentText : p.textPrimary);
        btn.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 6),
                UiChrome.dp(this, 12), UiChrome.dp(this, 6));
        btn.setBackground(UiChrome.roundRect(
                primary ? p.accent : p.bgCard,
                UiChrome.dp(this, 14),
                primary ? 0 : p.border,
                primary ? 0 : Math.max(1, UiChrome.dp(this, 0.8f))));
        btn.setOnClickListener(onClick);
        return btn;
    }

    private LinearLayout buildBottomComposer(UiChrome.Palette p) {
        LinearLayout dock = new LinearLayout(this);
        dock.setOrientation(LinearLayout.VERTICAL);
        dock.setBackgroundColor(p.bgPaper);
        dock.setContentDescription("create_group_composer_dock");

        dock.addView(makeHairline(p.border));

        LinearLayout inner = new LinearLayout(this);
        inner.setOrientation(LinearLayout.HORIZONTAL);
        inner.setGravity(Gravity.BOTTOM);
        inner.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 10),
                UiChrome.dp(this, 14), UiChrome.dp(this, 12));

        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.BOTTOM);
        pill.setMinimumHeight(UiChrome.dp(this, 48));
        pill.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 6),
                UiChrome.dp(this, 6), UiChrome.dp(this, 6));
        pill.setBackground(UiChrome.roundRect(
                mTokens.composerBg, UiChrome.dp(this, 24), mTokens.menuBorder, Math.max(1, UiChrome.dp(this, 1))));

        mMessageInput = new EditText(this);
        mMessageInput.setContentDescription("group_first_message_input");
        mMessageInput.setBackground(null);
        mMessageInput.setTextColor(p.textPrimary);
        mMessageInput.setHintTextColor(p.textMuted);
        mMessageInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        mMessageInput.setMinLines(1);
        mMessageInput.setMaxLines(4);
        mMessageInput.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        mMessageInput.setPadding(UiChrome.dp(this, 2), UiChrome.dp(this, 6),
                UiChrome.dp(this, 8), UiChrome.dp(this, 6));
        mMessageInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        mMessageInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                updateActionStates();
            }
        });
        pill.addView(mMessageInput, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        int sendSz = UiChrome.dp(this, 36);
        mSendBtn = new ImageView(this);
        mSendBtn.setContentDescription("create_group_send_button");
        mSendBtn.setScaleType(ImageView.ScaleType.CENTER);
        mSendBtn.setLayoutParams(new LinearLayout.LayoutParams(sendSz, sendSz));
        GradientDrawable sendBg = UiChrome.circle(p.accent, 0, 0);
        GradientDrawable sendMask = UiChrome.circle(0xFFFFFFFF, 0, 0);
        int sendRipple = (p.accentText & 0x00FFFFFF) | 0x26000000;
        mSendBtn.setBackground(new RippleDrawable(ColorStateList.valueOf(sendRipple), sendBg, sendMask));
        mSendBtn.setImageDrawable(new VectorGlyphDrawable(
                ICON_ARROW_UP, p.accentText, UiChrome.dp(this, 18), UiChrome.dp(this, 2.0f)));
        mSendBtn.setOnClickListener(v -> submitCreateGroup(true));
        pill.addView(mSendBtn);

        inner.addView(pill, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dock.addView(inner);
        return dock;
    }

    private View makeHairline(int color) {
        View line = new View(this);
        line.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.7f))));
        line.setBackgroundColor(color);
        return line;
    }

    private void loadRosterAndProfile() {
        mLoadingBots = true;
        mHadLoadError = false;
        mProgress.setVisibility(View.VISIBLE);
        hideErrorBanner();
        new Thread(() -> {
            String fetchedDisplayName = "";
            try {
                JSONObject profile = HostApiClient.getProfile(this);
                if (profile != null) {
                    fetchedDisplayName = UiChrome.jsonStr(profile, "displayName").trim();
                }
            } catch (Throwable ignored) {}

            try {
                JSONArray all = HostApiClient.listAgents(this);
                RokBotAvatars.remember(this, all);
                List<GroupCreateModel.BotCandidate> rawList = new ArrayList<>();
                if (all != null) {
                    for (int i = 0; i < all.length(); i++) {
                        JSONObject a = all.optJSONObject(i);
                        if (a == null) continue;
                        rawList.add(new GroupCreateModel.BotCandidate(
                                UiChrome.jsonStr(a, "id"),
                                UiChrome.jsonStr(a, "name"),
                                UiChrome.jsonStr(a, "title"),
                                UiChrome.jsonStr(a, "description"),
                                UiChrome.jsonStr(a, "avatarShape"),
                                UiChrome.jsonStr(a, "avatarColor"),
                                UiChrome.jsonStr(a, "avatarDataUrl"),
                                a.optBoolean("isGroup", false),
                                a.optBoolean("isHiddenFromSidebar", false)));
                    }
                }
                final List<GroupCreateModel.BotCandidate> eligible = GroupCreateModel.filterEligibleBots(rawList);
                final String finalDisplayName = fetchedDisplayName;
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mLoadingBots = false;
                    mProgress.setVisibility(View.GONE);
                    mAccountDisplayName = finalDisplayName;
                    mEligibleBots.clear();
                    mEligibleBots.addAll(eligible);
                    pruneMissingExistingRecipients();
                    rebuildRecipientChips();
                    renderCandidates();
                    updateActionStates();
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mLoadingBots = false;
                    mHadLoadError = true;
                    mProgress.setVisibility(View.GONE);
                    String detail = t.getMessage() != null ? t.getMessage() : "";
                    showErrorBanner(
                            Localize.t(this, "加载 Bot 列表失败：", "Failed to load Bots: ") + detail,
                            true);
                    renderCandidates();
                });
            }
        }, "CreateGroupLoadRoster").start();
    }

    private void pruneMissingExistingRecipients() {
        List<GroupCreateModel.Recipient> kept = new ArrayList<>();
        for (GroupCreateModel.Recipient r : mRecipients) {
            if (r.isNewBot) {
                kept.add(r);
            } else {
                for (GroupCreateModel.BotCandidate b : mEligibleBots) {
                    if (b.id.equals(r.id)) {
                        kept.add(GroupCreateModel.Recipient.fromBot(b));
                        break;
                    }
                }
            }
        }
        mRecipients.clear();
        mRecipients.addAll(kept);
    }

    private void addRecipient(GroupCreateModel.Recipient recipient) {
        if (mSubmitting) return;
        if (GroupCreateModel.isAtBotLimit(mRecipients)) {
            Toast.makeText(this,
                    Localize.t(this, "群聊最多可添加 6 个 Bot", "Group chats support up to 6 Bots"),
                    Toast.LENGTH_SHORT).show();
            return;
        }
        if (!GroupCreateModel.canAddRecipient(mRecipients, recipient)) return;

        mRecipients.add(recipient);
        hideErrorBanner();
        if (!mQuery.isEmpty()) {
            mSearchInput.setText("");
        } else {
            renderCandidates();
        }
        rebuildRecipientChips();
        updateActionStates();
    }

    private void removeRecipientAt(int index) {
        if (mSubmitting || index < 0 || index >= mRecipients.size()) return;
        mRecipients.remove(index);
        rebuildRecipientChips();
        renderCandidates();
        updateActionStates();
    }

    private void handleSearchEnter() {
        String trimmed = mQuery.trim();
        if (!trimmed.isEmpty()) {
            List<GroupCreateModel.BotCandidate> filtered =
                    GroupCreateModel.filterCandidates(mEligibleBots, mRecipients, mQuery);
            if (!filtered.isEmpty() && !GroupCreateModel.isAtBotLimit(mRecipients)) {
                addRecipient(GroupCreateModel.Recipient.fromBot(filtered.get(0)));
                return;
            }
            if (GroupCreateModel.canOfferCreateNewBot(mEligibleBots, mRecipients, mQuery)) {
                addRecipient(GroupCreateModel.Recipient.newBot(trimmed));
                return;
            }
        } else if (!mRecipients.isEmpty()) {
            // Mirror Desktop Enter on empty query with selected recipients: focus composer or create
            if (mMessageInput != null) {
                mMessageInput.requestFocus();
            }
        }
    }

    private void rebuildRecipientChips() {
        UiChrome.Palette p = mPalette != null ? mPalette : UiChrome.palette(this);
        boolean hadSearchFocus = mSearchInput != null && mSearchInput.hasFocus();
        mChipFlow.removeAllViews();

        for (int i = 0; i < mRecipients.size(); i++) {
            final int idx = i;
            GroupCreateModel.Recipient r = mRecipients.get(i);
            mChipFlow.addView(makeMemberChip(r, idx, p));
        }

        // Update search input hint based on selection count
        if (GroupCreateModel.isAtBotLimit(mRecipients)) {
            mSearchInput.setHint(Localize.t(this, "已达人数上限（6）", "Maximum 6 Bots reached"));
        } else if (mRecipients.isEmpty()) {
            mSearchInput.setHint(Localize.t(this, "搜索 Bot 或输入新 Bot 名称…", "Start a chat with…"));
        } else {
            mSearchInput.setHint(Localize.t(this, "继续添加 Bot…", "Add another Bot…"));
        }
        mChipFlow.addView(mSearchInput);
        if (hadSearchFocus) {
            mSearchInput.requestFocus();
        }
    }

    /** Desktop sand-member-chip / sand-new-chat-chip: pill with avatar + name + × remove button. */
    private View makeMemberChip(GroupCreateModel.Recipient recipient, int index, UiChrome.Palette p) {
        LinearLayout chip = new LinearLayout(this);
        chip.setOrientation(LinearLayout.HORIZONTAL);
        chip.setGravity(Gravity.CENTER_VERTICAL);
        chip.setContentDescription("group_chip_" + recipient.key());
        chip.setMinimumHeight(UiChrome.dp(this, 30));
        chip.setPadding(UiChrome.dp(this, 6), UiChrome.dp(this, 3),
                UiChrome.dp(this, 4), UiChrome.dp(this, 3));
        chip.setBackground(UiChrome.roundRect(mTokens.chipBg, UiChrome.dp(this, 999), 0, 0));

        // Leading 20dp avatar (real RokBot avatar for existing Bot, circular "+" badge for new Bot)
        View avatarView;
        if (recipient.isNewBot) {
            int sz = UiChrome.dp(this, 20);
            ImageView plusBadge = new ImageView(this);
            plusBadge.setScaleType(ImageView.ScaleType.CENTER);
            plusBadge.setBackground(UiChrome.circle(mTokens.iconBadgeBg, 0, 0));
            plusBadge.setImageDrawable(new VectorGlyphDrawable(
                    ICON_PLUS, p.textSecondary, UiChrome.dp(this, 12), UiChrome.dp(this, 1.6f)));
            plusBadge.setLayoutParams(new LinearLayout.LayoutParams(sz, sz));
            avatarView = plusBadge;
        } else {
            RokBotAvatars.Look look = new RokBotAvatars.Look(
                    recipient.avatarShape,
                    recipient.avatarColor,
                    recipient.avatarDataUrl.startsWith("data:image") ? recipient.avatarDataUrl : null,
                    recipient.name);
            avatarView = RokBotAvatars.makeView(this, look, 20, p);
        }
        LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(
                UiChrome.dp(this, 20), UiChrome.dp(this, 20));
        avLp.rightMargin = UiChrome.dp(this, 5);
        chip.addView(avatarView, avLp);

        TextView nameTv = new TextView(this);
        nameTv.setText(recipient.name);
        nameTv.setTextColor(p.textPrimary);
        nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        nameTv.setSingleLine(true);
        nameTv.setEllipsize(TextUtils.TruncateAt.END);
        nameTv.setMaxWidth(UiChrome.dp(this, 180));
        chip.addView(nameTv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // Trailing × remove button
        int closeSz = UiChrome.dp(this, 20);
        ImageView closeBtn = new ImageView(this);
        closeBtn.setContentDescription(Localize.t(this, "移除 ", "Remove ") + recipient.name);
        closeBtn.setScaleType(ImageView.ScaleType.CENTER);
        GradientDrawable mask = UiChrome.circle(0xFFFFFFFF, 0, 0);
        closeBtn.setBackground(new RippleDrawable(
                ColorStateList.valueOf(mTokens.chipCloseHover), null, mask));
        closeBtn.setImageDrawable(new VectorGlyphDrawable(
                ICON_CLOSE, p.textSecondary, UiChrome.dp(this, 11), UiChrome.dp(this, 1.7f)));
        LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(closeSz, closeSz);
        cLp.leftMargin = UiChrome.dp(this, 3);
        closeBtn.setLayoutParams(cLp);
        closeBtn.setOnClickListener(v -> removeRecipientAt(index));
        chip.addView(closeBtn);

        return chip;
    }

    private void renderCandidates() {
        UiChrome.Palette p = mPalette != null ? mPalette : UiChrome.palette(this);
        mCandidatesContainer.removeAllViews();
        if (mLoadingBots) return;

        boolean atLimit = GroupCreateModel.isAtBotLimit(mRecipients);
        boolean offerNewBot = GroupCreateModel.canOfferCreateNewBot(mEligibleBots, mRecipients, mQuery);
        List<GroupCreateModel.BotCandidate> filtered =
                GroupCreateModel.filterCandidates(mEligibleBots, mRecipients, mQuery);

        int rowCount = 0;

        // Top capacity note when 6 Bots are already selected
        if (atLimit) {
            TextView note = new TextView(this);
            note.setContentDescription("group_capacity_note");
            note.setText(Localize.t(this,
                    "已达上限：每个群聊最多选择 6 个 Bot，点击上方标签可移除。",
                    "Limit reached: up to 6 Bots per group chat. Tap a chip above to remove."));
            note.setTextColor(p.textMuted);
            note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            note.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 8),
                    UiChrome.dp(this, 10), UiChrome.dp(this, 6));
            mCandidatesContainer.addView(note);
        }

        // Desktop ykS238: "Add '<query>' as a new Bot" row when query doesn't exact-match existing/selected Bots
        if (offerNewBot) {
            final String newName = mQuery.trim();
            mCandidatesContainer.addView(makeNewBotOptionRow(newName, p));
            rowCount++;
        }

        // Existing Bot candidate rows (Desktop sand-new-chat-row)
        for (int i = 0; i < filtered.size(); i++) {
            GroupCreateModel.BotCandidate bot = filtered.get(i);
            View row = makeBotCandidateRow(bot, atLimit, p);
            if (rowCount > 0) {
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.topMargin = UiChrome.dp(this, 2);
                row.setLayoutParams(rlp);
            }
            mCandidatesContainer.addView(row);
            rowCount++;
        }

        // Empty state copy matching Desktop (r32WRY / 12i8o8)
        if (rowCount == 0) {
            TextView empty = new TextView(this);
            empty.setContentDescription("create_group_empty_state");
            empty.setGravity(Gravity.CENTER);
            empty.setTextColor(p.textMuted);
            empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
            empty.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 20),
                    UiChrome.dp(this, 16), UiChrome.dp(this, 20));
            if (mEligibleBots.isEmpty() && mQuery.trim().isEmpty()) {
                empty.setText(Localize.t(this,
                        "输入名字以创建 Bot",
                        "Type a name to create a Bot"));
            } else if (!mQuery.trim().isEmpty()) {
                empty.setText(Localize.t(this,
                        "没有匹配的 Bot",
                        "No matching Bots"));
            } else {
                empty.setText(Localize.t(this,
                        "所有现有 Bot 均已加入，输入名称可新建 Bot 或直接开始聊天",
                        "All existing Bots added. Type a name to add a new Bot or start chatting."));
            }
            mCandidatesContainer.addView(empty);
        }
    }

    /** Desktop ykS238 row: circular "+" icon badge + "将“X”添加为新 Bot" / "Add “X” as a new Bot". */
    private View makeNewBotOptionRow(final String botName, UiChrome.Palette p) {
        LinearLayout row = createMenuRowContainer("group_add_new_bot_option", false, p);

        int badgeSz = UiChrome.dp(this, 32);
        ImageView iconCircle = new ImageView(this);
        iconCircle.setScaleType(ImageView.ScaleType.CENTER);
        iconCircle.setBackground(UiChrome.circle(mTokens.iconBadgeBg, 0, 0));
        iconCircle.setImageDrawable(new VectorGlyphDrawable(
                ICON_PLUS, p.textSecondary, UiChrome.dp(this, 16), UiChrome.dp(this, 1.8f)));
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(badgeSz, badgeSz);
        ilp.rightMargin = UiChrome.dp(this, 10);
        row.addView(iconCircle, ilp);

        TextView labelTv = new TextView(this);
        labelTv.setText(Localize.t(this,
                "将“" + botName + "”添加为新 Bot",
                "Add \u201C" + botName + "\u201D as a new Bot"));
        labelTv.setTextColor(p.textPrimary);
        labelTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        labelTv.setSingleLine(true);
        labelTv.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(labelTv, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView hintTv = new TextView(this);
        hintTv.setText(Localize.t(this, "添加到群聊", "Add to group chat"));
        hintTv.setTextColor(p.textMuted);
        hintTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hintTv.setSingleLine(true);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.leftMargin = UiChrome.dp(this, 8);
        row.addView(hintTv, hlp);

        row.setOnClickListener(v -> addRecipient(GroupCreateModel.Recipient.newBot(botName)));
        return row;
    }

    /** Desktop sand-new-chat-row: 32dp real Bot avatar + name (+ optional 1-line subtitle) + subtle Add cue. */
    private View makeBotCandidateRow(final GroupCreateModel.BotCandidate bot, boolean dimmed, UiChrome.Palette p) {
        LinearLayout row = createMenuRowContainer("group_member_" + bot.id, dimmed, p);

        RokBotAvatars.Look look = new RokBotAvatars.Look(
                bot.avatarShape,
                bot.avatarColor,
                bot.avatarDataUrl.startsWith("data:image") ? bot.avatarDataUrl : null,
                bot.name);
        View avatarView = RokBotAvatars.makeView(this, look, 32, p);
        LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(
                UiChrome.dp(this, 32), UiChrome.dp(this, 32));
        avLp.rightMargin = UiChrome.dp(this, 10);
        row.addView(avatarView, avLp);

        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);
        textCol.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView nameTv = new TextView(this);
        nameTv.setText(bot.name);
        nameTv.setTextColor(p.textPrimary);
        nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        nameTv.setTypeface(Typeface.DEFAULT_BOLD);
        nameTv.setSingleLine(true);
        nameTv.setEllipsize(TextUtils.TruncateAt.END);
        textCol.addView(nameTv);

        String subtitle = bot.displaySubtitle();
        if (!subtitle.isEmpty()) {
            TextView subTv = new TextView(this);
            subTv.setText(subtitle);
            subTv.setTextColor(p.textSecondary);
            subTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            subTv.setSingleLine(true);
            subTv.setEllipsize(TextUtils.TruncateAt.END);
            subTv.setPadding(0, UiChrome.dp(this, 1.5f), 0, 0);
            textCol.addView(subTv);
        }
        row.addView(textCol);

        // Subtle trailing "添加到群聊" / "Add" label + crisp "+" icon
        if (!dimmed) {
            TextView addHint = new TextView(this);
            addHint.setText(Localize.t(this, "添加到群聊", "Add"));
            addHint.setTextColor(p.textMuted);
            addHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            addHint.setSingleLine(true);
            LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            hlp.leftMargin = UiChrome.dp(this, 8);
            row.addView(addHint, hlp);
        }

        if (dimmed) {
            row.setAlpha(0.45f);
            row.setEnabled(false);
        } else {
            row.setOnClickListener(v -> addRecipient(GroupCreateModel.Recipient.fromBot(bot)));
        }
        return row;
    }

    private LinearLayout createMenuRowContainer(String contentDesc, boolean disabled, UiChrome.Palette p) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setContentDescription(contentDesc);
        row.setMinimumHeight(UiChrome.dp(this, 48));
        row.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 8),
                UiChrome.dp(this, 10), UiChrome.dp(this, 8));
        row.setClickable(!disabled);
        row.setFocusable(!disabled);
        if (!disabled) {
            GradientDrawable mask = UiChrome.roundRect(0xFFFFFFFF, UiChrome.dp(this, 8), 0, 0);
            row.setBackground(new RippleDrawable(
                    ColorStateList.valueOf(mTokens.rowHover), null, mask));
        }
        return row;
    }

    private void updateActionStates() {
        boolean zh = Localize.isChinese(this);
        int count = mRecipients.size();
        boolean canCreate = GroupCreateModel.canSubmitGroup(mRecipients, mSubmitting);
        String msgText = mMessageInput != null && mMessageInput.getText() != null
                ? mMessageInput.getText().toString() : "";
        boolean canSend = GroupCreateModel.canSendFirstMessage(mRecipients, msgText, mSubmitting);

        if (mCountBadge != null) {
            if (count > 0) {
                mCountBadge.setText(count + "/" + GroupCreateModel.MAX_GROUP_BOTS);
                mCountBadge.setVisibility(View.VISIBLE);
            } else {
                mCountBadge.setVisibility(View.GONE);
            }
        }

        if (mCreateBtn != null) {
            mCreateBtn.setText(mSubmitting
                    ? Localize.t(this, "创建中…", "Creating…")
                    : Localize.t(this, "创建", "Create"));
            mCreateBtn.setEnabled(canCreate);
            mCreateBtn.setAlpha(canCreate ? 1f : 0.38f);
        }

        if (mMessageInput != null) {
            if (count == 0) {
                mMessageInput.setHint(Localize.t(this, "发消息给 Bot", "Message Bot"));
            } else {
                String names = GroupCreateModel.formatComposerNames(mRecipients, zh);
                mMessageInput.setHint(Localize.t(this, "发消息给 " + names, "Message " + names));
            }
            mMessageInput.setEnabled(!mSubmitting);
        }

        if (mSearchInput != null) {
            mSearchInput.setEnabled(!mSubmitting);
        }

        if (mSendBtn != null) {
            mSendBtn.setEnabled(canSend);
            mSendBtn.setAlpha(canSend ? 1f : 0.30f);
        }
    }

    private void showErrorBanner(String message, boolean allowRetry) {
        if (mErrorBanner == null) return;
        mErrorBannerText.setText(message);
        mErrorRetryBtn.setVisibility(allowRetry ? View.VISIBLE : View.GONE);
        mErrorBanner.setVisibility(View.VISIBLE);
    }

    private void hideErrorBanner() {
        if (mErrorBanner != null) {
            mErrorBanner.setVisibility(View.GONE);
        }
    }

    private void submitCreateGroup(final boolean sendPrompt) {
        if (!GroupCreateModel.canSubmitGroup(mRecipients, mSubmitting)) {
            if (mRecipients.isEmpty()) {
                Toast.makeText(this,
                        Localize.t(this, "请至少选择一个成员 Bot", "Select at least one member Bot"),
                        Toast.LENGTH_SHORT).show();
            }
            return;
        }
        final String firstMessage = mMessageInput != null && mMessageInput.getText() != null
                ? mMessageInput.getText().toString().trim() : "";
        if (sendPrompt && firstMessage.isEmpty()) {
            return;
        }

        final boolean zh = Localize.isChinese(this);
        final List<GroupCreateModel.Recipient> snapshot = new ArrayList<>(mRecipients);
        final String groupName = GroupCreateModel.buildAutoGroupName(snapshot, mAccountDisplayName, zh);

        mSubmitting = true;
        mHadLoadError = false;
        mLastSubmitHadPrompt = sendPrompt;
        hideErrorBanner();
        updateActionStates();

        new Thread(() -> {
            List<String> memberAgentIds = new ArrayList<>();
            List<String> newlyCreatedBotIds = new ArrayList<>();
            try {
                // Step 1: Create any inline new Bots first (matches Desktop tzn)
                for (GroupCreateModel.Recipient r : snapshot) {
                    if (mDestroyed) {
                        rollbackCreatedBots(newlyCreatedBotIds);
                        return;
                    }
                    if (r.isNewBot) {
                        JSONObject created = HostApiClient.createAgent(this, r.name, "", "");
                        JSONObject createdAgent = created != null ? created.optJSONObject("agent") : null;
                        String createdId = createdAgent != null
                                ? UiChrome.jsonStr(createdAgent, "id")
                                : UiChrome.jsonStr(created, "id");
                        if (createdId.isEmpty()) {
                            throw new IllegalStateException("Host did not return id for new Bot " + r.name);
                        }
                        memberAgentIds.add(createdId);
                        newlyCreatedBotIds.add(createdId);
                    } else {
                        memberAgentIds.add(r.id);
                    }
                }

                if (mDestroyed) {
                    rollbackCreatedBots(newlyCreatedBotIds);
                    return;
                }

                // Step 2: Create the group with Desktop-identical payload { name, description: "", memberAgentIds }
                JSONObject res = HostApiClient.createGroup(this, groupName, "", memberAgentIds);
                JSONObject agent = res != null ? res.optJSONObject("agent") : null;
                final String newGroupId = agent != null
                        ? UiChrome.jsonStr(agent, "id")
                        : UiChrome.jsonStr(res, "id");

                // Step 3: Optionally send the first message (matches Desktop intent === 'send')
                if (sendPrompt && !firstMessage.isEmpty() && !newGroupId.isEmpty()) {
                    try {
                        HostApiClient.sendPrompt(this, newGroupId, null, firstMessage, null, null);
                    } catch (Throwable ignored) {
                        // Group already exists; still navigate into it so user can resend if needed
                    }
                }

                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mSubmitting = false;
                    Toast.makeText(this,
                            Localize.t(this, "群聊已创建", "Group chat created"),
                            Toast.LENGTH_SHORT).show();
                    final Context appCtx = getApplicationContext();
                    finish();
                    if (!newGroupId.isEmpty()) {
                        new Handler(Looper.getMainLooper()).postDelayed(() ->
                                RokBotBootstrap.openAgentFromDeepLink(
                                        appCtx, Uri.parse("rokbot-local://agent/" + newGroupId)), 450L);
                    }
                });
            } catch (Throwable t) {
                boolean cleanupFailed = !rollbackCreatedBots(newlyCreatedBotIds);
                if (mDestroyed) return;
                final String detail = t.getMessage() != null ? t.getMessage().trim() : "";
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mSubmitting = false;
                    updateActionStates();
                    String baseMsg;
                    if (cleanupFailed) {
                        baseMsg = Localize.t(this,
                                "无法创建群组，且部分新 Bot 无法移除。你的草稿已保存。请先检查聊天，再创建其他群组。",
                                "The group could not be created, and some new Bots could not be removed. Your draft is saved. Check your chats before creating another group.");
                    } else {
                        baseMsg = Localize.t(this,
                                "无法创建群组。你的草稿和收件人已保存。请检查收件人后重试。",
                                "The group could not be created. Your draft and recipients are saved. Review the recipients and try again.");
                    }
                    String fullMsg = detail.isEmpty() ? baseMsg : (baseMsg + "\n" + detail);
                    showErrorBanner(fullMsg, !cleanupFailed);
                });
            }
        }, "CreateGroupSubmit").start();
    }

    /** Cleans up inline newly created Bots if createGroup fails (mirrors Desktop tzn rollback). */
    private boolean rollbackCreatedBots(List<String> createdIds) {
        if (createdIds == null || createdIds.isEmpty()) return true;
        try {
            JSONObject del = HostApiClient.deleteAgents(this, createdIds);
            JSONArray refused = del != null ? del.optJSONArray("refusedAgentIds") : null;
            JSONArray failed = del != null ? del.optJSONArray("failedAgentIds") : null;
            int stuck = (refused != null ? refused.length() : 0) + (failed != null ? failed.length() : 0);
            return stuck == 0;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** ScrollView capped at maxHeightPx so wrapping chips never crowd out the candidate list when IME is open. */
    private static final class MaxHeightScrollView extends ScrollView {
        private final int mMaxHeightPx;

        MaxHeightScrollView(Context context, int maxHeightPx) {
            super(context);
            mMaxHeightPx = maxHeightPx;
        }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            int capped = MeasureSpec.makeMeasureSpec(mMaxHeightPx, MeasureSpec.AT_MOST);
            super.onMeasure(widthMeasureSpec, capped);
        }
    }

    /**
     * Wrapping horizontal flow layout for Member Chips + trailing inline search input,
     * mirroring Desktop sand-new-chat-bar's flex-wrap container.
     */
    private static final class FlowChipLayout extends ViewGroup {
        private final int mHGap;
        private final int mVGap;

        FlowChipLayout(Context context, int hGapPx, int vGapPx) {
            super(context);
            mHGap = hGapPx;
            mVGap = vGapPx;
        }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            int maxWidth = MeasureSpec.getSize(widthMeasureSpec);
            int mode = MeasureSpec.getMode(widthMeasureSpec);
            int availWidth = (mode == MeasureSpec.UNSPECIFIED || maxWidth <= 0)
                    ? Integer.MAX_VALUE
                    : (maxWidth - getPaddingLeft() - getPaddingRight());

            int x = 0;
            int y = 0;
            int rowHeight = 0;
            int maxLineWidth = 0;
            int count = getChildCount();

            for (int i = 0; i < count; i++) {
                View child = getChildAt(i);
                if (child.getVisibility() == GONE) continue;
                boolean isLastInput = (i == count - 1) && (child instanceof EditText);

                if (isLastInput && availWidth != Integer.MAX_VALUE) {
                    int remaining = availWidth - (x > 0 ? x + mHGap : 0);
                    int minW = child.getMinimumWidth();
                    if (x > 0 && remaining < minW) {
                        y += rowHeight + mVGap;
                        x = 0;
                        rowHeight = 0;
                        remaining = availWidth;
                    }
                    int inputW = Math.max(minW, remaining);
                    if (inputW > availWidth) inputW = availWidth;
                    child.measure(
                            MeasureSpec.makeMeasureSpec(inputW, MeasureSpec.EXACTLY),
                            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                } else {
                    int childWSpec = availWidth == Integer.MAX_VALUE
                            ? MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
                            : MeasureSpec.makeMeasureSpec(availWidth, MeasureSpec.AT_MOST);
                    child.measure(childWSpec, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                }

                int cw = child.getMeasuredWidth();
                int ch = child.getMeasuredHeight();
                if (x > 0 && x + mHGap + cw > availWidth) {
                    y += rowHeight + mVGap;
                    x = 0;
                    rowHeight = 0;
                }
                if (x > 0) x += mHGap;
                x += cw;
                rowHeight = Math.max(rowHeight, ch);
                maxLineWidth = Math.max(maxLineWidth, x);
            }

            int totalHeight = y + rowHeight + getPaddingTop() + getPaddingBottom();
            int resolvedW = mode == MeasureSpec.EXACTLY
                    ? maxWidth
                    : Math.min(maxWidth, maxLineWidth + getPaddingLeft() + getPaddingRight());
            setMeasuredDimension(resolvedW, resolveSize(totalHeight, heightMeasureSpec));
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            int padLeft = getPaddingLeft();
            int padTop = getPaddingTop();
            int availWidth = (r - l) - padLeft - getPaddingRight();

            int x = 0;
            int y = 0;
            int rowHeight = 0;
            int count = getChildCount();

            List<View> rowViews = new ArrayList<>();
            List<Integer> rowXs = new ArrayList<>();

            for (int i = 0; i < count; i++) {
                View child = getChildAt(i);
                if (child.getVisibility() == GONE) continue;
                int cw = child.getMeasuredWidth();
                int ch = child.getMeasuredHeight();
                if (x > 0 && x + mHGap + cw > availWidth) {
                    layoutRow(rowViews, rowXs, padLeft, padTop + y, rowHeight);
                    rowViews.clear();
                    rowXs.clear();
                    y += rowHeight + mVGap;
                    x = 0;
                    rowHeight = 0;
                }
                if (x > 0) x += mHGap;
                rowViews.add(child);
                rowXs.add(x);
                x += cw;
                rowHeight = Math.max(rowHeight, ch);
            }
            if (!rowViews.isEmpty()) {
                layoutRow(rowViews, rowXs, padLeft, padTop + y, rowHeight);
            }
        }

        private void layoutRow(List<View> views, List<Integer> xs, int padLeft, int top, int rowHeight) {
            for (int i = 0; i < views.size(); i++) {
                View child = views.get(i);
                int cw = child.getMeasuredWidth();
                int ch = child.getMeasuredHeight();
                int cy = top + (rowHeight - ch) / 2;
                int cx = padLeft + xs.get(i);
                child.layout(cx, cy, cx + cw, cy + ch);
            }
        }
    }

    /** Crisp vector icons (no emojis) drawn cleanly in 24x24 design space. */
    private static final class VectorGlyphDrawable extends Drawable {
        private final int mKind;
        private final int mSizePx;
        private final Paint mStroke;
        private final Paint mFill;

        VectorGlyphDrawable(int kind, int color, int sizePx, float strokePx) {
            mKind = kind;
            mSizePx = sizePx;
            mStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
            mStroke.setColor(color);
            mStroke.setStyle(Paint.Style.STROKE);
            mStroke.setStrokeWidth(strokePx);
            mStroke.setStrokeCap(Paint.Cap.ROUND);
            mStroke.setStrokeJoin(Paint.Join.ROUND);

            mFill = new Paint(Paint.ANTI_ALIAS_FLAG);
            mFill.setColor(color);
            mFill.setStyle(Paint.Style.FILL);
        }

        @Override
        public void draw(Canvas canvas) {
            android.graphics.Rect b = getBounds();
            float s = Math.min(b.width(), b.height());
            if (s <= 0f) return;
            float ox = b.left + (b.width() - s) * 0.5f;
            float oy = b.top + (b.height() - s) * 0.5f;
            canvas.save();
            canvas.translate(ox, oy);
            float scale = s / 24f;
            canvas.scale(scale, scale);
            float origStroke = mStroke.getStrokeWidth();
            mStroke.setStrokeWidth(origStroke / scale);

            if (mKind == ICON_PLUS) {
                canvas.drawLine(12f, 5f, 12f, 19f, mStroke);
                canvas.drawLine(5f, 12f, 19f, 12f, mStroke);
            } else if (mKind == ICON_CLOSE) {
                canvas.drawLine(6.5f, 6.5f, 17.5f, 17.5f, mStroke);
                canvas.drawLine(17.5f, 6.5f, 6.5f, 17.5f, mStroke);
            } else if (mKind == ICON_ARROW_UP) {
                canvas.drawLine(12f, 19f, 12f, 5.5f, mStroke);
                Path head = new Path();
                head.moveTo(6.5f, 11f);
                head.lineTo(12f, 5.5f);
                head.lineTo(17.5f, 11f);
                canvas.drawPath(head, mStroke);
            } else if (mKind == ICON_ALERT) {
                canvas.drawCircle(12f, 12f, 9.2f, mStroke);
                canvas.drawLine(12f, 7.6f, 12f, 13.0f, mStroke);
                canvas.drawCircle(12f, 16.4f, 1.15f, mFill);
            }

            mStroke.setStrokeWidth(origStroke);
            canvas.restore();
        }

        @Override public void setAlpha(int alpha) { mStroke.setAlpha(alpha); mFill.setAlpha(alpha); }
        @Override public void setColorFilter(ColorFilter cf) { mStroke.setColorFilter(cf); mFill.setColorFilter(cf); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        @Override public int getIntrinsicWidth() { return mSizePx; }
        @Override public int getIntrinsicHeight() { return mSizePx; }
    }
}
