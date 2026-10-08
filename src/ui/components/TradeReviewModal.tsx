/** Learning Mode popup shown when a trade closes. Playback stays paused until it is closed. */
import { useEffect } from 'react';
import { closeReview, useTrading } from '../state/tradingStore';
import { useJournal } from '../state/journalStore';
import { Modal } from './common';
import { JournalEntryDetail } from './JournalEntryDetail';

export function TradeReviewModal() {
  const reviewId = useTrading((s) => s.reviewId);
  const waiting = useTrading((s) => s.reviewQueue.length);
  const entry = useJournal((s) => s.entries.find((e) => e.id === reviewId));
  const gone = !!reviewId && !entry;
  // The trade on screen was undone (a rewind): go on to the next one waiting, if any.
  useEffect(() => {
    if (gone) closeReview();
  }, [gone]);
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
            {waiting ? `Next trade (${waiting} more)` : 'Continue'}
          </button>
        </>
      }
    >
      <JournalEntryDetail key={entry.id} entry={entry} />
    </Modal>
  );
}
