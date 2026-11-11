import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const translations = {
  en: {
    common: {
      retry: 'Try again',
      loadMore: 'Load more',
      loadMoreError: 'Could not load more. Please try again.',
      serviceUnavailable: 'This is temporarily unavailable. Please try again later.',
      tooManyRequests: 'Too many requests. Please try again in a few minutes.',
      imageQuotaReached: 'You have reached your photo storage limit, so this photo could not be added.',
      cheers: 'Cheers',
      cheersVerb: 'Cheer',
      cheersCount: '{{count}} Cheers',
      unknownUser: 'DrinkMe user',
      commentPlaceholder: 'Leave a comment…',
      addPartner: 'Add partner',
      you: 'You',
      comment: 'Comment',
      save: 'Save',
      saved: 'Saved',
      cancel: 'Cancel',
      close: 'Close',
      moreOptions: 'More options',
    },
    report: {
      action: 'Report',
      title: 'Why are you reporting this?',
      reason: {
        spam: 'Spam',
        harassment: 'Harassment',
        underage: 'Involves a minor',
        dangerous_drinking: 'Encourages dangerous drinking',
        mislabeled_alcohol: 'Wrongly marked as non-alcoholic',
        other: 'Something else',
      },
      success: 'Thanks. We will review your report.',
      failed: 'Could not send the report. Please try again.',
      dailyLimit: "You have reached today's report limit. Please try again tomorrow.",
    },
    block: {
      action: 'Block user',
      confirm: "You will not see each other's posts or comments, and any drink partnership will end.",
      unblock: 'Unblock',
      listTitle: 'Blocked users',
      empty: 'You have not blocked anyone.',
      failed: 'Could not update the block. Please try again.',
      loadError: 'Could not load blocked users.',
      limitReached: 'You have reached the limit of blocked users. Unblock someone to block another user.',
      accountSection: 'Account',
    },
    partners: {
      requested: 'Requested',
      accept: 'Accept',
      decline: 'Decline',
      requests: 'Requests',
      noRequests: 'No pending requests.',
      remove: 'Remove',
      removeConfirm: 'Remove this drink partner?',
      private: "Only this user's drink partners can see this list.",
      loadError: 'Could not load drink partners.',
      requestsLoadError: 'Could not load partner requests.',
      requestLimit: 'You have reached the limit for partner requests. Please try again later.',
    },
    comment: {
      delete: 'Delete comment',
      deleteFailed: 'Could not delete the comment. Please try again.',
      actions: 'Comment options',
    },
    post: {
      actions: 'Post options',
      delete: 'Delete post',
      deleteConfirm: 'Delete this post and its comments? This cannot be undone.',
      deleteFailed: 'Could not delete the post. Please try again.',
      notFound: 'This post is no longer available.',
      loadError: 'Could not load this post.',
    },
    errors: {
      cheerFailed: 'Failed to send cheers. Please try again.',
      saveFailed: 'Failed to save post. Please try again.',
      commentFailed: 'Failed to add comment. Please try again.',
      commentDailyLimit: 'You have reached the comment limit for today. Please try again tomorrow.',
      partnerFailed: 'Could not update drink partner. Please try again.',
    },
    auth: {
      title: 'DrinkMe',
      subtitleSignIn: 'Welcome back',
      subtitleSignUp: 'Create your account',
      emailPlaceholder: 'Email',
      passwordPlaceholder: 'Password',
      signIn: 'Sign In',
      signUp: 'Sign Up',
      loading: 'Loading...',
      toggleToSignIn: 'Already have an account? Sign in',
      toggleToSignUp: "Don’t have an account? Sign up",
      errorTitle: 'Error',
      errorMessage: 'Please fill in all fields',
    },
    home: {
      sections: {
        feed: 'Drink partners feed',
        emptyFeedTitle: 'No posts yet',
        emptyFeedSubtitle:
          'Follow more drink partners or share your first review to see activity here.',
        createFirstPost: 'Create first post',
        feedError: 'Could not load your feed.',
      },
    },
    ageGate: {
      title: 'DrinkMe is for adults',
      body: 'DrinkMe is for people aged 18 or over. Confirm your age to continue.',
      confirm: 'I am 18 or older',
      leaveHint: 'Not 18 yet? You can log out, or delete your account.',
      logout: 'Log out',
      deleteAccount: 'Delete account',
      banner: 'Confirm you are 18 or older to use DrinkMe.',
      bannerAction: 'Confirm age',
      required: 'Confirm you are 18 or older to continue.',
      confirmFailed: 'Could not save your answer. Please try again.',
      scannerIntro:
        'Point your camera at any bottle or label and let the AI instantly identify the product and suggest drink recipes crafted just for you.',
      scannerRecognition: 'Snap a photo or pick one from your gallery — our AI identifies drinks and mixers in seconds.',
      scannerRecipes: 'Once the product is detected, get 5 personalised drink recipes with ingredients and step-by-step instructions.',
      recipesIntro: 'Select ingredients from your bar, tap Generate, and our AI will craft personalised drink recipes matched to exactly what you have on hand.',
      recipesFeature: 'Get 5 tailored drink recipes instantly',
      itemNamePlaceholder: 'Item name (e.g., Lemonade, Tonic)',
    },
    session: {
      errorTitle: 'Could not connect',
      errorBody: 'We could not open your account. Check your connection and try again.',
    },
    verifyEmail: {
      title: 'Check your email',
      body: 'We sent a confirmation link to {{email}}.',
      resend: 'Send again',
      confirmed: 'I have verified',
      notYet: 'Your email is not verified yet.',
      sendFailed: 'Could not send the email. Please try again later.',
      signInAgain: 'Your email is confirmed. Please sign in again to continue.',
    },
    deleteAccount: {
      action: 'Delete account',
      warning: 'This permanently deletes your profile, posts, comments, saved posts and Smart Bar. Backup copies are removed within 40 days.',
      typePrompt: 'Type DELETE to confirm.',
      confirmWord: 'DELETE',
      passwordPrompt: 'Enter your password.',
      wrongPassword: 'Incorrect password.',
      failed: 'Could not delete your account. Please try again.',
      done: 'Your account has been deleted.',
      partial: 'Your data has been deleted. Removing your sign-in did not finish, and we will retry it automatically.',
      checking: 'We could not confirm the result. We are checking your account now.',
    },
    explore: {
      loadError: 'Could not load drinks.',
      title: 'Explore',
      searchPlaceholder: 'Search drinks, venues, or friends',
      tipUsers: 'Tip: search people with @username',
      tipPlaces: 'Search places by city name',
      searchMinChars: 'Type at least 2 characters to search.',
      filters: {
        all: 'All',
        cocktail: 'Cocktails',
        wine: 'Wine',
        beer: 'Beer',
        nonAlcoholic: 'Non-alcoholic',
      },
      sections: {
        users: 'Users',
        searchResults: 'Results for "{{query}}"',
        noDrinksTitle: 'No drinks found',
        noDrinksSubtitle: 'Try another keyword or check the spelling.',
        trending: 'Trending now',
        discover: 'Discover',
        tastingTitle: 'Host a tasting',
        tastingSubtitle:
          'Plan a private event with your friends directly in the app (coming soon).',
        partnersTitle: 'Featured venues',
        partnersSubtitle:
          'DrinkMe partners in Bucharest, Cluj, and Timișoara offer discounts to beta testers.',
        unknownLocation: 'Unknown location',
        noUsersTitle: 'No users found',
        noUsersSubtitle: 'Try @username format or invite more drink partners.',
      },
    },
    profile: {
      title: 'Profile',
      avatarTooLarge: 'This photo is too large. Please choose one under 2 MB.',
      avatarInvalidFormat: 'Use a JPEG, PNG or WebP photo.',
      avatarUploadError: 'Could not update your photo. Please try again.',
      posts: 'Posts',
      saved: 'Saved',
      drinkPartners: 'Drink Partners',
      noPartners: 'No drink partners yet',
      following: 'Following',
      edit: 'Edit profile',
      emptyDrinks: 'No drinks posted yet',
      createFirstPost: 'Create first post',
      settings: 'Settings',
      logoutConfirm: 'Are you sure you want to logout?',
      loadError: 'Could not load this profile.',
      notFound: 'This profile is not available.',
      postsLoadError: 'Could not load these posts.',
      retry: 'Try again',
      logout: 'Logout',
      cancel: 'Cancel',
      language: 'App language',
    },
    smartBar: {
      title: 'Smart Bar',
      tabs: {
        inventory: 'Inventory',
        recipes: 'Recipes',
        saved: 'Saved',
      },
      addFirst: 'Add first ingredient',
      inventoryEmptyTitle: 'Your bar is empty',
      inventoryEmptySubtitle: 'Add favorite bottles to receive personalized recipe suggestions.',
      savedEmptyTitle: 'No saved posts',
      savedEmptySubtitle: 'Save drink posts to see them here.',
      addItemTitle: 'Add to your bar',
      itemNamePlaceholder: 'Item name (e.g., Whiskey, Vodka)',
      quantityPlaceholder: 'Quantity (e.g., 1, 750ml)',
      addItem: 'Add item',
      itemLimit: 'Your bar is full (500 items). Remove an item to add a new one.',
      generateRecipes: 'Generate recipes',
      selectIngredients: 'Select the ingredients you want to use',
      selectIngredientsHint: 'Add ingredients to your bar first, then generate AI recipes.',
      selectAll: 'Select all',
    },
    scanner: {
      title: 'Scan bottle',
      choosePhoto: 'Choose photo',
      takePhoto: 'Take photo',
      detecting: 'Detecting product...',
      instruction: 'Select or photograph the bottle label',
      reset: 'Reset',
      modalTitle: 'Product detected',
      modalQuestion: 'Generate recipes for this product?',
      cancel: 'Cancel',
      generate: 'Generate recipes',
      permissionLibrary: 'Media library access is required to pick a photo.',
      permissionCamera: 'Camera access is required to take a photo.',
      error: 'Something went wrong. Please try again.',
    },
    editProfile: {
      title: 'Edit profile',
      firstName: 'First name',
      lastName: 'Last name',
      city: 'City',
      bio: 'Bio',
      save: 'Save changes',
      saving: 'Saving...',
      success: 'Profile updated successfully.',
      error: 'Failed to save changes.',
    },
    recipeResults: {
      garnish: 'Garnish',
    },
    drinkDetail: {
      title: 'Drink details',
      like: 'Tap to cheer',
      save: 'Save',
      next: 'What’s next?',
      tip: 'Use the scanner to get AI recipes or add the ingredients to your Smart Bar.',
      scan: 'Scan a new bottle',
      loading: 'Loading tasting notes...',
      comments: 'Comments',
      noComments: 'No comments yet',
      commentsLoadError: 'Could not load comments.',
    },
    createPost: {
      title: 'Create Post',
      imageTooLarge: 'This photo is too large. Please choose one under 7 MB.',
      imageInvalidFormat: 'Use a JPEG, PNG, WebP or HEIC photo.',
      dailyLimit: 'You have reached the post limit for today. Please try again tomorrow.',
      cancel: 'Cancel',
      submit: 'Create Post',
      submitting: 'Posting...',
      nameLabel: 'Drink name *',
      namePlaceholder: 'Enter drink name',
      descriptionLabel: 'Description *',
      descriptionPlaceholder: 'Describe your drink experience...',
      rating: 'Rating',
      location: 'Location',
      locationPlaceholder: 'Where did you have this drink?',
      helperText:
        'Share your drink experience with the DrinkMe community! Add photos, rate your drink, and let others know where to find it.',
      addPhoto: 'Add photo',
      changePhoto: 'Change photo',
      addLocation: 'Add location',
      addTags: 'Add tags',
      success: 'Your drink has been posted!',
      error: 'Failed to create post. Please try again.',
      fieldsError: 'Please fill in all required fields',
      photoRequired: 'A photo is required to post.',
    },
    languageSettings: {
      title: 'Language',
      subtitle: 'Choose your preferred language',
      current: 'Current',
    },
    notifications: {
      title: 'Activity',
      empty: 'No notifications yet',
    },
    onboarding: {
      privacyTitle: 'What others can see',
      privacyPublic:
        'Nothing on DrinkMe is visible to people without an account. Signed-in people who have confirmed they are 18 or older can see your name, photo, city and bio, your posts with their locations, and your comments.',
      privacyAlcoholic:
        "Until someone confirms they are 18 or older, they cannot see other people's profiles, posts or comments, alcoholic or not.",
      privacyActivity: 'Post owners see who cheered or commented on their posts, and cheer counts are visible to everyone who can see the post.',
      privacyPartners: 'Your drink partner list is visible only to you and your drink partners.',
      privacyPartnersOfPartners: "Your partners' other partners can see that you are partnered with them.",
      privacyModerators: 'Moderators can see reported content and who reported it.',
      privacyPrivate:
        'Your email, saved posts and Smart Bar stay private. You can delete your account at any time from Edit Profile.',
      privacyAccept: 'I understand',
      nameTitle: 'What should we call you?',
      nameHint: 'Other DrinkMe users will see this name. Do not use your email address.',
      nameInvalid: 'Enter a name, without @.',
      later: 'Later',
      saveFailed: 'Could not save. Please try again.',
    },
  },
  ro: {
    common: {
      retry: 'Încearcă din nou',
      loadMore: 'Încarcă mai multe',
      loadMoreError: 'Nu am putut încărca mai multe. Încearcă din nou.',
      serviceUnavailable: 'Momentan nu este disponibil. Încearcă din nou mai târziu.',
      tooManyRequests: 'Prea multe cereri. Încearcă din nou în câteva minute.',
      imageQuotaReached: 'Ai atins limita de stocare pentru fotografii, așa că această fotografie nu a putut fi adăugată.',
      cheers: 'Noroc',
      cheersVerb: 'Trimite noroc',
      cheersCount: '{{count}} norocuri',
      unknownUser: 'Utilizator DrinkMe',
      commentPlaceholder: 'Scrie un comentariu…',
      addPartner: 'Adaugă partener',
      you: 'Tu',
      comment: 'Comentează',
      save: 'Salvează',
      saved: 'Salvat',
      cancel: 'Anulează',
      close: 'Închide',
      moreOptions: 'Mai multe opțiuni',
    },
    report: {
      action: 'Raportează',
      title: 'De ce raportezi?',
      reason: {
        spam: 'Spam',
        harassment: 'Hărțuire',
        underage: 'Implică un minor',
        dangerous_drinking: 'Încurajează consumul periculos',
        mislabeled_alcohol: 'Marcat greșit ca fără alcool',
        other: 'Altceva',
      },
      success: 'Mulțumim. Vom analiza raportarea.',
      failed: 'Nu am putut trimite raportarea. Încearcă din nou.',
      dailyLimit: 'Ai atins limita de raportări pentru azi. Încearcă din nou mâine.',
    },
    block: {
      action: 'Blochează utilizatorul',
      confirm: 'Nu veți mai vedea postările și comentariile celuilalt, iar parteneriatul se va încheia.',
      unblock: 'Deblochează',
      listTitle: 'Utilizatori blocați',
      empty: 'Nu ai blocat pe nimeni.',
      failed: 'Nu am putut actualiza blocarea. Încearcă din nou.',
      loadError: 'Nu am putut încărca utilizatorii blocați.',
      limitReached: 'Ai atins limita de utilizatori blocați. Deblochează pe cineva pentru a bloca alt utilizator.',
      accountSection: 'Cont',
    },
    partners: {
      requested: 'Cerere trimisă',
      accept: 'Acceptă',
      decline: 'Refuză',
      requests: 'Cereri',
      noRequests: 'Nu ai cereri în așteptare.',
      remove: 'Elimină',
      removeConfirm: 'Elimini acest partener de băuturi?',
      private: 'Doar partenerii acestui utilizator pot vedea lista.',
      loadError: 'Nu am putut încărca partenerii de băuturi.',
      requestsLoadError: 'Nu am putut încărca cererile de parteneriat.',
      requestLimit: 'Ai atins limita de cereri de parteneriat. Încearcă din nou mai târziu.',
    },
    comment: {
      delete: 'Șterge comentariul',
      deleteFailed: 'Nu am putut șterge comentariul. Încearcă din nou.',
      actions: 'Opțiuni comentariu',
    },
    post: {
      actions: 'Opțiuni postare',
      delete: 'Șterge postarea',
      deleteConfirm: 'Ștergi această postare și comentariile ei? Acțiunea nu poate fi anulată.',
      deleteFailed: 'Nu am putut șterge postarea. Încearcă din nou.',
      notFound: 'Această postare nu mai este disponibilă.',
      loadError: 'Nu am putut încărca această postare.',
    },
    errors: {
      cheerFailed: 'Nu am putut trimite norocul. Încearcă din nou.',
      saveFailed: 'Nu am putut salva postarea. Încearcă din nou.',
      commentFailed: 'Nu am putut adăuga comentariul. Încearcă din nou.',
      commentDailyLimit: 'Ai atins limita de comentarii pentru azi. Încearcă din nou mâine.',
      partnerFailed: 'Nu am putut actualiza partenerul de băuturi.',
    },
    auth: {
      title: 'DrinkMe',
      subtitleSignIn: 'Bine ai revenit',
      subtitleSignUp: 'Creează-ți contul',
      emailPlaceholder: 'Email',
      passwordPlaceholder: 'Parolă',
      signIn: 'Autentificare',
      signUp: 'Creare cont',
      loading: 'Se încarcă...',
      toggleToSignIn: 'Ai deja cont? Autentifică-te',
      toggleToSignUp: 'Nu ai cont? Înregistrează-te',
      errorTitle: 'Eroare',
      errorMessage: 'Te rugăm să completezi toate câmpurile',
    },
    home: {
      sections: {
        feed: 'Flux parteneri de băuturi',
        emptyFeedTitle: 'Încă nu există postări',
        emptyFeedSubtitle:
          'Urmărește mai mulți parteneri de băuturi sau creează primul tău review pentru a vedea conținut aici.',
        createFirstPost: 'Creează primul post',
        feedError: 'Nu am putut încărca fluxul.',
      },
    },
    ageGate: {
      title: 'DrinkMe este pentru adulți',
      body: 'DrinkMe este pentru persoanele de cel puțin 18 ani. Confirmă-ți vârsta pentru a continua.',
      confirm: 'Am cel puțin 18 ani',
      leaveHint: 'Nu ai încă 18 ani? Te poți deconecta sau îți poți șterge contul.',
      logout: 'Deconectare',
      deleteAccount: 'Șterge contul',
      banner: 'Confirmă că ai cel puțin 18 ani pentru a folosi DrinkMe.',
      bannerAction: 'Confirmă vârsta',
      required: 'Confirmă că ai cel puțin 18 ani pentru a continua.',
      confirmFailed: 'Nu am putut salva răspunsul. Încearcă din nou.',
      scannerIntro:
        'Îndreaptă camera spre orice sticlă sau etichetă, iar AI-ul identifică imediat produsul și îți sugerează rețete de băuturi create pentru tine.',
      scannerRecognition: 'Fă o fotografie sau alege una din galerie — AI-ul nostru identifică băuturi și mixere în câteva secunde.',
      scannerRecipes: 'După ce produsul este detectat, primești 5 rețete de băuturi personalizate, cu ingrediente și instrucțiuni pas cu pas.',
      recipesIntro: 'Selectează ingredientele din barul tău, apasă Generează, iar AI-ul nostru creează rețete de băuturi personalizate pe baza a ceea ce ai la îndemână.',
      recipesFeature: 'Primești imediat 5 rețete de băuturi potrivite pentru tine',
      itemNamePlaceholder: 'Denumire (ex: Limonadă, Tonic)',
    },
    session: {
      errorTitle: 'Nu ne-am putut conecta',
      errorBody: 'Nu ți-am putut deschide contul. Verifică conexiunea și încearcă din nou.',
    },
    verifyEmail: {
      title: 'Verifică-ți e-mailul',
      body: 'Am trimis un link de confirmare la {{email}}.',
      resend: 'Trimite din nou',
      confirmed: 'Am confirmat',
      notYet: 'E-mailul nu este confirmat încă.',
      sendFailed: 'Nu am putut trimite e-mailul. Încearcă din nou mai târziu.',
      signInAgain: 'E-mailul este confirmat. Autentifică-te din nou pentru a continua.',
    },
    deleteAccount: {
      action: 'Șterge contul',
      warning: 'Acest lucru îți șterge definitiv profilul, postările, comentariile, postările salvate și Smart Bar. Copiile de siguranță sunt eliminate în cel mult 40 de zile.',
      typePrompt: 'Scrie STERGE pentru a confirma.',
      confirmWord: 'STERGE',
      passwordPrompt: 'Introdu parola.',
      wrongPassword: 'Parolă incorectă.',
      failed: 'Nu am putut șterge contul. Încearcă din nou.',
      done: 'Contul tău a fost șters.',
      partial: 'Datele tale au fost șterse. Eliminarea datelor de conectare nu s-a încheiat, iar noi vom reîncerca automat.',
      checking: 'Nu am putut confirma rezultatul. Îți verificăm contul acum.',
    },
    explore: {
      loadError: 'Nu am putut încărca băuturile.',
      title: 'Explorează',
      searchPlaceholder: 'Caută băuturi, baruri sau prieteni',
      tipUsers: 'Pont: caută persoane cu @utilizator',
      tipPlaces: 'Caută locuri după numele orașului',
      searchMinChars: 'Scrie cel puțin 2 caractere ca să cauți.',
      filters: {
        all: 'Toate',
        cocktail: 'Cocktailuri',
        wine: 'Vinuri',
        beer: 'Bere',
        nonAlcoholic: 'Fără alcool',
      },
      sections: {
        users: 'Utilizatori',
        searchResults: 'Rezultate pentru "{{query}}"',
        noDrinksTitle: 'Nicio băutură găsită',
        noDrinksSubtitle: 'Încearcă alt termen sau verifică ortografia.',
        trending: 'În trend acum',
        discover: 'Descoperă',
        tastingTitle: 'Planifică o degustare',
        tastingSubtitle: 'Creează un eveniment privat cu prietenii (în curând).',
        partnersTitle: 'Localuri partenere',
        partnersSubtitle: 'Partenerii DrinkMe oferă reduceri testerilor beta.',
        unknownLocation: 'Locație necunoscută',
        noUsersTitle: 'Niciun utilizator găsit',
        noUsersSubtitle: 'Folosește formatul @utilizator sau invită-ți prietenii.',
      },
    },
    profile: {
      title: 'Profil',
      avatarTooLarge: 'Fotografia este prea mare. Alege una sub 2 MB.',
      avatarInvalidFormat: 'Folosește o fotografie JPEG, PNG sau WebP.',
      avatarUploadError: 'Nu am putut actualiza fotografia. Încearcă din nou.',
      posts: 'Postări',
      saved: 'Salvate',
      drinkPartners: 'Parteneri de băuturi',
      noPartners: 'Încă nu ai parteneri de băuturi',
      following: 'Urmăriri',
      edit: 'Editează profilul',
      emptyDrinks: 'Nu există postări încă',
      createFirstPost: 'Creează prima postare',
      settings: 'Setări',
      logoutConfirm: 'Sigur dorești să te deconectezi?',
      loadError: 'Nu am putut încărca acest profil.',
      notFound: 'Acest profil nu este disponibil.',
      postsLoadError: 'Nu am putut încărca aceste postări.',
      retry: 'Încearcă din nou',
      logout: 'Deconectare',
      cancel: 'Anulează',
      language: 'Limba aplicației',
    },
    smartBar: {
      title: 'Smart Bar',
      tabs: {
        inventory: 'Inventar',
        recipes: 'Rețete',
        saved: 'Salvate',
      },
      addFirst: 'Adaugă primul ingredient',
      inventoryEmptyTitle: 'Barul tău este gol',
      inventoryEmptySubtitle:
        'Adaugă băuturile preferate pentru a primi recomandări de rețete personalizate.',
      savedEmptyTitle: 'Nu ai postări salvate',
      savedEmptySubtitle: 'Salvează băuturile preferate pentru a le vedea aici.',
      addItemTitle: 'Adaugă în barul tău',
      itemNamePlaceholder: 'Denumire (ex: Whiskey, Vodka)',
      quantityPlaceholder: 'Cantitate (ex: 1, 750ml)',
      addItem: 'Adaugă',
      itemLimit: 'Barul tău este plin (500 de articole). Șterge un articol ca să adaugi altul.',
      generateRecipes: 'Generează rețete',
      selectIngredients: 'Selectează ingredientele pe care vrei să le folosești',
      selectIngredientsHint: 'Adaugă ingrediente în bar, apoi generează rețete AI.',
      selectAll: 'Selectează tot',
    },
    scanner: {
      title: 'Scanează sticla',
      choosePhoto: 'Alege fotografie',
      takePhoto: 'Fă fotografie',
      detecting: 'Identificăm produsul...',
      instruction: 'Selectează sau fotografiază eticheta sticlei',
      reset: 'Resetează',
      modalTitle: 'Produs detectat',
      modalQuestion: 'Generezi rețete pentru acest produs?',
      cancel: 'Anulează',
      generate: 'Generează rețete',
      permissionLibrary: 'Este necesar accesul la galerie pentru a selecta o fotografie.',
      permissionCamera: 'Este necesar accesul la cameră pentru a face o fotografie.',
      error: 'A apărut o eroare. Încearcă din nou.',
    },
    editProfile: {
      title: 'Editează profilul',
      firstName: 'Prenume',
      lastName: 'Nume',
      city: 'Oraș',
      bio: 'Bio',
      save: 'Salvează modificările',
      saving: 'Se salvează...',
      success: 'Profilul a fost actualizat.',
      error: 'Nu am putut salva modificările.',
    },
    recipeResults: {
      garnish: 'Garnish',
    },
    drinkDetail: {
      title: 'Detalii băutură',
      like: 'Trimite noroc',
      save: 'Salvează',
      next: 'Ce urmează?',
      tip: 'Folosește scannerul pentru rețete recomandate sau adaugă ingredientele în Smart Bar.',
      scan: 'Scanează o nouă sticlă',
      loading: 'Încărcăm nota de degustare...',
      comments: 'Comentarii',
      noComments: 'Încă nu există comentarii',
      commentsLoadError: 'Nu am putut încărca comentariile.',
    },
    createPost: {
      title: 'Create Post',
      imageTooLarge: 'Fotografia este prea mare. Alege una sub 7 MB.',
      imageInvalidFormat: 'Folosește o fotografie JPEG, PNG, WebP sau HEIC.',
      dailyLimit: 'Ai atins limita de postări pentru azi. Încearcă din nou mâine.',
      cancel: 'Anulează',
      submit: 'Publică',
      submitting: 'Se publică...',
      nameLabel: 'Numele băuturii *',
      namePlaceholder: 'Introdu numele băuturii',
      descriptionLabel: 'Descriere *',
      descriptionPlaceholder: 'Descrie experiența ta...',
      rating: 'Rating',
      location: 'Locație',
      locationPlaceholder: 'Unde ai savurat această băutură?',
      helperText:
        'Împărtășește-ți experiența cu comunitatea DrinkMe! Adaugă fotografii și spune-le unde o pot găsi.',
      addPhoto: 'Adaugă fotografie',
      changePhoto: 'Schimbă fotografia',
      addLocation: 'Adaugă locație',
      addTags: 'Adaugă etichete',
      success: 'Băutura ta a fost publicată!',
      error: 'Nu am putut publica postarea. Încearcă din nou.',
      fieldsError: 'Completează toate câmpurile obligatorii',
      photoRequired: 'Este necesară o fotografie pentru a publica.',
    },
    languageSettings: {
      title: 'Limba aplicației',
      subtitle: 'Alege limba preferată',
      current: 'Actuală',
    },
    notifications: {
      title: 'Activitate',
      empty: 'Nu ai notificări încă',
    },
    onboarding: {
      privacyTitle: 'Ce pot vedea ceilalți',
      privacyPublic:
        'Nimic din DrinkMe nu este vizibil pentru persoanele fără cont. Persoanele autentificate care au confirmat că au cel puțin 18 ani pot vedea numele, fotografia, orașul și descrierea ta, postările tale cu locațiile lor și comentariile tale.',
      privacyAlcoholic:
        'Până nu confirmă că au cel puțin 18 ani, utilizatorii nu pot vedea profilurile, postările sau comentariile altora, cu sau fără alcool.',
      privacyActivity: 'Autorii postărilor văd cine le-a apreciat sau comentat, iar numărul de aprecieri este vizibil pentru oricine poate vedea postarea.',
      privacyPartners: 'Lista partenerilor tăi de băuturi este vizibilă doar pentru tine și partenerii tăi.',
      privacyPartnersOfPartners: 'Ceilalți parteneri ai partenerilor tăi pot vedea că sunteți parteneri.',
      privacyModerators: 'Moderatorii pot vedea conținutul raportat și cine l-a raportat.',
      privacyPrivate:
        'E-mailul, postările salvate și Smart Bar rămân private. Îți poți șterge contul oricând din ecranul Editează profilul.',
      privacyAccept: 'Am înțeles',
      nameTitle: 'Cum să-ți spunem?',
      nameHint: 'Ceilalți utilizatori DrinkMe vor vedea acest nume. Nu folosi adresa de e-mail.',
      nameInvalid: 'Introdu un nume, fără @.',
      later: 'Mai târziu',
      saveFailed: 'Nu am putut salva. Încearcă din nou.',
    },
  },
  es: {},
  zh: {},
  hi: {},
  ar: {},
  bn: {},
} as const;

