/**
 * Phase 2A & 2B — Credit Domain Types
 *
 * All stored financial quantities use integer scaled units:
 *   1 credit = 1000 credit_units (BIGINT).
 *   FLOAT is strictly disallowed in storage.
 */

export type CreditAccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface CreditAccountRecord {
  id: string;
  user_id: string;
  status: CreditAccountStatus;
  created_at: string;
  updated_at: string;
}

export type CreditGrantSourceType =
  | 'FREE_BOOTSTRAP'
  | 'SUBSCRIPTION_CYCLE'
  | 'CREDIT_PACK_PURCHASE'
  | 'PROMOTION'
  | 'ADMIN_ADJUSTMENT'
  | 'MIGRATION';

export type CreditGrantStatus = 'ACTIVE' | 'DEPLETED' | 'EXPIRED' | 'REVOKED';

export interface CreditGrantRecord {
  id: string;
  account_id: string;
  user_id: string;
  source_type: CreditGrantSourceType;
  source_product_id?: string | null;
  pricing_version_id?: string | null;
  subscription_id?: string | null;
  billing_cycle_start?: string | null;
  billing_cycle_end?: string | null;
  original_units: number;
  remaining_units: number;
  reserved_units?: number;
  granted_at: string;
  expires_at?: string | null;
  status: CreditGrantStatus;
  idempotency_key: string;
  source_reference_type?: string | null;
  source_reference_id?: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export type CreditLedgerEntryType = 'GRANT' | 'ADJUSTMENT' | 'EXPIRATION' | 'CAPTURE';

export interface CreditLedgerRecord {
  id: string;
  account_id: string;
  user_id: string;
  grant_id?: string | null;
  entry_type: CreditLedgerEntryType;
  delta_units: number;
  /**
   * Financial ledger running owned-credit balance after this permanent mutation.
   * Reservation holds are excluded from this field.
   * Clock-time expiration alone does not change this balance; explicit expiration mutations do.
   */
  balance_after_units?: number | null;
  reference_type?: string | null;
  reference_id?: string | null;
  idempotency_key: string;
  description?: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

/**
 * Phase 2B Reservation Types
 */
export type CreditReservationStatus =
  | 'RESERVED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'RELEASED'
  | 'SETTLED'
  | 'EXPIRED';

export interface CreditReservationRecord {
  id: string;
  account_id: string;
  user_id: string;
  requested_units: number;
  reserved_units: number;
  captured_units: number;
  released_units: number;
  status: CreditReservationStatus;
  idempotency_key: string;
  reference_type?: string | null;
  reference_id?: string | null;
  reservation_expires_at?: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  settled_at?: string | null;
}

export interface CreditReservationAllocationRecord {
  id: string;
  reservation_id: string;
  account_id: string;
  user_id: string;
  grant_id: string;
  allocation_order: number;
  reserved_units: number;
  captured_units: number;
  released_units: number;
  created_at: string;
  updated_at: string;
}

export type CreditReservationEventType = 'CAPTURE' | 'RELEASE';

export interface CreditReservationEventRecord {
  id: string;
  reservation_id: string;
  account_id: string;
  user_id: string;
  event_type: CreditReservationEventType;
  units: number;
  idempotency_key: string;
  metadata: Record<string, any>;
  created_at: string;
}

/**
 * Public DTOs for client consumption
 */
export interface CreditBucketsDto {
  subscriptionUnits: number;
  purchasedUnits: number;
  otherUnits: number;
}

export interface UserCreditBalanceDto {
  /** Currently valid/unexpired remaining credit visible to the user before reservation subtraction. */
  grossRemainingUnits: number;
  /** Currently reserved credit held for in-flight processing. */
  reservedUnits: number;
  /** Currently valid/unexpired remaining units minus reserved units. */
  totalAvailableUnits: number;
  totalAvailableCredits: number;
  buckets: CreditBucketsDto;
  status?: CreditAccountStatus | 'NONE';
  userId?: string;
  accountId?: string | null;
}

export interface CreditGrantDto {
  id: string;
  sourceType: CreditGrantSourceType;
  originalUnits: number;
  remainingUnits: number;
  reservedUnits: number;
  availableUnits: number;
  originalCredits: number;
  remainingCredits: number;
  reservedCredits: number;
  availableCredits: number;
  grantedAt: string;
  expiresAt: string | null;
  status: CreditGrantStatus;
  billingCycleStart?: string | null;
  billingCycleEnd?: string | null;
}

export interface CreditLedgerItemDto {
  id: string;
  entryType: CreditLedgerEntryType;
  deltaUnits: number;
  deltaCredits: number;
  balanceAfterUnits?: number | null;
  balanceAfterCredits?: number | null;
  description?: string | null;
  referenceType?: string | null;
  createdAt: string;
}

export interface CreditLedgerPageDto {
  items: CreditLedgerItemDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreditReservationAllocationDto {
  allocationId: string;
  grantId: string;
  allocationOrder: number;
  reservedUnits: number;
  capturedUnits: number;
  releasedUnits: number;
}

export interface CreditReservationDto {
  id: string;
  accountId: string;
  userId: string;
  requestedUnits: number;
  reservedUnits: number;
  capturedUnits: number;
  releasedUnits: number;
  outstandingUnits: number;
  status: CreditReservationStatus;
  idempotencyKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  reservationExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt?: string | null;
  allocations?: CreditReservationAllocationDto[];
}

/**
 * Service Operation Input Interfaces
 */
export interface GrantUserCreditsParams {
  userId: string;
  sourceType: CreditGrantSourceType;
  originalUnits: number;
  idempotencyKey: string;
  expiresAt?: string | null;
  productId?: string | null;
  pricingVersionId?: string | null;
  subscriptionId?: string | null;
  billingCycleStart?: string | null;
  billingCycleEnd?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string | null;
  metadata?: Record<string, any>;
}

export interface GrantSubscriptionCycleCreditsParams {
  userId: string;
  productCode: string;
  pricingVersionId?: string;
  subscriptionId?: string;
  cycleStart: string;
  cycleEnd: string;
  idempotencyKey: string;
}

export interface GrantPurchasedCreditPackParams {
  userId: string;
  productCode: string;
  pricingVersionId?: string;
  referenceId?: string;
  idempotencyKey: string;
}

export interface AdminCreditAdjustmentParams {
  userId: string;
  deltaUnits: number;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  metadata?: Record<string, any>;
}

export interface ReserveCreditUnitsParams {
  userId: string;
  requestedUnits: number;
  idempotencyKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  reservationExpiresAt?: string | null;
  metadata?: Record<string, any>;
}

export interface CaptureCreditReservationParams {
  userId: string;
  reservationId: string;
  captureUnits: number;
  idempotencyKey: string;
  metadata?: Record<string, any>;
}

export interface ReleaseCreditReservationParams {
  userId: string;
  reservationId: string;
  releaseUnits: number;
  idempotencyKey: string;
  metadata?: Record<string, any>;
}

export * from './processingPricing.js';
export * from './processingEligibility.js';
