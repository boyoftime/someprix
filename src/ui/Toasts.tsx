import { CircleAlert, CircleCheck } from "lucide-react";
import { useAppData } from "../state/AppData";

export function Toasts() {
  const { toasts } = useAppData();
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
        </div>
      ))}
    </div>
  );
}
