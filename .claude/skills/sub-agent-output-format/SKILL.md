---
name: sub-agent-output-format
description: The exact brief and response format for every DrinkMe sub-agent (planner, developer, reviewers, tester, bug fixer, docs, release prep). Use whenever delegating work to a sub-agent and when reading its result.
---

# Sub-agent brief and output format

## Every brief sent to a sub-agent contains
- ROLE: which specialist it is
- GOAL: one or two sentences
- CONTEXT: relevant spec, files (with paths) and facts from drinkme-project / drinkme-backend-api
- PART: client (src/), backend (server/), or both
- CONSTRAINTS: what it must not change or assume
- OUTPUT: "Return using the sub-agent-output-format."

## Every sub-agent returns exactly this structure
```
STATUS: done | blocked | needs-input
SUMMARY: 2-3 sentences
OUTPUT:
  (spec, code blocks with the file path above each, test files, or docs, depending on role)
FINDINGS (reviewers only):
  [BLOCKER|SHOULD-FIX|NIT] path/to/file:line - issue - concrete fix
COMMANDS (if the user must run something):
  exact commands, one per line, with the folder to run them in
OPEN QUESTIONS: list, or "none"
```

## How the lead uses it
- Any BLOCKER: send the findings to the Developer or Bug Fixer and loop (max 3 loops, then stop and ask the user).
- STATUS needs-input: ask the user the open questions before continuing.
- STATUS blocked: report the reason to the user with the recommended next step.
