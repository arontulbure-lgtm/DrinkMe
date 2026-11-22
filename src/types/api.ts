export interface BaseUser {
  id: string;
  email?: string; // only returned to the account owner
  ageConfirmed?: boolean; // only returned to the account owner
  needsName?: boolean; // only returned to the account owner: no name is public yet
  privacyNoticeVersion?: number | null; // only returned to the account owner
  termsVersion?: number | null; // only returned to the account owner (legal T-06)
  // Owner only, while needsName: the Google or Apple name was not kept because it is reserved for the
  // official DrinkMe account. The name prompt explains it.
  nameReservedAtSignIn?: boolean;
  firstName?: string;
  lastName?: string;
  city?: string;
  bio?: string;
  isPartner?: boolean;
  partnerStatus?: PartnerStatus; // signed-in viewers, about another user
  partnerCount?: number; // only for the owner and that user's partners
  avatar?: string | null;
  // The official DrinkMe account (OFFICIAL_USER_IDS on the server): true for it, false for everyone else.
  // Sent in every user view, so also on post and comment authors, search results and partner lists.
  // Optional only for older servers; the stripped view of a profile without a public name is false.
  official?: boolean;
  // Owner only, and only while true: the profile is hidden from others after reports until an admin reviews it.
  hiddenPendingReview?: boolean;
  // Owner only, and only while suspended. suspendedUntil is null for a permanent suspension.
  suspendedUntil?: string | null;
  suspendedPermanently?: boolean;
}

// The 403 a suspended account gets for posting, commenting, partner requests, profile edits and reports.
export interface AccountSuspendedError {
  error: string;
  code: 'account_suspended';
  until: string | null;
}

export type PartnerStatus = 'none' | 'requested' | 'incoming' | 'partner';

export interface PartnerActionResult {
  status: PartnerStatus;
  isPartner: boolean;
}

export interface PartnerRequestUser extends BaseUser {
  createdAt: string;
}

export interface PartnerRequests {
  incoming: PartnerRequestUser[];
  outgoing: PartnerRequestUser[];
}

// A bounded list. nextCursor is the `before` value for the next page; total is on user post lists only.
export interface Page<T> {
  items: T[];
  nextCursor: number | null;
  total?: number;
}

// Post categories. Must match DRINK_CATEGORIES in server/server.js. A post stores its category as
// tags: [category]; older posts have tags: []. An alcoholic category needs isAlcoholic true, and a
// non-alcoholic one needs isAlcoholic false, or the server answers 400.
// server/test/categories.test.js reads these two arrays from this file and compares them with the
// server's lists, so keep each one a single-line array literal.
export const ALCOHOLIC_DRINK_CATEGORIES = ['cocktail', 'wine', 'beer', 'spirits'] as const;
export const NON_ALCOHOLIC_DRINK_CATEGORIES = ['mocktail', 'coffee', 'tea', 'other'] as const;

export type AlcoholicDrinkCategory = (typeof ALCOHOLIC_DRINK_CATEGORIES)[number];
export type NonAlcoholicDrinkCategory = (typeof NON_ALCOHOLIC_DRINK_CATEGORIES)[number];
export type DrinkCategory = AlcoholicDrinkCategory | NonAlcoholicDrinkCategory;

export const isDrinkCategory = (value: unknown): value is DrinkCategory =>
  (ALCOHOLIC_DRINK_CATEGORIES as readonly unknown[]).includes(value)
  || (NON_ALCOHOLIC_DRINK_CATEGORIES as readonly unknown[]).includes(value);

// POST /api/drinks. category is optional; without it the post is stored with tags: [].
export interface CreateDrinkRequest {
  name: string;
  description: string;
  rating: number;
  location: string | null;
  isAlcoholic: boolean;
  imageData: string;
  category?: DrinkCategory;
}

// PUT /api/drinks/:id (owner only). Every field is optional and a missing one stays as stored; at least
// one is required. category null clears it; location null clears it. The image cannot be changed
// (imageData gives 400). The category is checked against the post's alcoholic flag after the edit: when
// the flag changes and the stored category no longer fits, send a new category or null, otherwise 400
// `category_required`. Errors: 403 account_suspended, 403 age_required, 404 (gone, blocked or hidden),
// 409 hidden_pending_review, 503 (save failed), 507 storage_full. Answers the updated Drink.
export interface UpdateDrinkRequest {
  name?: string;
  description?: string;
  rating?: number;
  location?: string | null;
  isAlcoholic?: boolean;
  category?: DrinkCategory | null;
}

