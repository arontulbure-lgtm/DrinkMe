// Every image that may come from this server's /media routes (post photos, avatars) is rendered here.
//
// /media needs the session token as an Authorization header (getImageSource adds it, only for our own
// media). React Native's Image drops request headers on Android under the New Architecture, so those
// images always got 401 there; expo-image sends them on Android, iOS and web. Tokens never go into URLs.
//
// Cache: memory only, cleared whenever the session token changes. A disk cache is keyed by URL and ignores
// the server's Vary: Authorization, so after an account switch on the same device it could show an image
// the new account may not see (blocked user, post hidden after reports, alcoholic post before 18+).
import React from 'react';
import { Image, type ImageProps } from 'expo-image';

import { getImageSource, onApiTokenChange } from '../lib/api';

onApiTokenChange(() => {
  void Image.clearMemoryCache();
});

type MediaImageProps = Omit<ImageProps, 'source' | 'cachePolicy'> & {
  // A /media path or URL from the API, or an https URL (for example a Google profile photo).
  uri: string | null | undefined;
};

export default function MediaImage({ uri, contentFit = 'cover', ...rest }: MediaImageProps) {
  const source = getImageSource(uri);
  return <Image {...rest} source={source.uri ? source : null} cachePolicy="memory" contentFit={contentFit} />;
}
