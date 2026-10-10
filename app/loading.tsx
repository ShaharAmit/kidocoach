import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ensureAuth } from '../services/firebase';
import { requestNotificationPermissions } from '../services/notifications';
import {
  downloadWelcomeAssets,
  warmAllRoutineAssetsToCompletion,
} from '../services/assetCacheService';
import { getPaidStatus, refreshPaidStatusFromRevenueCat } from '../services/subscription';
import { getChildProfile } from '../services/profile';
import { recoverSignedInFamily } from '../services/accountSession';
import { getAccessRoute } from '../utils/accessRoute';
import { markBootComplete } from '../services/bootState';
import { initPurchases } from '../services/purchases';
import { Routine } from '../types';
import { getHomeBootstrapSnapshot, primeHomeBootstrap } from '../services/homeBootstrap';
import { colors, fs, ms, s, vs } from '../theme';
import { requestParentalGate } from '../components/ParentalGate';
import DayNightTransition from '../components/DayNightTransition';

export default function LoadingScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const isPostQuestionnaire = params.mode === 'generating_experience';
  const isWarmStart = isPostQuestionnaire;

  const progressAnim = useRef(new Animated.Value(0)).current;
  const [progress, setProgress] = useState(isWarmStart ? 15 : 0);
  const [stage, setStage] = useState(
    isWarmStart ? 'Generating experience...' : 'Starting...'
  );
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

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
        let profile = await getChildProfile();
        if (!profile && !user.isAnonymous) {
          setStage('Recovering saved family...');
          await recoverSignedInFamily();
          profile = await getChildProfile();
        }

        if (!isWarmStart) {
          setStage('Preparing your coach...');
          setProgress(35);
          await downloadWelcomeAssets().catch((err) => {
            console.warn('[Loading] Welcome asset download error:', err);
          });
        }

        // Purchase arrivals use the cached flag; cold starts refresh RevenueCat.
        if (!isWarmStart) await initPurchases();
        const isPaid = isWarmStart ? await getPaidStatus() : await refreshPaidStatusFromRevenueCat();
        const onboardingDone = profile !== null;

        if (onboardingDone && isPaid) {
          setStage('Generating experience...');
          setProgress(50);

          await primeHomeBootstrap(user.uid).catch((err) => {
            console.warn('[Loading] Home bootstrap preload failed:', err);
          });

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

        markBootComplete();
        router.replace(getAccessRoute(isPaid, onboardingDone));
      } catch (err) {
        console.warn('[Loading] Failed to initialize app:', err);
        if (!isCancelled) {
          setError('Could not load your family. Check your connection and try again.');
        }
      }
    }

    run();

    return () => {
      isCancelled = true;
    };
  }, [isWarmStart, attempt]);

  const width = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

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
          {error ? (
            <>
              <Text style={styles.cardStage}>{error}</Text>
              <TouchableOpacity onPress={() => { setError(''); setAttempt((value) => value + 1); }}>
                <Text style={styles.percent}>Try again</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { void requestParentalGate().then((passed) => { if (passed) router.replace('/profile'); }); }}>
                <Text style={styles.percent}>Parent sign in</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      </View>
    </DayNightTransition>
  );
}

const styles = StyleSheet.create({
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
