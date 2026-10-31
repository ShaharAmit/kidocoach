import React, { useEffect, useCallback, useState, useRef } from 'react';
import { AppState, Text, View, Image, useWindowDimensions, type ColorValue } from 'react-native';
import { Tabs, Stack, router, usePathname } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getHomeViewMode, subscribeHomeViewMode } from '../services/homeViewState';
import { getPaidStatus, refreshPaidStatusFromRevenueCat, startPaidStatusSync } from '../services/subscription';
import { hasCompletedOnboarding } from '../services/profile';
import { getAccessRoute } from '../utils/accessRoute';
import { isBootComplete } from '../services/bootState';
import { onAppEnteredForeground, onAppLeftForeground } from '../services/assetCacheService';
import { auth, ensureAuth } from '../services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { getCurrentSegment, segmentToTitle, segmentToSubtitle, type DaySegment, segmentToTitleColor, segmentToSubtitleColor } from '../utils/timeOfDay';
import { colors, CONTENT_MAX_WIDTH, fs, ms, s, vs } from '../theme';
import { preloadLocalImages, retryLocalImage, useLocalImage } from '../utils/localImages';
import { ALL_BUNDLED_IMAGES, MOON_IMAGE, SUN_IMAGE } from '../constants/images';
import { ParentalGateHost, requestParentalGate } from '../components/ParentalGate';
import { useIsOnline } from '../hooks/useIsOnline';

/** Parent-only tabs open only after the parental gate (Kids Category guideline 1.3). */
function gatedTabListener(href: '/profile' | '/settings', enabled = true) {
  return {
    tabPress: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      if (!enabled) return;
      void requestParentalGate().then((passed) => {
        if (passed) router.navigate(href);
      });
    },
  };
}



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

function TabLabel({ text, color }: { text: string; color: ColorValue }) {
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
  const isOnline = useIsOnline();
  const [showDecorations, setShowDecorations] = useState(false);
  const [homeViewMode, setHomeViewModeLocal] = useState(getHomeViewMode);
  const [authUserId, setAuthUserId] = useState(auth.currentUser?.uid);
  const sunSource = useLocalImage(SUN_IMAGE);
  const moonSource = useLocalImage(MOON_IMAGE);
  // Keep the floating tab bar and the sun/moon over the centered content column on tablets.
  const columnInset = Math.max(0, Math.round((screenWidth - CONTENT_MAX_WIDTH) / 2));
  const tabBarHorizontalInset = Math.max(Math.round(screenWidth * 0.05), columnInset);

  useEffect(() => {
    return subscribeHomeViewMode(setHomeViewModeLocal);
  }, []);

  useEffect(() => onAuthStateChanged(auth, (user) => setAuthUserId(user?.uid)), []);

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

  // Every return to the app re-checks the cloud catalog for new or updated activities and
  // re-validates cached media against it; the live catalog listener only runs while foregrounded.
  // Cold starts are covered by app/loading.tsx, which runs the same refresh before booting.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        if (isBootComplete()) {
          onAppEnteredForeground().catch((err) => console.warn('[RootLayout] Catalog refresh failed:', err));
        }
      } else if (state === 'background') {
        onAppLeftForeground();
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

      // Before boot, app/loading.tsx routes home itself once assets are ready.
      if (data?.routineId && isBootComplete()) {
        router.push('/' as never);
      }
    },
    []
  );

  // Init RevenueCat and keep the paid flag bound to the Firebase UID for the app session.
  useEffect(() => startPaidStatusSync(), []);

  // Paywall gate: any screen outside onboarding/loading/paywall requires a completed
  // questionnaire AND an active paid entitlement. Re-checked on every foreground so a lapsed
  // subscription (or an onboarding flow abandoned mid-paywall) is caught without hard-blocking
  // offline-first usage — getPaidStatus() reads the local cache only, never blocks on network.
  useEffect(() => {
    let cancelled = false;
    const enforceAccessGate = async () => {
      const alreadyInOnboarding = pathname.startsWith('/onboarding');
      const alreadyInLoading = pathname === '/loading';
      const alreadyInPaywall = pathname === '/paywall';
      if (alreadyInOnboarding || alreadyInLoading || alreadyInPaywall || pathname === '/profile') return;
      // Cold start: app/index.tsx redirects to /loading, which runs the same checks.
      if (!isBootComplete()) return;

      const user = await ensureAuth();
      const [isPaid, onboardingDone] = await Promise.all([getPaidStatus(), hasCompletedOnboarding()]);
      if (cancelled || auth.currentUser?.uid !== user.uid) return;
      if (isPaid && onboardingDone) return;

      router.replace(getAccessRoute(isPaid, onboardingDone));
    };

    const checkAccess = () => {
      enforceAccessGate().catch((err) => {
        console.warn('[RootLayout] Failed to check family access:', err);
        if (!cancelled) router.replace('/loading');
      });
    };
    checkAccess();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkAccess();
        refreshPaidStatusFromRevenueCat()
          .then(checkAccess)
          .catch((err) => console.warn('[RootLayout] Failed to refresh family access:', err));
      }
    });

    return () => {
      cancelled = true;
      appStateSub.remove();
    };
  }, [pathname, authUserId]);

  useEffect(() => {
    const responseListener = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleNotificationResponse(response);
    }).catch((err) => console.warn('[RootLayout] Failed to read notification response:', err));
    return () => responseListener.remove();
  }, [handleNotificationResponse]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Moon/Sun decoration - positioned between header and content - only on routines tab's task list */}
      {pathname === '/' && showDecorations && homeViewMode === 'activities' && (
        <View style={{ position: 'absolute', right: columnInset + s(16), top: vs(80), zIndex: 50, pointerEvents: 'none' }}>
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

      {pathname === '/loading' ||
      pathname === '/paywall' ||
      pathname.startsWith('/onboarding') ||
      (pathname === '/' && !isBootComplete()) ? (
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
          <Stack.Screen name="paywall" options={{ headerShown: false }} />
          <Stack.Screen name="index" options={{ headerShown: false, animation: 'none' }} />
        </Stack>
      ) : (
        <Tabs
          screenLayout={({ children, route }) => (
            <React.Fragment key={route.name === 'profile' ? 'profile' : authUserId ?? 'guest'}>
              {children}
            </React.Fragment>
          )}
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
            name="profile"
            listeners={gatedTabListener('/profile', isOnline)}
            options={{
              title: 'Profile',
              // Account linking, sign-in and deletion all need the server.
              tabBarItemStyle: { flex: 1, paddingVertical: vs(6), justifyContent: 'center', opacity: isOnline ? 1 : 0.4 },
              tabBarAccessibilityLabel: isOnline ? 'Profile' : 'Profile, unavailable offline',
              headerLeft: () => <NavigationBackButton />,
              headerStyle: { backgroundColor: colors.morningBg },
              headerTintColor: colors.textInk,
              tabBarStyle: { display: 'none' },
              tabBarLabel: ({ color }) => <TabLabel text="Profile" color={color} />,
              tabBarIcon: ({ color, size }) => (
                <MaterialCommunityIcons name="account-circle-outline" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="settings"
            listeners={gatedTabListener('/settings')}
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
          <Tabs.Screen name="paywall" options={{ href: null }} />
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
      <ParentalGateHost />
    </GestureHandlerRootView>
  );
}
