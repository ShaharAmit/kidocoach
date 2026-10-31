import { useMemo } from 'react';
import { Dimensions, PixelRatio, Platform, useWindowDimensions, type ViewStyle } from 'react-native';

/**
 * Centralized responsive scaling helpers — the single place phone vs tablet sizing is decided.
 *
 * Two separate concerns:
 * - **Size** (`s`/`vs`/`ms`/`fs`): how big text, icons and touch targets are. Decided once per
 *   device from its *portrait* dimensions, so rotating an iPad or resizing its window never
 *   changes them (StyleSheets are static, so they couldn't follow anyway).
 * - **Layout** (`CONTENT_MAX_WIDTH` / `contentColumn` / `useContentWidth`): how wide content
 *   gets. A phone layout scaled for the device, centered in whatever window it gets. On phones
 *   the cap is wider than the screen, so nothing changes there; on iPads (portrait, landscape,
 *   Split View, Stage Manager) forms, lists and cards stop stretching edge to edge.
 */

// Guideline sizes are based on a standard ~iPhone 11/12 portrait viewport.
export const GUIDELINE_BASE_WIDTH = 390;
export const GUIDELINE_BASE_HEIGHT = 844;

// Clamp the scale factor so tablets stay tasteful and tiny phones stay legible.
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.6;

/** How much wider than the scaled phone design the content column may get. */
const CONTENT_WIDTH_ALLOWANCE = 1.15;

/** Shorter side at which a device is treated as a tablet (Android has no `isPad`). */
const TABLET_MIN_SHORT_SIDE = 600;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function widthScaleFactor(width: number): number {
  return clamp(width / GUIDELINE_BASE_WIDTH, MIN_SCALE, MAX_SCALE);
}

function heightScaleFactor(height: number): number {
  return clamp(height / GUIDELINE_BASE_HEIGHT, MIN_SCALE, MAX_SCALE);
}

/** Round to the nearest device pixel for crisp rendering. */
function round(value: number): number {
  return Math.round(PixelRatio.roundToNearestPixel(value));
}

/**
 * Build a set of scaling helpers for a viewport. Orientation-independent: the shorter side
 * drives width scaling and the longer side drives height scaling, as if held in portrait.
 */
export function createScalers(width: number, height: number) {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const wFactor = widthScaleFactor(shortSide);
  const hFactor = heightScaleFactor(longSide);

  /** Scale a horizontal/size value proportionally to screen width. */
  const scaleFn = (size: number): number => round(size * wFactor);

  /** Scale a vertical value proportionally to screen height. */
  const verticalScaleFn = (size: number): number => round(size * hFactor);

  /**
   * Dampened scale — moves a value toward its scaled target by `factor`.
   * Ideal for paddings/margins/radii that shouldn't grow as aggressively.
   */
  const moderateScaleFn = (size: number, factor = 0.5): number =>
    round(size + (size * wFactor - size) * factor);

  /** Font scaling: dampened width scale, ignores OS fontScale to keep layout stable. */
  const scaleFontFn = (size: number): number => round(size + (size * wFactor - size) * 0.5);

  return {
    scale: scaleFn,
    verticalScale: verticalScaleFn,
    moderateScale: moderateScaleFn,
    scaleFont: scaleFontFn,
    widthFactor: wFactor,
    heightFactor: hFactor,
    isTablet: shortSide >= TABLET_MIN_SHORT_SIDE,
    /** Widest a content column gets: the phone design scaled for this device, plus some room. */
    contentMaxWidth: round(GUIDELINE_BASE_WIDTH * wFactor * CONTENT_WIDTH_ALLOWANCE),
  };
}

/**
 * Largest box for `aspectRatio` (width / height) media inside `maxWidth` × `maxHeight` when shown
 * with `contentFit="cover"`. The box may be wider than the media by at most `maxCrop`, so a
 * portrait video in a wide window (iPad, landscape) is never cropped to a face strip.
 */
export function fitCoverBox(
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number,
  maxCrop = 1.2,
): { width: number; height: number } {
  const height = Math.min(maxWidth / aspectRatio, maxHeight);
  const width = Math.min(maxWidth, height * aspectRatio * maxCrop);
  return { width: Math.round(width), height: Math.round(height) };
}

// iPads size from the full screen so a launch in Split View / Stage Manager still gets tablet
// sizes; phones (portrait-locked) and Android use the app window.
const initial = Platform.OS === 'ios' && Platform.isPad ? Dimensions.get('screen') : Dimensions.get('window');
const moduleScalers = createScalers(initial.width, initial.height);

export const scale = moduleScalers.scale;
export const verticalScale = moduleScalers.verticalScale;
export const moderateScale = moduleScalers.moderateScale;
export const scaleFont = moduleScalers.scaleFont;

// Short aliases for terse use inside stylesheets.
export const s = scale;
export const vs = verticalScale;
export const ms = moderateScale;
export const fs = scaleFont;

/** True on iPads and Android tablets. Fixed for the app session. */
export const isTablet = (Platform.OS === 'ios' && Platform.isPad) || moduleScalers.isTablet;

/** Max width of a screen's content. Wider than any phone, so it only takes effect on tablets. */
export const CONTENT_MAX_WIDTH = moduleScalers.contentMaxWidth;

/**
 * Centers content in a column no wider than `CONTENT_MAX_WIDTH`. Spread it into a screen's
 * content container (`ScrollView.contentContainerStyle`, card wrapper, button row…);
 * backgrounds stay full-bleed outside it.
 */
export const contentColumn: ViewStyle = {
  width: '100%',
  maxWidth: CONTENT_MAX_WIDTH,
  alignSelf: 'center',
};

/** Live width available to content: the window width, capped at `CONTENT_MAX_WIDTH`. */
export function useContentWidth(): number {
  const { width } = useWindowDimensions();
  return Math.min(width, CONTENT_MAX_WIDTH);
}

/**
 * Reactive variant of the scaling helpers. Use in components that must respond
 * to orientation changes or split-view resizing on tablets. Returns the live
 * window dimensions alongside the bound scaling functions.
 */
export function useResponsive() {
  const { width, height } = useWindowDimensions();
  return useMemo(() => ({ width, height, ...createScalers(width, height) }), [width, height]);
}
