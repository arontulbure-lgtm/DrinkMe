import React, { useEffect, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useLocalization } from '../context/LocalizationContext';
import { placesRequestHeaders } from '../lib/placesHeaders';

interface LocationSuggestion {
  description: string;
  placeId: string;
  lat?: number;
  lng?: number;
}

interface LocationPickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (payload: { description: string; lat: number | null; lng: number | null }) => void;
  initialValue?: string;
}

const GOOGLE_API_KEY =
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ||
  (Constants.expoConfig?.extra as any)?.googleMapsApiKey ||
  (Constants.manifest2?.extra as any)?.googleMapsApiKey;

export function LocationPickerModal({ visible, onClose, onSelect, initialValue }: LocationPickerModalProps) {
  const { t } = useLocalization();
  const [query, setQuery] = useState(initialValue ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<LocationSuggestion[]>([]);

  useEffect(() => {
    if (visible) {
      setQuery(initialValue ?? '');
      setResults([]);
      setError(null);
    }
  }, [visible, initialValue]);

  const fetchSuggestions = useCallback(
    async (search: string) => {
      if (!search || search.trim().length < 2) {
        setResults([]);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        if (!GOOGLE_API_KEY) {
          setError(t('location.notConfigured'));
          setResults([]);
          setLoading(false);
          return;
        }
        const response = await fetch(
          `https://maps.googleapis.com/maps/api/place/autocomplete/json?key=${GOOGLE_API_KEY}&input=${encodeURIComponent(
            search
          )}&types=establishment`,
          { headers: placesRequestHeaders() }
        );
        const data = await response.json();
        // ZERO_RESULTS is a normal answer: no places match.
        if (data.status === 'ZERO_RESULTS') {
          setResults([]);
          return;
        }
        if (data.status !== 'OK') {
          // Google's own error_message is English and can describe the key: never shown (legal T-04).
          setError(t('location.loadError'));
          setResults([]);
          return;
        }
        const suggestions: LocationSuggestion[] = data.predictions.map((item: any) => ({
          description: item.description,
          placeId: item.place_id,
        }));
        setResults(suggestions);
      } catch (error) {
        console.error('Failed to fetch location suggestions', error);
        setError(t('location.loadError'));
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!visible) return;
    const timeout = setTimeout(() => {
      fetchSuggestions(query);
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, visible, fetchSuggestions]);

  const handleSelect = useCallback(
    async (item: LocationSuggestion) => {
      if (!GOOGLE_API_KEY) {
        onSelect({ description: item.description, lat: null, lng: null });
        onClose();
        return;
      }
      try {
        setLoading(true);
        const response = await fetch(
          `https://maps.googleapis.com/maps/api/place/details/json?key=${GOOGLE_API_KEY}&place_id=${encodeURIComponent(item.placeId)}&fields=formatted_address`,
          { headers: placesRequestHeaders() }
        );
        const data = await response.json();
        // Only the address is asked for: posts keep the place name, never coordinates (data minimisation).
        onSelect({
          description: data.result?.formatted_address || item.description,
          lat: null,
          lng: null,
        });
        onClose();
      } catch (error) {
        console.error('Failed to resolve place details', error);
        onSelect({ description: item.description, lat: null, lng: null });
        onClose();
      } finally {
        setLoading(false);
      }
    },
    [onClose, onSelect]
  );

  const renderItem = ({ item }: { item: LocationSuggestion }) => (
    <TouchableOpacity style={styles.resultItem} onPress={() => handleSelect(item)}>
      <Ionicons name="location-outline" size={18} color="#8B5FBF" style={styles.resultIcon} />
      <Text style={styles.resultText}>{item.description}</Text>
    </TouchableOpacity>
  );

  const keyExtractor = (item: LocationSuggestion) => item.placeId;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('location.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={11} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            placeholder={t('location.searchPlaceholder')}
            placeholderTextColor="#6B7280"
            value={query}
            onChangeText={setQuery}
            autoFocus
          />
          {loading && <ActivityIndicator style={styles.loader} color="#8B5FBF" />}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <FlatList
            data={results}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              !loading && !error && query.length >= 2 ? (
                <Text style={styles.emptyText}>{t('location.noMatches')}</Text>
              ) : undefined
            }
          />
          {/* Google Places terms: results from Places carry Google's attribution (legal T-04). */}
          {results.length > 0 ? <Text style={styles.attribution}>{t('location.poweredByGoogle')}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#111827',
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 36,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#1F2937',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 16,
  },
  loader: {
    marginVertical: 12,
  },
  errorText: {
    color: '#FCA5A5',
    marginTop: 8,
  },
  attribution: {
    color: '#6B7280',
    fontSize: 11,
    textAlign: 'right',
    marginTop: 6,
  },
  emptyText: {
    color: '#9CA3AF',
    marginTop: 12,
    textAlign: 'center',
  },
  resultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  resultIcon: {
    marginRight: 12,
  },
  resultText: {
    color: '#FFFFFF',
    flex: 1,
    fontSize: 15,
  },
});

export default LocationPickerModal;
