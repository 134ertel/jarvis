import { useEffect, useState } from "react";
import {
  confirmPendingRun,
  createRoutine,
  deleteRoutine,
  getAutomationOptions,
  getRoutines,
  requestRunRoutine,
  updateRoutine,
  type Routine,
  type Step,
  type StepType,
} from "../lib/automationsClient";
import ConfirmDialog from "./ConfirmDialog";
import { useBackendStatus } from "../hooks/useBackendStatus";

const STEP_LABELS: Record<StepType, string> = {
  open_app: "Open application",
  switch_window: "Switch to application",
  open_settings: "Open Windows Settings",
  open_folder: "Open a folder",
  check_performance: "Check PC performance",
};

const STEP_TYPES: StepType[] = ["open_app", "switch_window", "open_settings", "open_folder", "check_performance"];
const NO_TARGET_STEPS = new Set<StepType>(["open_settings", "check_performance"]);

function describeStep(step: Step): string {
  switch (step.type) {
    case "open_app":
      return `Open ${step.target}`;
    case "switch_window":
      return `Switch to ${step.target}`;
    case "open_settings":
      return "Open Settings";
    case "open_folder":
      return `Open the ${step.target} folder`;
    case "check_performance":
      return "Check PC performance";
    default:
      return step.type;
  }
}

interface Draft {
  id: string | null; // null = creating a new routine
  name: string;
  steps: Step[];
}

function targetOptionsFor(type: StepType, options: { apps: string[]; folders: string[] }): string[] {
  if (type === "open_app" || type === "switch_window") return options.apps;
  if (type === "open_folder") return options.folders;
  return [];
}

export default function AutomationsView(): JSX.Element {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [options, setOptions] = useState<{ apps: string[]; folders: string[] } | null>(null);
  const [failed, setFailed] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingReply, setPendingReply] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const backendStatus = useBackendStatus();

  async function refresh(): Promise<void> {
    try {
      const [routineList, opts] = await Promise.all([getRoutines(), getAutomationOptions()]);
      setRoutines(routineList.routines);
      setOptions(opts);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (backendStatus === "online" && failed) refresh();
  }, [backendStatus]);

  function startCreate(): void {
    if (!options) return;
    setDraft({ id: null, name: "", steps: [{ type: "open_app", target: options.apps[0] ?? "" }] });
    setDraftError(null);
  }

  function startEdit(routine: Routine): void {
    setDraft({ id: routine.id, name: routine.name, steps: routine.steps.map((s) => ({ ...s })) });
    setDraftError(null);
  }

  function cancelDraft(): void {
    setDraft(null);
    setDraftError(null);
  }

  function updateDraftStep(index: number, patch: Partial<Step>): void {
    if (!draft) return;
    const steps = draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    setDraft({ ...draft, steps });
  }

  function addDraftStep(): void {
    if (!draft || !options) return;
    setDraft({ ...draft, steps: [...draft.steps, { type: "open_app", target: options.apps[0] ?? "" }] });
  }

  function removeDraftStep(index: number): void {
    if (!draft) return;
    setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return;
    if (!draft.name.trim()) {
      setDraftError("Give the routine a name.");
      return;
    }
    setBusy(true);
    setDraftError(null);
    try {
      if (draft.id) {
        await updateRoutine(draft.id, draft.name, draft.steps);
      } else {
        await createRoutine(draft.name, draft.steps);
      }
      setDraft(null);
      await refresh();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Couldn't save that routine.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setBusy(true);
    try {
      await deleteRoutine(id);
      if (pendingId === id) {
        setPendingId(null);
        setPendingReply(null);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRun(id: string): Promise<void> {
    setBusy(true);
    setRunResult(null);
    try {
      const { reply } = await requestRunRoutine(id);
      setPendingId(id);
      setPendingReply(reply);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(answer: "yes" | "no"): Promise<void> {
    if (!pendingId) return;
    setBusy(true);
    try {
      const { reply } = await confirmPendingRun(answer);
      setRunResult({ id: pendingId, text: reply });
      setPendingId(null);
      setPendingReply(null);
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <div className="placeholder-view glass-panel">
        <div className="placeholder-ring" />
        <h2>Automations</h2>
        <p>Couldn't reach the backend to load routines.</p>
      </div>
    );
  }

  return (
    <div className="automations-view">
      <div className="settings-card glass-panel">
        <h2>Automations</h2>
        <p className="settings-row-desc">
          Save a routine once — a named list of steps, like "Gaming Mode" — then run it later
          with a single command, e.g. "run Gaming Mode." JARVIS always describes exactly what a
          routine will do and waits for you to confirm before running anything.
        </p>
      </div>

      {!draft && (
        <button type="button" className="automation-new-button" onClick={startCreate} disabled={!options}>
          + New Routine
        </button>
      )}

      {draft && (
        <div className="settings-card glass-panel automation-builder">
          <h2>{draft.id ? "Edit Routine" : "New Routine"}</h2>
          <input
            className="automation-name-input"
            type="text"
            placeholder="Routine name, e.g. Gaming Mode"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />

          <div className="automation-step-list">
            {draft.steps.map((step, index) => {
              const targets = options ? targetOptionsFor(step.type, options) : [];
              return (
                <div className="automation-step-row" key={index}>
                  <span className="automation-step-index">{index + 1}</span>
                  <select
                    value={step.type}
                    onChange={(e) => {
                      const type = e.target.value as StepType;
                      const nextTargets = options ? targetOptionsFor(type, options) : [];
                      updateDraftStep(index, { type, target: nextTargets[0] ?? "" });
                    }}
                  >
                    {STEP_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {STEP_LABELS[t]}
                      </option>
                    ))}
                  </select>
                  {!NO_TARGET_STEPS.has(step.type) && (
                    <select value={step.target} onChange={(e) => updateDraftStep(index, { target: e.target.value })}>
                      {targets.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="automation-step-remove"
                    onClick={() => removeDraftStep(index)}
                    disabled={draft.steps.length <= 1}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>

          <button type="button" className="automation-add-step" onClick={addDraftStep}>
            + Add step
          </button>

          {draftError && <p className="automation-error">{draftError}</p>}

          <div className="automation-builder-actions">
            <button type="button" className="automation-cancel" onClick={cancelDraft} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="automation-save" onClick={saveDraft} disabled={busy}>
              Save
            </button>
          </div>
        </div>
      )}

      <div className="automation-list">
        {routines === null ? (
          <p className="settings-row-desc">Loading…</p>
        ) : routines.length === 0 ? (
          <p className="settings-row-desc">No routines yet. Create one above.</p>
        ) : (
          routines.map((routine) => (
            <div className="settings-card glass-panel automation-card" key={routine.id}>
              <div className="automation-card-header">
                <h2>{routine.name}</h2>
                <div className="automation-card-actions">
                  <button
                    type="button"
                    className="automation-run"
                    onClick={() => handleRun(routine.id)}
                    disabled={busy || pendingId !== null}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="automation-edit"
                    onClick={() => startEdit(routine)}
                    disabled={busy || pendingId !== null}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="automation-delete"
                    onClick={() => handleDelete(routine.id)}
                    disabled={busy || pendingId !== null}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <ol className="automation-steps">
                {routine.steps.map((step, i) => (
                  <li key={i}>{describeStep(step)}</li>
                ))}
              </ol>

              {runResult?.id === routine.id && <p className="automation-result">{runResult.text}</p>}
            </div>
          ))
        )}
      </div>

      {pendingReply && <ConfirmDialog prompt={pendingReply} busy={busy} onConfirm={handleConfirm} />}
    </div>
  );
}
