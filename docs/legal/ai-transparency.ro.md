DRAFT v0.1 – 2026-11-16 – to be reviewed by a qualified lawyer before publication. Not legal advice.
CIORNĂ v0.1 – 2026-11-16 – trebuie revizuită de un avocat calificat înainte de publicare. Nu reprezintă consultanță juridică. Traducere a `ai-transparency.md`.

# Cum funcționează AI în DrinkMe – Notificare de transparență AI

Versiunea 0.1 · Data intrării în vigoare: [se stabilește la publicare] · Corespunde notificării AI din aplicație, versiunea 1 (`AI_NOTICE_VERSION = 1`) · Operator: Tulbure Aron PFA (DrinkMe), drinkmesocialapp@gmail.com

DrinkMe are două funcții AI opționale: **scanerul de băuturi** și **rețetele AI**. Această pagină explică ce fac, ce nu pot face și ce se întâmplă cu datele tale. Politica de confidențialitate (§5a) este referința juridică pentru datele tale; această pagină este ghidul pe înțelesul tuturor.

## 1. Ce face AI
- **Scanerul:** fotografiezi eticheta unei sticle, doze sau cutii ori un ingredient proaspăt (fruct, plantă aromatică). AI citește eticheta și îți spune ce este: tipul (de exemplu gin, apă tonică, lime) și, acolo unde poate, marca, produsul, procentul de alcool și volumul, cu un scor de încredere. Verifici și corectezi rezultatul înainte să îl adaugi în Smart Bar sau să ceri rețete.
- **Codul de bare:** dacă fotografia nu este clară, poți scana codul de bare. Aceasta nu este AI: căutăm numărul în Open Food Facts, o bază de date alimentară liberă și deschisă.
- **Rețetele AI:** AI scrie 3–5 rețete de băuturi construite în jurul produsului scanat sau folosind doar ce ai în Smart Bar, plus câteva ingrediente de bază alese de tine (de exemplu gheață, apă, zahăr, sare). Fiecare serie include o variantă fără alcool atunci când ingredientele permit.

## 2. Ce AI folosim
- Un **model AI cu ponderi deschise** („open-weights”; în prezent Qwen3-VL 4B Instruct, publicat de echipa Qwen sub licența Apache 2.0), împreună cu recunoaștere de text (OCR). **Îl rulăm noi înșine**, pe propriul server AI al DrinkMe. Fotografiile și ingredientele tale **nu sunt trimise unei companii AI externe**, precum OpenAI sau Google.
- Serverul DrinkMe verifică fiecare răspuns AI înainte să îl vezi (format, ingrediente și regulile de siguranță de la §5). AI nu învață de la tine în timp ce îl folosești.
- Putem schimba modelul pentru a îmbunătăți calitatea. Dacă o schimbare îți afectează datele (de exemplu un alt furnizor), vom actualiza această pagină și Politica de confidențialitate și te vom anunța mai întâi în aplicație.

## 3. Ce nu poate face AI – te rugăm să citești
- **AI poate greși.** Poate citi greșit o etichetă, poate confunda produse sau poate greși procentul de alcool ori volumul. Verifică întotdeauna rezultatul scanării înainte să îl salvezi.
- **Rețetele sunt sugestii, nu rețete testate.** Pot conține greșeli de cantități, pași sau nume de ingrediente. Folosește-ți propria judecată.
- **Alergii și intoleranțe:** AI nu îți cunoaște alergiile. Verifică singur fiecare ingredient (și etichetele produselor pe care le folosești).
- **Nu este un sfat medical, de sănătate sau de nutriție.** Tăria afișată (% vol. și numărul de băuturi standard) este o estimare. Nu te baza pe ea pentru a decide dacă poți conduce, lucra, lua medicamente sau bea în siguranță.
- **Scanerul cunoaște doar ingrediente pentru băuturi.** Nu recunoaște persoane și refuză lucrurile care nu sunt ingrediente pentru băuturi (de exemplu medicamente sau produse de curățenie).

