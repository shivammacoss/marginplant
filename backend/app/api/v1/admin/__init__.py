"""Admin panel routers (mounted under /api/v1/admin)."""

from fastapi import APIRouter

from app.api.v1.admin import (
    auth,
    brokerage,
    brokers,
    dashboard,
    infoway,
    instruments,
    kyc,
    ledger,
    management,
    netting,
    payin_out,
    reports,
    risk,
    settings,
    trading,
    users,
    zerodha,
)

router = APIRouter(prefix="/admin", tags=["admin"])
router.include_router(auth.router)
router.include_router(dashboard.router)
router.include_router(users.router)
router.include_router(risk.router)
router.include_router(netting.router)
router.include_router(trading.router)
router.include_router(payin_out.router)
router.include_router(brokerage.router)
router.include_router(instruments.router)
router.include_router(ledger.router)
router.include_router(reports.router)
router.include_router(settings.router)
router.include_router(zerodha.router)
router.include_router(infoway.router)
router.include_router(kyc.router)
router.include_router(management.router)
router.include_router(brokers.router)
