const EARTH_RADIUS_M = 6_371_000;

function radians(value: number): number {
  return value * Math.PI / 180;
}

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const deltaLat = radians(b.latitude - a.latitude);
  const deltaLon = radians(b.longitude - a.longitude);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine));
}

export function conservativeDistance(distance: number, accuracyM: number): number {
  return Math.max(0, distance - Math.max(0, accuracyM));
}
