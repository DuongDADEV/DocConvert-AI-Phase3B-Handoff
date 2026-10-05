import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { db } from '../db/db.js';

function getSupabaseConfig() {
  const rawUrl = process.env.SUPABASE_URL || '';
  const url = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, anonKey, serviceRoleKey };
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  currentPlanId: string;
  usedDocuments: number;
}

/**
 * 1. Base Supabase Client (Anonymous public client)
 */
let baseClient: SupabaseClient | null = null;

export function getBaseSupabaseClient(): SupabaseClient | null {
  const { url, anonKey } = getSupabaseConfig();
  if (url && anonKey) {
    if (!baseClient) {
      baseClient = createClient(url, anonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }
    return baseClient;
  }
  return null;
}

/**
 * 2. User-Scoped Supabase Client (For RLS queries)
 * Injects user's access token so Supabase Database evaluates auth.uid() = user.id
 */
export function createSupabaseUserClient(accessToken: string): SupabaseClient | null {
  const { url, anonKey } = getSupabaseConfig();
  if (url && anonKey && accessToken) {
    return createClient(url, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return null;
}

/**
 * 3. Service-Role Admin Supabase Client
 * Trusted client for server-side background operations (e.g. ocrWorker)
 */
let adminClient: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient {
  const { url, serviceRoleKey, anonKey } = getSupabaseConfig();
  const keyToUse = serviceRoleKey || anonKey;
  if (!adminClient && url && keyToUse) {
    adminClient = createClient(url, keyToUse, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return adminClient!;
}

/**
 * 3. Verify Supabase Session / Access Token
 * Calls Supabase Auth API to authenticate user.
 * In local/test mode without cloud credentials, validates against local auth state.
 */
export async function verifySupabaseToken(accessToken: string): Promise<AuthenticatedUser | null> {
  if (!accessToken || typeof accessToken !== 'string') {
    return null;
  }

  // 1. Local session token pattern
  if (accessToken.startsWith('sbp_')) {
    return db.verifyLocalSupabaseToken(accessToken);
  }

  // 2. Live Supabase Auth JWT verification
  const liveClient = getBaseSupabaseClient();
  if (liveClient) {
    try {
      const { data, error } = await liveClient.auth.getUser(accessToken);
      if (!error && data?.user) {
        const profile = await db.findProfileById(data.user.id);
        return {
          id: data.user.id,
          email: data.user.email || '',
          fullName: profile?.full_name || (data.user.user_metadata?.full_name as string) || 'User',
          currentPlanId: profile?.current_plan_id || 'FREE',
          usedDocuments: profile?.used_documents || 0,
        };
      }
    } catch (err) {
      // Continue to local fallback
    }
  }

  return db.verifyLocalSupabaseToken(accessToken);
}
