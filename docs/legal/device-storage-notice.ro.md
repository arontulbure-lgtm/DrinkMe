DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.
CIORNĂ v0.2 – 2026-11-22 – trebuie revizuită de un avocat calificat înainte de publicare. Nu reprezintă consultanță juridică. Traducere a `device-storage-notice.md`.

# Notificare privind stocarea pe dispozitiv

Versiunea 0.2 · Data intrării în vigoare: [se stabilește la publicare]

DrinkMe stochează câteva elemente pe telefonul tău. Toate sunt **strict necesare** pentru furnizarea serviciului pe care l-ai cerut, deci nu este necesar consimțământul (Directiva 2002/58/CE art. 5 alin. (3); Legea 506/2004 art. 4 alin. (5)). **Nu folosim tehnologii de urmărire, publicitate sau statistici.**

| Ce | Unde pe telefon | De ce | Cât timp |
|---|---|---|---|
| Tokenul de conectare DrinkMe | Stocare securizată (iOS Keychain / Android Keystore) | Te menține conectat la serverul nostru | Până te deconectezi sau 30 de zile |
| Sesiunea de conectare Firebase | Stocarea aplicației | Te menține conectat | Până te deconectezi sau dezinstalezi |
| Limba aleasă | Stocarea aplicației | Afișează aplicația în limba ta | Până o schimbi sau dezinstalezi |
| Momentul ultimului email de verificare trimis | Stocarea aplicației | Evită trimiterea repetată de emailuri | Până dezinstalezi |
| Imaginile vizualizate | Memoria cache a aplicației | Încărcare mai rapidă | Aproximativ 1 zi |
| Token de integritate a aplicației (doar după ce activăm verificările de integritate) | Stocarea aplicației, gestionată de biblioteca Firebase App Check | Arată serverului nostru că cererile vin din aplicația DrinkMe autentică (securitate) | De scurtă durată; reînnoit automat – VERIFY durata exactă la adăugarea bibliotecii |

**Permisiuni:** camera și galeria foto, doar când alegi să adaugi o fotografie (și, după activarea funcțiilor AI, camera când scanezi o etichetă sau un cod de bare; DrinkMe nu salvează fotografiile scanate pe telefon). DrinkMe nu cere acces la locație; căutarea locurilor trimite textul introdus de tine către Google Maps Platform.
**Notificări push:** nu sunt folosite; notificările apar în aplicație.
**Conținut de la terți:** fotografiile de profil Google sunt încărcate direct de pe serverele Google, care văd adresa ta IP.

Dacă vom adăuga vreodată statistici, publicitate sau raportarea erorilor, vom actualiza această notificare și vom cere consimțământul acolo unde este necesar.
