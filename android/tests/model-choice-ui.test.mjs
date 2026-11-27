import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = name => fs.readFileSync(new URL(`../companion/src/main/java/dev/rokbot/nativeapp/${name}`, import.meta.url), 'utf8');
const emoji = /\p{Extended_Pictographic}/u;

test('ModelsActivity no longer uses Spinner, ArrayAdapter or AlertDialog item lists for model choices', () => {
  const activity = src('ModelsActivity.java');
  assert.doesNotMatch(activity, /\bSpinner\b/, 'no Spinner type or import');
  assert.doesNotMatch(activity, /android\.widget\.(Spinner|ArrayAdapter|AdapterView)/);
  assert.doesNotMatch(activity, /simple_spinner_dropdown_item/);
  assert.doesNotMatch(activity, /\.setItems\(|\.setSingleChoiceItems\(/, 'no AlertDialog choice lists');
  // Default route profile + effort, route override dialog (scenario and Bot routes), provider format, profile provider.
  assert.ok((activity.match(/new ChoiceField\(this\)/g) ?? []).length >= 6);
  for (const cd of ['default_profile_picker', 'default_effort_picker', 'route_dialog_profile_picker', 'route_dialog_effort_picker', 'provider_format_picker', 'profile_provider_picker'])
    assert.ok(activity.includes(`"${cd}"`), cd);
  assert.match(activity, /ChoiceField\.showSheet\(this, Localize\.t\(this, "选择模型", "Choose Model"\)/, 'catalog picker uses the sheet');
});

test('ChoiceField is a RokBot-styled row that opens a themed bottom sheet with a vector check', () => {
  const field = src('ChoiceField.java');
  assert.match(field, /public final class ChoiceField extends LinearLayout/);
  assert.match(field, /UiChrome\.palette\(/, 'follows the light/dark palette');
  assert.match(field, /p\.dark \?/, 'dark variants');
  assert.match(field, /UiChrome\.roundRect\(/, 'rounded field and list card');
  assert.match(field, /setCornerRadii\(new float\[\] \{ r, r, r, r, 0f, 0f, 0f, 0f \}\)/, 'rounded sheet top corners');
  assert.match(field, /extends Dialog/);
  assert.match(field, /Gravity\.BOTTOM/);
  assert.match(field, /GlyphDrawable\.CHECK/, 'selected row has a vector check');
  assert.match(field, /canvas\.drawPath\(/);
  assert.match(field, /ScrollView/, 'long lists scroll');
  assert.doesNotMatch(field, /\bSpinner\b|AlertDialog|setSingleChoiceItems|setItems\(/);
  const sizes = field.match(/setTextSize\([^)]*\)/g) ?? [];
  assert.ok(sizes.length >= 3);
  for (const size of sizes) assert.match(size, /TypedValue\.COMPLEX_UNIT_SP/, size);
  for (const name of ['ChoiceField.java', 'ModelsActivity.java']) {
    assert.doesNotMatch(src(name), emoji, `${name} has no emoji`);
  }
  assert.doesNotMatch(field, /grok/i);
});

test('classes2.dex was rebuilt with ChoiceField', () => {
  const dex = fs.readFileSync(new URL('../bin/classes2.dex', import.meta.url));
  assert.ok(dex.includes(Buffer.from('Ldev/rokbot/nativeapp/ChoiceField;')));
  assert.ok(dex.includes(Buffer.from('choice_sheet_list')));
});
