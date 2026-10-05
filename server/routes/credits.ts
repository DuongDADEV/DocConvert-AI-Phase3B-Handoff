import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { creditService } from '../services/credit/creditService.js';

const router = Router();

/**
 * GET /api/credits/balance
 * Returns authenticated user's current credit balance, gross remaining, reserved units, and buckets.
 */
router.get('/balance', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
      return;
    }

    const balance = await creditService.getUserBalance(userId, req.supabaseClient);

    res.json({
      success: true,
      ...balance,
    });
  } catch (err: any) {
    console.error('[Credit API] Error fetching balance:', err);
    res.status(500).json({
      success: false,
      error: 'Không thể truy vấn số dư tín dụng',
      message: err.message,
    });
  }
});

/**
 * GET /api/credits/grants
 * Returns authenticated user's credit grant buckets (including reserved and available units).
 */
router.get('/grants', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
      return;
    }

    const grants = await creditService.getUserGrants(userId, req.supabaseClient);

    res.json({
      success: true,
      grants,
    });
  } catch (err: any) {
    console.error('[Credit API] Error fetching grants:', err);
    res.status(500).json({
      success: false,
      error: 'Không thể truy vấn danh sách gói tín dụng',
      message: err.message,
    });
  }
});

/**
 * GET /api/credits/ledger
 * Returns authenticated user's paginated credit ledger history.
 * Query params: page (default 1), pageSize (default 20, max 100).
 */
router.get('/ledger', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
      return;
    }

    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 20;

    const ledgerPage = await creditService.getUserLedger(userId, page, pageSize, req.supabaseClient);

    res.json({
      success: true,
      ...ledgerPage,
    });
  } catch (err: any) {
    console.error('[Credit API] Error fetching ledger:', err);
    res.status(500).json({
      success: false,
      error: 'Không thể truy vấn lịch sử giao dịch tín dụng',
      message: err.message,
    });
  }
});

/**
 * Phase 2B: GET /api/credits/reservations
 * Returns authenticated user's credit reservations (read-only history).
 * Query params: page, pageSize, status.
 */
router.get('/reservations', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
      return;
    }

    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 20;
    const status = req.query.status as string | undefined;

    const reservationsPage = await creditService.listUserReservations(
      userId,
      { page, pageSize, status },
      req.supabaseClient
    );

    res.json({
      success: true,
      ...reservationsPage,
    });
  } catch (err: any) {
    console.error('[Credit API] Error fetching reservations:', err);
    res.status(500).json({
      success: false,
      error: 'Không thể truy vấn lịch sử đặt trước tín dụng',
      message: err.message,
    });
  }
});

/**
 * Phase 2B: GET /api/credits/reservations/:id
 * Returns a specific credit reservation with allocations for the authenticated user.
 */
router.get('/reservations/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
      return;
    }

    const reservationId = req.params.id;
    const reservation = await creditService.getReservation(reservationId, userId, req.supabaseClient);

    res.json({
      success: true,
      reservation,
    });
  } catch (err: any) {
    console.error('[Credit API] Error fetching reservation details:', err);
    const status = err.message?.includes('RESERVATION_NOT_FOUND') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: 'Không thể truy vấn thông tin đặt trước tín dụng',
      message: err.message,
    });
  }
});

/**
 * Phase 3A.4 / 3A.4.1: POST /api/credits/bootstrap
 * Server-owned, authenticated, self-only idempotent ensure endpoint for initial FREE credits.
 * Client cannot specify amount, target user, source type, or expiry.
 * Strictly guarded against historical users claiming credits retroactively.
 */
router.post('/bootstrap', authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
      return;
    }

    // Phase 3A.4.1 / 3A.4.2: Server-authoritative eligibility guard
    const eligibility = await creditService.checkFreeBootstrapEligibility(userId);
    if (!eligibility.eligible && !eligibility.alreadyGranted) {
      if (eligibility.reason === 'POLICY_NOT_CONFIGURED') {
        res.status(503).json({
          success: false,
          code: 'FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED',
          error: 'Chính sách cấp tín dụng khởi tạo chưa được cấu hình.',
          message: 'Free credit bootstrap policy is not configured on server.',
        });
        return;
      }

      const status = (eligibility.reason === 'HISTORICAL_USER' || eligibility.reason === 'HISTORICAL_USER_NOT_ELIGIBLE') ? 409 : 422;
      res.status(status).json({
        success: false,
        code: 'FREE_BOOTSTRAP_NOT_ELIGIBLE',
        error: 'Tài khoản không đủ điều kiện nhận tín dụng dùng thử khởi tạo.',
        message: 'This account is not eligible for the initial free credit grant.',
      });
      return;
    }

    const result = await creditService.bootstrapNewUserFreeCredits(userId, { enforceEligibility: true });

    res.json({
      success: true,
      message: result.alreadyProcessed
        ? 'Tín dụng dùng thử đã được cấp trước đó.'
        : 'Cấp tín dụng dùng thử thành công.',
      ...result,
    });
  } catch (err: any) {
    if (err.code === 'FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED' || err.message?.includes('FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED')) {
      res.status(503).json({
        success: false,
        code: 'FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED',
        error: 'Chính sách cấp tín dụng khởi tạo chưa được cấu hình.',
        message: 'Free credit bootstrap policy is not configured on server.',
      });
      return;
    }

    if (err.code === 'FREE_BOOTSTRAP_NOT_ELIGIBLE' || err.message?.includes('FREE_BOOTSTRAP_NOT_ELIGIBLE')) {
      res.status(409).json({
        success: false,
        code: 'FREE_BOOTSTRAP_NOT_ELIGIBLE',
        error: 'Tài khoản không đủ điều kiện nhận tín dụng dùng thử khởi tạo.',
        message: 'This account is not eligible for the initial free credit grant.',
      });
      return;
    }

    console.error('[Credit API] Error in bootstrap endpoint:', err);
    res.status(500).json({
      success: false,
      error: 'Không thể cấp tín dụng dùng thử',
      message: err.message,
    });
  }
});

export default router;
