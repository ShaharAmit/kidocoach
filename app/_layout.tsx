import React, { useEffect, useCallback, useState, useRef } from 'react';
import { AppState, Text, View, Image, useWindowDimensions } from 'react-native';
import { Tabs, Stack, router, usePathname } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { clearDebugHomeAccess, hasDebugHomeAccess } from '../services/debugFlow';
import { getHomeViewMode, subscribeHomeViewMode } from '../services/homeViewState';
import { getCurrentSegment, segmentToTitle, segmentToSubtitle, type DaySegment, segmentToTitleColor, segmentToSubtitleColor } from '../utils/timeOfDay';
import { colors, fs, ms, s, vs } from '../theme';
import { preloadLocalImages, retryLocalImage, useLocalImage } from '../utils/localImages';
import { ALL_BUNDLED_IMAGES, MOON_IMAGE, SUN_IMAGE } from '../constants/images';



function HeaderTitle({ segment }: { segment: DaySegment }) {
  return (
    <View>
      <Text style={{ fontWeight: '700', fontSize: fs(18), color: segmentToTitleColor(segment) }}>
        {segmentToTitle(segment)}
      </Text>
      <Text style={{ fontSize: fs(12), color: segmentToSubtitleColor(segment), marginTop: vs(2), textAlign: 'center' }}>
        {segmentToSubtitle(segment)}
      </Text>
    </View>
  );
}

function TabLabel({ text, color }: { text: string; color: string }) {
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.8}
      style={{
        color,
        fontSize: fs(12),
        fontWeight: '700',
        textAlign: 'center',
        width: '100%',
      }}
    >
      {text}
    </Text>
  );
}

function NavigationBackButton() {
  return (
    <View style={{ marginLeft: s(12) }}>
      <MaterialCommunityIcons.Button
        name="arrow-left"
        size={ms(24)}
        color={colors.textInk}
        backgroundColor="transparent"
        underlayColor="transparent"
        onPress={() => router.replace('/' as never)}
      />
    </View>
  );
}