export interface Drink {
  id: number;
  userId: string;
  name: string;
  description: string;
  rating: number;
  location?: string | null;
  createdAt: string;
  cheersCount?: number;
  tags?: string[];
  isLiked?: boolean;
  isSaved?: boolean;
  isAlcoholic?: boolean;
  imageUrl?: string | null; // /media path, or null when the post has no usable image
  isPartner?: boolean;
  user?: BaseUser;
  // Only the owner and admins ever receive a hidden post: hidden from others after reports, pending review.
  hiddenPendingReview?: boolean;
  // Set by the last edit (ISO time); absent on a post never edited. No edit history is kept.
  editedAt?: string;
}

// POST /api/drinks/:id/like and /save. The body sets the state, so a repeat changes nothing; without
// it the server toggles (older apps). A value that is not a boolean gives 400.
export interface CheerRequest {
  cheered: boolean;
}

export interface CheerResult {
  cheered: boolean;
  cheersCount: number;
}

export interface SaveRequest {
  saved: boolean;
}

export interface SaveResult {
  saved: boolean;
}

export interface Story {
  id: number;
  userId: string;
  content: string;
  createdAt: string;
  user?: BaseUser;
}

export interface Comment {
  id: number;
  drinkId: number;
  userId: string;
  content: string;
  createdAt: string;
  user?: BaseUser;
  // Only the author and admins ever receive a hidden comment.
  hiddenPendingReview?: boolean;
}

export type ReportTargetType = 'drink' | 'comment' | 'user';
export type ReportReason = 'spam' | 'harassment' | 'underage' | 'dangerous_drinking' | 'mislabeled_alcohol' | 'other';

// Unused until the admin screen exists. Admin API: GET /api/admin/reports. The review target is 24 hours.
export interface AdminReport {
  id: number;
  reporterId?: string; // a deleted reporter's open report holds an anonymous "deleted-..." id
  targetType: ReportTargetType;
  targetId: string | number;
  drinkId?: number; // comment reports only
  reason: ReportReason;
  details: string | null;
  status: 'open' | 'resolved';
  createdAt: string;
  action?: 'dismiss' | 'remove_content' | 'clear_profile';
  removed?: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  target: unknown; // the public view of the post, comment or profile, or null once gone
  ageHours: number | null;
  overdue: boolean; // open and older than 24 hours
  openReporterCount: number; // distinct reporters among the open reports on the same target
  autoHideReporterCount: number; // of those, the ones who count (account 48 h old, privacy notice accepted)
  autoHidden: boolean; // 3 or more distinct counting reporters, and the target is not the official account's
  targetOfficial: boolean; // the content belongs to the official DrinkMe account, which is never auto-hidden
}

// Unused until the admin screen exists.
export interface AdminReportList {
  items: AdminReport[];
  total: number;
  overdueCount: number; // open reports older than 24 hours, whichever status is listed
}

// Unused until the admin screen exists. POST /api/admin/users/:id/suspend { reason?, permanent? } and
// /unsuspend { void? }, and `suspension` on a resolve with suspend: true. A suspend while one is in force
// answers 409 already_suspended with this shape; on resolve, applied is false and code is already_suspended.
export interface AdminSuspensionResult {
  userId: string;
  suspended: boolean;
  suspendedUntil: string | null;
  suspendedPermanently: boolean;
  suspensionCount: number; // voided suspensions are not counted
  applied?: boolean; // resolve only
  code?: 'already_suspended'; // resolve only, when applied is false
}

// Unused until an admin screen exists. GET /api/admin/audit?action=&limit=&before= answers Page<AuditEntry>,
// newest first; an unknown action is 400. Must match AUDIT_META_KEYS in server/server.js. Kept 90 days.
export type AuditAction =
  | 'ack.age_confirmed'
  | 'ack.privacy_accepted'
  | 'auth.session_revoked'
  | 'account.deletion_requested'
  | 'account.deletion_completed'
  | 'admin.report_resolved'
  | 'admin.user_suspended'
  | 'admin.user_unsuspended';

// actorId and targetId are uids, a `deleted-<hex>` id after an account deletion, or null.
export interface AuditEntry {
  id: number;
  at: string; // ISO date
  action: AuditAction;
  actorId: string | null;
  targetId: string | null;
  meta?: {
    version?: number; // ack.privacy_accepted
    // auth.session_revoked: Firebase revoked the refresh tokens (password reset), or reported the account
    // disabled or deleted outside the app. Absent for the email takeover guard's bump.
    reason?: 'tokens_revoked' | 'account_disabled' | 'account_gone';
    reportId?: number; // admin.report_resolved
    action?: 'dismiss' | 'remove_content' | 'clear_profile'; // admin.report_resolved
    resolvedCount?: number; // admin.report_resolved: open reports on the same target it closed
    permanent?: boolean; // admin.user_suspended
    void?: boolean; // admin.user_unsuspended
  };
}

