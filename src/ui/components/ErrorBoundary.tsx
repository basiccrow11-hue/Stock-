/**
 * Error boundaries. A failure while drawing one part of the app (a page, a terminal panel, the top
 * bar, a dialog) shows what failed in that part's place, with Try again and Reload the app, while the
 * rest keeps working: the other panels and pages, and the running session, which lives in the stores
 * rather than in the components that failed. The boundary around the whole app is the last resort.
 */
import { Component, createElement, createRef, lazy, useId, type ComponentProps, type ComponentType, type ReactNode, type RefObject } from 'react';
import { pause, useTrading } from '../state/tradingStore';
import { useCredentials } from '../state/credentials';
import { Modal, isShown } from './common';

/** A lazily loaded component whose download Try again can start again. */
export type RetryableLazy<P> = ComponentType<P> & { retry: () => void };

/**
 * The component a module exports as `name`, loaded on first use, whose download can be tried again
 * after it failed. React.lazy keeps a failed import's error for good, and browsers keep a failed
 * module download for as long as the page is open, so calling `load` again would fail at once without
 * asking the server. A retry asks for the module again at its address with a query added, which the
 * browser treats as a new module. The modules it imports keep their addresses, so the stores are still
 * the ones the rest of the app uses. When the error names no address (Safari's), `load` runs again.
 */
// Any component, as React.lazy's own type allows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function retryableLazy<K extends string, M extends Record<K, ComponentType<any>>>(load: () => Promise<M>, name: K): RetryableLazy<ComponentProps<M[K]>> {
  type P = ComponentProps<M[K]>;
  let failure: { error: unknown } | null = null;
  let attempts = 1;
  const make = (download: () => Promise<M>) =>
    lazy(() =>
      download().then(
        (m) => ({ default: m[name] }),
        (error: unknown) => {
          failure = { error };
          throw error;
        },
      ),
    );
  let current = make(load);
  function Retryable(props: P) {
    return createElement(current as ComponentType<P>, props);
  }
  // Only a failed download is thrown away: a component that loaded keeps its identity, and so its state.
  Retryable.retry = () => {
    if (!failure) return;
    const url = moduleRetryUrl(failure.error, attempts++);
    failure = null;
    current = make(url ? () => import(/* @vite-ignore */ url) as Promise<M> : load);
  };
  return Retryable;
}

/**
 * Where to ask again for a module whose download failed: its path on this site, from the error Chrome
 * or Firefox gives, with a query that makes it a new module. Null when the error names no module of
 * this site, as Safari's names none.
 */
export function moduleRetryUrl(e: unknown, attempt: number): string | null {
  const named = e instanceof Error ? /dynamically imported module:?\s*(\S+)/i.exec(e.message) : null;
  if (!named) return null;
  let url: URL;
  try {
    url = new URL(named[1], window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  url.searchParams.set('retry', String(attempt));
  return url.pathname + url.search;
}

/** Whether an error is a page's code failing to download: the messages Chrome, Firefox and Safari give, and Vite's for a page's stylesheet. */
export function isChunkLoadError(e: unknown): boolean {
  return e instanceof Error && /dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload CSS/i.test(e.message);
}

/** Where focus goes when the part that had it is replaced: the trading terminal if it shows, else the current page's tab. */
function focusHome(): void {
  const first = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(isShown);
  (first('[data-focus-home]') ?? first('[aria-current="page"]'))?.focus({ preventScroll: true });
}

type Layout = 'app' | 'page' | 'panel' | 'bar' | 'dialog';

interface Props {
  /** What failed, as the start of a sentence: "The Backtest page", "The watchlist". */
  what: string;
  /** Where the message goes: in place of the whole app, a page, a terminal panel or the top bar, or as a dialog. */
  layout: Layout;
  /** The message's classes, for its place in the layout (a panel's grid area). */
  className?: string;
  /** Hides the message, for a page that stays mounted while another page shows. */
  hidden?: boolean;
  /** Pause playback when this part fails: it holds the replay controls, which go with it. */
  pausesPlayback?: boolean;
  /** Runs before Try again draws the part again: a lazy page's retry, so its code is downloaded again. */
  onRetry?: () => void;
  /** A dialog's Close: clears what opens the dialog, so it does not fail again straight away. */
  onClose?: () => void;
  children?: ReactNode;
}

interface State {
  error: Error | null;
  /** Whether this failure paused a playing replay. */
  paused: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, paused: false };
  private message = createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(): void {
    if (this.props.pausesPlayback && useTrading.getState().playing) {
      pause();
      this.setState({ paused: true });
    }
  }

  /** Set by Try again until the part shows again. */
  private retried = false;

  // A part that fails as it first appears mounts its boundary with the message already showing. A page
  // downloaded again after Try again shows from behind its Loading…, which React reports as a mount.
  componentDidMount(): void {
    if (this.state.error || this.retried) this.refocus();
  }

  componentDidUpdate(_: Props, prev: State): void {
    if (!this.state.error !== !prev.error) this.refocus();
  }

  /**
   * Focus inside the part that failed went with it. It goes to the message, and after Try again to
   * the terminal or the current page's tab, so keyboard and screen reader users are not left on the
   * page body. Focus elsewhere stays where it is, and a dialog's message takes focus itself.
   */
  private refocus(): void {
    const failed = !!this.state.error;
    if (!failed) this.retried = false;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost || this.props.hidden || this.props.layout === 'dialog') return;
    if (failed) this.message.current?.focus({ preventScroll: true });
    else focusHome();
  }

  private retry = () => {
    this.props.onRetry?.();
    this.retried = true;
    this.setState({ error: null, paused: false });
  };

  private close = () => {
    this.props.onClose?.();
    this.setState({ error: null, paused: false });
  };

  render() {
    const { error, paused } = this.state;
    if (!error) return this.props.children;
    return <Fallback {...this.props} error={error} paused={paused} messageRef={this.message} retry={this.retry} close={this.close} />;
  }
}

