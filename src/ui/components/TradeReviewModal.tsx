/** Learning Mode popup shown when a trade closes. Playback stays paused until it is closed. */
import { closeReview, useTrading } from '../state/tradingStore';
import { useJournal } from '../state/journalStore';
import { Modal } from './common';
import { JournalEntryDetail } from './JournalEntryDetail';

export function TradeReviewModal() {
  const reviewId = useTrading((s) => s.reviewId);
  const entry = useJournal((s) => s.entries.find((e) => e.id === reviewId));
  if (!reviewId || !entry) return null;
  return (
    <Modal
      title="Trade closed · review"
      onClose={closeReview}
      wide
      footer={
        <>
          <span className="small muted">Playback is paused. Notes save automatically. Learning Mode can be turned off in Settings.</span>
          <div className="spacer" />
          <button className="btn primary" onClick={closeReview}>
            Continue
          </button>
        </>
      }
    >
      <JournalEntryDetail entry={entry} />
    </Modal>
  );
}
