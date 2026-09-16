/**
 * Core type primitives used across the engine.
 * Kept in a separate file so other modules can import without circular deps.
 */

import type { Vector3 } from 'three';

export type Vec3 = Vector3;

/** Identifier for a logical entity in the world (room, door, key, prop, etc.). */
export type EntityId = string;

/** Generic event payload map. Add new event names as the system grows. */
export type GameEventMap = {
  // Phase 1+ events
  'engine:ready': void;
  'frame:tick': { dt: number; elapsed: number };
  'resize': { width: number; height: number; pixelRatio: number };
  'debug:toggle': void;
  'quality:change': { tier: 'low' | 'mid' | 'high' };
  'resolution:change': { scale: number };

  // Phase 3+ events (declared now so the bus is typed end-to-end)
  'noise:emitted': { pos: Vec3; radius: number; kind: 'footstep' | 'door' | 'object' | 'impact' | 'cat' };
  'noise:alert': { pos: Vec3; level: number };
  'item:collected': { id: EntityId; kind: 'key' | 'item' };
  'door:state': { id: EntityId; state: 'locked' | 'unlocked' | 'open' | 'closed' | 'slam' };
  'puzzle:solved': { id: EntityId };
  'gate:progress': { locksRemaining: number };
  'player:hidden': { hidden: boolean; spotId: EntityId };
  'player:lives': { remaining: number; atCheckpoint: EntityId };
  'checkpoint:saved': { id: EntityId };
  'daayan:state': { state: string };
  'game:caught': void;
  'game:escaped': void;
  'story:beat': { id: string };
};

export type QualityTier = 'low' | 'mid' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  renderScale: number; // 0.6 - 1.5
  maxRealTimeLights: number;
  shadowMapEnabled: boolean;
  textureMaxSize: number;
  fpsCap: number; // 0 = uncapped
  dynamicResolutionEnabled: boolean;
}
