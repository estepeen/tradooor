import { prisma, generateId } from '../lib/prisma.js';

export type WalletProcessingJob = {
  id: string;
  walletId: string;
  jobType: string;
  status: 'pending' | 'processing' | 'failed';
  priority: number;
  attempts: number;
  lastAttemptAt: Date | null;
  nextRunAt: Date;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class WalletProcessingQueueRepository {
  async enqueue(walletId: string, jobType: string = 'metrics', priority = 0) {
    const now = new Date();

    await prisma.walletProcessingQueue.upsert({
      where: {
        walletId_jobType: {
          walletId,
          jobType,
        },
      },
      create: {
        id: generateId(),
        walletId,
        jobType,
        status: 'pending',
        priority,
        attempts: 0,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        status: 'pending',
        priority,
        nextRunAt: now,
        updatedAt: now,
      },
    });
  }

  async claimNextJob(): Promise<WalletProcessingJob | null> {
    const now = new Date();

    // Find next pending job
    const job = await prisma.walletProcessingQueue.findFirst({
      where: {
        status: 'pending',
        nextRunAt: { lte: now },
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'asc' },
      ],
    });

    if (!job) {
      return null;
    }

    // Atomically claim it
    try {
      const updated = await prisma.walletProcessingQueue.update({
        where: {
          id: job.id,
          status: 'pending', // Only update if still pending
        },
        data: {
          status: 'processing',
          attempts: job.attempts + 1,
          lastAttemptAt: now,
          updatedAt: now,
        },
      });

      return updated as WalletProcessingJob;
    } catch (error: any) {
      // Someone else claimed it or it was deleted
      if (error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  async markCompleted(jobId: string) {
    await prisma.walletProcessingQueue.delete({
      where: { id: jobId },
    });
  }

  async markFailed(jobId: string, errorMessage: string, delayMs = 60_000) {
    const nextRun = new Date(Date.now() + delayMs);
    const now = new Date();

    const truncatedError =
      errorMessage?.length > 500 ? `${errorMessage.slice(0, 497)}...` : errorMessage;

    await prisma.walletProcessingQueue.update({
      where: { id: jobId },
      data: {
        status: 'pending',
        nextRunAt: nextRun,
        error: truncatedError,
        updatedAt: now,
      },
    });
  }
}
