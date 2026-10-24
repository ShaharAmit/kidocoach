/**
 * Central registry of bundled artwork. Keeping every `require()` in one place lets the root
 * layout resolve all of them to stable local file URIs at boot (see utils/localImages).
 * Activity artwork is not bundled: it comes from the catalog (`catalog/activities/{key}.png`).
 */

export const SUN_IMAGE: number = require('../assets/images/sun.png');
export const MOON_IMAGE: number = require('../assets/images/moon.png');
export const CLOUD_IMAGE: number = require('../assets/images/cloud.png');
export const STAR_IMAGE: number = require('../assets/images/star.png');
export const GRASS_IMAGE: number = require('../assets/images/grass.png');

export const ACTIVITY_FALLBACK_IMAGE = SUN_IMAGE;

export const ALL_BUNDLED_IMAGES: number[] = Array.from(
  new Set<number>([
    SUN_IMAGE,
    MOON_IMAGE,
    CLOUD_IMAGE,
    STAR_IMAGE,
    GRASS_IMAGE,
  ])
);
