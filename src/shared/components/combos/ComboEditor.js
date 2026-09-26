"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import Button from "@/shared/components/Button";
import CopyField from "@/shared/components/CopyField";
import IconButton from "@/shared/components/IconButton";
import Input from "@/shared/components/Input";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { ConfirmDialog } from "@/shared/components/Modal";
import { roleLabel, weightShare, parseWeight, validateComboName } from "./comboBuilder";
import StrategyPicker from "./StrategyPicker";
import RouteStep from "./RouteStep";

/**
 * Combo editor card: header (rename, CopyField, Delete/Save), strategy
 * cards + explainer, numbered route track with drag-reorder, weighted
 * inputs + share meters, fusion judge row, model picker.
 */
export default function ComboEditor({
  combo,
  strategy,
  weights,
  judgeModel,
  headroom,
  healthByProvider,
  providerLabelById,
  saving,
  saveError,
  onRename,
  onDelete,
  onSave,
  onStrategyChange,
  onWeightSave,
  onJudgeChange,
  onModelsChange,
  activeProviders,
  modelAliases,
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(combo.name);
  const [nameError, setNameError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [weightErrors, setWeightErrors] = useState({});
  const [announcement, setAnnouncement] = useState("");

  const models = combo.models || [];
  const isWeighted = strategy === "weighted";
  const isFusion = strategy === "fusion";
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const items = models.map((m) => ({ uid: m, model: m }));
  const shares = weightShare(
    models.map((m) => {
      const parsed = parseWeight(drafts[m]);
      return parsed.ok ? parsed.value : (weights[m] ?? 1);
    }),
    models.map((m) => headroom[m]),
  );

  const commitRename = () => {
    const result = validateComboName(nameDraft);
    if (!result.ok) {
      setNameError(result.error);
      return;
    }
    setNameError("");
    setRenaming(false);
    if (result.value !== combo.name) onRename?.(result.value);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((s) => s.uid === active.id);
    const newIndex = items.findIndex((s) => s.uid === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(models, oldIndex, newIndex);
    onModelsChange?.(next);
    setAnnouncement(`Moved ${models[oldIndex]} to position ${newIndex + 1} of ${models.length}`);
  };

  const saveWeight = (model) => {
    if (!(model in drafts)) return;
    const clearDraft = () =>
      setDrafts((prev) => {
        const { [model]: _dropped, ...rest } = prev;
        return rest;
      });
    const parsed = parseWeight(drafts[model]);
    if (!parsed.ok) {
      setWeightErrors((prev) => ({ ...prev, [model]: parsed.error }));
      return;
    }
    if (parsed.value === (weights[model] ?? 1)) {
      clearDraft();
      setWeightErrors((prev) => {
        const { [model]: _dropped, ...rest } = prev;
        return rest;
      });
      return;
    }
    setWeightErrors((prev) => {
      const { [model]: _dropped, ...rest } = prev;
      return rest;
    });
    clearDraft();
    onWeightSave?.(model, parsed.value);
  };

  return (
    <section
      aria-label={`Edit combo ${combo.name}`}
      className="flex min-w-0 flex-1 flex-col gap-5 rounded-[20px] border border-line bg-panel p-5 shadow-card sm:p-7"
    >
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>

      {/* Header: name + rename, CopyField, Delete/Save */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-semibold tracking-wider text-muted uppercase">Combo</span>
          {renaming ? (
            <div className="flex max-w-sm flex-col gap-1">
              <Input
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  if (e.target.value) {
                    const r = validateComboName(e.target.value);
                    setNameError(r.ok ? "" : r.error);
                  } else setNameError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    // Claim Esc for the inline rename so the dismiss layer
                    // never sees it: the rename cancels, the route card stays.
                    e.preventDefault();
                    setNameDraft(combo.name);
                    setNameError("");
                    setRenaming(false);
                  }
                }}
                aria-label="Combo name"
                error={nameError}
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={commitRename}
                  disabled={!!nameError || !nameDraft.trim()}
                >
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setNameDraft(combo.name);
                    setNameError("");
                    setRenaming(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 truncate font-mono text-2xl font-semibold text-text sm:text-[32px]">
                {combo.name}
              </h2>
              <IconButton
                icon="edit"
                label={`Rename combo ${combo.name}`}
                onClick={() => {
                  setNameDraft(combo.name);
                  setNameError("");
                  setRenaming(true);
                }}
              />
            </div>
          )}
        </div>
        <CopyField
          value={`"model": "${combo.name}"`}
          copyValue={combo.name}
          label="Copy combo model name"
          className="w-full sm:w-auto sm:min-w-52"
        />
        <Button variant="danger" icon="delete" onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
        <Button variant="primary" icon="save" loading={saving} onClick={onSave}>
          Save
        </Button>
      </div>
      {saveError && (
        <p role="alert" className="text-sm text-err">
          {saveError}
        </p>
      )}

      <StrategyPicker value={strategy} onChange={onStrategyChange} />

      {/* Route track */}
      <div className="flex flex-col">
        <p className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">The route</p>
        {models.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
            No models in this route yet. Add one below.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext items={items.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
              <ol className="m-0 list-none p-0">
                {items.map(({ uid, model }, index) => {
                  const providerId = model.includes("/")
                    ? model.slice(0, model.indexOf("/"))
                    : model;
                  const health = healthByProvider?.[providerId] || {
                    label: "No data",
                    variant: "neutral",
                  };
                  return (
                    <RouteStep
                      key={uid}
                      uid={uid}
                      index={index}
                      model={model}
                      providerLabel={providerLabelById?.[providerId] || providerId}
                      role={roleLabel(strategy, index)}
                      health={health.label}
                      healthVariant={health.variant}
                      showWeight={isWeighted}
                      weight={drafts[model] ?? String(weights[model] ?? 1)}
                      share={shares[index] ?? 0}
                      weightError={weightErrors[model]}
                      onWeightChange={(v) => {
                        setDrafts((prev) => ({ ...prev, [model]: v }));
                        setWeightErrors((prev) => {
                          const { [model]: _dropped, ...rest } = prev;
                          return rest;
                        });
                      }}
                      onWeightBlur={() => saveWeight(model)}
                      onRemove={() => onModelsChange?.(models.filter((_, i) => i !== index))}
                    />
                  );
                })}
              </ol>
            </SortableContext>
          </DndContext>
        )}
        <div className="flex gap-3.5">
          <div className="flex w-8 shrink-0 justify-center" aria-hidden="true">
            <span className="size-7 rounded-full border-2 border-dashed border-subtle" />
          </div>
          <Button
            variant="ghost"
            icon="add"
            onClick={() => setShowModelSelect(true)}
            className="flex-1 justify-start border-dashed text-muted"
          >
            Add a model to this route
          </Button>
        </div>

        {isFusion && (
          <div className="mt-3.5 ms-11 flex items-center gap-3 rounded-xl border border-coral bg-coral-bg p-3.5 sm:p-4">
            <span
              className="material-symbols-outlined shrink-0 text-[20px] text-coral-ink"
              aria-hidden="true"
            >
              gavel
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text">
                Judge ·{" "}
                <code className="font-mono">
                  {judgeModel || `Auto — ${models[0] || "first model"}`}
                </code>
              </p>
              <p className="text-xs text-muted">
                Reads every panel answer and returns the best one
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setShowJudgeSelect(true)}>
              Change
            </Button>
          </div>
        )}
      </div>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={(m) => {
            if (m?.value && !models.includes(m.value)) onModelsChange?.([...models, m.value]);
          }}
          onDeselect={(m) => {
            if (m?.value) onModelsChange?.(models.filter((x) => x !== m.value));
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Route"
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => {
            onJudgeChange?.(m?.value || "");
            setShowJudgeSelect(false);
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Judge Model"
          addedModelValues={judgeModel ? [judgeModel] : []}
          closeOnSelect
        />
      )}
      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete?.();
        }}
        title="Delete Combo"
        message={`Delete combo "${combo.name}"? This cannot be undone.`}
        confirmText="Delete"
        variant="danger"
      />
    </section>
  );
}

ComboEditor.propTypes = {
  combo: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    models: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  strategy: PropTypes.string.isRequired,
  weights: PropTypes.object,
  judgeModel: PropTypes.string,
  headroom: PropTypes.object,
  healthByProvider: PropTypes.object,
  providerLabelById: PropTypes.object,
  saving: PropTypes.bool,
  saveError: PropTypes.string,
  onRename: PropTypes.func,
  onDelete: PropTypes.func,
  onSave: PropTypes.func,
  onStrategyChange: PropTypes.func,
  onWeightSave: PropTypes.func,
  onJudgeChange: PropTypes.func,
  onModelsChange: PropTypes.func,
  activeProviders: PropTypes.array,
  modelAliases: PropTypes.object,
};
