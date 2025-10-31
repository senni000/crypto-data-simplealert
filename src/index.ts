import './utils/setup-logging';
import { logger } from './utils/logger';

type ProcessRole = 'ingest' | 'aggregate' | 'alert';

function resolveProcessRole(): ProcessRole {
  const raw = (process.env['DERIBIT_PROCESS_ROLE'] ?? 'ingest').trim().toLowerCase();
  if (raw === 'ingest' || raw === 'aggregate' || raw === 'alert') {
    return raw;
  }
  logger.error(`Unknown DERIBIT_PROCESS_ROLE value: ${raw}`);
  process.exit(1);
}

const role = resolveProcessRole();

switch (role) {
  case 'ingest':
    void import('./processes/ingest');
    break;
  case 'aggregate':
    void import('./processes/aggregate');
    break;
  case 'alert':
    void import('./processes/alert');
    break;
  default:
    logger.error('Unhandled process role');
    process.exit(1);
}