export type SupportedLocale = keyof typeof translations;

export const AVAILABLE_LOCALES: { code: SupportedLocale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ro', label: 'Română' },
  { code: 'es', label: 'Español' },
  { code: 'zh', label: '中文 (Mandarin)' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ar', label: 'العربية' },
  { code: 'bn', label: 'বাংলা' },
];

const LOCALE_STORAGE_KEY = 'drinkme.locale';

type LocalizationContextValue = {
  locale: SupportedLocale;
  setLocale: (value: SupportedLocale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  availableLocales: { code: SupportedLocale; label: string }[];
};

const LocalizationContext = createContext<LocalizationContextValue | undefined>(undefined);
function resolveTranslation(locale: SupportedLocale, key: string) {
  const segments = key.split('.');
  let current: any = translations[locale];
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in current) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function LocalizationProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>('en');

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
        if (stored && stored in translations && isMounted) {
          setLocaleState(stored as SupportedLocale);
        }
      } catch (error) {
        console.warn('Failed to load stored locale', error);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const raw =
        resolveTranslation(locale, key) ??
        resolveTranslation('en', key) ??
        key;

      if (!params) return raw;

      return Object.keys(params).reduce((acc, paramKey) =>
        acc.replace(`{{${paramKey}}}`, String(params[paramKey]))
      , raw);
    },
    [locale]
  );

  const setLocale = useCallback((value: SupportedLocale) => {
    setLocaleState(value);
    AsyncStorage.setItem(LOCALE_STORAGE_KEY, value).catch((error) =>
      console.warn('Failed to persist locale', error)
    );
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, t, availableLocales: AVAILABLE_LOCALES }),
    [locale, setLocale, t]
  );

  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>;
}

export function useLocalization() {
  const context = useContext(LocalizationContext);
  if (!context) {
    throw new Error('useLocalization must be used within a LocalizationProvider');
  }
  return context;
}
