import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockHostServer } from './mock-host.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(PROJECT_ROOT, 'android/companion/src/main/java/dev/rokbot/nativeapp');

test('Android companion sources wire scenario models, per-Bot model routes, create group, and suggestions v2', () => {
  const models = fs.readFileSync(path.join(SRC, 'ModelsActivity.java'), 'utf8');
  for (const key of ['suggestions', 'summarization', 'memoryExtraction', 'autoReview', 'subagent', 'automation']) {
    assert.ok(models.includes(`"${key}"`), `ModelsActivity includes scenario ${key}`);
  }
  assert.ok(models.includes('EXTRA_AGENT_ID'), 'ModelsActivity accepts EXTRA_AGENT_ID for per-Bot launch');
  assert.ok(models.includes('mScenarioRoutes'), 'ModelsActivity tracks scenarioRoutes');
  assert.ok(models.includes('renderScenarioRoutesList'), 'ModelsActivity renders scenario routes');
  assert.ok(models.includes('renderBotRoutesList'), 'ModelsActivity renders per-Bot routes');
  assert.ok(models.includes('payload.put("scenarioRoutes"'), 'ModelsActivity persists scenarioRoutes');
  assert.ok(models.includes('payload.put("botRoutes"'), 'ModelsActivity persists botRoutes');
  // v3: the only entry is the first-level settings row (settings-menu.test.mjs), not a jump row here.
  assert.ok(!models.includes('SuggestionsSettingsActivity'), 'ModelsActivity no longer links to SuggestionsSettingsActivity');

  const groupAct = fs.readFileSync(path.join(SRC, 'CreateGroupActivity.java'), 'utf8');
  assert.ok(groupAct.includes('HostApiClient.createGroup'), 'CreateGroupActivity calls HostApiClient.createGroup');
  assert.ok(groupAct.includes('创建群聊') && groupAct.includes('New Group Chat'), 'CreateGroupActivity localized zh + en');
  assert.ok(groupAct.includes('RokBotBootstrap.openAgentFromDeepLink'), 'CreateGroupActivity opens created group');
  assert.ok(groupAct.includes('GroupCreateModel.buildAutoGroupName'), 'CreateGroupActivity auto-names groups like Desktop HRn');
  assert.ok(groupAct.includes('RokBotAvatars.makeView'), 'CreateGroupActivity uses RokBotAvatars for member rows and chips');
  assert.ok(groupAct.includes('VectorGlyphDrawable') && !groupAct.includes('new CheckBox('), 'CreateGroupActivity uses custom vector icons instead of default CheckBox');
  assert.ok(groupAct.includes('FlowChipLayout'), 'CreateGroupActivity renders Desktop-style wrapping recipient chip bar');

  const chooserSheet = fs.readFileSync(path.join(SRC, 'NewChatChooserSheet.java'), 'utf8');
  assert.ok(chooserSheet.includes('create_chooser_sheet'), 'NewChatChooserSheet renders custom bottom sheet');
  assert.ok(chooserSheet.includes('create_chooser_handle'), 'NewChatChooserSheet includes drag handle');
  assert.ok(chooserSheet.includes('SheetIconDrawable'), 'NewChatChooserSheet draws vector icons');
  assert.ok(chooserSheet.includes('新建 Bot') && chooserSheet.includes('New Bot'), 'NewChatChooserSheet localized New Bot');
  assert.ok(chooserSheet.includes('新建群组') && chooserSheet.includes('New Group'), 'NewChatChooserSheet localized New Group');
  assert.ok(!chooserSheet.includes('AlertDialog'), 'NewChatChooserSheet does not use system AlertDialog');
  assert.ok(!chooserSheet.includes('setNegativeButton'), 'NewChatChooserSheet has no separate Cancel button');

  const boot = fs.readFileSync(path.join(SRC, 'RokBotBootstrap.java'), 'utf8');
  assert.ok(boot.includes('matchesNewChatButtonLabel'), 'RokBotBootstrap intercepts + button');
  assert.ok(boot.includes('NewChatChooserSheet.show'), 'RokBotBootstrap opens NewChatChooserSheet');
  assert.ok(boot.includes('CreateGroupActivity.class'), 'RokBotBootstrap launches CreateGroupActivity');
  assert.ok(boot.includes('ComposerSuggestionsOverlay.onReactResumed'), 'RokBotBootstrap wires ComposerSuggestionsOverlay');
  assert.ok(boot.includes('BotProfileModelOverlay.onReactResumed'), 'RokBotBootstrap wires BotProfileModelOverlay');
  assert.ok(!boot.includes('SettingsSuggestionsOverlay'), 'the floating settings card is gone');
  assert.ok(boot.includes('matchesSuggestionsSettingsLabel(s)'), 'RokBotBootstrap routes the Input Suggestions row');

  const manifest = fs.readFileSync(path.join(PROJECT_ROOT, 'android/patchers/manifest.mjs'), 'utf8');
  assert.ok(manifest.includes('dev.rokbot.nativeapp.CreateGroupActivity'), 'manifest registers CreateGroupActivity');
  assert.ok(manifest.includes('dev.rokbot.nativeapp.SuggestionsSettingsActivity'), 'manifest registers SuggestionsSettingsActivity');

  const suggestions = fs.readFileSync(path.join(SRC, 'ComposerSuggestionsOverlay.java'), 'utf8');
  assert.ok(suggestions.includes('HostApiClient.getSuggestions'), 'ComposerSuggestionsOverlay fetches /local/suggestions');
  assert.ok(suggestions.includes('HostApiClient.getSuggestionsSettings'), 'ComposerSuggestionsOverlay syncs settings');
  assert.ok(suggestions.includes('composer.hasFocus()'), 'ComposerSuggestionsOverlay activates only on focus');
  assert.ok(suggestions.includes('sendSuggestion('), 'ComposerSuggestionsOverlay sends directly on tap');
  assert.ok(suggestions.includes('PhraseIconView') && suggestions.includes('SparkleIconView'), 'ComposerSuggestionsOverlay distinguishes phrases vs AI with vector icons');
  assert.ok(!suggestions.includes('FALLBACK_ZH_EMPTY') && !suggestions.includes('staticPresets'), 'ComposerSuggestionsOverlay removes static preset fallbacks');
  assert.doesNotMatch(suggestions, /grok/i, 'ComposerSuggestionsOverlay must not mention Grok');
  assert.doesNotMatch(suggestions, /[\u{1F300}-\u{1FAFF}]/u, 'ComposerSuggestionsOverlay must not contain emoji');

  const sugSettings = fs.readFileSync(path.join(SRC, 'SuggestionsSettingsActivity.java'), 'utf8');
  assert.ok(sugSettings.includes('HostApiClient.updateSuggestionsSettings'), 'SuggestionsSettingsActivity updates toggles');
  assert.ok(sugSettings.includes('HostApiClient.addQuickPhrase'), 'SuggestionsSettingsActivity adds quick phrases');
  assert.ok(sugSettings.includes('HostApiClient.updateQuickPhrase'), 'SuggestionsSettingsActivity edits quick phrases');
  assert.ok(sugSettings.includes('HostApiClient.deleteQuickPhrase'), 'SuggestionsSettingsActivity deletes quick phrases');
  assert.ok(sugSettings.includes('HostApiClient.reorderQuickPhrases'), 'SuggestionsSettingsActivity reorders quick phrases');
  assert.ok(sugSettings.includes('输入建议') && sugSettings.includes('Input Suggestions'), 'SuggestionsSettingsActivity localized zh + en');
  assert.doesNotMatch(sugSettings, /grok/i, 'SuggestionsSettingsActivity must not mention Grok');
  assert.doesNotMatch(sugSettings, /[\u{1F300}-\u{1FAFF}]/u, 'SuggestionsSettingsActivity must not contain emoji');

  assert.ok(!fs.existsSync(path.join(SRC, 'SettingsSuggestionsOverlay.java')), 'SettingsSuggestionsOverlay removed');

  const botOverlay = fs.readFileSync(path.join(SRC, 'BotProfileModelOverlay.java'), 'utf8');
  assert.ok(botOverlay.includes('ModelsActivity.EXTRA_AGENT_ID'), 'BotProfileModelOverlay opens ModelsActivity for current Bot');
});