export interface SmartBarItem {
  id: number;
  name: string;
  quantity: string;
  unit: string;
}

// Worked out by the server on each read. actorName is "Someone" when the actor's name is hidden or gone.
// drinkName is null when the post is gone or the reader may not see it. variant only on type 'partner'.
export interface NotificationParams {
  actorName: string;
  drinkName: string | null;
  variant?: 'accepted' | 'added';
}

export interface NotificationItem {
  id: number;
  // 'cheer' | 'comment' | 'partner' | 'partner_request'; kept as string so a newer server type still shows.
  type: string;
  // English text stored by the server: shown for older entries (params null) and unknown types.
  message: string;
  params?: NotificationParams | null;
  createdAt: string;
  read: boolean;
}

export interface DeleteAccountResponse {
  deleted: boolean;
  // False means the sign-in account still exists. The server keeps retrying, and it can no longer open the app.
  firebaseDeleted: boolean;
}

export interface RecipeIngredient {
  name: string;
  amount_oz: number;
  amount_ml: number;
}

export interface Recipe {
  title: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'mocktail';
  ingredients: RecipeIngredient[];
  garnish: string | null;
  instructions: string;
}

// ── AI v1 (server/ai, ai-service/schemas). Enums must match .claude/skills/ingredient-taxonomy and recipe-schema.
export type AiCategory =
  | 'spirit' | 'liqueur' | 'wine' | 'sparkling_wine' | 'beer' | 'cider' | 'vermouth_aperitif' | 'bitters'
  | 'syrup' | 'juice' | 'soda_mixer' | 'energy_drink' | 'dairy_cream' | 'fresh_fruit' | 'herb_spice' | 'water';
export const AI_CATEGORIES: AiCategory[] = [
  'spirit', 'liqueur', 'wine', 'sparkling_wine', 'beer', 'cider', 'vermouth_aperitif', 'bitters',
  'syrup', 'juice', 'soda_mixer', 'energy_drink', 'dairy_cream', 'fresh_fruit', 'herb_spice', 'water',
];
export type AiScanStatus = 'recognized' | 'low_confidence' | 'water' | 'not_ingredient' | 'unclear';

export interface AiScanItem {
  category: AiCategory;
  brand: string | null;
  product: string | null;
  style: string | null;
  abv: number | null;
  volumeMl: number | null;
  isAlcoholic: boolean;
  flags: ('energy_drink' | 'contains_caffeine')[];
  confidence: number;
}

export interface AiScanResult {
  schemaVersion: '1';
  source: 'photo' | 'barcode';
  status: AiScanStatus;
  item: AiScanItem | null;
  suggestBarcode: boolean;
}

export interface AiSettings {
  basics: string[];
  basicsCustomized: boolean;
  photoOptIn: boolean;
}

export interface AiStatus {
  schemaVersion: '1';
  available: boolean;
  provider: 'local' | 'openai' | 'off';
  scan: boolean;
  recipes: boolean;
  barcode: boolean;
  noticeVersion: number;
  noticeAccepted: boolean;
  // Where photos and ingredients are processed; picks the notice text.
  processing?: 'drinkme' | 'openai';
  settings: AiSettings;
}

export interface AiRecipeIngredient {
  name: string;
  amount: number;
  unit: 'ml' | 'g' | 'piece';
  abv: number;
  optional: boolean;
}

export interface AiRecipe {
  id: string;
  name: string;
  description: string;
  ingredients: AiRecipeIngredient[];
  steps: string[];
  glass: string;
  garnish: string | null;
  method: 'build' | 'stir' | 'shake' | 'blend' | 'muddle';
  estimatedAbv: number;
  standardDrinks: number;
  isAlcoholic: boolean;
  tags: string[];
  language: 'en' | 'ro';
  aiGenerated: true;
  youWillAlsoNeed: string[];
  warnings: ('raw_egg' | 'energy_alcohol')[];
  responsibleNote: string | null;
  savedAt?: string;
}

export interface AiRecipeBatch {
  schemaVersion: '1';
  recipes: AiRecipe[];
  exhausted: boolean;
}