## 4. Cum este marcat conținutul AI
- Fiecare rețetă AI și fiecare rezultat al scanării unei fotografii poartă eticheta **„Generat de AI”** în aplicație, iar rețetele poartă și un marcaj AI citibil automat în datele trimise de serverul nostru către aplicație (Regulamentul UE privind inteligența artificială, Regulamentul (UE) 2024/1689, art. 50).
- Fiecare rețetă afișează această mențiune: *„Rețetă generată de AI. Poate conține greșeli: verifică fiecare ingredient pentru alergii și intoleranțe. Cantitățile sunt pentru o porție.”*
- Rezultatele găsite după codul de bare sunt etichetate „Găsit după codul de bare (Open Food Facts)”.

## 5. Reguli de siguranță și avertismente pentru rețete
Serverul nostru elimină sau etichetează rețetele AI înainte să le vezi:
- **Eliminate:** mai mult de 2 băuturi standard per porție; jocuri de băut, provocări cu shoturi, limbaj despre consum excesiv sau „să te îmbeți”; foc, gheață carbonică sau inhalarea vaporilor; medicamente, droguri, suplimente sau ingrediente care nu sunt alimente; orice mențiune despre condus într-o rețetă cu alcool; ingrediente pe care nu le ai (rețete din Smart Bar); repetări.
- **Avertisment – ou crud:** „Conține ou crud: nerecomandat în sarcină, copiilor mici, vârstnicilor sau persoanelor cu imunitate scăzută.”
- **Avertisment – băutură energizantă cu alcool:** „Băutură energizantă cu alcool: cofeina poate ascunde cât de băut ești. Nu recomandăm această combinație.”
- **Fiecare rețetă cu alcool** afișează: „Consumă responsabil. Doar 18+. Nu conduce după ce ai băut și evită alcoolul dacă ești însărcinată, iei medicamente sau nu ai vârsta legală.”
Aceste reguli reduc riscul, dar nu îl pot elimina. Dacă vezi ceva nesigur, spune-ne (§7).

## 6. Vârsta: doar 18+
Funcțiile AI sunt disponibile doar utilizatorilor conectați care au confirmat că au cel puțin 18 ani. Acolo unde vârsta legală pentru consumul de alcool din țara ta este mai mare, trebuie să ai și acea vârstă pentru a folosi rețete cu alcool (vezi `age-and-alcohol.ro.md`). Serverul nostru refuză rețetele cu alcool oricui nu și-a confirmat vârsta. DrinkMe nu vinde niciodată alcool.

## 7. Raportează un răspuns AI greșit, nesigur sau ofensator
[DE ADĂUGAT CÂND SE LANSEAZĂ LC-39: „Atinge **Raportează** pe rețetă sau pe rezultatul scanării și alege un motiv. Rămâi în aplicație.”]
Până atunci: scrie la **drinkmesocialapp@gmail.com** cu numele rețetei (o captură de ecran ajută) și ce nu este în regulă. Folosim raportările pentru a ne îmbunătăți regulile de siguranță și pentru a elimina problemele; răspundem în [TERMEN – decizia D-25].

## 8. Fotografiile și datele tale (rezumat – detalii complete în Politica de confidențialitate §5a)
- **Implicit:** fotografia scanată este prelucrată în memorie pe serverul nostru și eliminată după ce primești răspunsul. Nu este stocată și nu este scrisă în jurnale.
- **Codul de bare:** doar numărul codului de bare ajunge la Open Food Facts – fără nume, cont sau adresă IP.
- **Rețetele salvate:** păstrate până le elimini sau îți ștergi contul (cel mult 200).
- **„Ajută la îmbunătățirea scannerului”:** dezactivată implicit. Doar dacă o activezi păstrăm fotografiile scanate cel mult 90 de zile (textul de mai jos). Dezactivarea o șterge.

