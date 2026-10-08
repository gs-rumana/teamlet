import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  FilePenLine,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  Search,
  SquareStop,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Agent, TimelineItem } from "../../../shared/protocol.ts";
import { useStore } from "../store.ts";
import { useSession } from "./sessionContext.ts";
import { Markdown, StatusDot } from "./ui.tsx";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

function useRelativePath() {
  const { cwd } = useSession();
  return (path: string) => {
    for (const root of [cwd, `/private${cwd}`]) {
      if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) return path.slice(root.length + 1);
    }
    return path;
  };
}

// ------------------------------------------------------------ delegation

const delegationName = (name: string) => name.match(/^(?:mcp__)?teamlet(?:__|\.)(\w+)$/)?.[1];

function WorkerChip({ workerId, fallbackTitle }: { workerId?: string; fallbackTitle: string }) {
  const store = useStore();
  const { openWorker } = useSession();
  const worker = workerId ? store.agents.get(workerId) : undefined;
  return (
    <button className="worker-chip" disabled={!worker} onClick={() => worker && openWorker(worker.id)}>
      {worker && <StatusDot status={worker.status} />}
      <span>{worker?.title ?? fallbackTitle}</span>
    </button>
  );
}

function DelegationCard({ item, action }: { item: ToolItem; action: string }) {
  const store = useStore();
  const input = parseJson(item.input) ?? {};
  const output = parseJson(item.output);
  const running = item.status === "running";
  let icon: LucideIcon = Users;
  let title: ReactNode = action;
  let chips: { id?: string; title: string }[] = [];

  if (action === "spawn_workers") {
    const tasks = (input.tasks as { title?: string }[] | undefined) ?? [];
    const started = (output?.started as { workerId: string; title: string }[] | undefined) ?? [];
    chips = tasks.map((task, index) => ({ id: started[index]?.workerId, title: task.title ?? `Worker ${index + 1}` }));
    title = running ? `Starting ${tasks.length} workers…` : `Started ${tasks.length} worker${tasks.length === 1 ? "" : "s"} in parallel`;
  } else if (action === "wait_for_workers") {
    const workers = (output?.workers as { workerId: string; title: string; status: string }[] | undefined) ?? [];
    chips = workers.map((w) => ({ id: w.workerId, title: w.title }));
    const done = workers.filter((w) => w.status !== "running" && w.status !== "queued").length;
    icon = ClipboardList;
    title = running ? "Waiting for workers…" : output?.allDone ? `Collected ${done} report${done === 1 ? "" : "s"}` : `${done} of ${workers.length} finished, still waiting`;
  } else if (action === "message_worker" || action === "stop_worker" || action === "get_worker") {
    const workerId = str(input.workerId);
    const worker = store.agents.get(workerId);
    chips = [{ id: workerId, title: worker?.title ?? workerId }];
    icon = action === "message_worker" ? MessageSquare : action === "stop_worker" ? SquareStop : ClipboardList;
    title = action === "message_worker" ? "Sent a follow-up" : action === "stop_worker" ? "Stopped a worker" : "Read a worker's report";
  } else if (action === "list_providers") {
    icon = Bot;
    title = "Checked available models";
  }

  const Icon = icon;
  return (
    <div className={`delegation ${item.status === "error" ? "delegation-error" : ""}`}>
      <div className="delegation-head">
        <span className="delegation-icon">{running ? <LoaderCircle size={15} className="spin" /> : <Icon size={15} />}</span>
        <span>{title}</span>
      </div>
      {chips.length > 0 && (
        <div className="delegation-chips">
          {chips.map((chip, index) => (
            <WorkerChip key={chip.id ?? index} workerId={chip.id} fallbackTitle={chip.title} />
          ))}
        </div>
      )}
      {item.status === "error" && item.output && <div className="delegation-err">{item.output}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ tools

interface ToolView {
  icon: LucideIcon;
  verb: string;
  target: string;
  body: () => ReactNode;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const removed = before ? before.split("\n") : [];
  const added = after ? after.split("\n") : [];
  return (
    <pre className="diff">
      {removed.map((line, index) => (
        <div key={`r${index}`} className="diff-del">
          <span className="diff-sign">−</span>
          {line || " "}
        </div>
      ))}
      {added.map((line, index) => (
        <div key={`a${index}`} className="diff-add">
          <span className="diff-sign">+</span>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function Output({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  return <pre className="tool-output">{text}</pre>;
}

function describeTool(item: ToolItem, relative: (path: string) => string): ToolView {
  const input = parseJson(item.input);
  const name = item.name;
  // Claude's Read input arrives as a bare path rather than JSON.
  const path = relative(str(input?.file_path) || str(input?.path) || str(input?.notebook_path) || (!input && name === "Read" ? item.input : ""));

  switch (name) {
    case "Bash":
    case "Shell": {
      const command = input ? str(input.command) : item.input;
      return {
        icon: SquareTerminal,
        verb: "Ran",
        target: command.split("\n")[0],
        body: () => (
          <pre className="terminal">
            <span className="terminal-prompt">$ </span>
            {command}
            {item.output ? `\n${item.output}` : ""}
          </pre>
        ),
      };
    }
    case "Read":
      return { icon: FileText, verb: "Read", target: path, body: () => <Output text={item.output} /> };
    case "Write": {
      const content = str(input?.content);
      return {
        icon: FilePlus,
        verb: "Wrote",
        target: `${path}${content ? `  · ${content.split("\n").length} lines` : ""}`,
        body: () => <DiffView before="" after={content} />,
      };
    }
    case "Edit":
    case "MultiEdit": {
      if (!input) {
        // Codex reports file changes as "kind path" lines.
        const files = item.input.split("\n").filter(Boolean);
        return {
          icon: FilePenLine,
          verb: "Changed",
          target: files.length === 1 ? relative(files[0].replace(/^\w+\s+/, "")) : `${files.length} files`,
          body: () => <pre className="tool-output">{files.map((f) => f.replace(/\s(\/\S+)/, (_, p: string) => ` ${relative(p)}`)).join("\n")}</pre>,
        };
      }
      const edits = (input.edits as { old_string: string; new_string: string }[] | undefined) ?? [
        { old_string: str(input.old_string), new_string: str(input.new_string) },
      ];
      return {
        icon: FilePenLine,
        verb: "Edited",
        target: path,
        body: () => (
          <>
            {edits.map((edit, index) => (
              <DiffView key={index} before={edit.old_string} after={edit.new_string} />
            ))}
            {item.status === "error" && <Output text={item.output} />}
          </>
        ),
      };
    }
    case "Grep":
    case "Glob":
      return {
        icon: Search,
        verb: "Searched",
        target: `${str(input?.pattern)}${path ? `  in ${path}` : ""}`,
        body: () => <Output text={item.output} />,
      };
    case "WebSearch":
    case "WebFetch":
      return {
        icon: Globe,
        verb: name === "WebSearch" ? "Searched the web" : "Fetched",
        target: str(input?.query) || str(input?.url) || item.input,
        body: () => <Output text={item.output} />,
      };
    case "TodoWrite": {
      const todos = (input?.todos as { content: string; status: string }[] | undefined) ?? [];
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        icon: ListTodo,
        verb: "Updated plan",
        target: `${done}/${todos.length} done`,
        body: () => (
          <ul className="todos">
            {todos.map((todo, index) => (
              <li key={index} className={`todo todo-${todo.status}`}>
                <span className="todo-box" />
                {todo.content}
              </li>
            ))}
          </ul>
        ),
      };
    }
    case "Task":
    case "Agent":
      return {
        icon: Bot,
        verb: "Sub-agent",
        target: str(input?.description) || str(input?.prompt).slice(0, 80),
        body: () => <Output text={item.output} />,
      };
    default: {
      const summary = input
        ? Object.entries(input)
            .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
            .join(", ")
        : item.input.split("\n")[0];
      return {
        icon: Wrench,
        verb: name.replace(/^mcp__/, "").replaceAll("__", " · "),
        target: summary,
        body: () => (
          <>
            {item.input && <pre className="tool-output">{item.input}</pre>}
            <Output text={item.output} />
          </>
        ),
      };
    }
  }
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const relative = useRelativePath();
  const view = describeTool(item, relative);
  const Icon = view.icon;
  return (
    <div className={`tool tool-${item.status} ${open ? "open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">{item.status === "running" ? <LoaderCircle size={14} className="spin" /> : <Icon size={14} />}</span>
        <span className="tool-verb">{view.verb}</span>
        <span className="tool-target">{view.target}</span>
        {item.status === "error" && <CircleAlert size={14} className="tool-error-icon" />}
        <ChevronRight size={14} className="tool-chevron" />
      </button>
      {open && <div className="tool-body">{view.body()}</div>}
    </div>
  );
}

// --------------------------------------------------------------- messages

function Brief({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.split("\n").length > 14 || text.length > 1200;
  return (
    <div className={`brief ${long && !expanded ? "collapsed" : ""}`}>
      <div className="brief-label">
        <ClipboardList size={13} /> Task from the lead
      </div>
      <Markdown text={text} />
      {long && (
        <button className="link-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show full brief"}
        </button>
      )}
    </div>
  );
}

type Segment = { kind: "tools"; items: ToolItem[] } | { kind: "item"; item: TimelineItem };

/** Consecutive tool calls render as one compact group. Delegation calls stand alone. */
function segment(items: TimelineItem[]): Segment[] {
  const segments: Segment[] = [];
  for (const item of items) {
    const last = segments.at(-1);
    if (item.kind === "tool" && !delegationName(item.name)) {
      if (last?.kind === "tools") last.items.push(item);
      else segments.push({ kind: "tools", items: [item] });
    } else segments.push({ kind: "item", item });
  }
  return segments;
}

export function Timeline({ agent }: { agent: Agent }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastItem = agent.items.at(-1);
  const lastLength = lastItem && "text" in lastItem ? lastItem.text.length : 0;

  useEffect(() => {
    if (stick.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [agent.items.length, lastLength, agent.status]);

  return (
    <div
      className="timeline"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="timeline-inner">
        {segment(agent.items).map((seg) => {
          if (seg.kind === "tools") {
            return (
              <div key={seg.items[0].id} className="tool-group">
                {seg.items.map((item) => (
                  <ToolRow key={item.id} item={item} />
                ))}
              </div>
            );
          }
          const item = seg.item;
          switch (item.kind) {
            case "user":
              return agent.role === "worker" && item === agent.items[0] ? (
                <Brief key={item.id} text={item.text} />
              ) : (
                <div key={item.id} className="msg-user">
                  <Markdown text={item.text} />
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className="msg-assistant">
                  <Markdown text={item.text} />
                </div>
              );
            case "tool":
              return <DelegationCard key={item.id} item={item} action={delegationName(item.name) ?? item.name} />;
            case "error":
              return (
                <div key={item.id} className="msg-error">
                  <CircleAlert size={15} />
                  <span>{item.text}</span>
                </div>
              );
            case "notice":
              return (
                <div key={item.id} className="msg-notice">
                  <span>{item.text}</span>
                </div>
              );
          }
        })}
        {agent.status === "running" && lastItem?.kind !== "assistant" && (
          <div className="thinking">
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
            Working
          </div>
        )}
        {agent.status === "queued" && <div className="thinking">Queued, waiting for a free worker slot…</div>}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
