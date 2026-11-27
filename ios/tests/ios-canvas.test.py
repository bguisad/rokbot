#!/usr/bin/env python3
"""iOS canvases: canvas links open RBCanvas (in-app stage + share sheet), the Library lists them
with RokBot choice sheets, and the sources compile with the dylib's flags."""
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
IOS = ROOT / "clients/ios"


def read(name):
    return (IOS / name).read_text(encoding="utf-8")


class CanvasTest(unittest.TestCase):
    def test_links_route_to_the_canvas_stage(self):
        deep = read("RBDeepLinks.m")
        self.assertIn('#import "RBCanvas.h"', deep)
        self.assertEqual(deep.count("if (RBOpenCanvasURL(url)) {"), 2, "RN Linking and UIApplication openURL")
        canvas = read("RBCanvas.m")
        self.assertIn('![segments[0] isEqual:@"canvas"] || ![segments[1] isEqual:@"app"]', canvas)
        self.assertIn("RBConnection.shared.deviceToken.length", canvas)

    def test_stage_is_offline_and_uses_the_device_credential(self):
        canvas = read("RBCanvas.m")
        for text in [
            "WKWebsiteDataStore.nonPersistentDataStore",
            'compileContentRuleListForIdentifier:@"rokbot-canvas-offline"',
            "/canvas/app/%@/frame?theme=%@",
            '[request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"]',
            "Content-Security-Policy",
            'baseURL:[NSURL URLWithString:@"https://canvas.rokbot.invalid/"]',
            "WKNavigationTypeLinkActivated",
        ]:
            self.assertIn(text, canvas)
        self.assertNotIn("addScriptMessageHandler", canvas)

    def test_share_sheet_and_library(self):
        canvas = read("RBCanvas.m")
        for text in ["分享“%@”", "谁可以访问", "公开访问", "知道链接的任何人 · 无需登录", "仅你可见 · 只能在已登录的 RokBot 中打开",
                     "复制链接", "在浏览器中打开", "重新生成链接", "旧链接会立即失效", "返回聊天", "刷新", "关闭",
                     "@interface RBCanvasSwitch : UIControl", "/local/canvases/%@/visibility", "/local/canvases/%@/link",
                     "Asia/Shanghai"]:
            self.assertIn(text, canvas)
        self.assertNotIn("UISwitch", canvas)
        library = read("RBLibrary.m")
        for text in ["/local/canvases?agentId=", "RBCanvasShortTime(", "删除“%@”", "删除画布", "RBPresentCanvasShare(",
                     'RBPresentCanvas(canvas[@"id"], canvas[@"title"])', "这个 Bot 创建的画布会显示在这里。",
                     "RBChoiceSheet sheetWithTitle:"]:
            self.assertIn(text, library)
        self.assertNotIn("UIMenu", library)
        for name in ["RBCanvas.m", "RBLibrary.m"]:
            src = read(name)
            self.assertIsNone(re.search(r"[\U0001F300-\U0001FAFF☀-➿]", src), name)
            self.assertIsNone(re.search(r'@"[^"]*Grok[^"]*"', src), name)
        build = read("build.py")
        self.assertIn("'RBCanvas.m'", build)
        self.assertIn("'-framework','WebKit'", build)

    @unittest.skipUnless(shutil.which("xcrun"), "Xcode required")
    def test_sources_compile_with_the_dylib_flags(self):
        sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip()
        for name in ["RBCanvas.m", "RBLibrary.m", "RBDeepLinks.m"]:
            subprocess.run(["xcrun", "--sdk", "iphoneos", "clang", "-arch", "arm64", "-isysroot", sdk, "-miphoneos-version-min=15.1",
                            "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
                            "-Wno-deprecated-declarations", "-Wno-nullability-completeness", "-fsyntax-only", str(IOS / name)],
                           check=True)


if __name__ == "__main__":
    unittest.main()
