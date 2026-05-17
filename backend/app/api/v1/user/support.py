"""Public support contact endpoint.

Exposes the admin-managed `platform.support_whatsapp` + `platform.support_email`
PlatformSetting rows so the user app (APK + web) can render a "Contact
support" affordance with the current values. No auth required — these
are public contact details that any signed-in user can read; locking
them down behind admin would just mean every render in the user app
re-derives them, which is wasteful for a string that changes maybe
once a quarter.

Defaults to empty strings when the seed row has never been overridden —
the frontend then hides the buttons rather than rendering "tel://" with
no number.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.models.platform_setting import PlatformSetting
from app.schemas.common import APIResponse

router = APIRouter(prefix="/support", tags=["user-support"])


async def _read_setting(key: str) -> str:
    row = await PlatformSetting.find_one(PlatformSetting.setting_key == key)
    if row is None or row.setting_value is None:
        return ""
    val = row.setting_value
    return str(val).strip()


@router.get("", response_model=APIResponse[dict])
async def get_support_contacts():
    """Returns the admin-configured WhatsApp number + email for customer
    support. Both default to empty strings when unset — the UI is
    expected to hide the corresponding action button in that case so
    the user never sees a half-broken "Contact support" affordance."""
    whatsapp = await _read_setting("platform.support_whatsapp")
    email = await _read_setting("platform.support_email")
    return APIResponse(
        data={
            "whatsapp": whatsapp,
            "email": email,
        }
    )
