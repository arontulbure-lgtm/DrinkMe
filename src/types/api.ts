export interface BaseUser {
  id: string;
  email?: string; // only returned to the account owner
  ageConfirmed?: boolean; // only returned to the account owner
  needsName?: boolean; // only returned to the account owner: no name is public yet
  privacyNoticeVersion?: number | null; // only returned to the account owner
  firstName?: string;
  lastName?: string;
  city?: string;
  bio?: string;
  isPartner?: boolean;
  partnerStatus?: PartnerStatus; // signed-in viewers, about another user
  partnerCount?: number; // only for the owner and that user's partners
  avatar?: string | null;
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
}

export type ReportTargetType = 'drink' | 'comment' | 'user';
export type ReportReason = 'spam' | 'harassment' | 'underage' | 'dangerous_drinking' | 'mislabeled_alcohol' | 'other';

export interface SmartBarItem {
  id: number;
  name: string;
  quantity: string;
  unit: string;
}

export interface NotificationItem {
  id: number;
  type: string;
  message: string;
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
