DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.
CIORNĂ v0.2 – 2026-11-22 – trebuie revizuită de un avocat calificat înainte de publicare. Nu reprezintă consultanță juridică. Traducere a `ai-transparency.md`.

# Cum funcționează AI în DrinkMe – Notificare de transparență AI

Versiunea 0.2 · Data intrării în vigoare: [se stabilește la publicare] · Corespunde notificării AI din aplicație, versiunea 1 (`AI_NOTICE_VERSION = 1`, textul de la §9.1) · Operator: Tulbure Aron PFA (DrinkMe), drinkmesocialapp@gmail.com

DrinkMe are două funcții AI opționale: **scanerul de băuturi** și **rețetele AI**. Această pagină explică ce fac, ce nu pot face și ce se întâmplă cu datele tale. Politica de confidențialitate (§5a) este referința juridică pentru datele tale, iar Termenii (§7a) stabilesc regulile de folosire a AI; această pagină este ghidul pe înțelesul tuturor.

## 1. Ce face AI
- **Scanerul:** fotografiezi eticheta unei sticle, doze sau cutii ori un ingredient proaspăt (fruct, plantă aromatică). AI citește eticheta și îți spune ce este: tipul (de exemplu gin, apă tonică, lime) și, acolo unde poate, marca, produsul, procentul de alcool și volumul, cu un scor de încredere. Verifici și corectezi rezultatul înainte să îl adaugi în Smart Bar sau să ceri rețete.
- **Codul de bare:** dacă fotografia nu este clară, poți scana codul de bare. Aceasta nu este AI: căutăm numărul în Open Food Facts, o bază de date alimentară liberă și deschisă.
- **Rețetele AI:** AI scrie rețete de băuturi construite în jurul produsului scanat sau folosind doar ce ai în Smart Bar, plus câteva ingrediente de bază alese de tine (de exemplu gheață, apă, zahăr, sare). Rețetele apar **una câte una**, pe măsură ce sunt create; serverul nostru verifică fiecare rețetă înainte să ți-o arate (§5). Un set include o variantă fără alcool atunci când ingredientele permit.

## 2. Ce AI folosim
- **Modele AI cu ponderi deschise („open-weights”) pe care le rulăm noi înșine**, pe propriul server AI al DrinkMe, împreună cu recunoaștere de text (OCR): în prezent **Qwen3-VL 4B Instruct** pentru fiecare scanare și rețetă și **Qwen3-VL 8B Instruct**, un model mai mare care citește a doua oară o etichetă atunci când primul model nu este sigur. Ambele sunt publicate de echipa Qwen sub licența Apache 2.0. Ambele rulează pe același server DrinkMe; a doua citire nu înseamnă un nou destinatar al fotografiei tale.
- Fotografiile și ingredientele tale **nu sunt trimise niciodată unei companii AI externe** (precum OpenAI sau Google). Serverul nostru AI funcționează în Uniunea Europeană sau în Spațiul Economic European.
- Serverul DrinkMe verifică fiecare răspuns AI înainte să îl vezi (format, ingrediente și regulile de siguranță de la §5). AI nu învață de la tine: fotografiile, ingredientele și raportările tale nu sunt folosite pentru antrenarea vreunui model.
- Putem schimba modelele pentru a îmbunătăți calitatea. Dacă o schimbare îți afectează datele (de exemplu un alt loc de prelucrare), vom actualiza această pagină și Politica de confidențialitate și te vom anunța mai întâi în aplicație.

## 3. Ce nu poate face AI – te rugăm să citești
- **AI poate greși.** Poate citi greșit o etichetă, poate confunda produse sau poate greși procentul de alcool ori volumul. Verifică întotdeauna rezultatul scanării înainte să îl salvezi.
- **Rețetele sunt sugestii, nu rețete testate.** Pot conține greșeli de cantități, pași sau nume de ingrediente. Folosește-ți propria judecată.
- **Alergii și intoleranțe:** AI nu îți cunoaște alergiile. Verifică singur fiecare ingredient (și etichetele produselor pe care le folosești).
- **Nu este un sfat medical, de sănătate sau de nutriție.** Tăria afișată (% vol. și numărul de băuturi standard) este o estimare. Nu te baza pe ea pentru a decide dacă poți conduce, lucra, lua medicamente sau bea în siguranță.
- **Scanerul cunoaște doar ingrediente pentru băuturi.** Nu recunoaște persoane și refuză lucrurile care nu sunt ingrediente pentru băuturi (de exemplu medicamente sau produse de curățenie).

