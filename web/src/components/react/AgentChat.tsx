/** @jsxImportSource react */
// Cabal Corner agent chat, built on assistant-ui (MIT) primitives with a local runtime. The model
// adapter is ours: it calls the site's /api/corner/agent (retrieval over the curated NEAR notes,
// optionally Workers AI when switched on) and falls back to the same retrieval in the browser.
// No assistant-ui cloud, no third-party API. Mounted from the Solid page via mountAgentChat().
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";

export interface AgentProps {
  symbol: string;
  context: () => Record<string, unknown>;
  ask: (q: string, ctx: Record<string, unknown>) => Promise<{ text: string; sources: { title: string }[]; engine?: string }>;
}

const SUGGESTIONS = ["What skills are we missing?", "Who are the passengers?", "How do TWAP unlocks work?", "How do bounties get paid?", "What is wNEAR?"];

function UserMessage() {
  return <MessagePrimitive.Root className="cc-msg you"><MessagePrimitive.Parts /></MessagePrimitive.Root>;
}
function AssistantMessage() {
  return <MessagePrimitive.Root className="cc-msg agent"><MessagePrimitive.Parts /></MessagePrimitive.Root>;
}

function Chat(p: AgentProps) {
  const adapter: ChatModelAdapter = {
    async run({ messages }) {
      const last = messages[messages.length - 1];
      const q = last?.content.map((c: any) => (c.type === "text" ? c.text : "")).join(" ") ?? "";
      const a = await p.ask(q, p.context());
      const src = a.sources?.length ? `\n\n— ${a.sources.map((s) => s.title).join(" · ")}${a.engine === "workers-ai" ? " · Workers AI" : ""}` : "";
      return { content: [{ type: "text", text: a.text + src }] };
    },
  };
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="cc-thread">
        <ThreadPrimitive.Viewport className="cc-chat">
          <div className="cc-msg agent">Hi caballero. I can help plan ${p.symbol}: ask what skills are missing, who's quiet, how unlocks work, or anything NEAR.</div>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <div className="cc-chips cc-sugg">
          {SUGGESTIONS.map((s) => (
            <ThreadPrimitive.Suggestion key={s} prompt={s} send asChild>
              <button className="btn sm ghost" type="button">{s}</button>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
        <ComposerPrimitive.Root className="cc-inline">
          <ComposerPrimitive.Input className="cc-input" placeholder="Ask the agent…" aria-label="Ask the agent" rows={1} />
          <ComposerPrimitive.Send className="btn sm primary">Ask</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export function mountAgentChat(el: HTMLElement, props: AgentProps): () => void {
  const root: Root = createRoot(el);
  root.render(<Chat {...props} />);
  return () => root.unmount();
}
