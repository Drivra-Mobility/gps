// Geo helpers shared by the fleet and per-vehicle pages. Pure functions, no
// dependencies - distance and "is this point parked" are computed client-side
// from the lat/lon history Supabase already returns, no extra backend needed.
const GEO = (() => {
  const EARTH_RADIUS_M = 6371000;

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  // Great-circle distance between two points, in metres.
  function distanceMeters(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
  }

  // Generic geofence membership check - both PARK_CENTER/PARK_RADIUS_M and
  // MAINTENANCE_CENTER/MAINTENANCE_RADIUS_M go through this. The isWithin*
  // wrappers exist only so call sites don't thread CONFIG constants by hand.
  function isWithin(lat, lon, center, radiusM) {
    if (lat == null || lon == null) return false;
    return distanceMeters(lat, lon, center.lat, center.lon) <= radiusM;
  }

  function isWithinParking(lat, lon) {
    return isWithin(lat, lon, CONFIG.PARK_CENTER, CONFIG.PARK_RADIUS_M);
  }

  function isWithinMaintenance(lat, lon) {
    return isWithin(lat, lon, CONFIG.MAINTENANCE_CENTER, CONFIG.MAINTENANCE_RADIUS_M);
  }

  function isWithinKtm(lat, lon) {
    if (!CONFIG.KTM_CENTER) return true;
    return isWithin(lat, lon, CONFIG.KTM_CENTER, CONFIG.KTM_RADIUS_M);
  }

  // Classifies coordinates into one of the 4 zones:
  // "maintenance", "parking", "in_ktm", or "outside_ktm"
  function classifyZone(lat, lon) {
    if (lat == null || lon == null) return "in_ktm";
    if (isWithinMaintenance(lat, lon)) return "maintenance";
    if (isWithinParking(lat, lon)) return "parking";
    if (isWithinKtm(lat, lon)) return "in_ktm";
    return "outside_ktm";
  }

  // Sum of consecutive great-circle hops through a time-ordered list of
  // {latitude, longitude} points.
  function pathDistanceMeters(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      total += distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
    }
    return total;
  }

  function metersToKm(m) {
    return m / 1000;
  }

  return {
    distanceMeters,
    isWithin,
    isWithinParking,
    isWithinMaintenance,
    isWithinKtm,
    classifyZone,
    pathDistanceMeters,
    metersToKm,
  };
})();