## 4. Cum este marcat conținutul AI
- Fiecare rețetă AI și fiecare rezultat al scanării unei fotografii poartă eticheta **„Generat de AI”** în aplicație – și în timp ce rețetele apar una câte una –, iar rețetele poartă și un marcaj AI citibil automat în datele trimise de serverul nostru către aplicație (Regulamentul UE privind inteligența artificială, Regulamentul (UE) 2024/1689, art. 50).
- Fiecare rețetă afișează această mențiune: *„Rețetă generată de AI. Poate conține greșeli: verifică fiecare ingredient pentru alergii și intoleranțe. Cantitățile sunt pentru o porție. Nu este un sfat medical sau de nutriție.”*
- Rețetele salvate păstrează eticheta „Generat de AI”.
- Rezultatele găsite după codul de bare sunt etichetate „Găsit după codul de bare (Open Food Facts)”.

## 5. Reguli de siguranță și avertismente pentru rețete
Serverul nostru elimină sau etichetează rețetele AI înainte să le vezi – fiecare rețetă separat, înainte să apară:
- **Eliminate:** mai mult de 2 băuturi standard per porție; jocuri de băut, provocări cu shoturi, limbaj despre consum excesiv sau „să te îmbeți”; foc, gheață carbonică sau inhalarea vaporilor; medicamente, droguri, suplimente sau ingrediente care nu sunt alimente; orice mențiune despre condus într-o rețetă cu alcool; ingrediente pe care nu le ai (rețete din Smart Bar); repetări.
- **Avertisment – ou crud:** „Conține ou crud: nerecomandat în sarcină, copiilor mici, vârstnicilor sau persoanelor cu imunitate scăzută.”
- **Avertisment – băutură energizantă cu alcool:** „Băutură energizantă cu alcool: cofeina poate ascunde cât de băut ești. Nu recomandăm această combinație.”
- **Fiecare rețetă cu alcool** afișează: „Consumă responsabil. Doar 18+. Nu conduce după ce ai băut și evită alcoolul dacă ești însărcinată, iei medicamente sau nu ai vârsta legală.”
Aceste reguli reduc riscul, dar nu îl pot elimina. Dacă vezi ceva nesigur, raportează (§7).

## 6. Vârsta și limitele
- **Doar 18+.** Funcțiile AI sunt disponibile doar utilizatorilor conectați care au confirmat că au cel puțin 18 ani. Acolo unde vârsta legală pentru consumul de alcool din țara ta este mai mare, trebuie să ai și acea vârstă pentru a folosi rețete cu alcool (vezi `age-and-alcohol.ro.md`). Serverul nostru refuză rețetele cu alcool oricui nu și-a confirmat vârsta. DrinkMe nu vinde niciodată alcool.
- **Limite zilnice.** Fiecare cont poate face cel mult **20 de scanări foto și 10 seturi de rețete pe zi**; există și o limită pe oră și poate rula o singură cerere AI în același timp. Căutările după codul de bare au propria limită. Aplicația îți spune când atingi o limită. Putem modifica limitele și vom actualiza această pagină când o facem.

## 7. Raportează un răspuns AI greșit, nesigur sau ofensator
Atinge **Raportează** pe rețetă sau pe rezultatul scanării și alege un motiv: ofensator sau nepotrivit; nesigur sau încurajează consumul excesiv; ingredient, cantitate sau produs greșit; altceva. Rămâi în aplicație.
- **Ținte:** verificăm raportările despre răspunsuri **nesigure sau ofensatoare** în **24 de ore**, iar pe cele despre răspunsuri **greșite** sau „altceva” în **72 de ore**.
- Folosim raportările pentru a corecta problemele și pentru a ne îmbunătăți regulile de siguranță. Nu răspundem individual la fiecare raportare; dacă vrei un răspuns, scrie la **drinkmesocialapp@gmail.com** cu numele rețetei (o captură de ecran ajută).
- Ce păstrează o raportare: tipul răspunsului (rețetă sau scanare), motivul, identificatorul și numele rețetei sau categoria și starea scanării, identificatorul tău de utilizator și ora – fără fotografie. Se păstrează aproximativ 90 de zile și se șterge mai devreme dacă îți ștergi contul (Politica de confidențialitate §7).

