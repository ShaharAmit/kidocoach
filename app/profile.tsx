import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { onAuthStateChanged, User } from 'firebase/auth';
import PageBackground from '../components/PageBackground';
import { auth, ensureAuth } from '../services/firebase';
import {
  AccountProvider, connectParentProvider, getAccountErrorMessage, getAvailableAccountProviders,
  isAccountCancellation, loginParentProvider, loginParentWithEmail, registerParentWithEmail,
  resetParentPassword, signOutParent,
} from '../services/accountAuth';
import { backUpCurrentFamily, clearLocalFamilySession, recoverSignedInFamily } from '../services/accountSession';
import { getChildProfile } from '../services/profile';
import { ChildProfile } from '../types';
import { colors, fs, ms, s, vs } from '../theme';

export default function ProfileScreen() {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [profile, setProfile] = useState<ChildProfile | null>(null);
  const [providers, setProviders] = useState<AccountProvider[]>([]);
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operationInProgress = useRef(false);
  const isLinked = user !== null && !user.isAnonymous;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setUser);
    ensureAuth().catch((err: unknown) => setError(getAccountErrorMessage(err)));
    getAvailableAccountProviders().then(setProviders)
      .catch((err: unknown) => setError(getAccountErrorMessage(err)));
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    getChildProfile().then((value) => { if (active) setProfile(value); })
      .catch((err: unknown) => { if (active) setError(getAccountErrorMessage(err)); });
    return () => { active = false; };
  }, [user]);

  const run = async (operation: () => Promise<void>) => {
    if (operationInProgress.current) return;
    operationInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (err) {
      if (!isAccountCancellation(err)) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
        setError(code === 'permission-denied'
          ? 'Could not access this family. Deploy the account-scoped Firestore rules and try again.'
          : code === 'unavailable'
            ? 'Could not recover or back up your family. Check your connection and try again.'
            : err instanceof Error && code === undefined ? err.message : getAccountErrorMessage(err));
      }
    } finally {
      operationInProgress.current = false;
      setBusy(false);
    }
  };

  const continueToApp = () =>
    router.replace({ pathname: '/loading', params: { mode: 'generating_experience' } });

  const recoverAndContinue = async () => {
    const recovered = await recoverSignedInFamily();
    if (recovered) {
      continueToApp();
    } else {
      Alert.alert(
        'Set up your child',
        'This account has no complete saved questionnaire. Your purchase access is unchanged; you will not need to buy an active subscription again.',
        [{ text: 'Continue', onPress: () => router.replace('/onboarding/questionnaire') }]
      );
    }
  };

  const requestLogin = (login: () => Promise<User>) => {
    const performLogin = () => run(async () => {
      await login();
      setPassword('');
      await recoverAndContinue();
    });
    if (!profile) {
      void performLogin();
      return;
    }
    Alert.alert(
      'Switch family accounts?',
      'Signing in loads that account\'s saved family instead of this device\'s setup. To keep the current setup, register or connect this guest account instead. Accounts are not merged.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign in', onPress: () => { void performLogin(); } },
      ]
    );
  };

  const register = () => run(async () => {
    await backUpCurrentFamily();
    const linkedUser = await registerParentWithEmail(email, password);
    setUser(linkedUser);
    setPassword('');
    Alert.alert('Account connected', 'Your current family and routines are now connected to this parent account.');
  });

  const connect = (provider: AccountProvider) => run(async () => {
    await backUpCurrentFamily();
    const linkedUser = await connectParentProvider(provider);
    setUser(linkedUser);
    Alert.alert('Account connected', 'Use this sign-in on another device to recover your saved family and routines.');
  });

  const requestSignOut = () => Alert.alert(
    'Sign out?',
    'Your linked family stays saved online. Its setup and routine reminders will be removed from this device. Signing out does not cancel your subscription.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', onPress: () => { void run(async () => {
        await clearLocalFamilySession();
        await signOutParent();
        await ensureAuth();
        router.replace('/loading');
      }); } },
    ]
  );

  return (
    <PageBackground variant="clouds" edges={['bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <MaterialCommunityIcons name="account-circle-outline" size={ms(64)} color={colors.primary} />
            <Text style={styles.title}>{profile? profile.childName + '\'s' : ''} Parent profile</Text>
            <Text style={styles.subtitle}>
              {isLinked ? user.email ?? 'Connected parent account' : 'Guest family on this device'}
            </Text>
            <Text style={styles.body}>
              Connect an account to keep your child&apos;s setup and routines across devices.
              Purchase restoration only confirms paid access; it does not recover your family or identify your Firebase account.
            </Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {busy ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}

            {isLinked ? (
              <>
                <TouchableOpacity disabled={busy || !profile} style={styles.button} onPress={() => { void run(async () => {
                  await backUpCurrentFamily();
                  Alert.alert('Setup saved', 'Your complete questionnaire is backed up to this account.');
                }); }}>
                  <Text style={styles.buttonText}>Back up current setup</Text>
                </TouchableOpacity>
                <TouchableOpacity disabled={busy} style={styles.secondaryButton}
                  onPress={() => { void run(recoverAndContinue); }}>
                  <Text style={styles.link}>Recover saved family</Text>
                </TouchableOpacity>
                <TouchableOpacity disabled={busy} style={styles.secondaryButton} onPress={continueToApp}>
                  <Text style={styles.link}>Continue</Text>
                </TouchableOpacity>
                <TouchableOpacity disabled={busy} style={styles.secondaryButton} onPress={requestSignOut}>
                  <Text style={styles.link}>Sign out</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View style={styles.modeRow}>
                  <TouchableOpacity disabled={busy} onPress={() => { setMode('register'); setError(''); }}>
                    <Text style={[styles.link, mode === 'register' && styles.selected]}>Register / connect</Text>
                  </TouchableOpacity>
                  <TouchableOpacity disabled={busy} onPress={() => { setMode('login'); setError(''); }}>
                    <Text style={[styles.link, mode === 'login' && styles.selected]}>Sign in</Text>
                  </TouchableOpacity>
                </View>
                <TextInput style={styles.input} value={email} onChangeText={setEmail} editable={!busy}
                  placeholder="Parent email" accessibilityLabel="Parent email" keyboardType="email-address"
                  autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" />
                <TextInput style={styles.input} value={password} onChangeText={setPassword} editable={!busy}
                  placeholder="Password" accessibilityLabel="Password" secureTextEntry autoCapitalize="none"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  textContentType={mode === 'register' ? 'newPassword' : 'password'} />
                <TouchableOpacity disabled={busy || !email.trim() || !password} style={styles.button}
                  onPress={() => mode === 'register'
                    ? void register() : requestLogin(() => loginParentWithEmail(email, password))}>
                  <Text style={styles.buttonText}>{mode === 'register' ? 'Register with email' : 'Sign in with email'}</Text>
                </TouchableOpacity>
                {providers.map((provider) => provider === 'apple' ? (
                  <View key={provider} pointerEvents={busy ? 'none' : 'auto'}>
                    <AppleAuthentication.AppleAuthenticationButton
                      buttonType={mode === 'register'
                        ? AppleAuthentication.AppleAuthenticationButtonType.CONTINUE
                        : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                      cornerRadius={ms(14)}
                      style={{ width: '100%', height: vs(48) }}
                      onPress={() => mode === 'register'
                        ? void connect(provider) : requestLogin(() => loginParentProvider(provider))}
                    />
                  </View>
                ) : (
                  <TouchableOpacity key={provider} disabled={busy} style={styles.secondaryButton}
                    onPress={() => mode === 'register'
                      ? void connect(provider) : requestLogin(() => loginParentProvider(provider))}>
                    <Text style={styles.link}>
                      {mode === 'register' ? 'Connect with' : 'Sign in with'} Google
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity disabled={busy || !email.trim()} style={styles.secondaryButton}
                  onPress={() => { void run(async () => {
                    await resetParentPassword(email);
                    Alert.alert('Check your email', 'If an account exists for this email, you will receive password reset instructions.');
                  }); }}>
                  <Text style={styles.link}>Reset email password</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </PageBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: s(20), paddingBottom: vs(130) },
  card: { backgroundColor: '#FFF', borderRadius: ms(24), padding: s(24), gap: vs(14) },
  title: { color: colors.textInk, fontSize: fs(26), fontWeight: '800' },
  subtitle: { color: colors.textInk, fontSize: fs(17), fontWeight: '600' },
  body: { color: colors.textSlate, fontSize: fs(15), lineHeight: fs(23) },
  modeRow: { flexDirection: 'row', justifyContent: 'space-between', gap: s(12) },
  selected: { textDecorationLine: 'underline', fontWeight: '800' },
  input: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: ms(12), padding: s(14), fontSize: fs(16), color: colors.textInk },
  button: { backgroundColor: colors.primary, padding: s(16), borderRadius: ms(14), alignItems: 'center' },
  buttonText: { color: '#FFF', fontWeight: '700', fontSize: fs(16) },
  secondaryButton: { paddingVertical: vs(10), alignItems: 'center' },
  link: { color: colors.primary, fontWeight: '600', fontSize: fs(15) },
  error: { color: '#B42318', fontSize: fs(15) },
  spinner: { marginVertical: vs(8) },
});
