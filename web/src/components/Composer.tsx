import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

export function Composer({
  placeholder,
  busy,
  onSend,
  onStop,
}: {
  placeholder: string;
  busy: boolean;
  onSend: (text: string) => Promise<unknown>;
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = async () => {
    if (!text.trim() || busy || sending) return;
    setSending(true);
    setError("");
    try {
      await onSend(text);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      {error && <div className="form-error">{error}</div>}
      <div className={`composer-box ${busy ? "busy" : ""}`}>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={busy ? "Working… you can reply once it finishes" : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {busy && onStop ? (
          <button className="send-btn stop" onClick={onStop} aria-label="Stop" title="Stop">
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button className="send-btn" disabled={!text.trim() || sending} onClick={() => void submit()} aria-label="Send" title="Send">
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