## 9. Texte din aplicație (ciorne – aplicația trebuie să afișeze exact formularea finală aprobată)

### 9.1 Notificarea AI (afișată înainte de prima utilizare; butonul „Am înțeles”)
**Titlu:** Înainte să folosești AI
**Text:**
Scanerul și rețetele DrinkMe folosesc AI. Fotografia ta ajunge la propriul server AI al DrinkMe, unde un model cu ponderi deschise, rulat de noi, o citește – nicio companie AI externă nu o primește. Fotografia este folosită doar pentru a-ți răspunde și nu este stocată, cu excepția cazului în care activezi „Ajută la îmbunătățirea scannerului” din Setări AI. Dacă scanezi un cod de bare, doar numărul este căutat în Open Food Facts.
AI poate greși: verifică ce a găsit scanerul și verifică fiecare ingredient din rețete pentru alergii și intoleranțe. Rețetele sunt sugestii, nu sfaturi medicale sau de nutriție. Rețetele cu alcool sunt pentru adulți 18+: consumă responsabil și nu conduce niciodată după ce ai băut. Tot ce creează AI este marcat „Generat de AI”.
**Linkuri:** Politica de confidențialitate · Cum funcționează AI în DrinkMe (această pagină)
**Buton:** Am înțeles

### 9.2 Acordul pentru fotografii – textul de consimțământ (Setări AI; comutator dezactivat implicit)
**Titlu:** Ajută la îmbunătățirea scannerului
**Text:**
Dezactivat, cu excepția cazului în care îl activezi. Când este activat, DrinkMe păstrează fiecare fotografie pe care o scanezi, împreună cu ce a recunoscut scanerul, cel mult 90 de zile, doar pentru a testa și îmbunătăți cât de bine recunoaște scanerul băuturile. Le poate vedea doar echipa DrinkMe; nu sunt arătate niciodată altor utilizatori, nu sunt vândute și nu sunt folosite pentru publicitate. Fotografiază doar produsul – evită persoane, fețe și documente. Camera telefonului poate adăuga locul în care a fost făcută fotografia; dezactivează etichetarea cu locația dacă nu vrei să fie păstrată. Poți dezactiva oricând opțiunea: fotografiile deja păstrate se șterg imediat și se șterg și dacă îți ștergi contul. Folosirea scanerului nu depinde de această alegere. Detalii: Politica de confidențialitate.
**Eticheta comutatorului (accesibilitate):** Păstrează fotografiile scanate pentru a îmbunătăți scanerul

*Variantă dacă decizia D-24 permite antrenarea modelului:* înlocuiește „doar pentru a testa și îmbunătăți cât de bine recunoaște scanerul băuturile” cu „pentru a testa scanerul și pentru a antrena propriul nostru model AI să recunoască mai bine băuturile (fotografiile nu sunt date nimănui altcuiva)”.

### 9.3 Mențiunea de pe rețete (pe fiecare rețetă)
Rețetă generată de AI. Poate conține greșeli: verifică fiecare ingredient pentru alergii și intoleranțe. Cantitățile sunt pentru o porție. Nu este un sfat medical sau de nutriție.

## 10. Modificări și contact
Vom actualiza această pagină când funcțiile AI se schimbă și te vom anunța în aplicație dacă schimbarea îți afectează datele. Întrebări: drinkmesocialapp@gmail.com.

---
Faptele provin din cod: `internal/data-inventory.md` §8 (fișier:linie). Analiza juridică: `internal/dpia-screening.md` („EU AI Act classification”). Licența modelului: fișa modelului Qwen/Qwen3-VL-4B-Instruct pe Hugging Face (Apache-2.0), verificată la 2026-11-16 – VERIFY pachetul Ollama. Puncte deschise: raportare în aplicație (LC-39), evidența consimțământului (LC-37), eliminarea EXIF (LC-38), linkuri în notificarea AI (LC-43).
