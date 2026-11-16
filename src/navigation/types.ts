import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { StackScreenProps } from '@react-navigation/stack';
import { AiRecipe, AiScanItem, Recipe } from '../types/api';

// Route params for every screen. Keep these in sync with the navigate() calls: TypeScript checks them
// through the global RootParamList below.

export type TabParamList = {
  Home: undefined;
  Explore: undefined;
  Scanner: undefined;
  SmartBar: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  SessionError: undefined;
  VerifyEmail: undefined;
  Main: NavigatorScreenParams<TabParamList> | undefined;
  // drinkId is for editing an existing post (Task F, edit post, uses it next).
  CreatePost: { drinkId?: number } | undefined;
  DrinkDetail: { drinkId: number };
  EditProfile: undefined;
  RecipeResults: { product: string; recipes: Recipe[]; isAlcoholic: boolean | null };
  LanguageSettings: undefined;
  // No userId: the signed-in user's own list.
  PartnersList: { userId?: string } | undefined;
  UserProfile: { userId: string };
  BlockedUsers: undefined;
  // AI recipes: from a confirmed scan (item) or from the whole Smart Bar.
  AiRecipes: { mode: 'scan'; item: AiScanItem } | { mode: 'smart_bar' };
  AiRecipeDetail: { recipe: AiRecipe };
  AiSettings: undefined;
};

export type RootStackScreenProps<T extends keyof RootStackParamList> = StackScreenProps<RootStackParamList, T>;

// A tab screen can also navigate to every screen of the root stack.
export type TabScreenProps<T extends keyof TabParamList> = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, T>,
  StackScreenProps<RootStackParamList>
>;

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
