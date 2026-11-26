import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The 1.26 RN Auto-review switch reads two cloud preference RPCs first; when both fail it locks the
// switch ("Couldn't check your team settings" + Retry). Once paired, the companion answers them on
// the device with 200 `{}` (no team, no cloud-agent settings), as iOS RBLocalPreferenceResponse does.
const NATIVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const PREFERENCE_RPCS = [
  '/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
  '/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
];

for (const name of ['R8OkHttpInterceptor126.java', 'R8OkHttpInterceptor.java', 'NetworkInterceptor.java']) {
  test(`${name} answers the Auto-review preference reads locally once paired, before forwarding to the Host`, () => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8');
    const local = source.indexOf('GatewayEndpointRouter.isLocalPreferenceRpc(path)');
    assert.ok(local > 0, 'checks the preference RPC paths');
    const block = source.slice(local - 200, local + 300);
    assert.match(block, /"POST"\.equals\(httpMethod\)/, 'only POST');
    assert.match(block, /token != null && !token\.isEmpty\(\)/, 'only once paired');
    assert.match(block, /return jsonOkResponse\(request, "\{\}"\);/, 'answers 200 {}');
    const tokenRead = source.indexOf('String token = Storage.getToken(mContext);');
    const forward = source.indexOf('rewriteRpcPath(path)');
    assert.ok(tokenRead > 0 && tokenRead < local, 'after the token is read');
    assert.ok(forward > local, 'before the request is forwarded to the Host');
    assert.ok(source.lastIndexOf('isTargetCloudEndpoint(host)', local) > 0, 'inside the cloud endpoint redirect');
  });
}

test('GatewayEndpointRouter.isLocalPreferenceRpc matches exactly the two preference RPCs (JVM)', (t) => {
  const sdkRoot = [process.env.ANDROID_HOME, path.join(os.homedir(), 'Library/Android/sdk'), '/Users/lianqishi/Library/Android/sdk']
    .find(dir => dir && fs.existsSync(path.join(dir, 'platforms/android-36/android.jar')));
  const javac = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  if (!sdkRoot || !javac) return t.skip('Android SDK (android-36) and a JDK are required');
  const java = javac.endsWith('javac') ? javac.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-preference-rpc-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) files.push(full);
    }
  };
  walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
  walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));
  const harness = path.join(tmp, 'PreferenceRpcHarness.java');
  fs.writeFileSync(harness, `
import dev.rokbot.nativeapp.GatewayEndpointRouter;
public class PreferenceRpcHarness {
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  public static void main(String[] args) {
${PREFERENCE_RPCS.map(rpc => `    check(GatewayEndpointRouter.isLocalPreferenceRpc("${rpc}"), "${rpc}");`).join('\n')}
    check(!GatewayEndpointRouter.isLocalPreferenceRpc("/aiserver.v1.DashboardService/GetTeamAdminSettings"), "other Dashboard RPC");
    check(!GatewayEndpointRouter.isLocalPreferenceRpc("/aiserver.v1.BackgroundComposerService/UpdateBackgroundComposerUserSettings"), "writes are not answered");
    check(!GatewayEndpointRouter.isLocalPreferenceRpc("/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam/x"), "exact path");
    check(!GatewayEndpointRouter.isLocalPreferenceRpc(null), "null path");
    // They stay out of the Host-forwarded allowlists.
    check(GatewayEndpointRouter.getDashboardMethod("${PREFERENCE_RPCS[0]}") == null, "not a mobile-rpc method");
    System.out.println("PREFERENCE_RPC_OK");
  }
}
`);
  const classes = path.join(tmp, 'classes');
  fs.mkdirSync(classes);
  cp.execFileSync(javac, ['--release', '17', '-encoding', 'UTF-8', '-nowarn', '-cp', androidJar, '-d', classes, ...files, harness], { stdio: 'pipe' });
  const out = cp.execFileSync(java, ['-cp', `${classes}:${androidJar}`, 'PreferenceRpcHarness'], { encoding: 'utf8' });
  assert.match(out, /PREFERENCE_RPC_OK/);
});
