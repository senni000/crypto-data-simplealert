import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const DEFAULT_RETENTION_DAYS = 7;

export interface DatabaseBackupSchedulerOptions {
  sourcePath: string;
  targetPath: string;
  intervalMs: number;
  retentionDays?: number;
}

/**
 * Periodically copies the main SQLite database to a backup location.
 */
export class DatabaseBackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly retentionDays: number;

  constructor(private readonly options: DatabaseBackupSchedulerOptions) {
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    logger.info('Starting database backup scheduler', {
      intervalMs: this.options.intervalMs,
      targetPath: this.options.targetPath,
    });

    this.scheduleNextRun(0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextRun(delayMs?: number): void {
    const delay = delayMs ?? this.options.intervalMs;
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.isRunning) {
      logger.warn('Database backup skipped because previous run is still in progress');
      this.scheduleNextRun();
      return;
    }

    this.isRunning = true;
    try {
      await this.performBackup();
    } catch (error) {
      logger.error('Database backup failed', error);
    } finally {
      this.isRunning = false;
      this.scheduleNextRun();
    }
  }

  private async performBackup(): Promise<void> {
    const { sourcePath, targetPath } = this.options;

    if (sourcePath === targetPath) {
      logger.warn('Database backup skipped because source and target paths are identical', {
        sourcePath,
      });
      return;
    }

    try {
      await fs.promises.access(sourcePath, fs.constants.R_OK);
    } catch (error) {
      logger.warn('Database backup skipped because source file is not accessible', {
        sourcePath,
        error,
      });
      return;
    }

    const targetDir = path.dirname(targetPath);
    await fs.promises.mkdir(targetDir, { recursive: true });

    await fs.promises.copyFile(sourcePath, targetPath);
    await this.createSnapshotIfNeeded(sourcePath, targetDir, path.basename(targetPath));
    const stats = await fs.promises.stat(targetPath);

    logger.info('Database backup completed', {
      targetPath,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  private async createSnapshotIfNeeded(sourcePath: string, targetDir: string, baseFilename: string): Promise<void> {
    if (this.retentionDays <= 0) {
      return;
    }

    const parsed = path.parse(baseFilename);
    const timestampToken = this.createTimestampToken();
    const snapshotFilename = `${parsed.name}_${timestampToken}${parsed.ext}`;
    const snapshotPath = path.join(targetDir, snapshotFilename);

    try {
      await fs.promises.copyFile(sourcePath, snapshotPath);
      const stats = await fs.promises.stat(snapshotPath);
      logger.info('Database backup snapshot created', {
        snapshotPath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch (error) {
      logger.warn('Failed to create backup snapshot', {
        snapshotPath,
        error,
      });
      return;
    }

    try {
      await this.removeExpiredSnapshots(targetDir, parsed.name, parsed.ext);
    } catch (error) {
      logger.warn('Failed to purge expired backup snapshots', {
        targetDir,
        error,
      });
    }
  }

  private async removeExpiredSnapshots(targetDir: string, baseName: string, extension: string): Promise<void> {
    if (this.retentionDays <= 0) {
      return;
    }

    const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const pattern = new RegExp(
      `^${this.escapeRegExp(baseName)}_(\\d{8}T\\d{6}Z)${this.escapeRegExp(extension)}$`,
    );

    await Promise.all(
      entries
        .filter(entry => entry.isFile())
        .map(async entry => {
          const match = entry.name.match(pattern);
          if (!match) {
            return;
          }

          const timestampToken = match[1];
          if (!timestampToken) {
            return;
          }

          const timestamp = this.parseTimestampToken(timestampToken);
          if (timestamp === null || timestamp >= cutoff) {
            return;
          }

          const snapshotPath = path.join(targetDir, entry.name);
          try {
            await fs.promises.unlink(snapshotPath);
            logger.info('Removed expired backup snapshot', { snapshotPath });
          } catch (error) {
            logger.warn('Failed to remove expired backup snapshot', {
              snapshotPath,
              error,
            });
          }
        }),
    );
  }

  private createTimestampToken(): string {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }

  private parseTimestampToken(token: string): number | null {
    const match = token.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    );
    if (!match) {
      return null;
    }

    const [, year, month, day, hour, minute, second] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
