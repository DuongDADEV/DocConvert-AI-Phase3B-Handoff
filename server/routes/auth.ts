import { Router, Request, Response } from 'express';
import { db } from '../db/db.js';
import { getBaseSupabaseClient, verifySupabaseToken } from '../services/supabaseClient.js';
import { getSupabaseAdminClient } from '../services/supabaseAdmin.js';
import { quotaService } from '../services/quotaService.js';
import { creditService } from '../services/credit/creditService.js';
import { auditService } from '../services/auditService.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// ============================================================================
// 1. REGISTER USER (Supabase Auth Integration)
// ============================================================================
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, fullName, confirmPassword } = req.body;

    if (!email || !password || !fullName) {
      res.status(400).json({
        success: false,
        error: 'Vui lòng điền đầy đủ họ tên, email và mật khẩu.',
      });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({
        success: false,
        error: 'Mật khẩu phải chứa ít nhất 6 ký tự.',
      });
      return;
    }

    if (confirmPassword && password !== confirmPassword) {
      res.status(400).json({
        success: false,
        error: 'Mật khẩu xác nhận không khớp.',
      });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanFullName = fullName.trim();

    // 1. Live Supabase Auth via Admin Client (Auto-confirmed email for frictionless UX)
    const adminSupabase = getSupabaseAdminClient();
    const liveSupabase = getBaseSupabaseClient();

    if (adminSupabase && liveSupabase) {
      // Create user in Supabase Auth with auto email confirmation
      const { data: createData, error: createError } = await adminSupabase.auth.admin.createUser({
        email: cleanEmail,
        password,
        user_metadata: {
          full_name: cleanFullName,
        },
        email_confirm: true,
      });

      if (createError) {
        if (createError.message?.toLowerCase().includes('already registered') || createError.message?.toLowerCase().includes('already exists')) {
          res.status(400).json({
            success: false,
            error: 'Email này đã được đăng ký trên Supabase. Vui lòng đăng nhập hoặc sử dụng email khác.',
          });
          return;
        }
        res.status(400).json({
          success: false,
          error: createError.message || 'Không thể tạo tài khoản trên Supabase.',
        });
        return;
      }

      const user = createData.user;
      if (!user) {
        res.status(400).json({
          success: false,
          error: 'Không thể tạo người dùng Supabase.',
        });
        return;
      }

      // Automatically sign in to get active session token
      const { data: signInData } = await liveSupabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });

      const profile = await db.ensureProfile(user.id, user.email || cleanEmail, cleanFullName);

      // Phase 3A.4 / 3A.4.2: Idempotent FREE bootstrap grant for new user
      try {
        await creditService.bootstrapNewUserFreeCredits(user.id, { enforceEligibility: true });
      } catch (bootErr: any) {
        console.error(`[Auth Register] Non-fatal free bootstrap grant error for user ${user.id}:`, bootErr?.message || bootErr);
      }

      const token = signInData?.session?.access_token || '';
      const quota = await quotaService.checkUserQuota(user.id);

      await auditService.log({
        userId: user.id,
        action: 'REGISTER_USER',
        resourceType: 'profiles',
        resourceId: user.id,
        ipAddress: req.ip,
      });

      res.status(201).json({
        success: true,
        message: 'Đăng ký tài khoản thành công qua Supabase Auth.',
        token,
        user: {
          id: user.id,
          email: user.email || cleanEmail,
          fullName: cleanFullName,
          currentPlanId: profile.current_plan_id,
          usedDocuments: profile.used_documents,
          createdAt: user.created_at,
        },
        quota,
      });
      return;
    }

    // 2. Fallback to standard Supabase Client signUp if admin is unavailable
    if (liveSupabase) {
      const { data: authData, error: authError } = await liveSupabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: {
            full_name: cleanFullName,
          },
        },
      });

      if (authError || !authData.user) {
        res.status(400).json({
          success: false,
          error: authError?.message || 'Không thể tạo tài khoản với Supabase Auth.',
        });
        return;
      }

      const profile = await db.ensureProfile(authData.user.id, authData.user.email || cleanEmail, cleanFullName);

      // Phase 3A.4 / 3A.4.2: Idempotent FREE bootstrap grant for new user
      try {
        await creditService.bootstrapNewUserFreeCredits(authData.user.id, { enforceEligibility: true });
      } catch (bootErr: any) {
        console.error(`[Auth Register] Non-fatal free bootstrap grant error for user ${authData.user.id}:`, bootErr?.message || bootErr);
      }

      const token = authData.session?.access_token || '';
      const quota = await quotaService.checkUserQuota(authData.user.id);

      auditService.log({
        userId: authData.user.id,
        action: 'REGISTER_USER',
        resourceType: 'profiles',
        resourceId: authData.user.id,
        ipAddress: req.ip,
      });

      res.status(201).json({
        success: true,
        message: 'Đăng ký tài khoản thành công qua Supabase Auth.',
        token,
        user: {
          id: authData.user.id,
          email: authData.user.email,
          fullName: cleanFullName,
          currentPlanId: profile.current_plan_id,
          usedDocuments: profile.used_documents,
          createdAt: authData.user.created_at,
        },
        quota,
      });
      return;
    }

    // 3. Unified Supabase Local Auth Engine fallback (DEV-ONLY FALLBACK)
    const { user, profile, session } = await db.createAuthUserAndProfile({
      email: cleanEmail,
      password_hash: password,
      full_name: cleanFullName,
    });

    // Phase 3A.4.1 (Section XI): Branch 3 is local/test-only fallback (no row created in auth.users).
    // Live credit bootstrap is unsupported in this branch to preserve credit_accounts.user_id REFERENCES auth.users(id) FK integrity.

    const quota = await quotaService.checkUserQuota(user.id);

    auditService.log({
      userId: user.id,
      action: 'REGISTER_USER',
      resourceType: 'profiles',
      resourceId: user.id,
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Đăng ký tài khoản thành công.',
      token: session.access_token,
      user: {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        currentPlanId: profile.current_plan_id,
        usedDocuments: profile.used_documents,
        createdAt: profile.created_at,
      },
      quota,
    });
  } catch (err: any) {
    console.error('Registration error:', err);
    res.status(400).json({
      success: false,
      error: err.message || 'Đăng ký không thành công. Vui lòng thử lại.',
    });
  }
});

