-- ==============================================================================
-- MIGRATION: 20260930040000_publish_pricing_v1.sql
-- DESCRIPTION: Phase 1.3 — Publish and Lock pricing-v1
--   Officially lock commercial terms for pricing-v1 to enforce strict immutability.
--   Once is_locked = true, prices, entitlements, and credit grants cannot be modified.
-- ==============================================================================

UPDATE public.pricing_versions
SET is_locked = true
WHERE code = 'pricing-v1'
  AND active = true
  AND is_locked = false;
