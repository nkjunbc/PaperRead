import { Component, type JSX, type ReactNode } from 'react';

/** Shown in the dock when the question panel could not be loaded or drawn. */
export function ChatUnavailable({ onClose }: { onClose(): void }): JSX.Element {
  return (
    <div className="chat-dock__failed" role="alert">
      <p>질문 창을 불러오지 못했습니다. 새로고침해 주세요.</p>
      <div className="chat-dock__failed-actions">
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          새로고침
        </button>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}

interface ChatBoundaryProps {
  children?: ReactNode;
  /** The panel is open; opening it again after a failure tries to draw it again. */
  open: boolean;
  onClose(): void;
}

interface ChatBoundaryState {
  failed: boolean;
}

/**
 * Keeps a failure of the question panel inside the dock. The panel loads on first use as its
 * own file; after the app is rebuilt while a tab stays open that file is gone (404), and a failed
 * import — or any error while drawing an answer — would otherwise take the whole reader down
 * with it. A failed import is remembered by the browser for the page's lifetime, so the way
 * forward offered is a reload; closing and opening the panel again draws it again (a drawing
 * error may not recur).
 */
export class ChatBoundary extends Component<ChatBoundaryProps, ChatBoundaryState> {
  override state: ChatBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChatBoundaryState {
    return { failed: true };
  }

  override componentDidUpdate(previous: ChatBoundaryProps): void {
    if (this.state.failed && !previous.open && this.props.open) this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? <ChatUnavailable onClose={this.props.onClose} /> : this.props.children;
  }
}

export default ChatBoundary;
