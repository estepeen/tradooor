import { supabase, TABLES, generateId } from '../lib/supabase.js';

export type WalletProcessingJob = {
  id: string;
  walletId: string;
  jobType: string;
  status: 'pending' | 'processing' | 'failed';
  priority: number;
  attempts: number;
  lastAttemptAt: string | null;
  nextRunAt: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

const TABLE_NAME = TABLES.WALLET_PROCESSING_QUEUE || 'WalletProcessingQueue';

export class WalletProcessingQueueRepository {
  async enqueue(walletId: string, jobType: string = 'metrics', priority = 0) {
    const now = new Date().toISOString();

    const payload = {
      id: generateId(),
      walletId,
      jobType,
      status: 'pending',
      priority,
      attempts: 0,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const { error } = await supabase
      .from(TABLE_NAME)
      .upsert(payload, { onConflict: 'walletId,jobType' });

    if (error) {
      console.error('❌ Failed to enqueue wallet processing job:', error);
      throw new Error(`Failed to enqueue wallet ${walletId}: ${error.message}`);
    }
  }

  async claimNextJob(): Promise<WalletProcessingJob | null> {
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('*')
      .eq('status', 'pending')
      .lte('nextRunAt', nowIso)
      .order('priority', { ascending: false })
      .order('createdAt', { ascending: true })
      .limit(1);

    if (error) {
      throw new Error(`Failed to fetch queue job: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return null;
    }

    const job = data[0] as WalletProcessingJob;

    const { data: updated, error: updateError } = await supabase
      .from(TABLE_NAME)
      .update({
        status: 'processing',
        attempts: (job.attempts ?? 0) + 1,
        lastAttemptAt: nowIso,
        updatedAt: nowIso,
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select()
      .single();

    if (updateError) {
      if (updateError.code === 'PGRST116') {
        // Someone else claimed it, try next time
        return null;
      }
      throw new Error(`Failed to claim queue job: ${updateError.message}`);
    }

    return updated as WalletProcessingJob;
  }

  async markCompleted(jobId: string) {
    const { error } = await supabase
      .from(TABLE_NAME)
      .delete()
      .eq('id', jobId);

    if (error) {
      throw new Error(`Failed to delete completed job: ${error.message}`);
    }
  }

  async markFailed(jobId: string, errorMessage: string, delayMs = 60_000) {
    const nextRun = new Date(Date.now() + delayMs).toISOString();
    const now = new Date().toISOString();

    const truncatedError =
      errorMessage?.length > 500 ? `${errorMessage.slice(0, 497)}...` : errorMessage;

    const { error } = await supabase
      .from(TABLE_NAME)
      .update({
        status: 'pending',
        nextRunAt: nextRun,
        error: truncatedError,
        updatedAt: now,
      })
      .eq('id', jobId);

    if (error) {
      throw new Error(`Failed to reschedule failed job: ${error.message}`);
    }
  }
}



