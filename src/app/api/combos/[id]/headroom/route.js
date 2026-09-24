import { NextResponse } from "next/server";
import { getComboById } from "@/lib/localDb";
import { loadComboHeadroomFn } from "@/sse/services/comboHeadroom.js";

// GET /api/combos/[id]/headroom - Headroom per combo member (YAN-261)
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const fn = await loadComboHeadroomFn();
    const models = Array.isArray(combo.models) ? combo.models : [];
    return NextResponse.json({
      headroom: Object.fromEntries(models.map((m) => [m, fn(m)])),
    });
  } catch (error) {
    console.log("Error fetching combo headroom:", error);
    return NextResponse.json({ error: "Failed to fetch combo headroom" }, { status: 500 });
  }
}