test('MockHostServer supports scenarioRoutes, botRoutes, suggestions v2 settings/phrases, and /api/createGroup end to end', async t => {
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

  // Save scenarioRoutes + botRoutes via PUT /local/model
  const getBefore = await (await fetch(`${host.canonical}/local/model`, { headers })).json();
  const cfg = getBefore.config;
  const putRes = await fetch(`${host.canonical}/local/model`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...cfg,
      botRoutes: { 'agent-coding': { profileId: 'default', effort: 'high', fallbacks: [] } },
      scenarioRoutes: { suggestions: { profileId: 'default', effort: 'minimal' } },
    }),
  });
  assert.equal(putRes.status, 200);
  const saved = await putRes.json();
  assert.equal(saved.config.botRoutes['agent-coding'].effort, 'high');
  assert.equal(saved.config.scenarioRoutes.suggestions.effort, 'minimal');

  // Empty chat with no quick phrases returns empty suggestions (no static presets!)
  const emptySug = await (await fetch(`${host.canonical}/local/suggestions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: 'agent-empty-brand-new', locale: 'zh-CN' }),
  })).json();
  assert.equal(emptySug.source, 'empty');
  assert.deepEqual(emptySug.suggestions, []);

  // Add, edit, reorder quick phrases
  const p1 = (await (await fetch(`${host.canonical}/local/suggestions/phrases`, {
    method: 'POST', headers, body: JSON.stringify({ text: '继续' }),
  })).json()).phrase;
  const p2 = (await (await fetch(`${host.canonical}/local/suggestions/phrases`, {
    method: 'POST', headers, body: JSON.stringify({ text: '总结一下' }),
  })).json()).phrase;
  await fetch(`${host.canonical}/local/suggestions/phrases/reorder`, {
    method: 'PUT', headers, body: JSON.stringify({ ids: [p2.id, p1.id] }),
  });

  // Ongoing chat returns quick phrases first, AI suggestions second
  const sugRes = await fetch(`${host.canonical}/local/suggestions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: 'agent-default',
      locale: 'zh-CN',
      recentMessages: [{ id: 'm1', role: 'assistant', text: '已经完成构建。' }],
    }),
  });
  assert.equal(sugRes.status, 200);
  const sugBody = await sugRes.json();
  assert.equal(sugBody.lang, 'zh');
  assert.equal(sugBody.source, 'model');
  assert.deepEqual(sugBody.quickPhrases.map(p => p.text), ['总结一下', '继续']);
  assert.equal(sugBody.items[0].type, 'phrase');
  assert.equal(sugBody.items.at(-1).type, 'ai');

  // Toggle master switch off -> returns empty
  await fetch(`${host.canonical}/local/suggestions/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ enabled: false }),
  });
  const disabledBody = await (await fetch(`${host.canonical}/local/suggestions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: 'agent-default', locale: 'zh-CN', recentMessages: [{ id: 'm1', role: 'assistant', text: 'hi' }] }),
  })).json();
  assert.equal(disabledBody.source, 'disabled');
  assert.deepEqual(disabledBody.suggestions, []);

  // Create group via POST /api/createGroup
  const grpRes = await fetch(`${host.canonical}/api/createGroup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Engineering Squad',
      description: 'Code & general assistant',
      memberAgentIds: ['agent-default', 'agent-coding'],
    }),
  });
  assert.equal(grpRes.status, 200);
  const grpBody = await grpRes.json();
  assert.equal(grpBody.agent.name, 'Engineering Squad');
  assert.equal(grpBody.agent.isGroup, true);
  assert.deepEqual(grpBody.agent.memberIds, ['agent-default', 'agent-coding']);

  // Empty memberAgentIds rejected
  const badGrp = await fetch(`${host.canonical}/api/createGroup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Empty', memberAgentIds: [] }),
  });
  assert.equal(badGrp.status, 400);
});
