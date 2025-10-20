export interface BaseUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  bio?: string;
  isPartner?: boolean;
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
  imageUrl?: string;
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
