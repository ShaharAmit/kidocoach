import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import ActivityPlayer from '../components/ActivityPlayer';
import StarsBackground from '../components/StarsBackground';
import CloudsBackground from '../components/CloudsBackground';
import { ACTIVITIES } from '../constants/activities';
import {
  ACTIVITY_FALLBACK_IMAGE,
  ACTIVITY_IMAGES,
  ALL_BUNDLED_IMAGES,
} from '../constants/images';
import { useLocalDailyCompletion } from '../hooks/useLocalDailyCompletion';
import { useUserRoutines } from '../hooks/useRoutine';
import { subscribeAssetCacheStatus } from '../services/assetCacheService';
import { areAssetsReady, syncRoutineAssets } from '../services/assetSync';
import { ensureAuth } from '../services/firebase';
import { getHomeBootstrapSnapshot, isRoutineWarmed, markRoutineWarmed } from '../services/homeBootstrap';
import { setHomeViewMode } from '../services/homeViewState';
import { getChildProfile, saveChildProfile } from '../services/profile';
import { awardRoutineStepStar } from '../services/stars';
import { ensureAudioForRoutine } from '../services/tts';
import { Routine } from '../types';
import { getCurrentSegment, isMorningTime } from '../utils/timeOfDay';
import { getTodayISO } from '../utils/date';
import {
  localImageSource,
  preloadLocalImages,
  retryLocalImage,
  useLocalImagesRevision,
} from '../utils/localImages';
import { colors, fs, ms, ROUNDED_FONT, s, vs } from '../theme';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ACTIVITY_SUBTITLES: Record<string, string> = {
  brush_teeth: "Let's make those teeth sparkle!",
  get_dressed: "Time to put on comfy clothes",
  eat_breakfast: "Time to fuel up for the day!",
  pack_backpack: "Let's get ready for school!",
  wash_face: "A splash of water to wake up!",
  comb_hair: "Let's look neat and tidy!",
  put_shoes_on: "Let's get those shoes on!",
  drink_water: "A little sip for sweet dreams",
  tidy_room: "Let's clean up our space!",
  read_book: "Let's go on an adventure!",
  put_on_pajamas: "Time to get cozy for bed",
  bedtime_story: "Let's read a cozy story",
  eat_dinner: "Yummy food to end the day!",
  go_to_sleep: "Sweet dreams, sleep tight!",
  homework: "Time to focus and learn!",
  make_bed: "Let's make the bed nice and neat",
  wake_up: "Good morning, rise and shine!",
};

const ACTIVITY_FALLBACK_SUBTITLE = 'Close your eyes and rest';

function routineHasActivitiesInSegment(routine: Routine, segment: 'morning' | 'evening'): boolean {
  return routine.activityStack.some((_, index) => {
    const time = routine.stepTimes?.[index] ?? routine.scheduledTime;
    const stepIsMorning = isMorningTime(time);
    return segment === 'morning' ? stepIsMorning : !stepIsMorning;
  });
}

function pickPrimaryRoutine(
  routines: Routine[],
  segment: 'morning' | 'evening'
): Routine | null {
  if (routines.length === 0) return null;

  const withSegmentActivities = routines.find((routine) => routineHasActivitiesInSegment(routine, segment));
  if (withSegmentActivities) return withSegmentActivities;

  return routines[0];
}

const roundedFontBold = ROUNDED_FONT;

