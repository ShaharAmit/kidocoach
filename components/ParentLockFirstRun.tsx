import React, { useCallback, useState } from 'react';
import { Modal, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import ParentLockSetup from './ParentLockSetup';
import { getParentalLockSetupState, type ParentalLockMethod } from '../services/parentalLock';
import { hasCompletedOnboarding } from '../services/profile';
import { colors, s, vs } from '../theme';

interface ParentLockFirstRunProps {
  onChosen?: (method: ParentalLockMethod) => void;
}

/**
 * First visit to a parent area (Settings / Profile) after the questionnaire: the parent must pick
 * how the parental gate unlocks. Skipped before onboarding (e.g. signing in from the welcome
 * screen loads that account's own lock) and while offline, when we can't tell if one already exists.
 */
export default function ParentLockFirstRun({ onChosen }: ParentLockFirstRunProps) {
  const [visible, setVisible] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        if (!(await hasCompletedOnboarding())) return;
        const state = await getParentalLockSetupState();
        if (active && state === 'unset') setVisible(true);
      })().catch((err: unknown) => console.warn('[ParentLockFirstRun] setup check failed:', err));
      return () => { active = false; };
    }, []),
  );

  return (
    // Full screen (not a page sheet) so it can't be swiped away before a method is saved.
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => undefined}>
      <SafeAreaView style={styles.root}>
        <ParentLockSetup
          doneLabel="Save"
          onDone={(method) => {
            setVisible(false);
            onChosen?.(method);
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white, paddingHorizontal: s(18), paddingVertical: vs(12) },
});
