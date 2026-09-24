import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [
      combo.id,
      combo.name,
      combo.kind,
      stringifyJson(combo.models),
      combo.createdAt,
      combo.updatedAt,
    ],
  );
  return combo;
}

// Move settings.comboStrategies[fromName] to toName (drop when toName is null).
// Caller must hold the transaction that writes the combo row, so rename/delete and
// strategy migration commit or roll back together. No own entry: no settings write.
function moveComboStrategy(db, fromName, toName) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const current = row ? parseJson(row.data, {}) : {};
  const strategies = current.comboStrategies;
  if (
    !strategies ||
    typeof strategies !== "object" ||
    Array.isArray(strategies) ||
    !Object.hasOwn(strategies, fromName)
  ) {
    return;
  }
  const next = { ...strategies };
  if (toName) next[toName] = next[fromName];
  delete next[fromName];
  db.run(`UPDATE settings SET data = ? WHERE id = 1`, [
    stringifyJson({ ...current, comboStrategies: next }),
  ]);
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(`UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`, [
      merged.name,
      merged.kind,
      stringifyJson(merged.models || []),
      merged.updatedAt,
      id,
    ]);
    if (merged.name !== row.name) moveComboStrategy(db, row.name, merged.name);
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const row = db.get(`SELECT name FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM combos WHERE id = ?`, [id]);
    moveComboStrategy(db, row.name, null);
    deleted = true;
  });
  return deleted;
}
