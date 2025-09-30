import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
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

type TabParamList = {
  Home: undefined;
  Explore: undefined;
  Scanner: undefined;
  SmartBar: undefined;
  Profile: undefined;
};

type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
  CreatePost: undefined;
  DrinkDetail: { drinkId: number };
  EditProfile: undefined;
  RecipeResults: { product: string; recipes: Recipe[] };
  LanguageSettings: undefined;
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
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return null; // You can add a loading screen here
  }

  return (
    <Stack.Navigator id={undefined} screenOptions={{ headerShown: false }}>
      {!isAuthenticated ? (
        <Stack.Screen name="Auth" component={AuthScreen} />
      ) : (
        <>
          <Stack.Screen name="Main" component={TabNavigator} />
          <Stack.Screen
            name="CreatePost"
            component={CreatePostScreen}
            options={{
              presentation: 'modal',
              headerShown: true,
              headerStyle: { backgroundColor: '#000000' },
              headerTintColor: '#FFFFFF',
              title: 'Creează postare',
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
        </>
      )}
    </Stack.Navigator>
  );
}
