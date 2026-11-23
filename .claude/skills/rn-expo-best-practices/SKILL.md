---
name: rn-expo-best-practices
description: React Native and Expo SDK 58 coding and review standards for the DrinkMe client. Use when writing, reviewing or debugging screens, components, navigation, data fetching or performance.
---

# React Native / Expo best practices (DrinkMe client)

## Styling
- Use React Native StyleSheet with the design-system colors from drinkme-project. Do not introduce NativeWind/Tailwind classes.
- Keep existing style names; add new styles at the bottom of the file's StyleSheet.

## Data fetching
- All API calls go through `apiFetch` (src/lib/api.ts); never call fetch directly to the backend or handle the JWT manually.
- Use TanStack Query: useQuery for reads, useMutation for writes, and invalidate the affected query keys after a mutation.
- Types for request and response bodies live in src/types/api.ts.

## Lists and performance
- Use FlatList for any list longer than ~20 items. Never map a long array inside a ScrollView.
- Stable keyExtractor; avoid inline anonymous renderItem in large or frequently updated lists.
- Use React.memo / useMemo / useCallback only where re-renders are measurable.
- Debounce search input (Explore already uses 300 ms).

## Screens
- Every screen handles loading, empty, error and offline states.
- Respect safe areas and the keyboard (KeyboardAvoidingView).
- Check iOS vs Android differences: permissions, back button, shadows.
- Guard against missing data (`?.` and `??`), e.g. `name?.toUpperCase() ?? 'U'`.

## Expo SDK 58 specifics
- Use APIs that match Expo SDK 58. When unsure, check the Expo docs with web search before writing code.
- Respect the critical pinned versions in drinkme-project; never suggest upgrading them as part of a feature.
- Expo Go cannot do Google Sign-In; features that need native config require a development build (`npx expo run:android` / EAS development profile).
- Client config comes from `EXPO_PUBLIC_*` variables via app.config.ts. Remember that EXPO_PUBLIC_ values ship inside the app bundle, so never put real secrets there.

## Localization
- Every new user-facing string goes through LocalizationContext with both `ro` and `en` translations.

## Accessibility
- Interactive elements have accessibilityLabel and a touch target of at least 44×44.
- The primary violet (#8B5FBF) is for accents and buttons, not long body text on black.

## TypeScript
- Strict mode. No `any` without a comment explaining why.
- Type navigation params and API payloads.
