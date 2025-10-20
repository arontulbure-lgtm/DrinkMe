import React, { useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  AVAILABLE_LOCALES,
  SupportedLocale,
  useLocalization,
} from '../context/LocalizationContext';

interface Props {
  navigation: {
    goBack: () => void;
  };
}

export default function LanguageSettingsScreen({ navigation }: Props) {
  const { locale, setLocale, t } = useLocalization();

  const renderItem = useCallback(
    ({ item }: { item: { code: SupportedLocale; label: string } }) => {
      const isSelected = item.code === locale;
      return (
        <TouchableOpacity
          style={[styles.option, isSelected && styles.optionSelected]}
          onPress={() => {
            setLocale(item.code);
            navigation.goBack();
          }}
        >
          <Text style={styles.optionLabel}>{item.label}</Text>
          {isSelected ? (
            <Ionicons name="checkmark-circle" size={22} color="#8B5FBF" />
          ) : (
            <View style={styles.placeholder} />
          )}
        </TouchableOpacity>
      );
    },
    [locale, navigation, setLocale]
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={navigation.goBack}>
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('languageSettings.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.intro}>
        <Text style={styles.introText}>{t('languageSettings.subtitle')}</Text>
      </View>

      <FlatList
        data={AVAILABLE_LOCALES}
        keyExtractor={(item) => item.code}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 36,
    height: 36,
  },
  intro: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  introText: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#0F172A',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionSelected: {
    borderColor: '#8B5FBF',
  },
  optionLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  placeholder: {
    width: 22,
    height: 22,
  },
});
