import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db/schema.js';
import { DeliveryRepo } from '../src/db/repositories.js';

let db: DB;
let repo: DeliveryRepo;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new DeliveryRepo(db);
});

describe('enqueue', () => {
  it('is idempotent, so a double-click or duplicate timer cannot double-send', () => {
    expect(repo.enqueue('2026-08-23', 'News')).toBe(true);
    expect(repo.enqueue('2026-08-23', 'News')).toBe(false);
    expect(repo.recent()).toHaveLength(1);
  });

  it('keeps folders and dates independent', () => {
    repo.enqueue('2026-08-23', 'News');
    repo.enqueue('2026-08-23', 'Tech');
    repo.enqueue('2026-08-24', 'News');
    expect(repo.recent()).toHaveLength(3);
  });

  it('starts pending and due immediately', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.find('2026-08-23', 'News')!;
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toBe(1000);
  });
});

describe('claimDue', () => {
  it('claims a pending row into building', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const claimed = repo.claimDue(2000)!;
    expect(claimed.state).toBe('building');
    expect(claimed.claimed_at).toBe(2000);
  });

  it('does not return a row twice — the claim is the lock', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    expect(repo.claimDue(2000)).toBeDefined();
    expect(repo.claimDue(2000)).toBeUndefined();
  });

  it('skips rows whose backoff has not elapsed', () => {
    repo.enqueue('2026-08-23', 'News', 5000);
    expect(repo.claimDue(4000)).toBeUndefined();
    expect(repo.claimDue(5000)).toBeDefined();
  });

  it('sends a built row without rebuilding it', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const building = repo.claimDue(2000)!;
    repo.markBuilt(building.id, '/data/digests/news.epub', 4096, 157);

    const claimed = repo.claimDue(Date.now())!;
    // The critical property: a built artifact goes straight to sending.
    expect(claimed.state).toBe('sending');
    expect(claimed.epub_path).toBe('/data/digests/news.epub');
    expect(claimed.article_count).toBe(157);
  });

  it('ignores terminal states', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(2000)!;
    repo.markSent(row.id, '<abc@example.com>');
    expect(repo.claimDue(Date.now())).toBeUndefined();
  });
});

describe('recordFailure', () => {
  it('returns a retryable build failure to pending and backs it off', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(2000)!;
    const state = repo.recordFailure(row.id, 'boom', {
      retry: true,
      hasBuild: false,
      nextAttemptAt: 99_000,
    });
    expect(state).toBe('pending');

    const after = repo.get(row.id)!;
    expect(after.attempts).toBe(1);
    expect(after.next_attempt_at).toBe(99_000);
    expect(after.last_error).toBe('boom');
    expect(after.claimed_at).toBeNull();
  });

  it('preserves a successful build when only the send failed', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(2000)!;
    repo.markBuilt(row.id, '/tmp/news.epub', 10, 5);
    const sending = repo.claimDue(Date.now())!;

    const state = repo.recordFailure(sending.id, 'smtp timeout', {
      retry: true,
      hasBuild: true,
      nextAttemptAt: 123,
    });
    // Back to 'built', not 'pending' — the retry must not rebuild.
    expect(state).toBe('built');
    expect(repo.get(row.id)!.epub_path).toBe('/tmp/news.epub');
  });

  it('marks permanently failed when not retryable', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(2000)!;
    const state = repo.recordFailure(row.id, 'bad password', {
      retry: false,
      hasBuild: false,
      nextAttemptAt: 0,
    });
    expect(state).toBe('failed');
    expect(repo.claimDue(Date.now())).toBeUndefined();
  });

  it('truncates pathological error text', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(2000)!;
    repo.recordFailure(row.id, 'x'.repeat(5000), {
      retry: true,
      hasBuild: false,
      nextAttemptAt: 1,
    });
    expect(repo.get(row.id)!.last_error!.length).toBe(2000);
  });
});

describe('requeueStale', () => {
  it('recovers a build abandoned by a crash or OOM kill', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(1_000_000)!;
    expect(row.state).toBe('building');

    // An hour later the claim is clearly abandoned.
    const recovered = repo.requeueStale(30 * 60 * 1000, 1_000_000 + 60 * 60 * 1000);
    expect(recovered).toBe(1);

    const after = repo.get(row.id)!;
    expect(after.state).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.last_error).toMatch(/interrupted/);
    expect(after.claimed_at).toBeNull();
  });

  it('returns an interrupted send to built so the EPUB is reused', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(1000)!;
    repo.markBuilt(row.id, '/tmp/news.epub', 10, 5);
    repo.claimDue(1_000_000);

    repo.requeueStale(30 * 60 * 1000, 1_000_000 + 60 * 60 * 1000);
    expect(repo.get(row.id)!.state).toBe('built');
  });

  it('leaves a claim that is still fresh alone', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    repo.claimDue(1_000_000);
    expect(repo.requeueStale(30 * 60 * 1000, 1_000_000 + 60_000)).toBe(0);
  });
});

describe('alerting', () => {
  it('surfaces failed rows once and only once', () => {
    repo.enqueue('2026-08-23', 'News', 1000);
    const row = repo.claimDue(2000)!;
    repo.recordFailure(row.id, 'nope', { retry: false, hasBuild: false, nextAttemptAt: 0 });

    expect(repo.dueForAlert().map((r) => r.id)).toEqual([row.id]);
    repo.markAlerted(row.id);
    expect(repo.dueForAlert()).toHaveLength(0);
  });
});

describe('prunableArtifacts', () => {
  it('only offers finished rows older than the cutoff', () => {
    repo.enqueue('2026-08-01', 'Old');
    const old = repo.claimDue(Date.now())!;
    repo.markBuilt(old.id, '/tmp/old.epub', 1, 1);
    repo.markSent(old.id, 'mid');

    repo.enqueue('2026-08-30', 'New');
    const fresh = repo.claimDue(Date.now())!;
    repo.markBuilt(fresh.id, '/tmp/new.epub', 1, 1);
    repo.markSent(fresh.id, 'mid2');

    const prunable = repo.prunableArtifacts('2026-08-15');
    expect(prunable.map((r) => r.folder)).toEqual(['Old']);

    repo.clearArtifact(old.id);
    expect(repo.prunableArtifacts('2026-08-15')).toHaveLength(0);
  });
});
