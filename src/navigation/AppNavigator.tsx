import React, { useEffect, useState } from 'react';
import { Alert, View, ActivityIndicator } from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';
import { useLocalization } from '../context/LocalizationContext';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { Recipe } from '../types/api';

// Import screens
import AuthScreen from '../screens/AuthScreen';
import HomeScreen from '../screens/HomeScreen';
import ExploreScreen from '../screens/ExploreScreen';
import ScannerScreen from '../screens/ScannerScreen';
import SmartBarScreen from '../screens/SmartBarScreen';
import ProfileScreen from '../screens/ProfileScreen';
import CreatePostScreen from '../screens/CreatePostScreen';
import DrinkDetailScreen from '../screens/DrinkDetailScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import RecipeResultsScreen from '../screens/RecipeResultsScreen';
import LanguageSettingsScreen from '../screens/LanguageSettingsScreen';
import PartnersListScreen from '../screens/PartnersListScreen';
import SessionErrorScreen from '../screens/SessionErrorScreen';
import VerifyEmailScreen from '../screens/VerifyEmailScreen';
import AgeGateScreen from '../screens/AgeGateScreen';
import OnboardingScreen, { PRIVACY_NOTICE_VERSION } from '../screens/OnboardingScreen';
import BlockedUsersScreen from '../screens/BlockedUsersScreen';

type TabParamList = {
  Home: undefined;
  Explore: undefined;
  Scanner: undefined;
  SmartBar: undefined;
  Profile: undefined;
};

type RootStackParamList = {
  Auth: undefined;
  SessionError: undefined;
  VerifyEmail: undefined;
  Main: undefined;
  CreatePost: undefined;
  DrinkDetail: { drinkId: number };
  EditProfile: undefined;
  RecipeResults: { product: string; recipes: Recipe[]; isAlcoholic: boolean | null };
  LanguageSettings: undefined;
  PartnersList: undefined;
  UserProfile: { userId: string };
  BlockedUsers: undefined;
};

const Stack = createStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function TabNavigator() {
  return (
    <Tab.Navigator
      id={undefined}
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'Home') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Explore') {
            iconName = focused ? 'search' : 'search-outline';
          } else if (route.name === 'Scanner') {
            iconName = focused ? 'camera' : 'camera-outline';
          } else if (route.name === 'SmartBar') {
            iconName = focused ? 'wine' : 'wine-outline';
          } else if (route.name === 'Profile') {
            iconName = focused ? 'person' : 'person-outline';
          } else {
            iconName = 'help-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#8B5FBF',
        tabBarInactiveTintColor: 'gray',
        tabBarStyle: {
          backgroundColor: '#000000',
          borderTopColor: '#1F2937',
        },
        headerShown: false,
        headerStyle: {
          backgroundColor: '#000000',
        },
        headerTintColor: '#FFFFFF',
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Explore" component={ExploreScreen} />
      <Tab.Screen name="Scanner" component={ScannerScreen} />
      <Tab.Screen name="SmartBar" component={SmartBarScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export function AppNavigator() {
  const { isAuthenticated, isLoading, sessionStatus, profile, serverUserId, accountDeletedNotice, clearAccountDeletedNotice, signInAgainNotice, clearSignInAgainNotice } = useAuth();
  const { t } = useLocalization();
  // Only for this session: "Later" on the name prompt is not stored. The age gate and the notice have no
  // such way out.
  const [skippedNameUid, setSkippedNameUid] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) setSkippedNameUid(null);
  }, [isAuthenticated]);

  // Without this, signing in to a deleted account would just return to the sign-in screen with no reason.
  useEffect(() => {
    if (!accountDeletedNotice) return;
    clearAccountDeletedNotice();
    Alert.alert(t('deleteAccount.action'), t('deleteAccount.done'));
  }, [accountDeletedNotice, clearAccountDeletedNotice, t]);

  useEffect(() => {
    if (!signInAgainNotice) return;
    clearSignInAgainNotice();
    Alert.alert(t('verifyEmail.signInAgain'));
  }, [signInAgainNotice, clearSignInAgainNotice, t]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#8B5FBF" />
      </View>
    );
  }

  // profile is set only once the session is ready, so an unknown answer never shows the gate.
  // A hard gate: the server refuses everything but the first-run routes before the 18+ confirmation, so
  // neither the tabs nor the stack are mounted until then. Leaving means logging out or deleting the account.
  if (isAuthenticated && sessionStatus === 'ready' && profile && profile.ageConfirmed !== true) {
    return <AgeGateScreen />;
  }

  // After the age gate.
  if (
    isAuthenticated &&
    sessionStatus === 'ready' &&
    profile &&
    ((profile.privacyNoticeVersion ?? 0) < PRIVACY_NOTICE_VERSION || (profile.needsName === true && skippedNameUid !== serverUserId))
  ) {
    return <OnboardingScreen onLater={() => setSkippedNameUid(serverUserId)} />;
  }

  return (
    <Stack.Navigator id={undefined} screenOptions={{ headerShown: false }}>
      {!isAuthenticated ? (
        <Stack.Screen name="Auth" component={AuthScreen} />
      ) : sessionStatus === 'error' ? (
        <Stack.Screen name="SessionError" component={SessionErrorScreen} />
      ) : sessionStatus === 'verification_required' ? (
        <Stack.Screen name="VerifyEmail" component={VerifyEmailScreen} />
      ) : (
        <>
          <Stack.Screen name="Main" component={TabNavigator} />
          <Stack.Screen
            name="CreatePost"
            component={CreatePostScreen}
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="DrinkDetail"
            component={DrinkDetailScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="EditProfile"
            component={EditProfileScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="RecipeResults"
            component={RecipeResultsScreen}
            options={{ presentation: 'modal', headerShown: false }}
          />
          <Stack.Screen
            name="LanguageSettings"
            component={LanguageSettingsScreen}
            options={{ headerShown: false, presentation: 'modal' }}
          />
          <Stack.Screen
            name="PartnersList"
            component={PartnersListScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="UserProfile"
            component={ProfileScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="BlockedUsers"
            component={BlockedUsersScreen}
            options={{ headerShown: false }}
          />
        </>
      )}
    </Stack.Navigator>
  );
}
