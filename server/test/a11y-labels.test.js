// Accessibility gate (launch): every icon-only button (TouchableOpacity/Pressable with an icon and no Text)
// has an accessibilityLabel, so screen readers announce it. Reads the source; see i18n-parity.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SERVER_DIR } from './helpers/routes.js';

const ROOT = path.resolve(SERVER_DIR, '..');

test('icon-only buttons have an accessibilityLabel', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/<(TouchableOpacity|Pressable)\b([\s\S]*?)<\/\1>/g)) {
      const element = match[0];
      const iconOnly = /<(Ionicons|FontAwesome5|MaterialIcons|Feather)\b/.test(element) && !/<Text\b/.test(element);
      if (iconOnly && !/accessibilityLabel=/.test(element)) {
        missing.push(`${path.relative(ROOT, file)}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
