"""Lightweight PDF builders for the user-facing reports.

Uses ReportLab (already in requirements.txt) to render a one-pager PDF per
report kind. All builders return a `bytes` payload that the FastAPI route
streams back via `StreamingResponse`. No filesystem writes — the PDF lives in
memory only.

The same blueprint is consumed by both the Next.js web frontend and the Expo
APK; the APK saves the bytes via `expo-file-system` + `expo-sharing`, the web
triggers a normal browser download via `application/pdf` content-disposition.
"""

from __future__ import annotations

import io
import os
from datetime import datetime
from typing import Any

from reportlab.lib import colors as rl_colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

BRAND = rl_colors.HexColor("#A855F7")
BRAND_SOFT = rl_colors.HexColor("#F3E8FF")
GRID = rl_colors.HexColor("#E5E7EB")
TEXT = rl_colors.HexColor("#0F172A")
MUTED = rl_colors.HexColor("#64748B")
BUY = rl_colors.HexColor("#0F766E")
SELL = rl_colors.HexColor("#DC2626")


# ── Font with Indian Rupee (₹, U+20B9) glyph support ─────────────────
# ReportLab's built-in PDF fonts (Helvetica / Times / Courier) are Type 1
# fonts with the WinAnsi encoding — they predate Unicode and have NO
# glyph for ₹. Renders show up as a black square (■), which is exactly
# what the user reported in the P&L PDF.
#
# Fix: register a TrueType font that DOES carry ₹, and route every
# Paragraph / Table cell through it. We try a list of candidate paths
# at import time, pick whichever one resolves first, and fall back to
# the legacy "Rs." prefix in `_fmt_money` if absolutely nothing works
# (so the PDF still renders cleanly on a stripped-down host).
_FONT_NAME = "Helvetica"
_FONT_BOLD = "Helvetica-Bold"
_HAS_RUPEE = False


def _register_unicode_font() -> None:
    """Locate a system TrueType font that includes ₹ (U+20B9) and
    register it under the stable aliases used elsewhere in this module.
    Search order: bundled app font → Linux server paths → Windows
    system paths → macOS system paths. First hit wins."""
    global _FONT_NAME, _FONT_BOLD, _HAS_RUPEE

    here = os.path.dirname(__file__)
    bundled = os.path.normpath(os.path.join(here, "..", "..", "assets", "fonts"))

    # Each entry: (alias, regular path, bold path-or-None). The bold
    # path is optional — if it's missing we fall back to the regular
    # face for bold spans (better than reverting to Helvetica which
    # would re-introduce the ■ glyph).
    candidates: list[tuple[str, str, str | None]] = [
        # Bundled with the app (preferred — no system dependency).
        ("AppSans", os.path.join(bundled, "NotoSans-Regular.ttf"),
         os.path.join(bundled, "NotoSans-Bold.ttf")),
        ("AppSans", os.path.join(bundled, "DejaVuSans.ttf"),
         os.path.join(bundled, "DejaVuSans-Bold.ttf")),

        # Linux (Ubuntu / Debian / Amazon Linux) — DejaVu is in
        # fonts-dejavu-core which is installed by default on most
        # server images and ships with ₹.
        ("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("DejaVu", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
        # Noto Sans — often present alongside DejaVu.
        ("NotoSans", "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
         "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"),

        # Windows — Arial and Segoe UI both carry ₹ (Win 8+).
        ("Arial", "C:\\Windows\\Fonts\\arial.ttf",
         "C:\\Windows\\Fonts\\arialbd.ttf"),
        ("Segoe", "C:\\Windows\\Fonts\\segoeui.ttf",
         "C:\\Windows\\Fonts\\segoeuib.ttf"),

        # macOS.
        ("HelveticaNeue", "/System/Library/Fonts/HelveticaNeue.ttc", None),
        ("Arial", "/Library/Fonts/Arial.ttf",
         "/Library/Fonts/Arial Bold.ttf"),
    ]

    for alias, reg, bold in candidates:
        if not os.path.exists(reg):
            continue
        try:
            pdfmetrics.registerFont(TTFont(alias, reg))
            bold_alias = f"{alias}-Bold"
            if bold and os.path.exists(bold):
                pdfmetrics.registerFont(TTFont(bold_alias, bold))
            else:
                pdfmetrics.registerFont(TTFont(bold_alias, reg))
            # Map `<b>` inside Paragraph HTML to the bold face. Without
            # this, `<b>` falls back to the synthetic-bold renderer which
            # ignores our TTF entirely and would re-introduce ■ for ₹.
            addMapping(alias, 0, 0, alias)         # normal
            addMapping(alias, 1, 0, bold_alias)    # bold
            addMapping(alias, 0, 1, alias)         # italic — synth
            addMapping(alias, 1, 1, bold_alias)    # bold italic — synth
            _FONT_NAME = alias
            _FONT_BOLD = bold_alias
            _HAS_RUPEE = True
            return
        except Exception:
            # Bad / unreadable font file — keep trying the next one.
            continue


_register_unicode_font()


def _rupee() -> str:
    """₹ when the host font carries U+20B9, otherwise the plain-ASCII
    fallback. Keeps PDFs readable on a stripped-down server image."""
    return "₹" if _HAS_RUPEE else "Rs. "


def _fmt_money(v: float | int | str | None) -> str:
    n = float(v or 0)
    return f"{_rupee()}{n:,.2f}"


def _fmt_qty(v: Any) -> str:
    try:
        return f"{int(v):,}"
    except (TypeError, ValueError):
        return str(v or "—")


def _fmt_date(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, datetime):
        return v.strftime("%d %b %Y, %H:%M")
    return str(v)


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title",
            parent=base["Title"],
            fontName=_FONT_BOLD,
            fontSize=20,
            textColor=TEXT,
            spaceAfter=2,
            leading=24,
        ),
        "subtitle": ParagraphStyle(
            "subtitle",
            parent=base["Normal"],
            fontName=_FONT_NAME,
            fontSize=10,
            textColor=MUTED,
            spaceAfter=10,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            fontName=_FONT_BOLD,
            fontSize=12,
            textColor=TEXT,
            spaceBefore=6,
            spaceAfter=6,
        ),
        "label": ParagraphStyle(
            "label",
            parent=base["Normal"],
            fontName=_FONT_NAME,
            fontSize=9,
            textColor=MUTED,
            spaceAfter=2,
        ),
        "value": ParagraphStyle(
            "value",
            parent=base["Normal"],
            fontName=_FONT_NAME,
            fontSize=12,
            textColor=TEXT,
            spaceAfter=6,
        ),
        "footer": ParagraphStyle(
            "footer",
            parent=base["Normal"],
            fontName=_FONT_NAME,
            fontSize=8,
            textColor=MUTED,
            alignment=1,  # center
        ),
    }


