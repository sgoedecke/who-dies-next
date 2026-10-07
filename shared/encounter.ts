export const MAX_SCENARIO_HEROES = 5;
export const MAX_HERO_SPAN = 3200;
export const CAMERA_MARGIN = 240;
export const MIN_CAMERA_EXTENT = 1000;

type PositionedFrame = { heroes: { x: number | null; y: number | null }[] };

export function trajectoryBounds(frames: PositionedFrame[]) {
  const positions = frames.flatMap(frame => frame.heroes).filter(
    (hero): hero is { x: number; y: number } => hero.x !== null && hero.y !== null,
  );
  if (!positions.length) return null;
  return {
    minX: Math.min(...positions.map(hero => hero.x)), maxX: Math.max(...positions.map(hero => hero.x)),
    minY: Math.min(...positions.map(hero => hero.y)), maxY: Math.max(...positions.map(hero => hero.y)),
  };
}

export function encounterBounds(frames: PositionedFrame[]) {
  const bounds = trajectoryBounds(frames);
  if (!bounds) return null;
  const paddingX = Math.max(CAMERA_MARGIN, (MIN_CAMERA_EXTENT - (bounds.maxX - bounds.minX)) / 2);
  const paddingY = Math.max(CAMERA_MARGIN, (MIN_CAMERA_EXTENT - (bounds.maxY - bounds.minY)) / 2);
  return {
    minX: bounds.minX - paddingX, maxX: bounds.maxX + paddingX,
    minY: bounds.minY - paddingY, maxY: bounds.maxY + paddingY,
  };
}
