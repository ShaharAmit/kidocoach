import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageBackground,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PACKAGE_TYPE, PurchasesPackage } from 'react-native-purchases';
import {
  fetchOfferingPackages,
  purchasePackageAndCheckEntitlement,
  restorePurchasesAndCheckEntitlement,
} from '../services/purchases';
import { setPaidStatus } from '../services/subscription';
import { grantTemporaryPaywallAccess } from '../services/temporaryAccess';
import { scheduleTrialEndingNotification, cancelTrialEndingNotification } from '../services/notifications';
import { PAYWALL_IMAGES } from '../constants/paywallImages';
import { colors, fs, ms, s, vs } from '../theme';

const LEGAL_BASE_URL = 'https://kidocoach.app';
const TRIAL_NOTIFY_ID_KEY = 'trial_notify_id_v1';

const FALLBACK_YEARLY_PRICE = '$49.99/year';
const FALLBACK_THREE_MONTH_PRICE = '$24.99/3 months';

function monthlyBreakdown(priceString: string, price: number, months: number): string {
  const currencySymbol = priceString.replace(/[\d.,\s]/g, '') || '$';
  return `${currencySymbol}${(price / months).toFixed(2)} / month`;
}

type PlanCardProps = {
  title: string;
  badge?: string;
  monthlyLabel: string;
  billedLabel: string;
  selected: boolean;
  onPress: () => void;
};

