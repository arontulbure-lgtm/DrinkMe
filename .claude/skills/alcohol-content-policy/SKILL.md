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
7. **Reviews.** The Code Reviewer and Security Reviewer flag any violation of these rules as a BLOCKER.