// ============================================================================
// 2. LOGIN USER (Supabase Auth Integration)
// ============================================================================
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Vui lòng nhập đầy đủ email và mật khẩu.',
      });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();

    // 1. If Supabase Auth Live Client is available
    const liveSupabase = getBaseSupabaseClient();
    if (liveSupabase) {
      const { data: authData, error: authError } = await liveSupabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });

      if (authError || !authData.session || !authData.user) {
        res.status(401).json({
          success: false,
          error: 'Email hoặc mật khẩu không chính xác.',
        });
        return;
      }

      const token = authData.session.access_token;
      const profile = await db.ensureProfile(
        authData.user.id,
        authData.user.email || cleanEmail,
        (authData.user.user_metadata?.full_name as string) || 'User'
      );
      const quota = await quotaService.checkUserQuota(authData.user.id);

      await auditService.log({
        userId: authData.user.id,
        action: 'LOGIN_USER',
        resourceType: 'profiles',
        resourceId: authData.user.id,
        ipAddress: req.ip,
      });

      res.json({
        success: true,
        message: 'Đăng nhập thành công qua Supabase Auth.',
        token,
        user: {
          id: authData.user.id,
          email: authData.user.email,
          fullName: profile?.full_name || authData.user.user_metadata?.full_name || 'User',
          currentPlanId: profile?.current_plan_id || 'FREE',
          usedDocuments: profile?.used_documents || 0,
          createdAt: authData.user.created_at,
        },
        quota,
      });
      return;
    }

    // 2. Unified Supabase Local Auth Engine
    const result = await db.authenticateUser(email, password);
    if (!result) {
      res.status(401).json({
        success: false,
        error: 'Email hoặc mật khẩu không chính xác.',
      });
      return;
    }

    const { profile, session } = result;
    const quota = await quotaService.checkUserQuota(profile.id);

    auditService.log({
      userId: profile.id,
      action: 'LOGIN_USER',
      resourceType: 'profiles',
      resourceId: profile.id,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      message: 'Đăng nhập thành công.',
      token: session.access_token,
      user: {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        currentPlanId: profile.current_plan_id,
        usedDocuments: profile.used_documents,
        createdAt: profile.created_at,
      },
      quota,
    });
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({
      success: false,
      error: 'Lỗi máy chủ khi xác thực đăng nhập.',
    });
  }
});

// ============================================================================
// 3. GET CURRENT USER PROFILE & QUOTA (Requires Supabase Session)
// ============================================================================
router.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const quota = await quotaService.checkUserQuota(user.id);

    res.json({
      success: true,
      user,
      quota,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Không thể tải thông tin người dùng.' });
  }
});

// ============================================================================
// 4. LOGOUT (Revokes Supabase Session)
// ============================================================================
router.post('/logout', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const token = req.userToken;
    if (token) {
      const liveSupabase = getBaseSupabaseClient();
      if (liveSupabase) {
        await liveSupabase.auth.signOut();
      }
      db.revokeSession(token);
    }

    if (req.user) {
      auditService.log({
        userId: req.user.id,
        action: 'LOGOUT_USER',
        resourceType: 'profiles',
        resourceId: req.user.id,
        ipAddress: req.ip,
      });
    }

    res.json({ success: true, message: 'Đăng xuất thành công.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi khi đăng xuất.' });
  }
});

export default router;