interface FallbackProps extends Props {
  error: Error;
  paused: boolean;
  messageRef: RefObject<HTMLDivElement | null>;
  retry: () => void;
  close: () => void;
}

function Fallback({ what, layout, className, hidden, error, paused, messageRef, retry, close }: FallbackProps) {
  const id = useId();
  const mode = useTrading((s) => s.session?.mode);
  const keys = useCredentials((s) => !!(s.creds.polygonApiKey || s.creds.alpacaKeyId));
  const session = mode === 'sim' ? 'simulated market session' : 'replay session';
  const chunk = isChunkLoadError(error);
  const title = chunk ? `${what} could not be loaded` : `${what} stopped because of an error`;
  const state = paused ? `your ${session} is paused` : `your ${session} carries on`;
  const explain = chunk
    ? `Its code did not download: the connection may have dropped, or the app was updated since this tab opened it, and then only reloading helps.${layout === 'app' ? '' : ' The rest of the app still works.'}`
    : layout === 'app'
      ? mode
        ? `Your ${session} is still held in memory${paused ? ', paused' : ''}: Try again draws the app again without ending it. If it keeps failing, reload the app.`
        : 'Try again to draw the app again. If it keeps failing, reload the app.'
      : `The rest of the app still works${mode ? `, and ${state}` : ''}. Try again to draw it again. If it keeps failing, reload the app.`;
  // Sessions are kept only in memory (tradingStore): a reload starts the app with none.
  const note = `${mode ? `Reloading ends your ${session}: sessions are not restored after a reload. It keeps` : 'Reloading keeps'} your journal, settings, imported data and drawings.${
    keys ? ' API keys you entered have to be entered again (or unlocked, if you saved them).' : ''
  }`;
  const compact = layout === 'panel' || layout === 'bar';
  const btn = compact ? 'btn sm' : 'btn';
  const reload = (
    <button className={btn} aria-describedby={`${id}-note`} onClick={() => window.location.reload()}>
      Reload the app
    </button>
  );
  const details = (
    <details className="small">
      <summary style={{ cursor: 'pointer' }}>Technical details</summary>
      <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0' }}>
        {`${error.name}: ${error.message}`}
      </pre>
    </details>
  );
  const noteText = (
    <p id={`${id}-note`} className="small muted" style={{ margin: 0 }}>
      {note}
    </p>
  );

  if (layout === 'dialog') {
    return (
      <Modal
        title={title}
        onClose={close}
        footer={
          <>
            {reload}
            <div className="spacer" />
            <button className="btn" onClick={retry}>
              Try again
            </button>
            <button className="btn primary" data-autofocus onClick={close}>
              Close
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{explain}</p>
        {noteText}
        {details}
      </Modal>
    );
  }

  const message = (
    <div ref={messageRef} tabIndex={-1} role="group" aria-labelledby={`${id}-title`} className="stack" style={{ gap: compact ? 6 : 10, outline: 'none' }}>
      <div role="alert">
        {compact ? (
          <b id={`${id}-title`}>{title}</b>
        ) : (
          <h2 id={`${id}-title`} style={{ marginBottom: 6 }}>
            {title}
          </h2>
        )}
        <p className={compact ? 'small' : undefined} style={{ margin: 0 }}>
          {explain}
        </p>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className={`${btn} primary`} onClick={retry}>
          Try again
        </button>
        {reload}
      </div>
      {noteText}
      {details}
    </div>
  );

  if (layout === 'bar') return <header className="topbar">{message}</header>;
  if (layout === 'panel')
    return (
      <div className={className}>
        <div className="panel-body">{message}</div>
      </div>
    );
  const page = (
    <div className={className ?? 'page'} hidden={hidden}>
      <div className="page-inner">
        <div className="card">{message}</div>
      </div>
    </div>
  );
  return layout === 'app' ? <div className="app">{page}</div> : page;
}
