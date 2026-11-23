---
name: alcohol-content-policy
description: Responsible-drinking and app-store policy rules for DrinkMe content. Use for features involving alcoholic drinks, onboarding, age checks, sharing, recommendations or user-generated content, and in every security or release review.
---

# Alcohol content policy

1. **Age gate.** Users must confirm they are of legal drinking age (18 in Romania) before alcoholic content is shown. Store the age state on the server and enforce it in the API, not only in the UI.
2. **Non-alcoholic drinks are first-class.** Mocktails, coffee, tea and other non-alcoholic drinks get equal placement and quality. Posts carry an `isAlcoholic` flag; use it for filtering, never to hide non-alcoholic content.
3. **No encouragement of excessive drinking.** No drinking challenges, "how drunk" ratings, streaks for alcohol consumption, or content linking alcohol to performance or social success.
4. **User-generated content.** Posts and comments need a report/flag option and a way to remove content.
5. **Store rules.** Before release features, check the current Apple App Store and Google Play policies for alcohol-related apps (age rating, restricted regions, no in-app alcohol sales without licensing).
6. **GDPR.** Drink preferences, locations and social connections are personal data. Collect only what a feature needs and plan for account deletion (SEC-G).
7. **AI-generated recipes.** Every generated recipe passes the server-side safety rules S1-S13 in
   `.claude/skills/recipe-schema/SKILL.md` before anyone sees it: at most 2 standard drinks per serving; no shots
   challenge, drinking game or binge framing; no flaming, dry ice or inhalation; raw egg only with a warning; a
   warning when energy drinks are mixed with alcohol; no medicines or non-food ingredients; a responsible-drinking
   line on every alcoholic recipe; never a hint of drinking and driving. Every batch offers at least one mocktail
   when the ingredients allow it. Users not confirmed 18+ get mocktails only. Every recipe is labelled "AI-generated".
   Prompts never ask for "strong", "party" or "get the night going" drinks.
8. **Reviews.** The Code Reviewer and Security Reviewer flag any violation of these rules as a BLOCKER.
