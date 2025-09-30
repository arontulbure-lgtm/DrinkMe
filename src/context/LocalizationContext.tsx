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
      cheers: 'Cheers',
      cheersVerb: 'Cheer',
      cheersCount: '{{count}} Cheers',
      commentPlaceholder: 'Leave a comment…',
      addPartner: 'Add partner',
      you: 'You',
    },
    errors: {
      cheerFailed: 'Failed to send cheers. Please try again.',
      saveFailed: 'Failed to save post. Please try again.',
      commentFailed: 'Failed to add comment. Please try again.',
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
      },
    },
    explore: {
      title: 'Explore',
      searchPlaceholder: 'Search drinks, venues, or friends',
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
      },
    },
    profile: {
      title: 'Profile',
      posts: 'Posts',
      drinkPartners: 'Drink Partners',
      following: 'Following',
      edit: 'Edit profile',
      emptyDrinks: 'No drinks posted yet',
      createFirstPost: 'Create first post',
      settings: 'Settings',
      logoutConfirm: 'Are you sure you want to logout?',
      logout: 'Logout',
      cancel: 'Cancel',
      language: 'App language',
    },
    smartBar: {
      title: 'Smart Bar',
      tabs: {
        inventory: 'My inventory',
        saved: 'Saved posts',
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
    },
    createPost: {
      title: 'New post',
      cancel: 'Cancel',
      submit: 'Post',
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
  },
  ro: {
    common: {
      cheers: 'Noroc',
      cheersVerb: 'Trimite noroc',
      cheersCount: '{{count}} norocuri',
      commentPlaceholder: 'Scrie un comentariu…',
      addPartner: 'Adaugă partener',
      you: 'Tu',
    },
    errors: {
      cheerFailed: 'Nu am putut trimite norocul. Încearcă din nou.',
      saveFailed: 'Nu am putut salva postarea. Încearcă din nou.',
      commentFailed: 'Nu am putut adăuga comentariul. Încearcă din nou.',
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
      },
    },
    explore: {
      title: 'Explorează',
      searchPlaceholder: 'Caută băuturi, baruri sau prieteni',
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
      },
    },
    profile: {
      title: 'Profil',
      posts: 'Postări',
      drinkPartners: 'Parteneri de băuturi',
      following: 'Urmăriri',
      edit: 'Editează profilul',
      emptyDrinks: 'Nu există postări încă',
      createFirstPost: 'Creează prima postare',
      settings: 'Setări',
      logoutConfirm: 'Sigur dorești să te deconectezi?',
      logout: 'Deconectare',
      cancel: 'Anulează',
      language: 'Limba aplicației',
    },
    smartBar: {
      title: 'Smart Bar',
      tabs: {
        inventory: 'Inventar',
        saved: 'Postări salvate',
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
    },
    createPost: {
      title: 'Postare nouă',
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
