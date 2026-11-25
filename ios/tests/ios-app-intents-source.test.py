"""Static guardrails for the iOS App Intents compatibility path."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AppIntentsCompatibility(unittest.TestCase):
    def test_1_26_credentials_include_a_non_expiring_local_refresh_marker(self):
        source = (ROOT / 'clients' / 'ios' / 'RBAppIntents.m').read_text(encoding='utf-8')
        self.assertIn('@"refreshToken": marker', source)
        self.assertIn('@"exp": @4070908800LL', source)
        self.assertIn('@"type": @"sand_mobile"', source)
        self.assertIn('tokenStoreStatus == errSecSuccess && appIntentStatus == errSecSuccess', source)
        self.assertIn('void RBVerifyAppIntentCredentials(void)', source)

    def test_embedded_bundle_validation_is_opt_in(self):
        source = (ROOT / 'clients' / 'ios' / 'RBBootstrap.m').read_text(encoding='utf-8')
        self.assertIn('ROKBOT_VALIDATE_EMBEDDED_BUNDLE', source)
        self.assertIn('useEmbeddedBundle ? url : (paired ?: url)', source)
        self.assertIn('RBLoadedPairedBundle = paired != nil && !useEmbeddedBundle', source)


if __name__ == '__main__':
    unittest.main()
