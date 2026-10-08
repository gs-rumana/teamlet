import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, Copy, Eye, Pencil, Zap, type LucideIcon } from "lucide-react";
import type { Agent, AgentStatus, PermissionLevel, ProviderId, ProviderStatus } from "../../../shared/protocol.ts";

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

export const PERMISSIONS: Record<PermissionLevel, { label: string; icon: LucideIcon; hint: string }> = {
  "read-only": { label: "Read only", icon: Eye, hint: "Agents can read and search files, nothing else." },
  "workspace-write": {
    label: "Edit files",
    icon: Pencil,
    hint: "Agents edit files in the folder. Claude asks before running commands; Codex runs them sandboxed.",
  },
  "full-access": { label: "Full access", icon: Zap, hint: "No approvals and no sandbox. Only use in folders you trust." },
};

const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Working",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

export const isActive = (agent: Pick<Agent, "status">) => agent.status === "running" || agent.status === "queued";

export const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "/";

/** Tells a provider's accounts apart: the signed-in email, else the config folder's name. */
export const accountLabel = (status: ProviderStatus) => status.account ?? (status.configDir ? basename(status.configDir) : status.name);

export function modelLabel(providers: ProviderStatus[], provider: ProviderId, model?: string): string | undefined {
  if (!model) return undefined;
  return providers.find((p) => p.id === provider)?.models.find((m) => m.id === model)?.label ?? model;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function useNow(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export function Elapsed({ agent }: { agent: Agent }) {
  const running = agent.status === "running";
  const now = useNow(running);
  if (!agent.startedAt) return null;
  return <span className="tabular">{formatDuration((running ? now : (agent.finishedAt ?? now)) - agent.startedAt)}</span>;
}

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`dot dot-${status}`} aria-label={STATUS_TEXT[status]} />;
}

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <StatusDot status={status} />
      {STATUS_TEXT[status]}
    </span>
  );
}

export function ProviderTag({ provider, model }: { provider: ProviderId; model?: string }) {
  return (
    <span className="provider-tag">
      {PROVIDER_LABEL[provider]}
      {model && <span className="provider-tag-model">{model}</span>}
    </span>
  );
}

export function AgentAvatar({ label }: { label: string }) {
  return <span className="avatar">{label}</span>;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  icon: Icon,
  className = "",
  ...props
}: {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...props}>
      {Icon && <Icon size={size === "sm" ? 14 : 16} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className = "",
  ...props
}: { icon: LucideIcon; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} title={label} {...props}>
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      aria-label={label}
      title={label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** Small markdown subset: fenced code, inline code, bold/italic, headings, lists, quotes, links. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g);
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.startsWith("```")) {
          const language = block.match(/^```(\S*)/)?.[1] ?? "";
          const body = block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
          return (
            <div key={index} className="code-block">
              <div className="code-block-head">
                <span>{language || "code"}</span>
                <CopyButton text={body} />
              </div>
              <pre>{body}</pre>
            </div>
          );
        }
        return block
          .split(/\n{2,}/)
          .filter((paragraph) => paragraph.trim())
          .map((paragraph, pIndex) => renderParagraph(paragraph, `${index}-${pIndex}`));
      })}
    </div>
  );
}

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;

/** Renders a block of lines, splitting it into headings, lists, quotes and plain text runs. */
function renderParagraph(paragraph: string, key: string): ReactNode[] {
  const lines = paragraph.split("\n").filter((line) => line.trim() !== "");
  if (/^(-{3,}|\*{3,})$/.test(paragraph.trim())) return [<hr key={key} />];
  const out: ReactNode[] = [];
  let run: string[] = [];
  let runKind: "text" | "list" | "quote" | null = null;

  const flush = () => {
    if (!run.length) return;
    const k = `${key}-${out.length}`;
    if (runKind === "list") {
      const ordered = /^\s*\d/.test(run[0]);
      const items = run.map((line, index) => (
        <li key={index} className={/^\s{2,}/.test(line) ? "nested" : ""}>
          {inline(line.replace(LIST_ITEM, ""))}
        </li>
      ));
      out.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    } else if (runKind === "quote") {
      out.push(<blockquote key={k}>{inline(run.map((line) => line.replace(/^\s*>\s?/, "")).join(" "))}</blockquote>);
    } else {
      out.push(
        <p key={k}>
          {run.map((line, index) => (
            <span key={index}>
              {index > 0 && <br />}
              {inline(line)}
            </span>
          ))}
        </p>,
      );
    }
    run = [];
    runKind = null;
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const Tag = heading[1].length <= 2 ? "h3" : "h4";
      out.push(<Tag key={`${key}-${out.length}`}>{inline(heading[2])}</Tag>);
      continue;
    }
    const kind = LIST_ITEM.test(line) ? "list" : /^\s*>/.test(line) ? "quote" : "text";
    if (kind !== runKind) flush();
    runKind = kind;
    run.push(line);
  }
  flush();
  return out;
}

/** Markdown reduced to plain text, for one-line previews. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, "· ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*\s][^*]*\*$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^https?:/.test(link[2])) {
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return part;
  });
}
