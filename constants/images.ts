/**
 * Central registry of bundled artwork. Keeping every `require()` in one place lets the root
 * layout resolve all of them to stable local file URIs at boot (see utils/localImages).
 */

export const ACTIVITY_IMAGES: Record<string, number> = {
  brush_teeth: require('../assets/images/tooth_brush.png'),
  get_dressed: require('../assets/images/get_dressed.png'),
  eat_breakfast: require('../assets/images/eat_breakfast.png'),
  pack_backpack: require('../assets/images/pack_backpack.png'),
  wash_face: require('../assets/images/wash_face.png'),
  comb_hair: require('../assets/images/comb_hair.png'),
  put_shoes_on: require('../assets/images/put_shoes_on.png'),
  drink_water: require('../assets/images/drink_water.png'),
  tidy_room: require('../assets/images/tidy_room.png'),
  read_book: require('../assets/images/read_book.png'),
  put_on_pajamas: require('../assets/images/put_on_pajamas.png'),
  bedtime_story: require('../assets/images/read_book.png'),
  eat_dinner: require('../assets/images/eat_dinner.png'),
  go_to_sleep: require('../assets/images/go_to_sleep.png'),
  homework: require('../assets/images/homework.png'),
  make_bed: require('../assets/images/make_bed.png'),
  wake_up: require('../assets/images/wake_up.png'),
};

export const SUN_IMAGE: number = require('../assets/images/sun.png');
export const MOON_IMAGE: number = require('../assets/images/moon.png');
export const CLOUD_IMAGE: number = require('../assets/images/cloud.png');
export const STAR_IMAGE: number = require('../assets/images/star.png');
export const GRASS_IMAGE: number = require('../assets/images/grass.png');

export const ACTIVITY_FALLBACK_IMAGE = SUN_IMAGE;

export const ALL_BUNDLED_IMAGES: number[] = Array.from(
  new Set<number>([
    ...Object.values(ACTIVITY_IMAGES),
    SUN_IMAGE,
    MOON_IMAGE,
    CLOUD_IMAGE,
    STAR_IMAGE,
    GRASS_IMAGE,
  ])
);
