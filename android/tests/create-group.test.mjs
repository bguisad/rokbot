import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockHostServer } from './mock-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(PROJECT_ROOT, 'android/companion/src/main/java/dev/rokbot/nativeapp');

function findJavaTool(name) {
  const fromPath = cp.spawnSync('which', [name], { encoding: 'utf8' });
  if (fromPath.status === 0 && fromPath.stdout.trim()) return fromPath.stdout.trim();
  const studio = `/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/${name}`;
  if (fs.existsSync(studio)) return studio;
  return name;
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/u;

test('CreateGroupActivity & GroupCreateModel match Desktop 1.3.0 design, localization, no-emoji, and no-legacy-brand rules', () => {
  const act = fs.readFileSync(path.join(SRC, 'CreateGroupActivity.java'), 'utf8');
  const model = fs.readFileSync(path.join(SRC, 'GroupCreateModel.java'), 'utf8');
  const api = fs.readFileSync(path.join(SRC, 'HostApiClient.java'), 'utf8');

  // Pure JVM model must not import android.*
  assert.doesNotMatch(model, /^import android\./m, 'GroupCreateModel has zero android.* imports');

  // Zero emoji and zero legacy "Grok" wording in CreateGroupActivity
  assert.equal(EMOJI_RE.test(act), false, 'CreateGroupActivity contains zero emoji');
  assert.equal(/grok/i.test(act), false, 'CreateGroupActivity contains zero legacy brand references');
  assert.equal(EMOJI_RE.test(model), false, 'GroupCreateModel contains zero emoji');

  // Desktop-aligned bilingual localization
  for (const text of [
    '创建群聊', 'New Group Chat',
    '收件人：', 'To:',
    '创建', 'Create',
    '创建中…', 'Creating…',
    '添加到群聊', 'Add to group chat',
    '发消息给 Bot', 'Message Bot',
    '发消息给 ', 'Message ',
    '没有匹配的 Bot', 'No matching Bots',
    '输入名字以创建 Bot', 'Type a name to create a Bot',
    '重试创建群组', 'Retry group creation',
    '返回聊天', 'Back to chats',
  ]) {
    assert.ok(act.includes(text), `CreateGroupActivity includes localized text: ${text}`);
  }

  // Android native conventions: dark/light palette, font scaling, keyboard resize, back handling, vector icons
  assert.ok(act.includes('UiChrome.palette(this)'), 'Uses adaptive light/dark palette');
  assert.ok(act.includes('DesktopTokens'), 'Applies Desktop light/dark tokens');
  assert.ok(act.includes('TypedValue.COMPLEX_UNIT_SP'), 'Uses SP units for system font scaling');
  assert.ok(act.includes('SOFT_INPUT_ADJUST_RESIZE'), 'Handles keyboard resize cleanly');
  assert.ok(act.includes('UiChrome.applyRootInsets'), 'Applies system bar + IME insets');
  assert.ok(act.includes('public void onBackPressed()'), 'Supports system back gesture');
  assert.ok(act.includes('VectorGlyphDrawable') && !act.includes('new CheckBox('), 'Uses vector drawables, not default CheckBox');
  assert.ok(act.includes('MaxHeightScrollView'), 'Caps chip container height so candidate list stays scrollable with keyboard open');
  assert.ok(act.includes('rokbot-local://agent/'), 'Navigates to created group via rokbot-local deep link');

  // Desktop API parity: inline new Bot creation + rollback + createGroup + optional sendPrompt
  assert.ok(act.includes('HostApiClient.createAgent('), 'Supports inline new Bot creation like Desktop tzn');
  assert.ok(act.includes('HostApiClient.deleteAgents('), 'Rolls back inline new Bots if createGroup fails');
  assert.ok(act.includes('HostApiClient.createGroup(this, groupName, "", memberAgentIds)'), 'Calls createGroup with Desktop payload fields');
  assert.ok(act.includes('HostApiClient.sendPrompt('), 'Sends optional first message after creating group');

  // HostApiClient.createGroup always serializes name, description, and memberAgentIds
  const cgStart = api.indexOf('public static JSONObject createGroup(');
  const cgBody = api.slice(cgStart, api.indexOf('\n    }\n', cgStart) + 6);
  assert.ok(cgBody.includes('req.put("name", name != null ? name.trim() : "");'), 'createGroup always sends name');
  assert.ok(cgBody.includes('req.put("description", description != null ? description.trim() : "");'), 'createGroup always sends description');
  assert.ok(cgBody.includes('req.put("memberAgentIds", members);'), 'createGroup always sends memberAgentIds');
});

test('GroupCreateModel runs on JVM and matches Desktop HRn, WRn, zRn, and validation rules', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-group-model-'));
  try {
    const driverSrc = `
import dev.rokbot.nativeapp.GroupCreateModel;
import dev.rokbot.nativeapp.GroupCreateModel.BotCandidate;
import dev.rokbot.nativeapp.GroupCreateModel.Recipient;
import java.util.*;

public class GroupModelDriver {
    private static void eq(Object actual, Object expected, String msg) {
        if (!Objects.equals(actual, expected)) {
            throw new AssertionError(msg + ": expected=<" + expected + "> actual=<" + actual + ">");
        }
    }
    private static void ok(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }

    public static void main(String[] args) {
        List<BotCandidate> raw = Arrays.asList(
            new BotCandidate("b1", "Alpha", "Coder", "Writes code", "circle", "blue", "", false, false),
            new BotCandidate("b2", "Beta", "", "Design partner", "square", "purple", "", false, false),
            new BotCandidate("b3", "Gamma Bot", "Research", "", "star", "green", "", false, false),
            new BotCandidate("g1", "Existing Room", "", "", "", "", "", true, false),
            new BotCandidate("h1", "Hidden Bot", "", "", "", "", "", false, true),
            new BotCandidate("", "NoId", "", "", "", "", "", false, false),
            new BotCandidate("b1", "Alpha Dup", "", "", "", "", "", false, false)
        );
        List<BotCandidate> eligible = GroupCreateModel.filterEligibleBots(raw);
        eq(eligible.size(), 3, "eligible filters out groups, hidden, empty id, dupes");
        eq(eligible.get(0).id, "b1", "first eligible is b1");
        eq(eligible.get(1).displaySubtitle(), "Design partner", "fallback to description");
        eq(eligible.get(0).displaySubtitle(), "Coder", "prefers title over description");

        // Search & ranking + excluding already-selected
        List<Recipient> selected = new ArrayList<>();
        List<BotCandidate> search1 = GroupCreateModel.filterCandidates(eligible, selected, "gamma");
        eq(search1.size(), 1, "search matches Gamma Bot");
        eq(search1.get(0).id, "b3", "search match id");

        List<BotCandidate> searchSub = GroupCreateModel.filterCandidates(eligible, selected, "design");
        eq(searchSub.size(), 1, "search matches subtitle description");
        eq(searchSub.get(0).id, "b2", "subtitle match id");

        selected.add(Recipient.fromBot(eligible.get(0)));
        List<BotCandidate> afterPick = GroupCreateModel.filterCandidates(eligible, selected, "");
        eq(afterPick.size(), 2, "picked bot excluded from candidates");
        eq(afterPick.get(0).id, "b2", "remaining starts with b2");

        // Inline new Bot offer rules
        ok(!GroupCreateModel.canOfferCreateNewBot(eligible, selected, ""), "blank query does not offer new bot");
        ok(!GroupCreateModel.canOfferCreateNewBot(eligible, selected, "  Alpha "), "exact match to existing/selected does not offer new bot");
        ok(!GroupCreateModel.canOfferCreateNewBot(eligible, selected, "beta"), "case-insensitive exact match to existing does not offer new bot");
        ok(GroupCreateModel.canOfferCreateNewBot(eligible, selected, "Delta"), "new name offers inline bot creation");

        // Duplicate prevention & 6-Bot cap (Desktop zRn)
        ok(!GroupCreateModel.canAddRecipient(selected, Recipient.fromBot(eligible.get(0))), "reject duplicate existing bot");
        selected.add(Recipient.newBot("Delta"));
        ok(!GroupCreateModel.canAddRecipient(selected, Recipient.newBot("delta")), "reject duplicate new bot");
        ok(!GroupCreateModel.canOfferCreateNewBot(eligible, selected, "Delta"), "already-selected new bot not offered again");

        // Auto group name matching Desktop HRn (zh & en, with & without accountName)
        eq(GroupCreateModel.formatComposerNames(selected, false), "Alpha and Delta", "en 2-member composer list");
        eq(GroupCreateModel.formatComposerNames(selected, true), "Alpha和Delta", "zh 2-member composer list");
        eq(GroupCreateModel.buildAutoGroupName(selected, "", false), "Alpha and Delta", "en auto name no account");
        eq(GroupCreateModel.buildAutoGroupName(selected, "", true), "Alpha和Delta", "zh auto name no account");
        eq(GroupCreateModel.buildAutoGroupName(selected, "Hongfa", false), "Hongfa, Alpha, Delta", "en auto name with account (2+ bots)");
        eq(GroupCreateModel.buildAutoGroupName(selected, "小红", true), "小红、Alpha、Delta", "zh auto name with account (2+ bots)");

        List<Recipient> single = Collections.singletonList(Recipient.fromBot(eligible.get(0)));
        eq(GroupCreateModel.buildAutoGroupName(single, "Hongfa", false), "Alpha, Hongfa", "en single bot + account puts bot first like Desktop HRn");
        eq(GroupCreateModel.buildAutoGroupName(single, "小红", true), "Alpha、小红", "zh single bot + account puts bot first like Desktop HRn");

        // 3 members conjunction
        List<Recipient> three = Arrays.asList(
            Recipient.fromBot(eligible.get(0)),
            Recipient.fromBot(eligible.get(1)),
            Recipient.fromBot(eligible.get(2))
        );
        eq(GroupCreateModel.buildAutoGroupName(three, "", false), "Alpha, Beta, and Gamma Bot", "en 3-member Oxford comma");
        eq(GroupCreateModel.buildAutoGroupName(three, "", true), "Alpha、Beta和Gamma Bot", "zh 3-member conjunction");

        // 72-char truncation & whitespace collapse (Desktop ZQ)
        String longName = GroupCreateModel.normalizeGroupName("   A   " + "x".repeat(90));
        ok(longName.length() <= 72, "normalized group name <= 72 chars");
        ok(longName.startsWith("A x"), "collapsed multiple spaces");

        // 6-Bot maximum limit
        List<Recipient> six = new ArrayList<>();
        for (int i = 1; i <= 6; i++) six.add(Recipient.newBot("Bot" + i));
        ok(GroupCreateModel.isAtBotLimit(six), "6 bots hits limit");
        ok(!GroupCreateModel.canAddRecipient(six, Recipient.newBot("Bot7")), "7th bot rejected");
        ok(!GroupCreateModel.canOfferCreateNewBot(eligible, six, "Bot7"), "no new-bot offer at 6-bot cap");

        // Validation
        ok(!GroupCreateModel.canSubmitGroup(Collections.emptyList(), false), "cannot submit 0 recipients");
        ok(GroupCreateModel.canSubmitGroup(single, false), "can submit 1 recipient");
        ok(!GroupCreateModel.canSubmitGroup(single, true), "cannot submit while in flight");
        ok(!GroupCreateModel.canSendFirstMessage(single, "   ", false), "cannot send blank first message");
        ok(GroupCreateModel.canSendFirstMessage(single, "Hello squad", false), "can send non-empty first message");

        // Guard helpers
        ok(!GroupCreateModel.containsEmoji("创建群聊 New Group Chat"), "clean text has no emoji");
        ok(GroupCreateModel.containsEmoji("Hi \uD83D\uDE80"), "detects emoji");
        ok(!GroupCreateModel.containsLegacyBrand("RokBot"), "RokBot passes brand check");
        ok(GroupCreateModel.containsLegacyBrand("Grok Bot"), "detects legacy brand");

        System.out.println("GROUP_MODEL_JVM_OK");
    }
}
`;
    const driverPath = path.join(tmpDir, 'GroupModelDriver.java');
    fs.writeFileSync(driverPath, driverSrc, 'utf8');

    const javac = findJavaTool('javac');
    const java = findJavaTool('java');
    const compile = cp.spawnSync(javac, [
      '--release', '17', '-encoding', 'UTF-8',
      '-d', tmpDir,
      path.join(SRC, 'GroupCreateModel.java'),
      driverPath,
    ], { encoding: 'utf8' });
    assert.equal(compile.status, 0, `javac failed:\n${compile.stderr}`);

    const run = cp.spawnSync(java, ['-cp', tmpDir, 'GroupModelDriver'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `JVM assertions failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /GROUP_MODEL_JVM_OK/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MockHostServer supports Desktop-identical createGroup + inline createAgent + first sendPrompt flow', async t => {
  const host = new MockHostServer();
  await host.start();
  t.after(() => host.stop());

  const pairRes = await fetch(`${host.canonical}/connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingKey: host.validPairingKey, deviceName: 'Test Android', platform: 'desktop' }),
  });
  assert.equal(pairRes.status, 201);
  const { token } = await pairRes.json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  // 1. Create an inline new Bot first (exact Desktop tzn flow)
  const newBotRes = await fetch(`${host.canonical}/api/createAgent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Design Critic', description: '' }),
  });
  assert.equal(newBotRes.status, 200);
  const newBotId = (await newBotRes.json()).agent.id;
  assert.ok(newBotId, 'inline new bot created');

  // 2. Create group with Desktop-identical payload { name, description: "", memberAgentIds }
  const createRes = await fetch(`${host.canonical}/api/createGroup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Alpha and Design Critic',
      description: '',
      memberAgentIds: ['agent-default', newBotId],
    }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.agent.isGroup, true);
  assert.equal(created.agent.name, 'Alpha and Design Critic');
  assert.equal(created.agent.description, '');
  assert.deepEqual(created.agent.memberIds, ['agent-default', newBotId]);

  // 3. Send optional first message to newly created group
  const sendRes = await fetch(`${host.canonical}/api/sendPrompt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: created.agent.id,
      clientNonce: 'test-group-first-msg-1',
      prompt: 'Let us review the launch checklist together.',
      directAddressedAcceptance: true,
    }),
  });
  assert.equal(sendRes.status, 200);

  // 4. Verify group shows up identically in /api/listAgents
  const listRes = await fetch(`${host.canonical}/api/listAgents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(listRes.status, 200);
  const agents = await listRes.json();
  const found = (Array.isArray(agents) ? agents : agents.agents).find(a => a.id === created.agent.id);
  assert.ok(found, 'created group appears in listAgents');
  assert.equal(found.isGroup, true);
  assert.deepEqual(found.memberIds, ['agent-default', newBotId]);
});
