import React, { useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, usePathname } from 'expo-router';
import StarBank from '../components/StarBank';
import DailyProgressCard from '../components/DailyProgressCard';
import PageBackground from '../components/PageBackground';
import { getNativeHeaderOptions } from '../components/ScreenHeader';
import { getChildProfile } from '../services/profile';
import { ensureAuth } from '../services/firebase';
import { useUserRoutines } from '../hooks/useRoutine';
import { getUserTotalStars } from '../services/stars';
import { ChildProfile, DailyProgress, Routine } from '../types';
import { colors, fs, ms, vs } from '../theme';
import { completionStorageKey } from '../utils/dailyCompletion';
import { getTodayISO } from '../utils/date';
import { isMorningTime } from '../utils/timeOfDay';

async function computeDailyProgress(routines: Routine[]): Promise<DailyProgress> {
  const today = getTodayISO();
  let morningTotal = 0;
  let eveningTotal = 0;
  let morningCompleted = 0;
  let eveningCompleted = 0;

  for (const routine of routines) {
    const raw = await AsyncStorage.getItem(completionStorageKey(routine.id));
    let parsed: { date?: string; morning?: string[]; evening?: string[] } | null = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const morningSet = new Set<string>(parsed?.date === today ? parsed?.morning ?? [] : []);
    const eveningSet = new Set<string>(parsed?.date === today ? parsed?.evening ?? [] : []);

    routine.activityStack.forEach((_, index) => {
      const stepId = routine.stepIds?.[index] ?? `step_${index}`;
      const stepTime = routine.stepTimes?.[index] ?? routine.scheduledTime;
      if (isMorningTime(stepTime)) {
        morningTotal += 1;
        if (morningSet.has(stepId)) morningCompleted += 1;
      } else {
        eveningTotal += 1;
        if (eveningSet.has(stepId)) eveningCompleted += 1;
      }
    });
  }

  return { morningCompleted, morningTotal, eveningCompleted, eveningTotal };
}

export default function RewardsScreen() {
  const pathname = usePathname();
  const [profile, setProfile] = useState<ChildProfile | null>(null);
  const [userId, setUserId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [dailyProgress, setDailyProgress] = useState<DailyProgress>({
    morningCompleted: 0,
    morningTotal: 0,
    eveningCompleted: 0,
    eveningTotal: 0,
  });

  useEffect(() => {
    let mounted = true;

    async function initProfile() {
      try {
        const user = await ensureAuth();
        if (mounted) setUserId(user.uid);

        const childProfile = await getChildProfile();
        if (mounted) setProfile(childProfile);
      } catch (err) {
        console.warn('[Rewards] init failed:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    initProfile();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (pathname !== '/rewards') return;

    let mounted = true;
    async function refreshProfile() {
      try {
        const latest = await getChildProfile();
        if (mounted) setProfile(latest);
      } catch (err) {
        console.warn('[Rewards] refresh profile failed:', err);
      }
    }

    refreshProfile();
    return () => {
      mounted = false;
    };
  }, [pathname]);

  const routinesResult = useUserRoutines(userId);
  const routines = useMemo(() => routinesResult?.routines ?? [], [routinesResult?.routines]);

  useEffect(() => {
    if (pathname !== '/rewards' || !userId) return;
    let mounted = true;

    async function refreshRewardsData() {
      try {
        const [profileResult, starsResult, progressResult] = await Promise.allSettled([
          getChildProfile(),
          getUserTotalStars(userId),
          computeDailyProgress(routines),
        ]);

        if (!mounted) return;

        const latestProfile =
          profileResult.status === 'fulfilled' ? profileResult.value : null;
        const serverStars =
          starsResult.status === 'fulfilled' ? starsResult.value : null;
        const progress =
          progressResult.status === 'fulfilled'
            ? progressResult.value
            : { morningCompleted: 0, morningTotal: 0, eveningCompleted: 0, eveningTotal: 0 };

        if (latestProfile) {
          const localStars = latestProfile.totalStarsEarned ?? 0;
          const resolvedStars =
            typeof serverStars === 'number' ? Math.max(localStars, serverStars) : localStars;
          setProfile({
            ...latestProfile,
            totalStarsEarned: resolvedStars,
          });
        } else {
          setProfile(null);
        }

        setDailyProgress(progress);
      } catch (err) {
        console.warn('[Rewards] refresh failed:', err);
      }
    }

    refreshRewardsData();
    return () => {
      mounted = false;
    };
  }, [pathname, userId, routines]);

  if (loading || !profile) {
    return (
      <PageBackground variant="clouds">
        <Stack.Screen options={getNativeHeaderOptions('Rewards')} />
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading rewards...</Text>
        </View>
      </PageBackground>
    );
  }

  const totalStars = profile.totalStarsEarned ?? 0;

  return (
    <PageBackground variant="clouds">
      <Stack.Screen options={getNativeHeaderOptions(`${profile.childName}'s Rewards`)} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <StarBank totalStars={totalStars} />

        {/* Today's Journey Section */}
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>Today&apos;s Journey</Text>
          {routines.length > 0 ? (
            <>
              <DailyProgressCard segment="morning" progress={dailyProgress} />
              <DailyProgressCard segment="evening" progress={dailyProgress} />
            </>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No routine configured yet</Text>
              <Text style={styles.emptyStateSubtext}>Complete your setup to start earning stars!</Text>
            </View>
          )}
        </View>

        {/* Info Box */}
        <View style={styles.infoBox}>
          <Text style={styles.infoLabel}>💡 How to earn stars</Text>
          <Text style={styles.infoText}>Complete your morning and evening activities to earn stars and unlock new levels!</Text>
        </View>
      </ScrollView>
    </PageBackground>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: ms(16),
    paddingBottom: vs(130),
  },
  sectionContainer: {
    marginTop: vs(20),
    marginBottom: vs(20),
  },
  sectionTitle: {
    fontSize: fs(18),
    fontWeight: '700',
    color: colors.textDark,
    marginBottom: vs(12),
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: fs(16),
    color: colors.textMuted,
  },
  emptyState: {
    backgroundColor: colors.white,
    borderRadius: ms(12),
    padding: ms(20),
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: fs(16),
    fontWeight: '600',
    color: colors.textDark,
    marginBottom: vs(8),
  },
  emptyStateSubtext: {
    fontSize: fs(14),
    color: colors.textMuted,
    textAlign: 'center',
  },
  infoBox: {
    backgroundColor: '#E6F2FF',
    borderRadius: ms(12),
    padding: ms(14),
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    marginTop: vs(20),
  },
  infoLabel: {
    fontSize: fs(14),
    fontWeight: '700',
    color: colors.textDark,
    marginBottom: vs(6),
  },
  infoText: {
    fontSize: fs(13),
    color: colors.textSlate,
    lineHeight: fs(19),
  },
});
