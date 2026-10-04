import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const googlePlugin = '@react-native-google-signin/google-signin';
  const plugins = (config.plugins ?? []).filter(
    (plugin) => (typeof plugin === 'string' ? plugin : plugin[0]) !== googlePlugin,
  );
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();

  if (iosClientId) {
    const match = /^([a-zA-Z0-9_-]+)\.apps\.googleusercontent\.com$/.exec(iosClientId);
    if (!match) {
      throw new Error('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID must be a valid Google iOS OAuth client ID.');
    }
    plugins.push([googlePlugin, { iosUrlScheme: `com.googleusercontent.apps.${match[1]}` }]);
  }

  return {
    ...config,
    name: config.name ?? 'KidoCoach',
    slug: config.slug ?? 'kidocoach',
    plugins,
  };
};
