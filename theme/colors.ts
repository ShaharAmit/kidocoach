/**
 * Centralized color palette.
 *
 * Reuse these named tokens instead of scattering raw hex literals across the
 * app. Brand + segment (morning/evening) colors live here so a future theme
 * change is a single-file edit.
 */
export const colors = {
  // Brand / actions
  primary: '#46a1c2',
  teal: '#46a1c2',
  tealMuted: '#5F8F86',

  // Surfaces
  white: '#FFFFFF',
  surfaceTranslucent: '#FFFFFFCC',
  appBg: '#FAFAFA',

  // Morning segment
  morningBg: '#c6e8e8',
  morningCardBorder: '#D7EBEB',
  morningTitle: '#1E4E79',
  morningSubtitle: '#356491',

  // Evening segment
  eveningBg: '#2e4385',
  eveningTitle: '#EAF0FF',
  eveningSubtitle: '#B9C6E8',

  // Text
  textDark: '#1F2937',
  textInk: '#1A2533',
  textSlate: '#475569',
  textMuted: '#64748B',
  textFaint: '#888888',

  // Borders / dividers
  border: '#E2E8F0',
  borderLight: '#E4EAF1',

  // Feedback
  star: '#FFB800',
  danger: '#D65050',
  dangerStrong: '#B91C1C',
  success: '#4F7F76',

  // Misc neutrals
  shadow: '#0B2040',
  placeholderBg: '#F0F0F0',
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayLight: 'rgba(0, 0, 0, 0.24)',
} as const;

export type ColorToken = keyof typeof colors;