export default function HomeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [userId, setUserId] = useState('');
  const [cacheStage, setCacheStage] = useState('idle');
  const [segment, setSegment] = useState<'morning' | 'evening'>(getCurrentSegment());
  const [viewMode, setViewMode] = useState<'activities' | 'player'>('activities');
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [assetsReady, setAssetsReady] = useState(false);
  const [trophyVisible, setTrophyVisible] = useState(false);
  const [showCaptions, setShowCaptions] = useState(false);
  const [activityListHeight, setActivityListHeight] = useState(0);
  const [activityContentHeight, setActivityContentHeight] = useState(0);
  const [activityListHasScrolled, setActivityListHasScrolled] = useState(false);
  // Bumped on focus and on app foreground to force the activity card <Image>s to remount, which
  // re-issues their source request. Mitigation for activity photos going blank after the app has
  // been open for a long stretch. Deliberately tied to those two boundaries only: remounting on a
  // timer while the list is interactive can cancel an in-flight tap on the surrounding
  // TouchableOpacity. Note this cannot recover a Metro-served asset in a dev build when the dev
  // server is unreachable (laptop asleep, IP change) — that case needs a full reload.
  const [activityImagesRevision, setActivityImagesRevision] = useState(0);
  // Re-renders this screen as bundled activity artwork finishes resolving to local file URIs.
  const localImagesRevision = useLocalImagesRevision(ALL_BUNDLED_IMAGES);
  const [trophyShownThisSession, setTrophyShownThisSession] = useState<Record<'morning' | 'evening', boolean>>({
    morning: false,
    evening: false,
  });

  const { routines, loading, error } = useUserRoutines(userId);
  const bootstrapSnapshot = useMemo(() => getHomeBootstrapSnapshot(userId), [userId]);
  const mergedRoutines = useMemo(() => {
    const byId = new Map<string, Routine>();

    for (const routine of bootstrapSnapshot?.routines ?? []) {
      byId.set(routine.id, routine);
    }

    for (const routine of routines) {
      byId.set(routine.id, routine);
    }

    return Array.from(byId.values());
  }, [bootstrapSnapshot, routines]);

  const primaryRoutine = useMemo(
    () => pickPrimaryRoutine(mergedRoutines, segment),
    [mergedRoutines, segment]
  );
  const initialCompletion = primaryRoutine
    ? bootstrapSnapshot?.completions[primaryRoutine.id] ?? null
    : null;

  const {
    completedMorningStepIds,
    completedEveningStepIds,
    markStepDone,
    loading: completionLoading,
    activeDate,
  } = useLocalDailyCompletion(
    userId,
    primaryRoutine?.id ?? '',
    primaryRoutine?.childName,
    initialCompletion
  );

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      const user = await ensureAuth();
      if (!mounted) return;
      setUserId(user.uid);
    }

    initialize().catch((err) => {
      console.warn('[Home] init failed:', err);
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeAssetCacheStatus((next) => {
      setCacheStage(next.stage);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadCaptionPreference() {
      const profile = await getChildProfile();
      if (mounted) {
        setShowCaptions(profile?.showCaptions ?? false);
      }
    }

    loadCaptionPreference().catch((err) => {
      console.warn('[Home] failed to load caption preference:', err);
    });

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setSegment(getCurrentSegment());
        setActivityImagesRevision((revision) => revision + 1);
        preloadLocalImages(ALL_BUNDLED_IMAGES).catch(() => undefined);
        loadCaptionPreference().catch((err) => {
          console.warn('[Home] failed to refresh caption preference:', err);
        });
      }
    });
    const segmentTimer = setInterval(() => {
      setSegment(getCurrentSegment());
    }, 60_000);

    return () => {
      mounted = false;
      appStateSub.remove();
      clearInterval(segmentTimer);
    };
  }, []);

  // Switching tabs (e.g. Settings -> Routines) doesn't remount this screen or trigger an
  // AppState change, so the caption toggle above only picks up the latest saved preference
  // when this tab regains focus.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      setActivityListHasScrolled(false);
      setActivityImagesRevision((revision) => revision + 1);

      getChildProfile()
        .then((profile) => {
          if (mounted) setShowCaptions(profile?.showCaptions ?? false);
        })
        .catch((err) => console.warn('[Home] failed to refresh caption preference on focus:', err));

      return () => {
        mounted = false;
      };
    }, [])
  );

  // Nested <Stack.Screen> options have no effect on a Tabs.Screen's header — this tab's header
  // must be styled via navigation.setOptions so it matches the segment-tinted body background.
  useEffect(() => {
    const isEveningHeader = segment === 'evening';
    navigation.setOptions({
      headerShown: viewMode !== 'player',
      tabBarStyle: viewMode === 'player' ? { display: 'none' } : undefined,
      headerStyle: { backgroundColor: isEveningHeader ? colors.eveningBg : colors.morningBg },
      headerTintColor: isEveningHeader ? '#FFF' : '#1E7B7B',
      headerTitleStyle: {
        fontFamily: roundedFontBold ?? 'System',
        fontSize: fs(17),
        color: isEveningHeader ? '#FFF' : '#1E7B7B',
      },
      headerShadowVisible: false,
    });
  }, [navigation, segment, viewMode]);

  // Let the root layout know when the full-screen activity player is active so it can hide
  // the moon/sun decoration (which should only float over the activities list, not the video).
  useEffect(() => {
    setHomeViewMode(viewMode);
  }, [viewMode]);

  useEffect(() => {
    return () => setHomeViewMode('activities');
  }, []);

  const visibleStepIndexes = useMemo(() => {
    if (!primaryRoutine) return [] as number[];

    return primaryRoutine.activityStack
      .map((_, index) => {
        const time = primaryRoutine.stepTimes?.[index] ?? primaryRoutine.scheduledTime;
        const stepIsMorning = isMorningTime(time);
        if ((segment === 'morning' && stepIsMorning) || (segment === 'evening' && !stepIsMorning)) {
          return index;
        }
        return -1;
      })
      .filter((index) => index >= 0);
  }, [primaryRoutine, segment]);

  const visibleStepIds = useMemo(() => {
    if (!primaryRoutine) return [] as string[];
    const stepIds = primaryRoutine.stepIds ?? [];
    return visibleStepIndexes.map((index) => stepIds[index] ?? `step_${index}`);
  }, [primaryRoutine, visibleStepIndexes]);

  const completedStepIds = segment === 'morning' ? completedMorningStepIds : completedEveningStepIds;

  const currentStepId = useMemo(
    () => primaryRoutine?.stepIds?.[currentStepIndex] ?? `step_${currentStepIndex}`,
    [primaryRoutine, currentStepIndex]
  );

  // Positional "last in the list" is not the same as "last one left": opening the bottom activity
  // first must not claim the whole segment is finished. Drives both the button label and the
  // trophy, so the two can never disagree.
  const isFinalRemainingStep = useMemo(
    () =>
      visibleStepIds.length > 0 &&
      visibleStepIds.every((id) => id === currentStepId || completedStepIds.has(id)),
    [visibleStepIds, currentStepId, completedStepIds]
  );

  useEffect(() => {
    setActivityListHasScrolled(false);
    setActivityListHeight(0);
    setActivityContentHeight(0);
  }, [segment]);

  useEffect(() => {
    if (visibleStepIndexes.length === 0) {
      setCurrentStepIndex(0);
      return;
    }

    if (!visibleStepIndexes.includes(currentStepIndex)) {
      setCurrentStepIndex(visibleStepIndexes[0]);
    }
  }, [visibleStepIndexes, currentStepIndex]);

  useEffect(() => {
    if (!primaryRoutine) return;
    const routine = primaryRoutine;

    async function prepareAssets() {
      setAssetsReady(false);

      try {
        if (isRoutineWarmed(routine.id)) {
          setAssetsReady(true);
          // Backfill any newly-added variants (e.g. caption videos) without blocking the UI.
          syncRoutineAssets(routine).catch((err) =>
            console.warn('[Home] Background asset backfill failed:', err)
          );
          return;
        }

        const ready = await areAssetsReady(routine);
        if (ready) {
          markRoutineWarmed(routine.id, true);
          setAssetsReady(true);
          // Base video/audio are ready, but caption videos are best-effort and may not have been
          // downloaded yet (e.g. toggled on after the routine was first synced) — backfill them.
          syncRoutineAssets(routine).catch((err) =>
            console.warn('[Home] Background asset backfill failed:', err)
          );
          return;
        }

        const { missingAudioKeys } = await syncRoutineAssets(routine);
        if (missingAudioKeys.length === 0) {
          markRoutineWarmed(routine.id, true);
          setAssetsReady(true);
          return;
        }

        await ensureAudioForRoutine(routine);

        let stillMissing = missingAudioKeys;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          await wait(1500);
          const retry = await syncRoutineAssets(routine);
          stillMissing = retry.missingAudioKeys;
          if (stillMissing.length === 0) {
            break;
          }
        }

        if (stillMissing.length > 0) {
          console.warn('[Home] Audio still pending after retries:', stillMissing);
          markRoutineWarmed(routine.id, false);
        } else {
          markRoutineWarmed(routine.id, true);
        }
        setAssetsReady(true);
      } catch (err) {
        console.error('[Home] Asset prep error:', err);
        markRoutineWarmed(routine.id, false);
        setAssetsReady(true);
      }
    }

    prepareAssets();
  }, [primaryRoutine]);

  // `trophyShownThisSession` is a per-day guard, but this screen can stay mounted across midnight.
  // Without clearing it on rollover the allScopedDone effect early-returns for the new day, which
  // skips `awardRoutineStepStar` entirely — the trophy still shows (handleStepComplete forces it)
  // so the missing star would go unnoticed.
  useEffect(() => {
    setTrophyShownThisSession({ morning: false, evening: false });
  }, [activeDate]);

  const allScopedDone = useMemo(() => {
    if (visibleStepIds.length === 0) return false;
    return visibleStepIds.every((id) => completedStepIds.has(id));
  }, [visibleStepIds, completedStepIds]);

  useEffect(() => {
    if (!allScopedDone) return;
    if (trophyShownThisSession[segment]) return;

    // Award 1 star for completing the entire routine segment (not per step)
    const awardSegmentStar = async () => {
      if (userId && primaryRoutine) {
        try {
          const award = await awardRoutineStepStar({
            userId,
            routineId: primaryRoutine.id,
            date: getTodayISO(),
            segment,
            stepIndex: -1, // -1 indicates segment completion, not a specific step
          });
          if (award.awarded) {
            const profile = await getChildProfile();
            if (profile && profile.userId === userId) {
              await saveChildProfile({
                ...profile,
                totalStarsEarned: award.totalStars,
                updatedAt: Date.now(),
              });
            }
          }
        } catch (err) {
          console.warn('[Home] Failed to award segment star:', err);
        }
      }
    };

    awardSegmentStar();
    setTrophyVisible(true);
    setTrophyShownThisSession((prev) => ({ ...prev, [segment]: true }));
  }, [allScopedDone, segment, trophyShownThisSession, userId, primaryRoutine]);

  const handleStepComplete = useCallback(async () => {
    if (!primaryRoutine || visibleStepIndexes.length === 0) return;

    const completesSegment = isFinalRemainingStep;
    const newlyCompleted = await markStepDone(segment, currentStepId, visibleStepIndexes.length);

    // Star awarding now happens in the allScopedDone effect,
    // so we don't award here anymore. Show the completion message immediately after the final
    // step is persisted; the effect still handles the idempotent star award.
    if (newlyCompleted && completesSegment) {
      setTrophyVisible(true);
    }

    // Always leave the player, including when this step was already completed earlier today.
    // `markStepDone` reports `false` for that re-watch case, and gating the transition on it made
    // the Done button silently do nothing whenever a finished activity was replayed.
    setViewMode('activities');
  }, [
    primaryRoutine,
    visibleStepIndexes,
    isFinalRemainingStep,
    currentStepId,
    markStepDone,
    segment,
  ]);


  if ((loading || completionLoading) && !primaryRoutine) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#5F8F86" />
        <Text style={styles.loadingText}>Loading routines...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Failed to load routines.</Text>
        <Text style={styles.errorSub}>{error.message}</Text>
      </View>
    );
  }

  if (!primaryRoutine) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>No routine found.</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/parent/create')}>
          <Text style={styles.primaryButtonText}>Create Routine</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isEvening = segment === 'evening';
  const completedCount = visibleStepIds.filter((id) => completedStepIds.has(id)).length;

  const currentActivityStep = primaryRoutine.activityStack[currentStepIndex] ?? [];
  // Progress reflects how many activities are actually finished, not where the opened card sits
  // in the list, so the dots and counter can't fill up ahead of the real state when the child
  // starts from the bottom of the list. Reaches `totalSteps` exactly when `isFinalRemainingStep`.
  const scopedProgress = completedCount + (completedStepIds.has(currentStepId) ? 0 : 1);

  return (
    <View style={[styles.container, isEvening ? styles.containerEvening : styles.containerMorning]}>
      <StatusBar barStyle={isEvening ? 'light-content' : 'dark-content'} />

      {viewMode === 'activities' ? (
        <View style={styles.activitiesContainer}>
          {isEvening ? (
            <>
              <StarsBackground />
            </>
          ) : (
            <>
              <CloudsBackground />
            </>
          )}

          <SafeAreaView style={styles.safeContent} edges={['bottom']}>
           <View style={styles.activitiesHeader}>
             <Text style={[styles.activitiesProgress, !isEvening && styles.activitiesProgressMorning]}>
               {completedCount} / {visibleStepIndexes.length}
             </Text>
              {cacheStage === 'warming-assets' ? (
                <View style={styles.prepBadge}>
                  <Text style={styles.prepBadgeText}>Preparing media...</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.cardWrap}>
              <View style={[styles.card, !isEvening && styles.cardMorning]}>
              <ScrollView
                contentContainerStyle={styles.activitiesList}
                showsVerticalScrollIndicator={false}
                onLayout={(event) => setActivityListHeight(event.nativeEvent.layout.height)}
                onContentSizeChange={(_, height) => setActivityContentHeight(height)}
                onScrollBeginDrag={() => setActivityListHasScrolled(true)}
                scrollEventThrottle={16}
              >
                {visibleStepIndexes.map((index, listIdx) => {
                  const step = primaryRoutine.activityStack[index] ?? [];
                  const metas = step.map((key) => ACTIVITIES[key]).filter(Boolean);
                  const primaryLabel = metas[0]?.label ?? 'Activity';
                  const stepId = primaryRoutine.stepIds?.[index] ?? `step_${index}`;
                  const done = completedStepIds.has(stepId);
                  const primaryActivityKey = step[0] ?? '';
                  const activityImage = ACTIVITY_IMAGES[primaryActivityKey] ?? ACTIVITY_FALLBACK_IMAGE;
                  const activitySubtitle = ACTIVITY_SUBTITLES[primaryActivityKey] ?? ACTIVITY_FALLBACK_SUBTITLE;

                  return (
                    <TouchableOpacity
                      key={`segment-step-${index}`}
                      style={[styles.activityCard, done && styles.activityCardDone]}
                      activeOpacity={0.9}
                      onPress={() => {
                        setCurrentStepIndex(index);
                        setViewMode('player');
                      }}
                    >
                      <View style={styles.activityImageWrap}>
                        <Image
                          key={`${stepId}-${activityImagesRevision}-${localImagesRevision}`}
                          source={localImageSource(activityImage)}
                          style={styles.activityImage}
                          resizeMode="contain"
                          onError={() => retryLocalImage(activityImage)}
                        />
                      </View>

                      <View style={styles.activityTextWrap}>
                        <Text style={styles.activityTitle} numberOfLines={1}>
                          {listIdx + 1}. {primaryLabel}
                        </Text>
                        <Text style={styles.activitySubtitle} numberOfLines={1}>
                          {activitySubtitle}
                        </Text>
                      </View>

                      <View style={[styles.checkWrap, done && styles.checkWrapDone]}>
                        <Text style={[styles.checkText, done && styles.checkTextDone]}>
                          {done ? '✓' : ''}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}

                {visibleStepIndexes.length === 0 ? (
                  <View style={styles.emptyState}>
                    <TouchableOpacity
                      style={styles.emptyAddButton}
                      onPress={() => router.push(`/parent/create?segment=${segment}` as never)}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.emptyAddIcon}>＋</Text>
                    </TouchableOpacity>
                    <Text style={styles.emptyTitle}>No activities yet</Text>
                    <Text style={styles.emptySub}>Tap + to add activities for this routine.</Text>
                  </View>
                ) : null}
              </ScrollView>
              {activityContentHeight > activityListHeight + 2 && !activityListHasScrolled ? (
                <View pointerEvents="none" style={styles.activityScrollHint}>
                  <Text style={styles.activityScrollHintText}>↓</Text>
                </View>
              ) : null}
            </View>
          </View>
          </SafeAreaView>
        </View>
      ) : null}

      {viewMode === 'player' && assetsReady ? (
        <>
          <ActivityPlayer
            key={`${primaryRoutine.id}_${currentStepIndex}_${(currentActivityStep || []).join('_')}`}
            activityStep={currentActivityStep}
            childName={primaryRoutine.childName || ''}
            avatarId={primaryRoutine.avatarId || 'becky'}
            segment={segment}
            stepNumber={scopedProgress}
            totalSteps={visibleStepIndexes.length}
            isFinalRemainingStep={isFinalRemainingStep}
            showCaptions={showCaptions}
            onComplete={handleStepComplete}
          />

          <TouchableOpacity
            style={[styles.backToActivitiesBtn, { top: insets.top + vs(12) }]}
            onPress={() => setViewMode('activities')}
            activeOpacity={0.9}
          >
            <Text style={styles.backToActivitiesText}>‹ Back</Text>
          </TouchableOpacity>
        </>
      ) : null}

      {viewMode === 'player' && !assetsReady ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#5F8F86" />
          <Text style={styles.loadingText}>Preparing media...</Text>
          <TouchableOpacity
            style={[styles.primaryButton, { marginTop: vs(14) }]}
            onPress={() => setViewMode('activities')}
            activeOpacity={0.9}
          >
            <Text style={styles.primaryButtonText}>Back To Activities</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal visible={trophyVisible} transparent animationType="fade" onRequestClose={() => setTrophyVisible(false)}>
        <View style={styles.trophyOverlay}>
          <View style={styles.trophyCard}>
            <Text style={styles.trophyEmoji}>🏆</Text>
            <Text style={styles.trophyTitle}>Amazing, {primaryRoutine.childName}!</Text>
            <Text style={styles.trophySub}>You finished all {segment} activities.</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                setTrophyVisible(false);
                setViewMode('activities');
              }}
            >
              <Text style={styles.primaryButtonText}>Great Job</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.morningBg,
  },
  containerMorning: {
    backgroundColor: colors.morningBg,
  },
  containerEvening: {
    backgroundColor: colors.eveningBg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.appBg,
    padding: ms(24),
  },
  loadingText: {
    marginTop: vs(14),
    fontSize: fs(16),
    color: '#5A6A64',
  },
  errorText: {
    fontSize: fs(20),
    fontWeight: '700',
    color: colors.danger,
    marginBottom: vs(8),
  },
  errorSub: {
    fontSize: fs(14),
    color: '#6A6A6A',
    textAlign: 'center',
  },
  activitiesContainer: {
    flex: 1,
  },
  safeContent: {
    flex: 1,
  },
  moon: {
    position: 'absolute',
    top: vs(-30),
    right: s(14),
    width: s(96),
    height: s(96),
    zIndex: 7!,
  },
  sun: {
    position: 'absolute',
    top: vs(-30),
    right: s(12),
    width: s(104),
    height: s(104),
    zIndex: 7!,
  },
  activitiesHeader: {
    alignItems: 'center',
    paddingTop: vs(12),
    paddingBottom: vs(6),
    paddingHorizontal: s(16),
  },
  activitiesTitle: {
    fontSize: fs(44),
    lineHeight: fs(48),
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.eveningTitle,
    fontFamily: roundedFontBold ?? 'System',
  },
  activitiesTitleMorning: {
    color: colors.morningTitle,
  },
  activitiesSubtitle: {
    marginTop: vs(4),
    fontSize: fs(30),
    color: colors.eveningSubtitle,
    fontFamily: roundedFontBold ?? 'System',
  },
  activitiesSubtitleMorning: {
    color: colors.morningSubtitle,
  },
  activitiesProgress: {
    marginTop: vs(6),
    fontSize: fs(15),
    color: '#8E9CC4',
    fontWeight: '600',
  },
  activitiesProgressMorning: {
    color: '#4E73A0',
  },
  prepBadge: {
    marginTop: vs(8),
    paddingVertical: vs(7),
    paddingHorizontal: s(12),
    borderRadius: ms(99),
    backgroundColor: '#FFF8D8',
    borderWidth: 1,
    borderColor: '#E8D28E',
  },
  prepBadgeText: {
    fontSize: fs(12),
    color: '#705E1A',
    fontWeight: '700',
  },
  cardWrap: {
    flex: 1,
    maxHeight: '65%',
    marginVertical: 'auto',
    paddingHorizontal: s(18),
    paddingTop: vs(2),
    paddingBottom: vs(6),
  },
  card: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: ms(28),
    overflow: 'hidden',
    shadowColor: colors.shadow,
    shadowOpacity: 0.18,
    shadowRadius: ms(16),
    shadowOffset: { width: 0, height: vs(8) },
    elevation: 4,
  },
  cardMorning: {
    backgroundColor: colors.white,
  },
  activitiesList: {
    paddingHorizontal: s(14),
    paddingTop: vs(8),
    paddingBottom: vs(96),
  },
  activityScrollHint: {
    position: 'absolute',
    bottom: vs(12),
    alignSelf: 'center',
    width: s(40),
    height: s(40),
    borderRadius: ms(20),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.92)',
    shadowColor: colors.shadow,
    shadowOpacity: 0.16,
    shadowRadius: ms(6),
    shadowOffset: { width: 0, height: vs(2) },
    elevation: 4,
  },
  activityScrollHintText: {
    marginTop: -vs(4),
    color: '#1F4A52',
    fontSize: fs(28),
    fontWeight: '800',
  },
  activityCard: {
    backgroundColor: colors.white,
    borderRadius: ms(20),
    marginBottom: vs(12),
    paddingVertical: vs(12),
    paddingHorizontal: s(12),
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.morningCardBorder,
    borderStyle: 'dashed',
  },
  activityCardDone: {
    backgroundColor: '#F4FBF5',
    borderColor: '#BFE3CF',
  },
  activityImageWrap: {
    width: s(60),
    height: s(60),
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: s(12),
  },
  activityImage: {
    width: s(56),
    height: s(56),
  },
  activityTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  activityTitle: {
    fontSize: fs(21),
    color: '#1F4A52',
    fontFamily: roundedFontBold ?? 'System',
  },
  activitySubtitle: {
    marginTop: vs(3),
    fontSize: fs(14),
    color: '#5E8A86',
    fontWeight: '600',
  },
  checkWrap: {
    width: s(34),
    height: s(34),
    borderRadius: ms(17),
    borderWidth: 2,
    borderColor: '#8CA3A1',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: s(8),
    backgroundColor: '#F7FBFA',
  },
  checkWrapDone: {
    borderColor: '#7AA49B',
    backgroundColor: '#E9F4F2',
  },
  checkText: {
    fontSize: fs(20),
    lineHeight: fs(22),
    color: '#5D7E78',
    fontWeight: '800',
  },
  checkTextDone: {
    color: colors.success,
  },
  backToActivitiesBtn: {
    position: 'absolute',
    left: s(16),
    top: vs(12),
    borderRadius: ms(18),
    backgroundColor: colors.primary,
    paddingVertical: vs(8),
    paddingHorizontal: s(16),
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: ms(6),
    shadowOffset: { width: 0, height: vs(2) },
  },
  backToActivitiesText: {
    fontSize: fs(15),
    fontWeight: '700',
    color: colors.white,
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: colors.overlayLight,
  },
  menuPopover: {
    position: 'absolute',
    borderRadius: ms(14),
    backgroundColor: colors.white,
    padding: ms(10),
    borderWidth: 1,
    borderColor: '#E1E8E7',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: vs(5) },
    shadowOpacity: 0.16,
    shadowRadius: ms(14),
    elevation: 8,
  },
  menuTitle: {
    fontSize: fs(12),
    color: '#8B9A98',
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: s(8),
    paddingVertical: vs(6),
    fontWeight: '700',
  },
  menuItem: {
    paddingHorizontal: s(10),
    paddingVertical: vs(10),
    borderRadius: ms(10),
  },
  menuItemText: {
    fontSize: fs(16),
    color: '#233232',
    fontWeight: '600',
  },
  trophyOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: ms(18),
  },
  trophyCard: {
    width: '100%',
    maxWidth: s(360),
    borderRadius: ms(22),
    backgroundColor: colors.white,
    paddingHorizontal: s(18),
    paddingVertical: vs(22),
    alignItems: 'center',
  },
  trophyEmoji: {
    fontSize: fs(72),
  },
  trophyTitle: {
    marginTop: vs(8),
    fontSize: fs(28),
    textAlign: 'center',
    color: '#243231',
    fontFamily: roundedFontBold ?? 'System',
  },
  trophySub: {
    marginTop: vs(6),
    marginBottom: vs(18),
    fontSize: fs(16),
    color: '#5E6F6E',
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: ms(14),
    paddingVertical: vs(12),
    paddingHorizontal: s(18),
  },
  primaryButtonText: {
    fontSize: fs(16),
    fontWeight: '700',
    color: colors.white,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: vs(28),
  },
  emptyAddButton: {
    width: s(62),
    height: s(62),
    borderRadius: ms(31),
    backgroundColor: '#EAF5F3',
    borderWidth: 2,
    borderColor: '#B7D9D2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: vs(12),
  },
  emptyAddIcon: {
    fontSize: fs(36),
    lineHeight: fs(38),
    color: '#3B8A7E',
    fontWeight: '700',
  },
  emptyTitle: {
    fontSize: fs(18),
    fontWeight: '700',
    color: '#536362',
  },
  emptySub: {
    marginTop: vs(4),
    fontSize: fs(14),
    color: '#788583',
  },
  headerMenuButton: {
    width: s(38),
    height: s(38),
    borderRadius: ms(19),
    backgroundColor: colors.surfaceTranslucent,
    borderWidth: 1,
    borderColor: '#D8DCCF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerMenuIcon: {
    fontSize: fs(24),
    color: colors.white,
    lineHeight: fs(24),
    fontFamily: roundedFontBold ?? 'System',
  },
  headerMenuIconMorning: {
    color: colors.teal,
  },
  floatingMenu: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    backgroundColor: colors.white,
    borderRadius: ms(16),
    paddingHorizontal: s(10),
    paddingVertical: vs(8),
    marginHorizontal: s(12),
    shadowColor: colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: ms(8),
    shadowOffset: { width: 0, height: vs(-4) },
    elevation: 8,
  },
  menuItemContainer: {
    alignItems: 'center',
    gap: s(3),
  },
  menuIconButton: {
    width: s(28),
    height: s(28),
    borderRadius: ms(14),
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIcon: {
    fontSize: fs(14),
  },
  menuLabel: {
    fontSize: fs(9),
    fontWeight: '600',
    color: '#536362',
    textAlign: 'center',
  },
});
