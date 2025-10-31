import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { IDatabaseManager } from './interfaces';

export interface DatabaseBackupSchedulerOptions {
  sourcePath: string;
  targetDirectory: string;
  intervalMs: number;
  fileName: string;
  databaseManager?: IDatabaseManager;
  retentionMs?: number | null;
}

export class DatabaseBackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: DatabaseBackupSchedulerOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }
    logger.info('Starting database backup scheduler', {
      intervalMs: this.options.intervalMs,
      targetDirectory: this.options.targetDirectory,
      fileName: this.options.fileName,
    });
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.running) {
      logger.warn('Skipping database backup run because previous run is still in progress');
      this.schedule(this.options.intervalMs);
      return;
    }

    this.running = true;
    try {
      await this.performBackup();
      await this.pruneIfNeeded();
    } catch (error) {
      logger.error('Database backup failed', error);
    } finally {
      this.running = false;
      this.schedule(this.options.intervalMs);
    }
  }

  private async performBackup(): Promise<void> {
    const { sourcePath, targetDirectory, fileName } = this.options;

    await fs.promises.access(sourcePath, fs.constants.R_OK);
    await fs.promises.mkdir(targetDirectory, { recursive: true });

    const targetPath = path.join(targetDirectory, fileName);
    await fs.promises.copyFile(sourcePath, targetPath);
    const stats = await fs.promises.stat(targetPath);

    logger.info('Database backup created', {
      targetPath,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  private async pruneIfNeeded(): Promise<void> {
    const { databaseManager, retentionMs } = this.options;
    if (!databaseManager || retentionMs === undefined || retentionMs === null || retentionMs <= 0) {
      return;
    }

    const cutoff = Date.now() - retentionMs;
    try {
      await databaseManager.pruneOlderThan(cutoff);
      logger.info('Database prune completed', { cutoffTimestamp: cutoff });
    } catch (error) {
      logger.warn('Database prune failed', error);
    }
  }
}
