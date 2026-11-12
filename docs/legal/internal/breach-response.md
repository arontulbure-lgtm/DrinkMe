DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Personal data breach response (internal)

Law: GDPR Art. 33 (notify the supervisory authority within 72 hours of becoming aware, unless unlikely to result in a risk), Art. 34 (tell users without undue delay when the risk is high), Art. 33(5) (document every breach). Lead authority: ANSPDCP (online breach notification form on dataprotection.ro – VERIFY current form). UK users: ICO within 72 h if UK is in scope. US states: state breach laws (mostly triggered by email + password or government ids; VERIFY per state). Checked 2026-11-12 (knowledge; not re-fetched).

## Steps
1. **Contain** (hour 0): rotate `JWT_SECRET` (signs everyone out), rotate Firebase service-account key and API keys as needed, block the attacker, take a database copy for evidence (keep it ≤ 30 days unless needed for legal claims, document why).
2. **Assess** (within 24 h): what data, how many users, which countries, likelihood and severity of harm (photos, emails, private Smart Bar, partner graph).
3. **Decide and notify** (within 72 h of awareness): ANSPDCP unless unlikely to result in a risk; record the reasoning either way. Phased notification is allowed if facts are incomplete.
4. **Tell users** if high risk: plain-language email from drinkmesocialapp@gmail.com plus an in-app notice; say what happened, likely consequences, what we did, what they should do (e.g. change password), contact.
5. **Stores**: Apple/Google if their policies require (VERIFY).
6. **Record** in the breach register (date, facts, effects, actions, notifications), keep 5 years (proposal).
7. **Review** the cause; add a regression test.

Contacts to keep up to date: John (operator), developer on call, hosting provider support, lawyer.