export default function RootLayout() {
  const { width: screenWidth } = useWindowDimensions();
  const pathname = usePathname();
  const prevPathnameRef = useRef<string | null>(null);
  const [segment, setSegment] = useState<DaySegment>(getCurrentSegment);
  const [showDecorations, setShowDecorations] = useState(false);
  const [homeViewMode, setHomeViewModeLocal] = useState(getHomeViewMode);
  const sunSource = useLocalImage(SUN_IMAGE);
  const moonSource = useLocalImage(MOON_IMAGE);
  const tabBarHorizontalInset = Math.round(screenWidth * 0.05);

  useEffect(() => {
    return subscribeHomeViewMode(setHomeViewModeLocal);
  }, []);

  // Resolve every bundled image to a stable local file URI up front. Without this, dev-build
  // artwork keeps pointing at packager URLs that stop resolving once the dev server goes away,
  // which is what leaves activity icons and sky decorations blank after a long session.
  useEffect(() => {
    preloadLocalImages(ALL_BUNDLED_IMAGES).catch((err) => {
      console.warn('[RootLayout] Image preload failed:', err);
    });

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        preloadLocalImages(ALL_BUNDLED_IMAGES).catch(() => undefined);
      }
    });

    return () => sub.remove();
  }, []);

  // Re-evaluate segment when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setSegment(getCurrentSegment());
    });
    const segmentTimer = setInterval(() => {
      setSegment(getCurrentSegment());
    }, 60_000);

    return () => {
      sub.remove();
      clearInterval(segmentTimer);
    };
  }, []);

  // Show moon/sun with 1 second delay when entering routines tab
  useEffect(() => {
    const wasNotHome = prevPathnameRef.current !== null && prevPathnameRef.current !== '/';
    const isNowHome = pathname === '/';
    
    if (isNowHome && (wasNotHome || prevPathnameRef.current === null)) {
      setShowDecorations(false);
      const timer = setTimeout(() => setShowDecorations(true), 200);
      prevPathnameRef.current = pathname;
      return () => clearTimeout(timer);
    } else if (isNowHome && prevPathnameRef.current === '/') {
      return;
    } else {
      setShowDecorations(false);
      prevPathnameRef.current = pathname;
    }
  }, [pathname]);

  // Handle notification tap when app is open or in background
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as {
        routineId?: string;
        url?: string;
      };

      if (data?.routineId) {
        router.push('/' as never);
      }
    },
    []
  );

  useEffect(() => {
    const enforceDebugLaunchRouting = () => {
      const alreadyInOnboarding = pathname.startsWith('/onboarding');
      const alreadyInLoading = pathname === '/loading';
      if (!hasDebugHomeAccess() && !alreadyInOnboarding && !alreadyInLoading) {
        router.replace('/onboarding/welcome' as never);
      }
    };

    enforceDebugLaunchRouting();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        enforceDebugLaunchRouting();
        return;
      }

      if (state === 'inactive' || state === 'background') {
        clearDebugHomeAccess();
      }
    });

    const responseListener = Notifications.addNotificationResponseReceivedListener(
      handleNotificationResponse
    );

    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        handleNotificationResponse(response);
      }
    });

    return () => {
      appStateSub.remove();
      responseListener.remove();
    };
  }, [handleNotificationResponse, pathname]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Moon/Sun decoration - positioned between header and content - only on routines tab's task list */}
      {pathname === '/' && showDecorations && homeViewMode === 'activities' && (
        <View style={{ position: 'absolute', right: s(16), top: vs(80), zIndex: 50, pointerEvents: 'none' }}>
          {segment === 'evening' ? (
            <Image
              source={moonSource}
              style={{ width: s(90), height: s(90) }}
              resizeMode="contain"
              onError={() => retryLocalImage(MOON_IMAGE)}
            />
          ) : (
            <Image
              source={sunSource}
              style={{ width: s(90), height: s(90) }}
              resizeMode="contain"
              onError={() => retryLocalImage(SUN_IMAGE)}
            />
          )}
        </View>
      )}

      {pathname === '/loading' || pathname.startsWith('/onboarding') ? (
        <Stack
          initialRouteName="loading"
          screenOptions={{
            headerStyle: { backgroundColor: colors.primary },
            headerTintColor: '#FFF',
            headerTitleStyle: { fontWeight: '700', fontSize: fs(18) },
          }}
        >
          <Stack.Screen name="loading" options={{ title: 'Loading', headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        </Stack>
      ) : (
        <Tabs
          screenOptions={{
            headerStyle: { backgroundColor: colors.appBg },
            headerTintColor: colors.textInk,
            headerTitleStyle: { fontWeight: '700', fontSize: fs(18) },
            headerShadowVisible: false,
            tabBarStyle: {
              position: 'absolute',
              marginHorizontal: tabBarHorizontalInset,
              bottom: vs(34),
              height: vs(66),
              borderRadius: ms(20),
              backgroundColor: '#FFFFFF',
              borderTopWidth: 0,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: vs(6) },
              shadowOpacity: 0.12,
              shadowRadius: ms(10),
              elevation: 10,
            },
            tabBarShowLabel: true,
            tabBarLabelPosition: 'below-icon',
            tabBarItemStyle: { flex: 1, paddingVertical: vs(6), justifyContent: 'center' },
            tabBarLabelStyle: {
              fontSize: fs(12),
              fontWeight: '700',
              textAlign: 'center',
            },
            tabBarIconStyle: { marginBottom: vs(2) },
            tabBarActiveTintColor: colors.primary,
            tabBarInactiveTintColor: '#CBD5E1',
          }}
        >
          <Tabs.Screen
            name="index"
            options={{
              headerTitle: () => <HeaderTitle segment={segment} />,
              title: 'Routines',
              headerShown: homeViewMode !== 'player',
              tabBarStyle:
                homeViewMode === 'player'
                  ? { display: 'none' }
                  : {
                      position: 'absolute',
                      marginHorizontal: tabBarHorizontalInset,
                      bottom: vs(34),
                      height: vs(66),
                      borderRadius: ms(20),
                      backgroundColor: '#FFFFFF',
                      borderTopWidth: 0,
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: vs(6) },
                      shadowOpacity: 0.12,
                      shadowRadius: ms(10),
                      elevation: 10,
                    },
              tabBarLabel: ({ color }) => <TabLabel text="Routines" color={color} />,
              tabBarIcon: ({ color, size }) => (
                <MaterialCommunityIcons name="checkbox-marked-circle-outline" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="rewards"
            options={{
              title: 'Rewards',
              headerLeft: () => <NavigationBackButton />,
              headerStyle: { backgroundColor: colors.morningBg },
              headerTintColor: colors.textInk,
              tabBarStyle: { display: 'none' },
              tabBarLabel: ({ color }) => <TabLabel text="Rewards" color={color} />,
              tabBarIcon: ({ color, size }) => (
                <MaterialCommunityIcons name="star" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="settings"
            options={{
              title: 'Settings',
              headerLeft: () => <NavigationBackButton />,
              headerStyle: { backgroundColor: colors.morningBg },
              headerTintColor: colors.textInk,
              tabBarStyle: { display: 'none' },
              tabBarLabel: ({ color }) => <TabLabel text="Settings" color={color} />,
              tabBarIcon: ({ color, size }) => (
                <MaterialCommunityIcons name="cog" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen name="loading" options={{ href: null }} />
          <Tabs.Screen name="onboarding" options={{ href: null }} />
          <Tabs.Screen
            name="parent/create"
            options={{
              href: null,
              title: 'Activity Manager',
              headerShown: false,
              tabBarStyle: { display: 'none' },
            }}
          />
        </Tabs>
      )}
    </GestureHandlerRootView>
  );
}
