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

  function isWithinParking(lat, lon) {
    if (lat == null || lon == null) return false;
    const d = distanceMeters(lat, lon, CONFIG.PARK_CENTER.lat, CONFIG.PARK_CENTER.lon);
    return d <= CONFIG.PARK_RADIUS_M;
  }

  // Sum of consecutive great-circle hops through a time-ordered list of
  // {latitude, longitude} points. This is a lower bound on real distance
  // travelled (straight lines between polls, not the road path), which is
  // the best that a 1-point-per-minute feed can give without a routing API.
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

  return { distanceMeters, isWithinParking, pathDistanceMeters, metersToKm };
})();
