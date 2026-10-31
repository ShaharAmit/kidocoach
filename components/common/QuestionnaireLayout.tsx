import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, contentColumn, fs, ms, s, vs } from '../../theme';

export interface QuestionnaireStep {
  id: string;
  title: string;
  description?: string;
  render: (data: any, onChange: (value: any) => void) => React.ReactNode;
}

interface QuestionnaireLayoutProps {
  title: string;
  steps: QuestionnaireStep[];
  onSubmit: (data: any) => void | Promise<void>;
  isLoading?: boolean;
}

export default function QuestionnaireLayout({
  title,
  steps,
  onSubmit,
  isLoading = false,
}: QuestionnaireLayoutProps) {
  const [currentStepIndex, setCurrentStepIndex] = React.useState(0);
  const [data, setData] = React.useState<Record<string, any>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const currentStep = steps[currentStepIndex];
  const isLastStep = currentStepIndex === steps.length - 1;
  const isFirstStep = currentStepIndex === 0;

  const handleNext = () => {
    if (!isLastStep) {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit(data);
    } catch (err) {
      console.warn('[QuestionnaireLayout] submit error:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStepChange = (value: any) => {
    setData((prev) => ({
      ...prev,
      [currentStep.id]: value,
    }));
  };

  const progress = Math.round(((currentStepIndex + 1) / steps.length) * 100);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.stepCounter}>
            Step {currentStepIndex + 1} of {steps.length}
          </Text>
        </View>

        {/* Progress bar */}
        <View style={styles.progressContainer}>
          <View style={[styles.progressBar, { width: `${progress}%` }]} />
        </View>

        {/* Step content */}
        <View style={styles.stepContainer}>
          <View style={styles.stepHeader}>
            <Text style={styles.stepTitle}>{currentStep.title}</Text>
            {currentStep.description && (
              <Text style={styles.stepDescription}>{currentStep.description}</Text>
            )}
          </View>

          <View style={styles.stepContent}>
            {currentStep.render(data[currentStep.id], handleStepChange)}
          </View>
        </View>

        {/* Navigation buttons */}
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton, isFirstStep && styles.buttonDisabled]}
            onPress={handlePrev}
            disabled={isFirstStep || isLoading || submitting}
          >
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>Back</Text>
          </TouchableOpacity>

          {isLastStep ? (
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, (isLoading || submitting) && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={isLoading || submitting}
            >
              <Text style={styles.buttonText}>
                {submitting ? 'Submitting...' : 'Complete'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, isLoading && styles.buttonDisabled]}
              onPress={handleNext}
              disabled={isLoading}
            >
              <Text style={styles.buttonText}>Next</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  scroll: {
    flex: 1,
  },
  content: {
    ...contentColumn,
    padding: ms(20),
    paddingBottom: vs(40),
  },
  header: {
    marginBottom: vs(24),
  },
  title: {
    fontSize: fs(28),
    fontWeight: '800',
    color: colors.textInk,
    marginBottom: vs(8),
  },
  stepCounter: {
    fontSize: fs(14),
    color: colors.textMuted,
    fontWeight: '600',
  },
  progressContainer: {
    height: vs(6),
    backgroundColor: colors.border,
    borderRadius: ms(3),
    overflow: 'hidden',
    marginBottom: vs(24),
  },
  progressBar: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: ms(3),
  },
  stepContainer: {
    backgroundColor: colors.white,
    borderRadius: ms(12),
    padding: ms(20),
    marginBottom: vs(24),
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  stepHeader: {
    marginBottom: vs(20),
  },
  stepTitle: {
    fontSize: fs(20),
    fontWeight: '700',
    color: colors.textDark,
    marginBottom: vs(8),
  },
  stepDescription: {
    fontSize: fs(14),
    color: colors.textSlate,
    lineHeight: fs(20),
  },
  stepContent: {
    minHeight: s(100),
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: s(12),
    justifyContent: 'space-between',
  },
  button: {
    flex: 1,
    paddingVertical: vs(14),
    paddingHorizontal: s(16),
    borderRadius: ms(12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    backgroundColor: colors.primary,
  },
  secondaryButton: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  buttonText: {
    fontSize: fs(16),
    fontWeight: '700',
    color: colors.white,
  },
  secondaryButtonText: {
    color: colors.textDark,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
