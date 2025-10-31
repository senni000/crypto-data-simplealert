module.exports = {
  apps: [
    {
      name: 'deribit-ingest',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        DERIBIT_PROCESS_ROLE: 'ingest',
      },
    },
    {
      name: 'deribit-aggregate',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        DERIBIT_PROCESS_ROLE: 'aggregate',
      },
    },
    {
      name: 'deribit-alert',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        DERIBIT_PROCESS_ROLE: 'alert',
      },
    },
  ],
};
