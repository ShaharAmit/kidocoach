import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { getChildProfile, saveChildProfile, saveUserProfileDoc } from '../services/profile';
import { clearLocalFamilySession } from '../services/accountSession';
import { clearAllLocalCachedAssets } from '../services/assetCacheService';
import { colors, fs, ms, vs } from '../theme';
import { ChildProfile } from '../types';
import { getUserTotalStars } from '../services/stars';
import { collection, deleteDoc, doc, getDocs } from 'firebase/firestore';
import { db } from '../services/firebase';
import { cancelRoutineNotification } from '../services/notifications';
import PageBackground from '../components/PageBackground';
import { getNativeHeaderOptions } from '../components/ScreenHeader';

export default function SettingsScreen() {
  const [profile, setProfile] = useState<ChildProfile | null>(null);
  const [starsCount, setStarsCount] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const [isSavingCaptions, setIsSavingCaptions] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);

  const avatarEmoji = useMemo(() => {
    if (!profile) return '🙂';
    return profile.gender === 'girl' ? '👧' : '👦';
  }, [profile]);

  const profileGenderLabel = useMemo(() => {
    if (!profile) return '—';
    return profile.gender === 'girl' ? 'Girl' : 'Boy';
  }, [profile]);

  useEffect(() => {
    let mounted = true;

    async function loadSettingsData() {
      const loadedProfile = await getChildProfile();
      if (!mounted) return;

      if (!loadedProfile) {
        setProfile(null);
        setStarsCount(0);
        return;
      }

      setProfile(loadedProfile);
      const remoteStars = await getUserTotalStars(loadedProfile.userId);
      if (!mounted) return;
      setStarsCount(typeof remoteStars === 'number' ? remoteStars : loadedProfile.totalStarsEarned ?? 0);
    }

    loadSettingsData().catch((err) => {
      console.warn('[Settings] failed to load profile:', err);
    });

    return () => {
      mounted = false;
    };
  }, []);

  const handleResetQuestionnaire = async () => {
    if (isResetting) return;

    const existingProfile = await getChildProfile();
    if (!existingProfile) {
      await clearLocalFamilySession();
      await clearAllLocalCachedAssets();
      router.replace('/onboarding/questionnaire' as never);
      return;
    }

    setIsResetting(true);
    try {
      const { userId } = existingProfile;
      const routinesSnap = await getDocs(collection(db, 'users', userId, 'routines'));

      for (const routineDoc of routinesSnap.docs) {
        const data = routineDoc.data() as Record<string, unknown>;
        const notificationId = data.notificationId;
        if (typeof notificationId === 'string' && notificationId.length > 0) {
          await cancelRoutineNotification(notificationId).catch((err) => {
            console.warn('[Settings] failed to cancel scheduled notification:', err);
          });
        }

        const activitiesSnap = await getDocs(
          collection(db, 'users', userId, 'routines', routineDoc.id, 'activities')
        );
        await Promise.all(activitiesSnap.docs.map((activityDoc) => deleteDoc(activityDoc.ref)));
        await deleteDoc(routineDoc.ref);
      }

      const [awardsSnap, trophiesSnap] = await Promise.all([
        getDocs(collection(db, 'users', userId, 'awards')),
        getDocs(collection(db, 'users', userId, 'trophies')),
      ]);

      await Promise.all([
        ...awardsSnap.docs.map((awardDoc) => deleteDoc(awardDoc.ref)),
        ...trophiesSnap.docs.map((trophyDoc) => deleteDoc(trophyDoc.ref)),
      ]);

      await deleteDoc(doc(db, 'users', userId, 'stats', 'main')).catch(() => {});
      await clearLocalFamilySession();
      await clearAllLocalCachedAssets();
      await deleteDoc(doc(db, 'users', userId));

      Alert.alert(
        'Questionnaire reset',
        'Profile, routines, and star counting were reset. You will now set up again from the questionnaire.',
        [{ text: 'OK', onPress: () => router.replace('/onboarding/questionnaire' as never) }]
      );
    } catch (err) {
      console.warn('[Settings] reset questionnaire failed:', err);
      Alert.alert('Reset failed', 'Could not reset right now. Please try again.');
    } finally {
      setIsResetting(false);
    }
  };

  const confirmResetQuestionnaire = () => {
    Alert.alert(
      'Reset questionnaire?',
      'This will reset app counting and routines, clear the profile, and take you back to setup.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset questionnaire',
          style: 'destructive',
          onPress: handleResetQuestionnaire,
        },
      ]
    );
  };

  const handleClearCache = async () => {
    if (isClearingCache) return;
    setIsClearingCache(true);
    try {
      await clearAllLocalCachedAssets();
      Alert.alert(
        'Cache cleared',
        'All locally cached videos, merged videos, audio, and captions were removed. They will be re-downloaded and rebuilt next time you open a routine.'
      );
    } catch (err) {
      console.warn('[Settings] failed to clear cached assets:', err);
      Alert.alert('Clear failed', 'Could not clear cached assets right now. Please try again.');
    } finally {
      setIsClearingCache(false);
    }
  };

  const confirmClearCache = () => {
    Alert.alert(
      'Clear cached media?',
      'This removes downloaded videos, merged videos, audio, and captions from this device (your profile and routines are kept). They will be re-downloaded and rebuilt automatically.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear cache', style: 'destructive', onPress: handleClearCache },
      ]
    );
  };

  const handleToggleCaptions = async (value: boolean) => {
    if (!profile || isSavingCaptions) return;

    setIsSavingCaptions(true);
    const updatedProfile: ChildProfile = { ...profile, showCaptions: value };
    setProfile(updatedProfile);

    try {
      await saveChildProfile(updatedProfile);
    } catch (err) {
      console.warn('[Settings] failed to save caption preference:', err);
      setProfile(profile); // revert on failure
      Alert.alert('Save failed', 'Could not save the caption preference on this device.');
      return;
    } finally {
      setIsSavingCaptions(false);
    }
    try {
      await saveUserProfileDoc(updatedProfile);
    } catch (err) {
      console.warn('[Settings] caption backup failed:', err);
      Alert.alert('Saved on this device', 'The caption preference could not be backed up. Use Profile to back up your setup when connected.');
    }
  };

  return (
    <PageBackground variant="clouds">
      <Stack.Screen options={getNativeHeaderOptions('Settings', 'Parent controls')} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={[styles.card, styles.profileCard]}>
          <View style={styles.cardHeader}>
            <View style={styles.iconBubble}>
              <Text style={styles.iconEmoji}>{avatarEmoji}</Text>
            </View>
            <View style={styles.cardHeaderTextWrap}>
              <Text style={styles.cardTitle}>{profile?.childName ?? 'Your child'}</Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Name</Text>
            <Text style={styles.infoValue}>{profile?.childName ?? 'Not set'}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Sex</Text>
            <Text style={styles.infoValue}>{profileGenderLabel}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Age</Text>
            <Text style={styles.infoValue}>{profile?.age ?? '—'}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Stars</Text>
            <Text style={styles.infoValue}>⭐ {starsCount}</Text>
          </View>
        </View>

        <View style={[styles.card, styles.avatarCard]}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Show Subtitles</Text>
            <Switch
              value={profile?.showCaptions ?? true}
              onValueChange={handleToggleCaptions}
              disabled={!profile || isSavingCaptions}
              trackColor={{ true: colors.textInk }}
            />
          </View>
        </View>

        <TouchableOpacity style={[styles.card, styles.actionCard]} onPress={() => router.push('/parent/create' as never)}>
          <View style={styles.rowBetween}>
            <View style={styles.actionTextWrap}>
              <Text style={styles.actionTitle}>Activity Manager</Text>
              <Text style={styles.actionSubtitle}>Manage child activities and routines.</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.card, styles.actionCard, isClearingCache && styles.disabledCard]}
          onPress={confirmClearCache}
          disabled={isClearingCache}
        >
          <View style={styles.rowBetween}>
            <View style={styles.actionTextWrap}>
              <Text style={styles.actionTitle}>Clear cached media</Text>
              <Text style={styles.actionSubtitle}>
                Redownload videos, audio, and captions (keeps your profile and routines).
              </Text>
            </View>
            {isClearingCache ? (
              <ActivityIndicator color={colors.textMuted} />
            ) : (
              <Text style={styles.chevron}>›</Text>
            )}
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.card, styles.resetCard, isResetting && styles.disabledCard]}
          onPress={confirmResetQuestionnaire}
          disabled={isResetting}
        >
          <View style={styles.rowBetween}>
            <View style={styles.actionTextWrap}>
              <Text style={styles.resetTitle}>Reset questionnaire</Text>
              <Text style={styles.resetSubtitle}>
                Resets app counting and routines, then takes you back to setup.
              </Text>
            </View>
            <Text style={styles.resetChevron}>›</Text>
          </View>
        </TouchableOpacity>
      </ScrollView>
    </PageBackground>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    padding: ms(18),
    paddingBottom: vs(80),
    paddingTop: vs(8),
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: ms(16),
    padding: ms(14),
    marginBottom: vs(12),
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  profileCard: {
    borderColor: '#C9D8EA',
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  avatarCard: {
    backgroundColor: '#EFF6FF',
    borderColor: '#DBEAFE',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: vs(10),
  },
  cardHeaderTextWrap: {
    flex: 1,
  },
  iconBubble: {
    width: ms(42),
    height: ms(42),
    borderRadius: ms(21),
    backgroundColor: '#FFFFFFAA',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: ms(10),
  },
  iconEmoji: {
    fontSize: fs(21),
  },
  cardTitle: {
    fontSize: fs(16),
    fontWeight: '800',
    color: colors.textInk,
    marginBottom: vs(2),
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: vs(4),
  },
  infoLabel: {
    fontSize: fs(13),
    color: colors.textMuted,
    fontWeight: '700',
  },
  infoValue: {
    fontSize: fs(14),
    color: colors.textDark,
    fontWeight: '700',
  },
  actionCard: {
    backgroundColor: '#F1F5F9',
    borderColor: '#E2E8F0',
  },
  resetCard: {
    backgroundColor: '#FFF1F2',
    borderColor: '#FFD8DD',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionTextWrap: {
    flex: 1,
    paddingRight: ms(8),
  },
  actionTitle: {
    fontSize: fs(17),
    fontWeight: '800',
    color: colors.textInk,
    marginBottom: vs(3),
  },
  actionSubtitle: {
    fontSize: fs(13),
    color: colors.textSlate,
    lineHeight: fs(18),
  },
  chevron: {
    fontSize: fs(24),
    color: colors.textMuted,
    fontWeight: '700',
  },
  resetTitle: {
    fontSize: fs(17),
    fontWeight: '800',
    color: colors.dangerStrong,
    marginBottom: vs(3),
  },
  resetSubtitle: {
    fontSize: fs(13),
    color: '#9F1239',
    lineHeight: fs(18),
  },
  resetChevron: {
    fontSize: fs(24),
    color: colors.dangerStrong,
    fontWeight: '800',
  },
  disabledCard: {
    opacity: 0.6,
  },
});