## 8. Fotografiile și datele tale (rezumat – detalii complete în Politica de confidențialitate §5a)
- **Fotografiile nu sunt păstrate niciodată.** Fotografia scanată este prelucrată în memorie pe serverul nostru AI, doar pentru a-ți răspunde, și ștearsă imediat ce răspunsul este gata. Nu este stocată, nu este scrisă în jurnale și nu este folosită pentru antrenarea AI. DrinkMe nu oferă o opțiune de păstrare a fotografiilor scanate.
- **Codul de bare:** doar numărul codului de bare ajunge la Open Food Facts – fără nume, cont sau adresă IP.
- **Rețetele salvate:** păstrate până le elimini sau îți ștergi contul (cel mult 200).
- **Unde:** serverele DrinkMe și serverul nostru AI, operate pentru noi de un furnizor de găzduire din UE/SEE, pe baza unui acord de prelucrare a datelor. Nicio companie AI externă.

## 9. Texte din aplicație (ciorne – aplicația trebuie să afișeze exact formularea finală aprobată)

### 9.1 Notificarea AI (afișată înainte de prima utilizare; butonul „Am înțeles”)
**Titlu:** Înainte să folosești AI
**Text:**
Scanerul și rețetele DrinkMe folosesc AI. Fotografia ta ajunge la propriul server AI al DrinkMe, unde modele cu ponderi deschise, rulate de noi, o citesc – nicio companie AI externă nu o primește. Fotografia este folosită doar pentru a-ți răspunde și nu este păstrată. Dacă scanezi un cod de bare, doar numărul este căutat în Open Food Facts.
AI poate greși: verifică ce a găsit scanerul și verifică fiecare ingredient din rețete pentru alergii și intoleranțe. Rețetele sunt sugestii, nu sfaturi medicale sau de nutriție. Rețetele cu alcool sunt pentru adulți 18+: consumă responsabil și nu conduce niciodată după ce ai băut. Tot ce creează AI este marcat „Generat de AI” și poți raporta orice răspuns.
**Linkuri:** Politica de confidențialitate · Cum funcționează AI în DrinkMe (această pagină)
**Buton:** Am înțeles

### 9.2 Acordul pentru păstrarea fotografiilor – nu este oferit la lansare
DrinkMe nu păstrează fotografiile scanate și **nu** oferă opțiunea „Ajută la îmbunătățirea scannerului” (deciziile D-21 și D-22 din 2026-11-22). Comutatorul este ascuns în aplicație cât timp indicatorul de server `AI_PHOTO_OPT_IN_ENABLED` este dezactivat (implicit). Nu se folosește niciun text de consimțământ. Oferirea ulterioară a opțiunii necesită o nouă decizie a lui John, o evaluare de impact actualizată (`internal/dpia-ai.md`), un text de consimțământ nou, redactat și revizuit, cu o versiune nouă de consimțământ, și actualizarea acestei pagini, a Politicii de confidențialitate, a declarațiilor din magazinele de aplicații și a notificării AI. (Textul de consimțământ din 2026-11-16 se păstrează doar în istoricul acestui fișier.)

### 9.3 Mențiunea de pe rețete (pe fiecare rețetă)
Rețetă generată de AI. Poate conține greșeli: verifică fiecare ingredient pentru alergii și intoleranțe. Cantitățile sunt pentru o porție. Nu este un sfat medical sau de nutriție.

## 10. Modificări și contact
Vom actualiza această pagină când funcțiile AI se schimbă și te vom anunța în aplicație dacă schimbarea îți afectează datele. Întrebări: drinkmesocialapp@gmail.com.

---
Faptele provin din cod: `internal/data-inventory.md` §8 (fișier:linie). Analiza juridică: `internal/dpia-screening.md` („EU AI Act classification”) și `internal/dpia-ai.md`. Licențele modelelor: fișele Qwen/Qwen3-VL-4B-Instruct (verificată la 2026-11-16) și Qwen/Qwen3-VL-8B-Instruct (Apache-2.0, verificată la 2026-11-22) pe Hugging Face – DE VERIFICAT pachetele Ollama. Art. 50 din AI Act se aplică de la 2 august 2026 (reverificat la 2026-11-22).
**Starea de lansare (deciziile din 2026-11-22):** această versiune descrie starea de după modificările de cod LC-49–LC-53 (`compliance-matrix.md`); se publică doar după livrarea lor. Puncte deschise: linkuri în notificarea AI (LC-43), contractul pentru serverul GPU din UE (LC-45).
