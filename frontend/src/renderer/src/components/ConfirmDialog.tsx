/**
 * The one shared confirmation modal in the app — used for every risky action
 * (closing an app, organizing a folder, running an automation routine). All
 * three reuse the same backend `_pending_confirmation` mechanism
 * (app/ai/manager.py); this component is just a real dialog UI on top of it,
 * replacing the old free-text-only "say yes to confirm" flow. Yes/No send the
 * literal text "yes"/"no" back through the caller's own confirm handler —
 * this component has no backend knowledge of its own.
 */
interface ConfirmDialogProps {
  prompt: string;
  busy: boolean;
  onConfirm: (answer: "yes" | "no") => void;
}

export default function ConfirmDialog({ prompt, busy, onConfirm }: ConfirmDialogProps): JSX.Element {
  return (
    <div className="confirm-overlay" role="presentation">
      <div className="confirm-dialog glass-panel" role="alertdialog" aria-modal="true">
        <p className="confirm-dialog-prompt">{prompt}</p>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-no"
            onClick={() => onConfirm("no")}
            disabled={busy}
            autoFocus
          >
            No
          </button>
          <button type="button" className="confirm-dialog-yes" onClick={() => onConfirm("yes")} disabled={busy}>
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}
