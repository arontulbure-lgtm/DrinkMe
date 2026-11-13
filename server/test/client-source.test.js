// Source-level guards for client behaviour found in device tests. The client has no test framework yet
// (jest-expo is deferred until after device tests), so, like email-exposure.test.js, these read the source.
//
// 1. Protected images (/media) must render through MediaImage (expo-image with the Authorization header).
//    React Native's Image drops request headers on Android under the New Architecture: every post photo
//    answered 401 on the emulator (2026-11-13).
// 2. The empty Home feed's "Create first post" button must open CreatePost, not Explore.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { SERVER_DIR } from './helpers/routes.js';

const ROOT = path.resolve(SERVER_DIR, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const sourceFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = path.join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(rel);
  return /\.(tsx?|jsx?)$/.test(entry.name) ? [rel] : [];
});
const CLIENT_FILES = [...sourceFiles('src'), 'App.tsx'];

describe('protected media render through MediaImage', () => {
  test('getImageSource is used only by MediaImage', () => {
    const users = CLIENT_FILES.filter((rel) => /getImageSource\s*\(/.test(read(rel)) && !rel.endsWith(path.join('lib', 'api.ts')));
    assert.deepEqual(users.map((rel) => rel.split(path.sep).join('/')), ['src/components/MediaImage.tsx']);
  });

  test('MediaImage uses expo-image, passes the headers and keeps the cache in memory, cleared on token change', () => {
    const text = read('src/components/MediaImage.tsx');
    assert.match(text, /from 'expo-image'/);
    assert.doesNotMatch(text, /from 'react-native'/);
    assert.match(text, /cachePolicy="memory"/);
    assert.match(text, /onApiTokenChange\(\(\) => \{\s*void Image\.clearMemoryCache\(\);/);
  });

  test('no screen renders /media paths or user avatars with React Native Image', () => {
    for (const rel of CLIENT_FILES) {
      const text = read(rel);
      // Any RN <Image whose source mentions imageUrl, avatar or /media is a protected image.
      const rnImage = /import\s*\{[^}]*\bImage\b[^}]*\}\s*from\s*'react-native'/.test(text);
      if (!rnImage) continue;
      const tags = text.match(/<Image\b[\s\S]*?\/>/g) ?? [];
      for (const tag of tags) {
        assert.doesNotMatch(tag, /imageUrl|avatar|\/media\//i, `${rel}: ${tag.slice(0, 80)}`);
      }
    }
  });

  test('getImageSource sends the token only to this server\'s /media and never puts it in the URL', () => {
    const api = read('src/lib/api.ts');
    const body = api.slice(api.indexOf('export function getImageSource'), api.indexOf('export function isStorageFullError'));
    assert.match(body, /headers: isOwnMedia && _apiToken \? \{ Authorization: `Bearer \$\{_apiToken\}` \} : \{\}/);
    assert.doesNotMatch(body, /[?&](token|access_token|auth)=/);
  });
});

describe('Home feed empty state', () => {
  test('"Create first post" opens CreatePost', () => {
    const home = read('src/screens/HomeScreen.tsx');
    const at = home.indexOf("t('home.sections.createFirstPost')");
    assert.ok(at > 0, 'the button text is still there');
    // The TouchableOpacity that wraps the label.
    const opening = home.lastIndexOf('<TouchableOpacity', at);
    const button = home.slice(opening, at);
    assert.match(button, /navigation\.navigate\('CreatePost'\)/);
    assert.doesNotMatch(button, /navigate\('Explore'\)/);
  });
});
