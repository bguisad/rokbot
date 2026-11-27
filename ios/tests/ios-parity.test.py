"""Static guardrails for the iOS port of the Android / Desktop updates of 2026-11-27.

Covers composer suggestions v2, Desktop-aligned group creation, RokBot-styled choice
sheets (no system pickers or action sheets), scenario / per-Bot model routes and the
branding rules (no legacy brand, no emoji, Chinese UI copy, RokBot controls).
"""
from pathlib import Path
import json
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / 'clients' / 'ios'
NEW_UI = ['RBTheme.m', 'RBChoiceSheet.m', 'RBHostAPI.m', 'RBSuggestions.m', 'RBGroupCreate.m', 'RBCanvas.m']
EMOJI = re.compile('[\U0001F300-\U0001FAFF☀-➿️⭐⬆⬇←-⇿]')


def source(name):
    return (CLIENT / name).read_text(encoding='utf-8')


def string_literals(text):
    return re.findall(r'@"((?:[^"\\]|\\.)*)"', text)


class ParitySources(unittest.TestCase):
    def test_new_sources_are_built_into_the_dylib(self):
        build = source('build.py')
        for name in NEW_UI:
            self.assertIn(f"'{name}'", build)
            self.assertTrue((CLIENT / name).is_file(), name)

    def test_branding_no_legacy_name_and_no_emoji_in_ui_strings(self):
        for name in NEW_UI + ['RBModels.m', 'RBLibrary.m', 'RBConnection.m']:
            for literal in string_literals(source(name)):
                self.assertIsNone(EMOJI.search(literal), f'{name}: emoji or symbol glyph in {literal!r}')
            if name in NEW_UI:
                self.assertNotIn('grok', source(name).lower(), name)

    def test_ui_copy_is_localized_with_chinese_first(self):
        for name, minimum in [('RBSuggestions.m', 20), ('RBGroupCreate.m', 20), ('RBChoiceSheet.m', 2)]:
            self.assertGreaterEqual(source(name).count('RBL(@"'), minimum, name)
        self.assertIn('RBL(@"输入建议", @"Input Suggestions")', source('RBSuggestions.m'))
        self.assertIn('RBL(@"创建群聊", @"New Group Chat")', source('RBGroupCreate.m'))
        self.assertIn('RBL(@"收件人：", @"To:")', source('RBGroupCreate.m'))

    def test_no_system_pickers_or_action_sheets_in_rokbot_screens(self):
        for name in ['RBModels.m', 'RBLibrary.m', 'RBConnection.m', 'RBUsage.m'] + NEW_UI:
            text = source(name)
            self.assertNotIn('UIAlertControllerStyleActionSheet', text, name)
            self.assertNotIn('UIPickerView', text, name)
            self.assertNotIn('UISegmentedControl', text, name)
            self.assertNotIn('UIMenu', text, name)
        models = source('RBModels.m')
        self.assertGreaterEqual(models.count('RBChoiceSheet sheetWithTitle'), 5)
        self.assertIn('RBChoiceSheet multiSheetWithTitle', models)
        usage = source('RBUsage.m')
        self.assertIn('RBSegmentControl', usage)
        self.assertIn('RBChoiceSheet sheetWithTitle', usage)
        conn = source('RBConnection.m')
        self.assertIn('RBSegmentControl', conn)

    def test_choice_sheet_is_rokbot_styled_for_light_and_dark(self):
        sheet = source('RBChoiceSheet.m')
        theme = source('RBTheme.m')
        for needle in ['cornerRadius = 24', 'RBThemeCard(18)', 'multiplier:0.62', 'RBGlyphCheck',
                       'scrollRectToVisible', 'UIPanGestureRecognizer', 'accessibilityPerformEscape']:
            self.assertIn(needle, sheet)
        self.assertIn('UIUserInterfaceStyleDark', theme)
        self.assertIn('UIFontMetrics', theme)
        self.assertNotIn('systemImageNamed', theme + sheet)

    def test_suggestions_v2_contract(self):
        text = source('RBSuggestions.m')
        for path in ['/local/suggestions/settings', '/local/suggestions/phrases', '/local/suggestions/phrases/reorder',
                     '"/local/suggestions"', '/local/suggestions/complete', '/api/sendPrompt']:
            self.assertIn(path, text)
        # Focus-only: shown on begin editing, hidden on end editing / typing.
        self.assertIn('UITextViewTextDidBeginEditingNotification', text)
        self.assertIn('UITextViewTextDidEndEditingNotification', text)
        self.assertIn('input.isFirstResponder', text)
        # No preset fallbacks: AI only from source == model, failures never cached.
        self.assertIn('isEqualToString:@"model"', text)
        self.assertNotRegex(text, r'(?i)fallback_?presets|staticPresets')
        self.assertIn('Never cache failures', text)
        # Toggle + AI toggle + inline completion toggle + shimmer + ghost text + phrase CRUD in settings.
        for needle in ['enabledSwitch', 'aiSwitch', 'completionSwitch', 'completionEnabled',
                       'RBSuggestionLoadState', 'RBInlineCompletionEngine', 'RBChatHistoryHints',
                       'RBSkeletonPillView', 'RBCompletionPill', 'RBGhostTextView',
                       'UIAccessibilityIsReduceMotionEnabled', 'movePhraseAt', 'deletePhrase', 'beginEditPhrase']:
            self.assertIn(needle, text)
        self.assertIn('RBSuggestionsNoteRequest(path, request.HTTPBody)', source('RBLibrary.m'))
        self.assertIn('RBInstallSuggestions();', source('RBBootstrap.m'))
        self.assertIn('RBShowSuggestionsSettingsFrom(self)', source('RBConnection.m'))

    def test_group_creation_matches_desktop_flow(self):
        text = source('RBGroupCreate.m')
        for needle in ['/api/listAgents', '/api/createAgent', '/api/createGroup', '/api/deleteAgents',
                       '/api/sendPrompt', '/local/profile', 'RBOpenAgent(groupId)']:
            self.assertIn(needle, text)
        self.assertIn('@"description" : @""', text)
        self.assertIn('RBL(@"重试创建群组", @"Retry group creation")', text)
        self.assertIn('RBL(@"返回聊天", @"Back to chats")', text)
        self.assertIn('将“%@”添加为新 Bot', text)
        self.assertIn('const NSUInteger RBGroupMaxBots = 6;', text)
        self.assertIn('const NSUInteger RBGroupMaxNameLength = 72;', text)
        boot = source('RBBootstrap.m')
        self.assertIn('RBReplaceNewChatView(view, label)', boot)
        self.assertIn('tag == 731995 && !RBGroupIsNewChatLabel(label)', boot)
        self.assertIn('RBShowCreateGroupFrom', source('RBConnection.m'))

    def test_models_page_keeps_scenario_and_bot_routes(self):
        models = source('RBModels.m')
        self.assertIn('RBModelsAttachRoutingExtras(payload, self.scenarioRoutes, self.adaptiveRouting, self.profiles)', models)
        self.assertIn('RBL(@"场景模型", @"Scenario Models")', models)
        self.assertIn('RBL(@"单 Bot 模型路由", @"Per-Bot Routes")', models)
        host_keys = re.search(r"SCENARIO_KEYS = Object\.freeze\(\[(.*?)\]\)",
                              (ROOT.parent / 'host' / 'runtime' / 'model-routing.mjs').read_text(encoding='utf-8'), re.S)
        self.assertIsNotNone(host_keys)
        keys = re.findall(r"'([A-Za-z]+)'", host_keys.group(1))
        ios_keys = re.search(r'RBModelsScenarioKeys\(void\) \{\s*return @\[(.*?)\];', models, re.S).group(1)
        self.assertEqual(re.findall(r'@"([A-Za-z]+)"', ios_keys), keys)

    def test_all_recipe_manifests_pin_the_shipped_dylib(self):
        import hashlib
        digest = hashlib.sha256((ROOT / 'bin' / 'RokBotLocal.dylib').read_bytes()).hexdigest()
        manifests = [ROOT / 'recipes' / 'ios' / 'manifest.json'] + sorted((ROOT / 'recipes' / 'ios').glob('*/manifest.json'))
        self.assertGreaterEqual(len(manifests), 3)
        for manifest in manifests:
            self.assertEqual(json.loads(manifest.read_text(encoding='utf-8'))['dylibSha256'], digest, manifest)


if __name__ == '__main__':
    unittest.main()