def _header(title: str, subtitle: str, user_label: str, styles: dict) -> list:
    band = Table(
        [[Paragraph(f"<b>SetupFX</b>", styles["title"]), Paragraph(user_label, styles["subtitle"])]],
        colWidths=[110 * mm, 70 * mm],
    )
    band.setStyle(
        TableStyle(
            [
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, -1), 1.5, BRAND),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ],
        ),
    )
    return [
        band,
        Spacer(1, 8),
        Paragraph(title, styles["title"]),
        Paragraph(subtitle, styles["subtitle"]),
        Spacer(1, 6),
    ]


def _table(rows: list[list[Any]], col_widths: list[float]) -> Table:
    """Build a tight-padded table that wraps long cell content instead of
    overflowing the column. Each cell is wrapped in a Paragraph so the
    layout engine breaks long strings (₹1,23,456.78 / symbol names) into
    multiple lines rather than running into the next column — the
    overflow the user reported in the P&L PDF.
    """
    base = getSampleStyleSheet()
    body_style = ParagraphStyle(
        "td",
        parent=base["Normal"],
        fontName=_FONT_NAME,
        fontSize=8,
        leading=10,
        textColor=TEXT,
        wordWrap="CJK",  # break inside long money strings if needed
    )
    head_style = ParagraphStyle(
        "th",
        parent=base["Normal"],
        fontName=_FONT_BOLD,
        fontSize=8,
        leading=10,
        textColor=TEXT,
        wordWrap="CJK",
    )

    def cell(value: Any, header: bool) -> Any:
        if isinstance(value, Paragraph):
            return value
        return Paragraph(str(value), head_style if header else body_style)

    wrapped: list[list[Any]] = []
    for i, r in enumerate(rows):
        wrapped.append([cell(c, header=(i == 0)) for c in r])

    t = Table(wrapped, colWidths=col_widths, hAlign="LEFT", repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), BRAND_SOFT),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.75, BRAND),
                ("GRID", (0, 1), (-1, -1), 0.3, GRID),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ],
        ),
    )
    return t


