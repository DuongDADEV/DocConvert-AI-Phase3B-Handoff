/**
 * Phase 1 — Billing Foundation Types
 */

export type ProductType = 'SUBSCRIPTION' | 'CREDIT_PACK' | 'USAGE' | 'ENTERPRISE';
export type PricingChannel = 'WEB' | 'API' | 'ENTERPRISE';
export type BillingInterval = 'NONE' | 'MONTH' | 'YEAR';
export type ApiAccessLevel = 'NONE' | 'BETA' | 'FULL';
export type SubscriptionStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

export interface PricingVersionRecord {
  id: string;
  code: string;
  description?: string;
  active: boolean;
  is_locked?: boolean;
  effective_from: string;
  effective_until?: string | null;
  created_at: string;
}

export interface BillingProductRecord {
  id: string;
  code: string;
  name: string;
  description?: string;
  product_type: ProductType;
  pricing_channel: PricingChannel;
  active: boolean;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface BillingPriceRecord {
  id: string;
  product_id: string;
  pricing_version_id: string;
  currency: string;
  amount_minor: number;
  billing_interval: BillingInterval;
  interval_count: number;
  active: boolean;
  valid_from: string;
  valid_until?: string | null;
  created_at: string;
}

export interface PlanEntitlementsRecord {
  id: string;
  product_id: string;
  pricing_version_id: string;
  included_credits: number;
  max_file_mb: number;
  batch_enabled: boolean;
  priority_queue: boolean;
  api_access: ApiAccessLevel;
  retention_days: number;
  metadata: Record<string, any>;
  created_at: string;
}

export type CreditGrantType = 'SUBSCRIPTION_CYCLE' | 'ONE_TIME_PACK';

export interface ProductCreditGrantRecord {
  id: string;
  product_id: string;
  pricing_version_id: string;
  credits_granted: number;
  grant_type: CreditGrantType;
  created_at: string;
}

export interface UserSubscriptionRecord {
  id: string;
  user_id: string;
  product_id: string;
  price_id: string;
  status: SubscriptionStatus;
  starts_at: string;
  ends_at?: string | null;
  auto_renew: boolean;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/**
 * Public DTO for frontend / consumer apps
 */
export interface PricingPlanDto {
  id: string;
  code: string;
  name: string;
  description: string;
  channel: PricingChannel;
  product_type: ProductType;
  price: number;
  currency: string;
  billing_interval: BillingInterval;
  interval_count: number;
  credits: number;
  entitlements: {
    included_credits: number;
    max_file_mb: number;
    batch_enabled: boolean;
    priority_queue: boolean;
    api_access: ApiAccessLevel;
    retention_days: number;
    pdf_to_word: boolean;
    pdf_to_excel: boolean;
  };
  metadata: {
    badge?: string | null;
    sort_order?: number;
    [key: string]: any;
  };
  pricing_version: string;
}

export interface CreditPackDto {
  id: string;
  code: string;
  name: string;
  description: string;
  channel: PricingChannel;
  product_type: ProductType;
  price: number;
  currency: string;
  credits: number;
  metadata: {
    sort_order?: number;
    [key: string]: any;
  };
  pricing_version: string;
}
