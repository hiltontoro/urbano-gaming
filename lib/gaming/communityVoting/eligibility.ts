import type { GeofenceConfig, LocationClaim, LocationDecision } from "./types";
import { CommunityVotingError } from "./types";

/**
 * Community Voting location eligibility (UG-IV-GATE-002).
 *
 * TRUST BOUNDARY. A client's coordinates, accuracy and timestamps are UNTRUSTED CLAIMS. Nothing
 * here, and nothing in the database, verifies that a person is physically present, that a reading
 * is fresh, or that it was produced by a real device. What the server does establish is narrower:
 * the claim is well-formed, and — computed server-side from the Instance's STORED venue facts —
 * how far the claimed position is from the venue and how that compares with the claimed accuracy.
 * This is an eligibility control, not anti-spoofing, exactly as the Predictions primitive it
 * descends from says of itself. No client-supplied "eligible" flag is ever read.
 *
 * This module is the TypeScript twin of community_voting_assess_location (the database function is
 * the authority at cast time); the contract suite asserts both agree on the same vectors. The
 * haversine below is a deliberate copy of the Predictions primitive's formula rather than an import,
 * so this bounded context does not depend on a module another product owns.
 *
 * Raw coordinates are never persisted, logged, placed in a URL or echoed in an error: every error
 * thrown here is a fixed message.
 */

const EARTH_RADIUS_METERS = 6371000;
const MAX_RADIUS_METERS = 100000;
const MAX_ACCURACY_CEILING_METERS = 100000;
const MAX_MARGIN_FACTOR = 1000;

const INVALID_READING_MESSAGE = "The location reading is missing, malformed or not accepted.";
const INVALID_CONFIG_MESSAGE = "The geofence configuration is missing or out of range.";

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two lat/long points, in meters. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.min(
    1,
    Math.max(
      0,
      Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2
    )
  );
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates an untrusted location claim. Rejects anything missing, non-numeric, non-finite, out of
 * range or with a non-positive accuracy. (0,0) is rejected as the explicit CURRENT PILOT POLICY —
 * not as a statement that the point is universally invalid; a reading with only one zero
 * coordinate is accepted. Returns only the three known fields (anything else the client sent,
 * including any claimed eligibility, is dropped).
 */
export function validateLocationClaim(raw: unknown): LocationClaim {
  if (!isPlainObject(raw)) {
    throw new CommunityVotingError("INVALID_LOCATION_READING", INVALID_READING_MESSAGE);
  }
  const { latitude, longitude, accuracyMeters } = raw;
  if (
    !isFiniteNumber(latitude) ||
    !isFiniteNumber(longitude) ||
    !isFiniteNumber(accuracyMeters) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    accuracyMeters <= 0 ||
    (latitude === 0 && longitude === 0)
  ) {
    throw new CommunityVotingError("INVALID_LOCATION_READING", INVALID_READING_MESSAGE);
  }
  return { latitude, longitude, accuracyMeters };
}

/** Validates a geofence configuration. Mirrors the database function's and the table constraints' bounds. */
export function validateGeofenceConfig(raw: unknown): GeofenceConfig {
  if (!isPlainObject(raw)) {
    throw new CommunityVotingError("INVALID_GEOFENCE_CONFIG", INVALID_CONFIG_MESSAGE);
  }
  const {
    venueLatitude,
    venueLongitude,
    venueRadiusMeters,
    maxAccuracyMeters,
    insideMarginFactor,
    outsideMarginFactor,
  } = raw;
  if (
    !isFiniteNumber(venueLatitude) ||
    !isFiniteNumber(venueLongitude) ||
    !isFiniteNumber(venueRadiusMeters) ||
    !isFiniteNumber(maxAccuracyMeters) ||
    !isFiniteNumber(insideMarginFactor) ||
    !isFiniteNumber(outsideMarginFactor) ||
    venueLatitude < -90 ||
    venueLatitude > 90 ||
    venueLongitude < -180 ||
    venueLongitude > 180 ||
    venueRadiusMeters <= 0 ||
    venueRadiusMeters > MAX_RADIUS_METERS ||
    maxAccuracyMeters <= 0 ||
    maxAccuracyMeters > MAX_ACCURACY_CEILING_METERS ||
    insideMarginFactor < 0 ||
    insideMarginFactor > MAX_MARGIN_FACTOR ||
    outsideMarginFactor < 0 ||
    outsideMarginFactor > MAX_MARGIN_FACTOR
  ) {
    throw new CommunityVotingError("INVALID_GEOFENCE_CONFIG", INVALID_CONFIG_MESSAGE);
  }
  return {
    venueLatitude,
    venueLongitude,
    venueRadiusMeters,
    maxAccuracyMeters,
    insideMarginFactor,
    outsideMarginFactor,
  };
}

/**
 * INSIDE    : distance + insideMarginFactor  * accuracy <= radius
 * OUTSIDE   : distance - outsideMarginFactor * accuracy >  radius
 * AMBIGUOUS : everything between (the claimed accuracy circle straddles the boundary)
 * ACCURACY_EXCESSIVE : the claimed accuracy exceeds the Instance's maximum, whatever the centre
 *
 * Expects an already-validated claim (see validateLocationClaim).
 */
export function assessLocationEligibility(
  claim: LocationClaim,
  config: GeofenceConfig
): { decision: LocationDecision; distanceMeters: number } {
  const distanceMeters = haversineMeters(
    claim.latitude,
    claim.longitude,
    config.venueLatitude,
    config.venueLongitude
  );

  let decision: LocationDecision;
  if (claim.accuracyMeters > config.maxAccuracyMeters) {
    decision = "ACCURACY_EXCESSIVE";
  } else if (distanceMeters + config.insideMarginFactor * claim.accuracyMeters <= config.venueRadiusMeters) {
    decision = "INSIDE";
  } else if (distanceMeters - config.outsideMarginFactor * claim.accuracyMeters > config.venueRadiusMeters) {
    decision = "OUTSIDE";
  } else {
    decision = "AMBIGUOUS";
  }
  return { decision, distanceMeters };
}