function PlanCard({ title, badge, monthlyLabel, billedLabel, selected, onPress }: PlanCardProps) {
  return (
    <TouchableOpacity
      style={[styles.planCard, selected && styles.planCardSelected]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.planCardLeft}>
        <View style={styles.planTitleRow}>
          <Text style={styles.planTitle}>{title}</Text>
          {badge ? (
            <View style={styles.planBadge}>
              <Text style={styles.planBadgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.planMonthly}>{monthlyLabel}</Text>
        <Text style={styles.planBilled}>{billedLabel}</Text>
      </View>
      <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
        {selected ? <MaterialCommunityIcons name="check" size={ms(16)} color="#FFF" /> : null}
      </View>
    </TouchableOpacity>
  );
}

export default function PaywallScreen() {
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [loadingOfferings, setLoadingOfferings] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<'annual' | 'three_month'>('annual');
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [notifyBeforeTrialEnds, setNotifyBeforeTrialEnds] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchOfferingPackages()
      .then((pkgs) => {
        if (mounted) setPackages(pkgs);
      })
      .finally(() => {
        if (mounted) setLoadingOfferings(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const annualPackage = useMemo(
    () => packages.find((pkg) => pkg.packageType === PACKAGE_TYPE.ANNUAL),
    [packages]
  );
  const threeMonthPackage = useMemo(
    () => packages.find((pkg) => pkg.packageType === PACKAGE_TYPE.THREE_MONTH),
    [packages]
  );

  const selectedPackage = selectedPlan === 'annual' ? annualPackage : threeMonthPackage;

  const yearlyMonthly = annualPackage
    ? monthlyBreakdown(annualPackage.product.priceString, annualPackage.product.price, 12)
    : '$4.17 / month';
  const yearlyBilled = annualPackage ? `Billed ${annualPackage.product.priceString} yearly` : 'Billed $49.99 yearly';
  const threeMonthMonthly = threeMonthPackage
    ? monthlyBreakdown(threeMonthPackage.product.priceString, threeMonthPackage.product.price, 3)
    : '$8.33 / month';
  const threeMonthBilled = threeMonthPackage
    ? `Billed ${threeMonthPackage.product.priceString} every 3 months`
    : 'Billed $24.99 every 3 months';

  const trialSubtitle = annualPackage
    ? `1 week free, then ${annualPackage.product.priceString} annually`
    : `1 week free, then ${FALLBACK_YEARLY_PRICE.replace('/year', ' annually')}`;

  const ctaPriceLabel = selectedPackage
    ? selectedPackage.product.priceString
    : selectedPlan === 'annual'
    ? FALLBACK_YEARLY_PRICE
    : FALLBACK_THREE_MONTH_PRICE;

  const unlockAndContinue = useCallback(async () => {
    await setPaidStatus(true);
    router.replace({ pathname: '/loading', params: { mode: 'generating_experience' } } as never);
  }, []);

  const handleTemporarySkip = useCallback(() => {
    grantTemporaryPaywallAccess();
    router.replace({ pathname: '/loading', params: { mode: 'temporary_skip' } } as never);
  }, []);

  const handleToggleNotify = useCallback(async (value: boolean) => {
    setNotifyBeforeTrialEnds(value);
    try {
      if (value) {
        const id = await scheduleTrialEndingNotification();
        await AsyncStorage.setItem(TRIAL_NOTIFY_ID_KEY, id);
      } else {
        const existingId = await AsyncStorage.getItem(TRIAL_NOTIFY_ID_KEY);
        if (existingId) {
          await cancelTrialEndingNotification(existingId);
          await AsyncStorage.removeItem(TRIAL_NOTIFY_ID_KEY);
        }
      }
    } catch (err) {
      console.warn('[Paywall] failed to update trial-ending notification:', err);
    }
  }, []);

  const handleStartTrial = useCallback(async () => {
    if (purchasing || restoring) return;

    if (!selectedPackage) {
      Alert.alert(
        'Plans unavailable',
        'We could not load subscription plans. Please check your connection and try again.'
      );
      return;
    }

    setPurchasing(true);
    try {
      const isEntitled = await purchasePackageAndCheckEntitlement(selectedPackage);
      if (isEntitled) {
        await unlockAndContinue();
      } else {
        Alert.alert('Purchase incomplete', 'We could not confirm your subscription. Please try again.');
      }
    } catch (err: any) {
      if (!err?.userCancelled) {
        Alert.alert('Purchase failed', err?.message ?? 'Something went wrong. You have not been charged.');
      }
    } finally {
      setPurchasing(false);
    }
  }, [purchasing, restoring, selectedPackage, unlockAndContinue]);

  const handleRestore = useCallback(async () => {
    if (purchasing || restoring) return;

    setRestoring(true);
    try {
      const isEntitled = await restorePurchasesAndCheckEntitlement();
      if (isEntitled) {
        await unlockAndContinue();
      } else {
        Alert.alert(
          'No subscription found',
          "We couldn't find an active subscription for this Apple ID / Google account."
        );
      }
    } catch (err: any) {
      Alert.alert('Restore failed', err?.message ?? 'Please try again later.');
    } finally {
      setRestoring(false);
    }
  }, [purchasing, restoring, unlockAndContinue]);

  const openLegalLink = (path: string) => {
    Linking.openURL(`${LEGAL_BASE_URL}/${path}`).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.brandRow}>
          <Image source={require('../assets/icon.png')} style={styles.brandIcon} resizeMode="contain" />
          <Text style={styles.brandName}>KidoCoach</Text>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={handleTemporarySkip}
            accessibilityRole="button"
            accessibilityLabel="Skip for now"
            hitSlop={8}
          >
            <MaterialCommunityIcons name="close" size={ms(24)} color={colors.textSlate} />
          </TouchableOpacity>
        </View>

        <View style={styles.carouselRow}>
          <ImageBackground source={PAYWALL_IMAGES.sahara} style={[styles.imageBox, styles.imageBoxTall]} resizeMode="stretch">
            <Image source={PAYWALL_IMAGES.boy} style={styles.tileImage} resizeMode="contain" />
            {/* <View style={styles.captionPill}>
              <Text style={styles.captionText}>Track progress{'\n'}and build habits</Text>
            </View> */}
          </ImageBackground>

          <View style={styles.carouselMiddleColumn}>
            <ImageBackground source={PAYWALL_IMAGES.sahara} style={[styles.logoBox, styles.characterTile]} resizeMode="stretch">
              <Image source={PAYWALL_IMAGES.boyAndGirl} style={styles.tileImage} resizeMode="contain" />
            </ImageBackground>
            <ImageBackground source={PAYWALL_IMAGES.backdrop} style={[styles.imageBox, styles.imageBoxShort]} resizeMode="stretch">
              <Image
                source={PAYWALL_IMAGES.coach}
                style={styles.tileImage}
                resizeMode="contain"
              />
              {/* <View style={styles.captionPill}>
                <Text style={styles.captionText}>Loved by{'\n'}parents and kids</Text>
              </View> */}
            </ImageBackground>
          </View>

          <ImageBackground source={PAYWALL_IMAGES.sahara} style={[styles.imageBox, styles.imageBoxTall]} resizeMode="stretch">
            <Image source={PAYWALL_IMAGES.girl} style={styles.tileImage} resizeMode="contain" />
            {/* <View style={styles.captionPill}>
              <Text style={styles.captionText}>Fun routines{'\n'}kids enjoy</Text>
            </View> */}
          </ImageBackground>
        </View>

        <Text style={styles.headline}>
          Build Better Habits,
          {' '}
          <Text style={styles.headlineAccent}>Together</Text>
        </Text>

        <Text style={styles.trialSubtitle}>{loadingOfferings ? '1 week free, then $49.99 annually' : trialSubtitle}</Text>

        <View style={styles.plansWrap}>
          <PlanCard
            title="Yearly"
            badge="BEST VALUE"
            monthlyLabel={yearlyMonthly}
            billedLabel={yearlyBilled}
            selected={selectedPlan === 'annual'}
            onPress={() => setSelectedPlan('annual')}
          />
          <PlanCard
            title="3 Months"
            monthlyLabel={threeMonthMonthly}
            billedLabel={threeMonthBilled}
            selected={selectedPlan === 'three_month'}
            onPress={() => setSelectedPlan('three_month')}
          />
        </View>

        <View style={styles.notifyRow}>
          <Text style={styles.notifyLabel}>Notify me before trial ends</Text>
          <Switch
            value={notifyBeforeTrialEnds}
            onValueChange={handleToggleNotify}
            trackColor={{ false: '#D9DEE5', true: colors.teal }}
            thumbColor="#FFF"
          />
        </View>

        <TouchableOpacity
          style={[styles.ctaButton, (purchasing || restoring || loadingOfferings) && styles.ctaButtonDisabled]}
          onPress={handleStartTrial}
          disabled={purchasing || restoring || loadingOfferings}
          activeOpacity={0.85}
        >
          {purchasing ? (
            <ActivityIndicator color={colors.teal} />
          ) : (
            <Text style={styles.ctaText}>
              {selectedPlan === 'annual' ? 'Start 1 Week Free' : `Subscribe for ${ctaPriceLabel}`}
            </Text>
          )}
        </TouchableOpacity>

        <View style={styles.footerRow}>
          <TouchableOpacity onPress={handleRestore} disabled={restoring || purchasing}>
            <Text style={styles.footerLink}>{restoring ? 'Restoring…' : 'Restore Purchases'}</Text>
          </TouchableOpacity>
          <Text style={styles.footerDot}>•</Text>
          <TouchableOpacity onPress={() => openLegalLink('terms')}>
            <Text style={styles.footerLink}>Terms & Conditions</Text>
          </TouchableOpacity>
          <Text style={styles.footerDot}>•</Text>
          <TouchableOpacity onPress={() => openLegalLink('privacy')}>
            <Text style={styles.footerLink}>Privacy Policy</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F5F8FC',
  },
  scrollContent: {
    paddingHorizontal: s(20),
    paddingTop: vs(12),
    paddingBottom: vs(28),
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: vs(16),
    position: 'relative',
  },
  closeButton: {
    position: 'absolute',
    right: 0,
    width: s(44),
    height: s(44),
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandIcon: {
    width: s(28),
    height: s(28),
    borderRadius: ms(8),
    marginRight: s(8),
  },
  brandName: {
    fontSize: fs(16),
    fontWeight: '800',
    color: colors.textInk,
  },
  carouselRow: {
    flexDirection: 'row',
    gap: s(10),
    marginBottom: vs(20),
  },
  imageBox: {
    flex: 1,
    borderRadius: ms(18),
    overflow: 'hidden',
    backgroundColor: colors.placeholderBg,
  },
  imageBoxTall: {
    height: vs(160),
  },
  imageBoxShort: {
    height: vs(96),
    marginTop: vs(8),
  },
  carouselMiddleColumn: {
    flex: 1,
  },
  logoBox: {
    height: vs(96),
    borderRadius: ms(18),
    backgroundColor: colors.placeholderBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  characterTile: {
    overflow: 'hidden',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  captionPill: {
    position: 'absolute',
    top: vs(8),
    left: s(8),
    right: s(8),
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: ms(10),
    paddingVertical: vs(4),
    paddingHorizontal: s(6),
  },
  captionText: {
    fontSize: fs(10),
    fontWeight: '700',
    color: colors.textInk,
    textAlign: 'center',
    lineHeight: fs(13),
  },
  headline: {
    fontSize: fs(24),
    fontWeight: '800',
    color: colors.textInk,
    textAlign: 'center',
    lineHeight: fs(30),
  },
  headlineAccent: {
    color: colors.primary,
  },
  trialSubtitle: {
    marginTop: vs(10),
    marginBottom: vs(18),
    fontSize: fs(15),
    color: colors.textSlate,
    textAlign: 'center',
  },
  plansWrap: {
    gap: vs(12),
    marginBottom: vs(16),
  },
  planCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: ms(16),
    paddingVertical: vs(14),
    paddingHorizontal: s(16),
    backgroundColor: '#FFF',
  },
  planCardSelected: {
    borderColor: colors.teal,
    backgroundColor: '#EAF6F5',
  },
  planCardLeft: {
    flex: 1,
  },
  planTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: vs(4),
  },
  planTitle: {
    fontSize: fs(17),
    fontWeight: '800',
    color: colors.textInk,
    marginRight: s(8),
  },
  planBadge: {
    backgroundColor: colors.teal,
    borderRadius: ms(20),
    paddingHorizontal: s(8),
    paddingVertical: vs(2),
  },
  planBadgeText: {
    fontSize: fs(10),
    fontWeight: '800',
    color: '#FFF',
  },
  planMonthly: {
    fontSize: fs(15),
    fontWeight: '700',
    color: colors.textInk,
  },
  planBilled: {
    fontSize: fs(12),
    color: colors.textMuted,
    marginTop: vs(2),
  },
  radioOuter: {
    width: s(28),
    height: s(28),
    borderRadius: s(14),
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterSelected: {
    borderColor: colors.teal,
    backgroundColor: colors.teal,
  },
  notifyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFF',
    borderRadius: ms(16),
    paddingVertical: vs(14),
    paddingHorizontal: s(16),
    marginBottom: vs(16),
  },
  notifyLabel: {
    fontSize: fs(15),
    fontWeight: '600',
    color: colors.textInk,
  },
  ctaButton: {
    backgroundColor: '#FFF',
    borderWidth: 2,
    borderColor: colors.teal,
    borderRadius: ms(16),
    paddingVertical: vs(16),
    alignItems: 'center',
    marginBottom: vs(14),
  },
  ctaButtonDisabled: {
    opacity: 0.6,
  },
  ctaText: {
    fontSize: fs(17),
    fontWeight: '800',
    color: colors.teal,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  footerLink: {
    fontSize: fs(12),
    color: colors.textMuted,
    fontWeight: '600',
  },
  footerDot: {
    marginHorizontal: s(6),
    color: colors.textFaint,
  },
});
