import { useMemo, useState } from "react";
import {
  BlockKitBuilder,
  type BlockKitBuilderProps,
  type ChannelOption,
  type SendAsUserStatus,
  type SendPayload,
  type SendResult,
} from "@tightknitai/block-kit-builder";

type Mode = "message" | "modal";

type BuilderIO = Pick<BlockKitBuilderProps, "loadChannels" | "loadSendAsUserStatus" | "onSend">;

const messageIO: BuilderIO = {
  loadChannels: async (): Promise<ChannelOption[]> => {
    const res = await fetch("/api/slack/channels", { credentials: "include" });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? "Failed to load channels");
    }
    return res.json();
  },
  loadSendAsUserStatus: async (): Promise<SendAsUserStatus> => {
    const res = await fetch("/api/slack/me/can-send-as-user", { credentials: "include" });
    return res.json();
  },
  onSend: async ({ channelId, blocks, sendAsUser }: SendPayload): Promise<SendResult> => {
    const res = await fetch("/api/slack/messages/send", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, blocks, sendAsUser }),
    });
    return res.json();
  },
};

const modalIO: BuilderIO = {
  loadChannels: async (): Promise<ChannelOption[]> => [
    { id: "__dm__", name: "Direct message (app Messages tab)" },
  ],
  loadSendAsUserStatus: async (): Promise<SendAsUserStatus> => ({ canSendAsUser: false }),
  onSend: async ({ blocks }: SendPayload): Promise<SendResult> => {
    const res = await fetch("/api/slack/modals/send", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks, title: "Modal preview" }),
    });
    return res.json();
  },
};

/**
 * Two builder modes:
 *   - "message": composes a message and posts it to a channel (channel picker
 *     in the send dialog, validated as surface "message" on the worker).
 *   - "modal":   composes a modal view, then DMs the installer a button that
 *     opens the modal in Slack (validated as surface "modal"; the
 *     channel-picker in the dialog is reduced to a single "Direct message"
 *     option since the destination is fixed).
 */
export function App() {
  const [mode, setMode] = useState<Mode>("message");
  const io = useMemo(() => (mode === "message" ? messageIO : modalIO), [mode]);

  return (
    <div className="app">
      <header className="app__header">
        <h1>Block Kit Builder Template</h1>
        <p>
          Drag blocks → preview → click <strong>Send</strong>. Install at{" "}
          <a href="/slack/install">/slack/install</a> first.
        </p>
        <div className="app__mode" role="tablist" aria-label="Builder mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "message"}
            className={mode === "message" ? "app__mode-btn app__mode-btn--active" : "app__mode-btn"}
            onClick={() => setMode("message")}
          >
            Message
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "modal"}
            className={mode === "modal" ? "app__mode-btn app__mode-btn--active" : "app__mode-btn"}
            onClick={() => setMode("modal")}
          >
            Modal
          </button>
          {mode === "modal" && (
            <span className="app__mode-hint">
              Sending DMs you a button that opens the modal in Slack.
            </span>
          )}
        </div>
      </header>
      <main className="app__main">
        <BlockKitBuilder key={mode} workspaceName="Slack" {...io} />
      </main>
    </div>
  );
}