def _summary_grid(items: list[tuple[str, str]], styles: dict) -> Table:
    """Borderless KPI strip — LABEL on top, VALUE below, four to a row.

    Previously this was a 4-up grid wrapped in `BOX` + `INNERGRID` lines
    which the user flagged as ugly cell borders in the PDF. The fix is
    to drop both lines and let the typography (small muted label / bold
    dark value) carry the structure on its own, which is what the
    in-app dashboard already does.
    """
    cells: list[list[Paragraph]] = []
    row: list[Paragraph] = []
    bold = _FONT_BOLD
    for label, value in items:
        cell = Paragraph(
            f"<font color='#64748B' size='8'>{label.upper()}</font><br/>"
            f"<font name='{bold}' color='#0F172A' size='13'>{value}</font>",
            styles["value"],
        )
        row.append(cell)
        if len(row) == 4:
            cells.append(row)
            row = []
    if row:
        while len(row) < 4:
            row.append(Paragraph("", styles["value"]))
        cells.append(row)

    grid = Table(cells, colWidths=[45 * mm] * 4)
    grid.setStyle(
        TableStyle(
            [
                # No BOX / INNERGRID — clean borderless layout.
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ],
        ),
    )
    return grid


def _doc() -> tuple[SimpleDocTemplate, io.BytesIO]:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title="SetupFX Report",
    )
    return doc, buf


def _user_label(user) -> str:
    code = getattr(user, "user_code", None) or ""
    name = getattr(user, "full_name", None) or ""
    return f"{name}<br/><font size='9'>{code}</font>" if code or name else "Trader"


def _footer_text() -> str:
    return f"Generated by SetupFX on {datetime.now().strftime('%d %b %Y, %H:%M IST')}"


# ── Builders ──────────────────────────────────────────────────────────


def build_pnl_pdf(user, payload: dict) -> bytes:
    styles = _styles()
    doc, buf = _doc()
    rng_from = _fmt_date(payload.get("from"))
    rng_to = _fmt_date(payload.get("to"))
    net_pnl = float(payload.get("net_pnl") or 0)
    elems = _header(
        "Profit & Loss Statement",
        f"Period: {rng_from} → {rng_to}",
        _user_label(user),
        styles,
    )
    elems.append(
        _summary_grid(
            [
                ("Total trades", str(payload.get("total_trades", 0))),
                ("Buy value", _fmt_money(payload.get("total_buy_value"))),
                ("Sell value", _fmt_money(payload.get("total_sell_value"))),
                ("Charges", _fmt_money(payload.get("total_charges"))),
            ],
            styles,
        ),
    )
    elems.append(Spacer(1, 14))
    pnl_color = "#0F766E" if net_pnl >= 0 else "#DC2626"
    elems.append(
        Paragraph(
            f"<font color='#64748B' size='10'>NET P&amp;L</font><br/>"
            f"<font color='{pnl_color}' size='22'><b>{('+' if net_pnl >= 0 else '')}{_fmt_money(net_pnl)}</b></font>",
            styles["value"],
        ),
    )
    elems.append(Spacer(1, 12))

    by_symbol = payload.get("by_symbol") or []
    if by_symbol:
        elems.append(Paragraph("Symbol-wise breakdown", styles["h2"]))
        rows: list[list[Any]] = [["Symbol", "Buy Qty", "Sell Qty", "Buy Value", "Sell Value", "Charges", "P&L"]]
        for s in by_symbol:
            pnl = float(s.get("pnl") or 0)
            rows.append(
                [
                    s.get("symbol", "—"),
                    _fmt_qty(s.get("buy_qty")),
                    _fmt_qty(s.get("sell_qty")),
                    _fmt_money(s.get("buy_value")),
                    _fmt_money(s.get("sell_value")),
                    _fmt_money(s.get("charges")),
                    f"{('+' if pnl >= 0 else '')}{_fmt_money(pnl)}",
                ],
            )
        # Trimmed column widths — 28+22+22+28+28+24+28 = 180mm fit the
        # 180mm content area exactly. With the wider 8pt + wrapping font
        # set in `_table()`, money columns now have room for ₹1,23,45,678.
        elems.append(
            _table(rows, [26 * mm, 18 * mm, 18 * mm, 28 * mm, 28 * mm, 22 * mm, 28 * mm]),
        )

    elems.append(Spacer(1, 14))
    elems.append(Paragraph(_footer_text(), styles["footer"]))
    doc.build(elems)
    return buf.getvalue()


