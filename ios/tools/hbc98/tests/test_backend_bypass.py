from __future__ import annotations

import unittest
from pathlib import Path

from ios.release import bytepatch
from ios.tools.build_ios_126_recipe import (
    BACKEND_CALL_FUNCTION as BACKEND_CALL_126,
    BACKEND_CALL_PUBLIC_FUNCTION as BACKEND_CALL_PUBLIC_126,
    BACKEND_LOCAL_BYPASS_RPCS as BACKEND_LOCAL_BYPASS_RPCS_126,
    EXPECTED_GATEWAY_SHA256_WITH_AVATAR_MOTION as EXPECTED_GATEWAY_126_SHA256,
)
from ios.tools.build_ios_127_recipe import (
    BACKEND_CALL_FUNCTION,
    BACKEND_CALL_PUBLIC_FUNCTION,
    BACKEND_LOCAL_BYPASS_RPCS,
    EXPECTED_GATEWAY_127_SHA256,
    assert_backend_local_bypass,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
RECIPES_DIR = REPO_ROOT / 'ios' / 'recipes' / 'ios'
RECIPES_126_DIR = RECIPES_DIR / '1.26.0'


class BackendLocalBypassTests(unittest.TestCase):
    def test_126_bypass_list_covers_auto_review_rpcs_and_recipe_pin(self):
        self.assertEqual(BACKEND_CALL_126, 26615)
        self.assertEqual(BACKEND_CALL_PUBLIC_126, 26617)
        required = {
            'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
            'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
        }
        self.assertTrue(required.issubset(set(BACKEND_LOCAL_BYPASS_RPCS_126)))
        self.assertEqual(len(BACKEND_LOCAL_BYPASS_RPCS_126), len(set(BACKEND_LOCAL_BYPASS_RPCS_126)))
        gateway_recipe = bytepatch.load(RECIPES_126_DIR / 'gateway-template.hbc.gbp.gz')
        self.assertEqual(gateway_recipe['targetSha256'], EXPECTED_GATEWAY_126_SHA256)

    def test_127_bypass_list_covers_auto_review_and_pages_rpcs(self):
        self.assertEqual(BACKEND_CALL_FUNCTION, 28177)
        self.assertEqual(BACKEND_CALL_PUBLIC_FUNCTION, 28179)
        self.assertTrue(callable(assert_backend_local_bypass))
        required = {
            'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
            'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
            'aiserver.v1.DashboardService/ListUserCanvases',
            'aiserver.v1.DashboardService/GetCanvasMetadata',
            'aiserver.v1.DashboardService/GetCanvasPayload',
            'aiserver.v1.DashboardService/SetCanvasVisibility',
            'aiserver.v1.DashboardService/SetPageAddress',
            'aiserver.v1.DashboardService/GetCanvasShareAccess',
            'aiserver.v1.DashboardService/UpdateCanvasShareAccess',
            'aiserver.v1.DashboardService/RefreshCanvasSources',
        }
        self.assertTrue(required.issubset(set(BACKEND_LOCAL_BYPASS_RPCS)))
        self.assertEqual(len(BACKEND_LOCAL_BYPASS_RPCS), len(set(BACKEND_LOCAL_BYPASS_RPCS)))

    def test_committed_127_gateway_recipe_matches_updated_pin(self):
        gateway_recipe = bytepatch.load(RECIPES_DIR / 'gateway-template.hbc.gbp.gz')
        self.assertEqual(gateway_recipe['targetSha256'], EXPECTED_GATEWAY_127_SHA256)


if __name__ == '__main__':
    unittest.main()
