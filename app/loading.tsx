import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ensureAuth } from '../services/firebase';
import { requestNotificationPermissions } from '../services/notifications';
import {
  downloadWelcomeAssets,
  warmAllRoutineAssetsToCompletion,
} from '../services/assetCacheService';
import { getPaidStatus, refreshPaidStatusFromRevenueCat } from '../services/subscription';
import { hasTemporaryPaywallAccess } from '../services/temporaryAccess';
import { getChildProfile, hasCompletedOnboarding } from '../services/profile';
import { Routine } from '../types';
import { getHomeBootstrapSnapshot, primeHomeBootstrap } from '../services/homeBootstrap';
import { colors, fs, ms, s, vs } from '../theme';
import DayNightTransition from '../components/DayNightTransition';

export default function LoadingScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const isPostQuestionnaire = params.mode === 'generating_experience';
  const isTemporarySkip = params.mode === 'temporary_skip';
  const isWarmStart = isPostQuestionnaire || isTemporarySkip;

  const progressAnim = useRef(new Animated.Value(0)).current;
  const [progress, setProgress] = useState(isWarmStart ? 15 : 0);
  const [stage, setStage] = useState(
    isWarmStart ? 'Generating experience...' : 'Starting...'
  );

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [progress, progressAnim]);

  useEffect(() => {
    let isCancelled = false;

    async function run() {
      try {
        if (!isWarmStart) {
          setStage('Signing in...');
          setProgress(15);
          await requestNotificationPermissions();
        }

        const user = await ensureAuth();

        if (!isWarmStart) {
          setStage('Preparing your coach...');
          setProgress(35);
          await downloadWelcomeAssets().catch((err) => {
            console.warn('[Loading] Welcome asset download error:', err);
          });
        }

        // Purchase and temporary-skip arrivals use the cached flag; cold starts refresh RevenueCat.
        const isPaid = isWarmStart ? await getPaidStatus() : await refreshPaidStatusFromRevenueCat();
        const onboardingDone = await hasCompletedOnboarding();

        if (isWarmStart || (onboardingDone && isPaid)) {
          setStage('Generating experience...');
          setProgress(50);

          await primeHomeBootstrap(user.uid).catch((err) => {
            console.warn('[Loading] Home bootstrap preload failed:', err);
          });

          const profile = await getChildProfile();
          const snapshot = getHomeBootstrapSnapshot(user.uid);
          const routines: Routine[] = snapshot?.routines ?? [];

          if (routines.length === 0 && profile) {
            const fallbackMorning: Routine = {
              id: 'morning',
              userId: profile.userId,
              childName: profile.childName,
              childAge: profile.age,
              avatarId: profile.avatarId,
              scheduledTime: profile.scheduledTime,
              activityStack: profile.activityStack,
              stepTimes: profile.stepTimes,
              tone: profile.tone,
              voice: profile.voice,
            };
            routines.push(fallbackMorning);
          }

          if (routines.length > 0) {
            await warmAllRoutineAssetsToCompletion(routines, (stageText, pct) => {
              if (isCancelled) return;
              setStage(stageText);
              setProgress(pct);
            });
          }
        }

        setStage('Ready!');
        setProgress(100);

        if (isCancelled) return;

        const canEnterApp = isPaid || (isTemporarySkip && hasTemporaryPaywallAccess());
        if (onboardingDone) {
          router.replace(canEnterApp ? '/' : ('/paywall' as never));
        } else {
          router.replace(canEnterApp ? ('/onboarding/questionnaire' as never) : ('/onboarding/welcome' as never));
        }
      } catch (err) {
        console.warn('[Loading] Failed to initialize app:', err);
        if (!isCancelled) {
          router.replace('/onboarding/welcome' as never);
        }
      }
    }

    run();

    return () => {
      isCancelled = true;
    };
  }, [isPostQuestionnaire, isTemporarySkip, isWarmStart]);

  const width = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  const content = (
    <View style={styles.container}>
      <Text style={styles.title}>Kids Routine Coach</Text>
      <Text style={styles.stage}>{stage}</Text>

      <View style={styles.barTrack}>
        <Animated.View style={[styles.barFill, { width }]} />
      </View>

      <Text style={styles.percent}>{Math.round(progress)}%</Text>
    </View>
  );

  if (!isWarmStart) {
    return content;
  }

  return (
    <DayNightTransition>
      <View style={styles.sceneContent}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Building {'\n'}your day &amp; night</Text>
          <Text style={styles.cardStage}>{stage}</Text>

          <View style={styles.barTrack}>
            <Animated.View style={[styles.barFill, { width }]} />
          </View>

          <Text style={styles.percent}>{Math.round(progress)}%</Text>
        </View>
      </View>
    </DayNightTransition>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: s(28),
    backgroundColor: '#F5F7FA',
  },
  title: {
    fontSize: fs(28),
    fontWeight: '800',
    color: '#1E2B39',
    marginBottom: vs(20),
  },
  stage: {
    fontSize: fs(16),
    color: '#4A5568',
    marginBottom: vs(24),
  },
  barTrack: {
    width: '100%',
    height: vs(12),
    borderRadius: ms(8),
    backgroundColor: '#DFE5EC',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  percent: {
    marginTop: vs(12),
    fontSize: fs(14),
    color: '#667085',
    fontWeight: '700',
  },
  sceneContent: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: s(24),
    paddingBottom: vs(80),
  },
  card: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: vs(24),
    paddingHorizontal: s(22),
    borderRadius: ms(24),
    backgroundColor: colors.surfaceTranslucent,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: vs(6) },
    shadowOpacity: 0.16,
    shadowRadius: ms(14),
    elevation: 8,
  },
  cardTitle: {
    fontSize: fs(24),
    fontWeight: '800',
    color: colors.textInk,
    textAlign: 'center',
    marginBottom: vs(10),
  },
  cardStage: {
    fontSize: fs(15),
    color: colors.textSlate,
    textAlign: 'center',
    marginBottom: vs(20),
  },
});
