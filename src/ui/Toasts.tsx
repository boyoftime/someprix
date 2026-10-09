import { CircleAlert, CircleCheck } from "lucide-react";
import { useAppData } from "../state/AppData";

export function Toasts() {
  const { toasts, dismiss } = useAppData();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          {toast.tone === "error" ? (
            <CircleAlert size={16} strokeWidth={1.75} />
          ) : (
            <CircleCheck size={16} strokeWidth={1.75} />
          )}
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="btn btn-small toast-action"
              onClick={() => {
                dismiss(toast.id);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
