import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockHostServer } from './mock-host.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(PROJECT_ROOT, 'android/companion/src/main/java/dev/rokbot/nativeapp');

test('Android companion sources wire scenario models, per-Bot model routes, create group, and composer suggestions', () => {
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

  const manifest = fs.readFileSync(path.join(PROJECT_ROOT, 'android/patchers/manifest.mjs'), 'utf8');
  assert.ok(manifest.includes('dev.rokbot.nativeapp.CreateGroupActivity'), 'manifest registers CreateGroupActivity');

  const suggestions = fs.readFileSync(path.join(SRC, 'ComposerSuggestionsOverlay.java'), 'utf8');
  assert.ok(suggestions.includes('HostApiClient.getSuggestions'), 'ComposerSuggestionsOverlay fetches /local/suggestions');
  assert.ok(suggestions.includes('SparkleIconView'), 'ComposerSuggestionsOverlay uses vector icon (no emoji)');

  const botOverlay = fs.readFileSync(path.join(SRC, 'BotProfileModelOverlay.java'), 'utf8');
  assert.ok(botOverlay.includes('ModelsActivity.EXTRA_AGENT_ID'), 'BotProfileModelOverlay opens ModelsActivity for current Bot');
});

test('MockHostServer supports scenarioRoutes, botRoutes, /local/suggestions, and /api/createGroup end to end', async t => {
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

  // Fetch suggestions via POST /local/suggestions
  const sugRes = await fetch(`${host.canonical}/local/suggestions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: 'agent-default', locale: 'zh-CN' }),
  });
  assert.equal(sugRes.status, 200);
  const sugBody = await sugRes.json();
  assert.equal(sugBody.lang, 'zh');
  assert.ok(Array.isArray(sugBody.suggestions) && sugBody.suggestions.length >= 3);

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
