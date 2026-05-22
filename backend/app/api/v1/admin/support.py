"""Per-admin support WhatsApp number — read + update for the calling admin.

Each admin-tier user (SUPER_ADMIN / ADMIN / BROKER, including nested
sub-brokers) can configure their OWN WhatsApp number that will be shown
to their downstream users on the apk's "Add funds → Support" button
(and any other Contact-support affordance). Resolution at the user end
walks up the parent_id chain, so a sub-broker who hasn't set their own
number inherits their parent broker's number; a client whose entire
broker chain is blank falls back to the platform-wide
`platform.support_whatsapp` PlatformSetting row.

Endpoints:
    GET  /admin/support — current admin's own number (empty string when unset)
    PUT  /admin/support — { "whatsapp": "<digits or +country digits>" }

Audit-logged as SETTING_CHANGE on the User entity so the existing audit
filter UI surfaces these rows alongside other per-user setting tweaks.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.dependencies import CurrentAdmin
from app.models.audit_log import AuditAction
from app.models.user import User
from app.schemas.common import APIResponse
from app.services.audit_service import log_event

router = APIRouter(prefix="/support", tags=["admin-support"])


class SupportPayload(BaseModel):
    whatsapp: str = Field(default="", max_length=32)


@router.get("", response_model=APIResponse[dict])
async def get_my_support(admin: CurrentAdmin):
    """Returns the calling admin's stored WhatsApp number. Empty string
    when unset — the UI then renders the input as a placeholder and
    explains the inheritance fallback so the admin knows what the
    user actually sees today."""
    return APIResponse(
        data={
            "whatsapp": (admin.support_whatsapp or "").strip(),
            "role": admin.role.value,
        }
    )


@router.put("", response_model=APIResponse[dict])
async def set_my_support(
    payload: SupportPayload,
    admin: CurrentAdmin,
    request: Request,
):
    """Updates the calling admin's own support WhatsApp number. Each
    admin tier writes only its own row — there's no "set someone
    else's number" endpoint, by design: a super-admin manages the
    platform-wide fallback via PlatformSetting; brokers manage their
    own pool's number here.

    The value is stored verbatim (spacing, leading `+`, dashes all
    preserved) so the admin's chosen format round-trips intact when
    re-displayed in the form. Length cap of 32 chars accommodates the
    longest realistic shape `+CC XXX XXX-XXXX`.
    """
    new_value = (payload.whatsapp or "").strip()
    old_value = (admin.support_whatsapp or "").strip()
    if new_value == old_value:
        return APIResponse(data={"whatsapp": new_value, "role": admin.role.value})

    # Refuse obviously-broken numbers. The apk's `buildWhatsappUrl`
    # silently hides the button when digits.length < 8, so blocking
    # the same shape at write time avoids storing a value the user app
    # can never display. Empty string is fine — that's the "clear"
    # action which restores inheritance from the parent admin.
    if new_value:
        digits = "".join(ch for ch in new_value if ch.isdigit())
        if len(digits) < 8:
            raise HTTPException(
                status_code=400,
                detail="WhatsApp number is too short. Include the country code (e.g. +91…).",
            )

    user_doc = await User.get(admin.id)
    if user_doc is None:
        raise HTTPException(status_code=404, detail="Admin user not found")
    user_doc.support_whatsapp = new_value or None
    await user_doc.save()

    await log_event(
        action=AuditAction.SETTING_CHANGE,
        entity_type="User",
        entity_id=admin.id,
        actor_id=admin.id,
        target_user_id=admin.id,
        old_values={"support_whatsapp": old_value},
        new_values={"support_whatsapp": new_value},
        metadata={"field": "support_whatsapp"},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )

    return APIResponse(data={"whatsapp": new_value, "role": admin.role.value})
