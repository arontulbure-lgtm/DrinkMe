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
    assert.match(ret, /<KeyboardAvoidingView[\s\S]*?behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
    // Android: padded by the keyboard height and scrolled to the end (KeyboardAvoidingView gets no usable
    // keyboard frame there with edge-to-edge; seen on the emulator 2026-11-14).
    // Expo Go on Android 15 reports a keyboard height of 0, so an estimate is used then.
    assert.match(auth, /Keyboard\.addListener\('keyboardDidShow'[\s\S]*?event\.endCoordinates\.height[\s\S]*?ESTIMATED_KEYBOARD_SHARE[\s\S]*?scrollToEnd/);
    assert.match(ret, /paddingBottom: keyboardHeight/);
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

// 4. Feed cards had no onPress on the body, so a post (and its detail) could be opened only from the
//    Explore Trending tiles, not from Home, Profile, Explore results or Smart Bar Saved (Android device
//    test, 2026-11-14, issue 3).
describe('feed cards open the post detail', () => {
  test('DrinkPostCard accepts onPress and wraps the body in a pressable button', () => {
    const card = read('src/components/DrinkPostCard.tsx');
    assert.match(card, /onPress\?: \(\) => void;/);
    const start = card.lastIndexOf('<TouchableOpacity', card.indexOf('style={styles.content}'));
    assert.ok(start > 0, 'the content area is a TouchableOpacity');
    const body = card.slice(start, card.indexOf('</TouchableOpacity>', start));
    assert.match(body, /onPress=\{onPress\}/);
    assert.match(body, /accessibilityRole="button"/);
    assert.match(body, /accessibilityLabel=\{t\('post\.open', \{ name: drink\.name \}\)\}/);
    assert.match(body, /styles\.drinkName/);
    assert.doesNotMatch(body, /onCheer|onSave|onComment|onMore|onPressAuthor/);
  });

  test('every <DrinkPostCard usage navigates to DrinkDetail on press', () => {
    const users = CLIENT_FILES.filter((rel) => /<DrinkPostCard\b/.test(read(rel)));
    assert.ok(users.length >= 4, 'Home, Profile, Explore and Smart Bar render DrinkPostCard');
    for (const rel of users) {
      const text = read(rel);
      const usages = text.split(/<DrinkPostCard\b/).slice(1).map((rest) => rest.slice(0, rest.indexOf('/>')));
      for (const usage of usages) {
        assert.match(usage, /\bonPress=\{\(\) => navigation\.navigate\('DrinkDetail', \{ drinkId: drink\.id \}\)\}/, rel);
      }
    }
  });

  test('the open-post label exists in en and ro', () => {
    const loc = read('src/context/LocalizationContext.tsx');
    assert.equal(loc.match(/^\s+open: '(Open post|Deschide postarea) \{\{name\}\}',$/gm)?.length, 2);
  });
});

// 4. Places requests carry the app-restriction headers (Maps key, JOHN_TODO section 3) and never show
//    Google's raw error text (legal T-04).
describe('Places requests (LocationPickerModal)', () => {
  const picker = read('src/components/LocationPickerModal.tsx');
  const headers = read('src/lib/placesHeaders.ts');

  test('both Places calls send placesRequestHeaders()', () => {
    const calls = picker.match(/fetch\([\s\S]*?maps\.googleapis\.com[\s\S]*?\);/g) ?? [];
    assert.equal(calls.length, 2);
    for (const call of calls) assert.match(call, /headers: placesRequestHeaders\(\)/);
  });

  test('the helper sends the Android package + certificate and the iOS bundle id, from app.config', () => {
    assert.match(headers, /'X-Android-Package': packageName, 'X-Android-Cert': sha1/);
    assert.match(headers, /'X-Ios-Bundle-Identifier': bundleId/);
    assert.match(read('app.config.ts'), /androidCertSha1: process\.env\.EXPO_PUBLIC_ANDROID_CERT_SHA1/);
  });

  test('Google error_message is never shown; results carry the Powered by Google attribution', () => {
    assert.doesNotMatch(picker, /setError\(data\.error_message/);
    assert.match(picker, /t\('location\.poweredByGoogle'\)/);
    assert.equal(read('src/context/LocalizationContext.tsx').match(/poweredByGoogle: 'Powered by Google'/g)?.length, 2);
  });
});

// 5. Legal links (legal T-01/T-02): every document the app can open exists in the static site for both
//    languages, links appear only with an https base URL, and Contact always shows.
describe('legal links', () => {
  const config = read('src/config/legal.ts');
  const links = read('src/components/LegalLinks.tsx');

  test('every linked document has an en and ro page in docs/public', () => {
    const docs = [...links.matchAll(/\{ doc: '([\w-]+)'/g)].map((m) => m[1]);
    assert.ok(docs.length >= 7);
    for (const doc of docs) {
      for (const lang of ['en', 'ro']) {
        assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'public', lang, `${doc}.html`)), `${lang}/${doc}.html`);
      }
    }
  });

  test('URLs are <base>/{en,ro}/<doc>.html, https only; no base means no document links', () => {
    assert.match(config, /return `\$\{base\}\/\$\{locale === 'ro' \? 'ro' : 'en'\}\/\$\{doc\}\.html`;/);
    assert.ok(config.includes(String.raw`/^https:\/\/`), 'https-only base URL');
    assert.match(links, /DOCS\.filter\(\(\{ doc \}\) => getLegalUrl\(doc, locale\) !== null\)/);
    assert.match(links, /legal\.contact/);
  });

  test('Edit Profile, the sign-in screen and the privacy notice use them', () => {
    assert.match(read('src/screens/EditProfileScreen.tsx'), /<LegalLinks \/>/);
    assert.match(read('src/screens/AuthScreen.tsx'), /<LegalAgreementLine \/>/);
    assert.match(read('src/screens/OnboardingScreen.tsx'), /<PrivacyPolicyLink \/>/);
  });
});

// 6. Terms acceptance (legal T-06/T-07): the app's TERMS_VERSION equals the server's, the step is behind
//    EXPO_PUBLIC_TERMS_STEP_ENABLED until the text is reviewed (D-01), and it posts { type: 'terms' }.
describe('terms step', () => {
  test('TERMS_VERSION matches the server and the step is flagged', () => {
    const onboarding = read('src/screens/OnboardingScreen.tsx');
    const server = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
    const clientVersion = Number(onboarding.match(/export const TERMS_VERSION = (\d+);/)?.[1]);
    const serverVersion = Number(server.match(/const TERMS_VERSION = (\d+);/)?.[1]);
    assert.ok(clientVersion >= 1);
    assert.equal(clientVersion, serverVersion);
    assert.match(onboarding, /TERMS_STEP_ENABLED = process\.env\.EXPO_PUBLIC_TERMS_STEP_ENABLED === 'true'/);
    assert.match(onboarding, /type: 'terms', version: TERMS_VERSION/);
    assert.match(read('src/navigation/AppNavigator.tsx'), /needsTermsAcceptance\(profile\)/);
    assert.equal(read('src/context/LocalizationContext.tsx').match(/termsAccept: '/g)?.length, 2);
  });
});

// 7. Release config for v1.0.0 (docs/RELEASE_BUILD.md): version and build numbers, the EAS production
//    profile builds an AAB with no secrets in eas.json, iOS permission prompts exist in en and ro, the app
//    never asks to add photos to the library, and the dev-only note strings stay out of the release bundle.
describe('release config', () => {
  const appConfig = read('app.config.ts');
  const eas = JSON.parse(read('eas.json'));

  test('version 1.0.0 with an iOS buildNumber and an Android versionCode', () => {
    assert.match(appConfig, /^\s*version: "1\.0\.0",/m);
    assert.match(appConfig, /buildNumber: "\d+"/);
    assert.match(appConfig, /versionCode: \d+,/);
    assert.match(appConfig, /runtimeVersion: \{ policy: "appVersion" \}/);
    assert.match(appConfig, /bundleIdentifier: "com\.aroncarola\.drinkmefinal"/);
    assert.match(appConfig, /package: "com\.aroncarola\.drinkmefinal"/);
  });

  test('eas.json: production builds an AAB for the store, preview an APK, no secret-looking env values', () => {
    const { production, preview, development } = eas.build;
    assert.equal(production.android.buildType, 'app-bundle');
    assert.equal(production.distribution, 'store');
    assert.equal(production.autoIncrement, true);
    assert.equal(eas.cli.appVersionSource, 'remote');
    assert.equal(preview.android.buildType, 'apk');
    assert.equal(development.developmentClient, true);
    for (const [name, profile] of Object.entries(eas.build)) {
      for (const [key, value] of Object.entries(profile.env ?? {})) {
        assert.match(key, /^EXPO_PUBLIC_/, `${name}.env.${key}: only public build values belong in eas.json`);
        assert.doesNotMatch(key, /SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ACCOUNT|OPENAI|JWT/i, `${name}.env.${key}`);
        assert.doesNotMatch(String(value), /^(sk-|AIza)|-----BEGIN|"private_key"/, `${name}.env.${key}`);
      }
    }
    assert.ok(production.env.EXPO_PUBLIC_API_URL.startsWith('https://'));
  });

  test('camera and photo prompts exist in en and ro; no NSPhotoLibraryAddUsageDescription; no microphone', () => {
    assert.match(appConfig, /en: "\.\/locales\/en\.json"/);
    assert.match(appConfig, /ro: "\.\/locales\/ro\.json"/);
    for (const lang of ['en', 'ro']) {
      const locale = JSON.parse(read(`locales/${lang}.json`)).ios;
      for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
        assert.ok(typeof locale[key] === 'string' && locale[key].length > 20, `${lang}: ${key}`);
        // Expo writes these into InfoPlist.strings between double quotes.
        assert.doesNotMatch(locale[key], /"/, `${lang}: ${key}`);
      }
      assert.equal(locale.NSPhotoLibraryAddUsageDescription, undefined);
    }
    // As a key (a comment in app.config.ts explains why it is absent).
    assert.doesNotMatch(appConfig, /^\s*"?NSPhotoLibraryAddUsageDescription"?\s*:/m);
    assert.match(appConfig, /"microphonePermission": false/);
    assert.match(appConfig, /"android\.permission\.RECORD_AUDIO"/);
  });

  test('dev note strings live only in DevNoteButton (dropped from release builds)', () => {
    assert.doesNotMatch(read('src/context/LocalizationContext.tsx'), /devNote/);
    assert.match(read('App.tsx'), /const DevNoteButton: [^=]+= __DEV__\s*\?\s*require\('\.\/src\/components\/DevNoteButton'\)/);
    assert.match(read('App.tsx'), /const devLogBridge: [^=]+= __DEV__ \? require\('\.\/src\/lib\/devLogBridge'\) : null;/);
  });
});
