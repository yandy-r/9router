import { NextResponse } from "next/server";
import {
  getCombos,
  getComboById,
  updateCombo,
  deleteCombo,
  getComboByName,
  updateComboStrategies,
} from "@/lib/localDb";
import { findComboCycle, isModelList, resetComboRotation } from "open-sse/services/combo.js";

const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Move (or drop, when toName is null) settings.comboStrategies[fromName] atomically
 * against the latest stored map. No own entry means no settings write.
 * ponytail: combo write and settings write are separate transactions; a failed
 * settings write leaves the combo renamed/deleted with a stale strategy key.
 * The combo write already committed, so failure is logged, not reported.
 */
async function moveComboStrategyBestEffort(fromName, toName) {
  try {
    await updateComboStrategies((strategies) => {
      if (!Object.hasOwn(strategies, fromName)) return strategies;
      const updated = { ...strategies };
      if (toName) updated[toName] = updated[fromName];
      delete updated[fromName];
      return updated;
    });
  } catch (error) {
    console.log("Error migrating combo strategy:", error);
  }
}

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    if (!prev) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Validate name format if provided
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json(
          { error: "Name can only contain letters, numbers, -, _ and ." },
          { status: 400 },
        );
      }

      if (BLOCKED_COMBO_NAMES.has(body.name)) {
        return NextResponse.json({ error: `Invalid combo name "${body.name}"` }, { status: 400 });
      }

      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }

    if (body.models !== undefined && !isModelList(body.models)) {
      return NextResponse.json({ error: "Models must be an array of strings" }, { status: 400 });
    }

    if (body.name !== undefined || body.models !== undefined) {
      const others = (await getCombos()).filter((c) => c.id !== id);
      const cycle = findComboCycle(
        body.name ?? prev.name,
        body.models ?? prev.models ?? [],
        others,
      );
      if (cycle) {
        return NextResponse.json(
          { error: `Combo cycle detected: ${cycle.join(" → ")}` },
          { status: 400 },
        );
      }
    }

    const combo = await updateCombo(id, body);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    // Migrate per-combo strategy entry on rename (only when one exists)
    if (combo.name && prev?.name && combo.name !== prev.name) {
      await moveComboStrategyBestEffort(prev.name, combo.name);
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);

    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) {
      resetComboRotation(prev.name);
      await moveComboStrategyBestEffort(prev.name, null);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
