// Source-level guards for client behaviour found in device tests. The client has no test framework yet
// (jest-expo is deferred until after device tests), so, like email-exposure.test.js, these read the source.
//
// 1. Protected images (/media) must render through MediaImage (expo-image with the Authorization header).
//    React Native's Image drops request headers on Android under the New Architecture: every post photo
//    answered 401 on the emulator (2026-11-13).
// 2. The empty Home feed's "Create first post" button must open CreatePost, not Explore.
// 3. DrinkDetail Cheer/Save buttons must reflect the cheered/saved state and expose accessibilityState.
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

describe('AuthScreen keyboard does not cover the submit button', () => {
  test('the form sits in a KeyboardAvoidingView and a ScrollView that lets taps dismiss the keyboard', () => {
    const auth = read('src/screens/AuthScreen.tsx');
    const ret = auth.slice(auth.lastIndexOf("<SafeAreaView edges={['top', 'left', 'right']}"));
    assert.match(ret, /<KeyboardAvoidingView[\s\S]*?behavior=\{Platform\.OS === 'ios' \? 'padding' : 'height'\}/);
    assert.match(ret, /<ScrollView[\s\S]*?keyboardShouldPersistTaps="handled"/);
    // Both wrappers enclose the email field and the submit buttons.
    const kav = ret.indexOf('<KeyboardAvoidingView');
    const scroll = ret.indexOf('<ScrollView');
    assert.ok(kav >= 0 && scroll > kav, 'ScrollView inside KeyboardAvoidingView');
    assert.ok(ret.indexOf('onPress={handleEmailAuth}') > scroll, 'submit button inside the ScrollView');
    assert.ok(ret.indexOf('onPress={handleSendReset}') > scroll, 'reset button inside the ScrollView');
    assert.ok(ret.indexOf('</ScrollView>') > ret.indexOf('onPress={handleEmailAuth}'));
  });

  test('the password field submits sign-in / sign-up from the keyboard action', () => {
    const auth = read('src/screens/AuthScreen.tsx');
    const at = auth.indexOf("placeholder={t('auth.passwordPlaceholder')}");
    assert.ok(at > 0);
    const input = auth.slice(auth.lastIndexOf('<TextInput', at), auth.indexOf('/>', at));
    assert.match(input, /returnKeyType="go"/);
    assert.match(input, /onSubmitEditing=\{isLoading \? undefined : handleEmailAuth\}/);
  });
});

// 3. The detail screen's Cheer and Save buttons showed static labels: no cheered/saved state, no count,
//    no accessibility state, so a second tap silently un-cheered (Android device test, 2026-11-14).
describe('DrinkDetail cheer and save buttons', () => {
  const screen = read('src/screens/DrinkDetailScreen.tsx');
  const button = (onPress) => {
    const at = screen.indexOf(onPress);
    assert.ok(at > 0, `${onPress} is still there`);
    const start = screen.lastIndexOf('<TouchableOpacity', at);
    return screen.slice(start, screen.indexOf('</TouchableOpacity>', at));
  };

  test('the cheer button reflects drink.isLiked and shows drink.cheersCount', () => {
    const cheer = button('toggleCheer(drink)');
    assert.match(cheer, /accessibilityRole="button"/);
    assert.match(cheer, /accessibilityState=\{\{\s*selected:\s*drink\.isLiked === true\s*\}\}/);
    assert.match(cheer, /accessibilityLabel=\{t\(drink\.isLiked \?/);
    assert.match(cheer, /color=\{drink\.isLiked \?/);
    assert.match(cheer, /drink\.isLiked \? t\('drinkDetail\.cheered'\) : t\('drinkDetail\.like'\)/);
    assert.match(cheer, /t\('common\.cheersCount', \{ count: drink\.cheersCount/);
  });

  test('the save button reflects drink.isSaved', () => {
    const save = button('toggleSave(drink)');
    assert.match(save, /accessibilityRole="button"/);
    assert.match(save, /accessibilityState=\{\{\s*selected:\s*drink\.isSaved === true\s*\}\}/);
    assert.match(save, /accessibilityLabel=\{t\(drink\.isSaved \?/);
    assert.match(save, /name=\{drink\.isSaved \? 'bookmark' : 'bookmark-outline'\}/);
    assert.match(save, /drink\.isSaved \? t\('common\.saved'\) : t\('common\.save'\)/);
    assert.doesNotMatch(save, /t\('drinkDetail\.save'\)/);
  });

  test('the new labels exist in en and ro', () => {
    const loc = read('src/context/LocalizationContext.tsx');
    for (const key of ['cheered', 'cheerA11y', 'uncheerA11y', 'saveA11y', 'unsaveA11y']) {
      assert.equal(loc.match(new RegExp(`^\\s+${key}: '`, 'gm'))?.length, 2, key);
    }
  });
});