def build_tradebook_pdf(user, rows: list[dict]) -> bytes:
    styles = _styles()
    doc, buf = _doc()
    elems = _header(
        "Tradebook",
        f"{len(rows)} trades",
        _user_label(user),
        styles,
    )
    body: list[list[Any]] = [
        ["Date", "Trade #", "Symbol", "Side", "Qty", "Price", "Value", "Charges"],
    ]
    for r in rows:
        side = (r.get("action") or "").upper()
        body.append(
            [
                _fmt_date(r.get("executed_at")),
                r.get("trade_number") or "—",
                r.get("symbol") or "—",
                side,
                _fmt_qty(r.get("quantity")),
                _fmt_money(r.get("price")),
                _fmt_money(r.get("value")),
                _fmt_money(r.get("total_charges")),
            ],
        )
    elems.append(
        _table(
            body,
            [28 * mm, 22 * mm, 24 * mm, 14 * mm, 16 * mm, 22 * mm, 26 * mm, 22 * mm],
        ),
    )
    elems.append(Spacer(1, 14))
    elems.append(Paragraph(_footer_text(), styles["footer"]))
    doc.build(elems)
    return buf.getvalue()


def build_brokerage_pdf(user, payload: dict) -> bytes:
    styles = _styles()
    doc, buf = _doc()
    totals = payload.get("totals") or {}
    elems = _header(
        "Brokerage Summary",
        f"Period: {_fmt_date(payload.get('from'))} → {_fmt_date(payload.get('to'))}",
        _user_label(user),
        styles,
    )
    elems.append(
        _summary_grid(
            [
                ("Total trades", str(payload.get("trade_count", 0))),
                ("Brokerage", _fmt_money(totals.get("brokerage"))),
                ("Total charges", _fmt_money(totals.get("total"))),
                ("Net (charges)", _fmt_money(totals.get("total"))),
            ],
            styles,
        ),
    )
    elems.append(Spacer(1, 14))
    elems.append(Paragraph(_footer_text(), styles["footer"]))
    doc.build(elems)
    return buf.getvalue()


def build_tax_pdf(user, payload: dict) -> bytes:
    styles = _styles()
    doc, buf = _doc()
    elems = _header(
        "Tax P&L (simplified)",
        "Indian capital-gains bucketization (simplified; consult a tax advisor)",
        _user_label(user),
        styles,
    )
    buckets = payload.get("buckets") or {}
    body: list[list[Any]] = [["Bucket", "Net realized"]]
    label_map = {
        "intraday_speculative": "Intraday (speculative)",
        "stcg": "Equity STCG",
        "ltcg": "Equity LTCG",
        "fno": "Futures & Options",
    }
    for k, v in buckets.items():
        body.append([label_map.get(k, k), _fmt_money(v)])
    elems.append(_table(body, [60 * mm, 40 * mm]))
    elems.append(Spacer(1, 14))
    elems.append(Paragraph(_footer_text(), styles["footer"]))
    doc.build(elems)
    return buf.getvalue()


def build_margin_pdf(user, summary: dict) -> bytes:
    styles = _styles()
    doc, buf = _doc()
    elems = _header(
        "Margin Report",
        "Live wallet snapshot",
        _user_label(user),
        styles,
    )
    elems.append(
        _summary_grid(
            [
                ("Available balance", _fmt_money(summary.get("available_balance"))),
                ("Used margin", _fmt_money(summary.get("used_margin"))),
                ("Credit limit", _fmt_money(summary.get("credit_limit"))),
                ("Realized P&L", _fmt_money(summary.get("realized_pnl"))),
                ("Unrealized P&L", _fmt_money(summary.get("unrealized_pnl"))),
                ("Total deposits", _fmt_money(summary.get("total_deposits"))),
                ("Total withdrawals", _fmt_money(summary.get("total_withdrawals"))),
                ("Total brokerage", _fmt_money(summary.get("total_brokerage"))),
            ],
            styles,
        ),
    )
    elems.append(Spacer(1, 14))
    elems.append(Paragraph(_footer_text(), styles["footer"]))
    doc.build(elems)
    return buf.getvalue()
